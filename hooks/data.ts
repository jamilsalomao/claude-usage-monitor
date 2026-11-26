// Reading the figures, keeping the history, raising the alerts.
//
// Where the figures come from:
//   1. The account usage endpoint (the same numbers as Settings → Usage),
//      fetched with the session's own credential, which never reaches this
//      module: `$.session.authorize()` hands an opaque handle that the host
//      spends on a first-party host only. Account-wide, so it also counts
//      claude.ai and every other session.
//   2. Fallback: the rate-limit windows the last API response of this session
//      reported (`$.session.usage()`), when the endpoint cannot be read.
// The context window and the cost always come from `$.session.usage()`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { DayTotal, TokenCounts, UsageSample, UsageSnapshot, UsageWindow } from '../types'
import type { Strings } from './i18n'
import { NO_TOKENS, addTokens, dayKey, fmtDuration, fmtPct, parseAccountUsage, windowLabel, windowShort } from './lib'
import type { Lang } from './lib'

export type Dollar = EngineInterface

export type Config = {
  lang: Lang
  t: Strings
  refreshMs: number
  showBand: boolean
  openOnStart: boolean
  showStatus: boolean
  thresholds: number[]
  notifyNative: boolean
  command: string
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const HISTORY_KEEP_MS = 6 * 3_600_000

const snapshotAtom = atom({ plugin: 'usage-monitor', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const historyAtom = atom({ plugin: 'usage-monitor', key: 'history' } as const, [], { shape: 'history-1' })
const refreshingAtom = atom({ plugin: 'usage-monitor', key: 'isRefreshing' } as const, false)
const bandHiddenAtom = atom({ plugin: 'usage-monitor', key: 'isBandHidden' } as const, false)
const chatTokensAtom = atom({ plugin: 'usage-monitor', key: 'chatTokens' } as const, NO_TOKENS, { shape: 'tokens-1' })
const ledgerAtom = atom({ plugin: 'usage-monitor', key: 'ledger' } as const, [], { shape: 'ledger-1' })
const costSeenAtom = atom({ plugin: 'usage-monitor', key: 'costSeen' } as const, -1)

/** This copy of the module's own bookkeeping; a reload starts it over. */
const runtime = {
  inFlight: null as Promise<void> | null,
  lastFetchAt: 0,
  lastRaw: undefined as string | undefined,
}

export function lastFetchAt(): number {
  return runtime.lastFetchAt
}

export function lastRaw(): string | undefined {
  return runtime.lastRaw
}

/** One refresh at a time; a second caller waits for the one running. */
export function refresh($: Dollar, cfg: Config, force = false): Promise<void> {
  if (runtime.inFlight) return runtime.inFlight
  runtime.inFlight = runRefresh($, cfg, force)

  return runtime.inFlight
}

async function runRefresh($: Dollar, cfg: Config, force: boolean): Promise<void> {
  await update($, refreshingAtom, () => true)
  try {
    await refreshNow($, cfg, force)
  } finally {
    await update($, refreshingAtom, () => false)
    runtime.inFlight = null
  }
}

async function refreshNow($: Dollar, cfg: Config, force: boolean): Promise<void> {
  const now = await $.clock.now()
  const local = await $.session.usage().catch(() => null)

  let windows: UsageWindow[] = []
  let extra: UsageSnapshot['extra']
  let breakdown: UsageSnapshot['breakdown']
  let source: UsageSnapshot['source'] = 'none'
  let error: string | undefined
  let fetchedAt = now

  const account = await readAccount($, now, force)
  if (account.data) {
    windows = account.data.windows
    extra = account.data.extra
    breakdown = account.data.breakdown
    fetchedAt = account.data.at
    source = 'account'
  }
  error = account.error

  if (source === 'none' && local && local.rateLimits.length > 0) {
    windows = local.rateLimits.map(r => ({ id: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt }))
    source = 'session'
  }

  const snap: UsageSnapshot = {
    fetchedAt,
    source,
    windows,
    extra,
    breakdown,
    context: local ? { tokens: local.context.tokens, window: local.context.window, percent: local.context.percent } : undefined,
    costUsd: local?.cost?.usd,
    error,
  }
  await update($, snapshotAtom, () => snap)
  await recordHistory($, snap, now)
  await checkAlerts($, cfg, snap, now)
  await checkResets($, cfg, snap)
  await syncLedger($)
  if (cfg.showStatus) $.ui.status(statusText(cfg, snap, now))
}

/** The account's figures as one session last read them, shared by every session. */
type AccountCache = {
  at: number
  windows: UsageWindow[]
  extra?: UsageSnapshot['extra']
  breakdown?: UsageSnapshot['breakdown']
}

/** A reading younger than this is used as is, by any session. */
const SHARE_MS = 45_000
/** A reading this old still stands in when the account can't be read. */
const STALE_MS = 15 * 60_000

/**
 * Reads the account usage, sharing one reading among the open sessions: a
 * session uses another's reading while it is fresh, so N sessions do not
 * mean N requests a minute, and every window shows the same figures.
 */
async function readAccount(
  $: Dollar,
  now: number,
  force: boolean,
): Promise<{ data?: AccountCache; error?: string }> {
  const cache = (await $.store.get('account').catch(() => undefined)) as AccountCache | undefined
  const isUsable = (c: AccountCache | undefined, ms: number) =>
    c !== undefined && Array.isArray(c.windows) && typeof c.at === 'number' && now - c.at < ms

  if (!force && isUsable(cache, SHARE_MS)) return { data: cache }

  const auth = await $.session.authorize().catch(() => null)
  if (!auth) return { error: 'no-login' }
  if (auth.kind !== 'bearer') return { error: 'api-key' }

  const backoffUntil = Number((await $.store.get('backoffUntil').catch(() => 0)) ?? 0)
  if (!force && now < backoffUntil) {
    return isUsable(cache, STALE_MS) ? { data: cache, error: 'HTTP 429' } : { error: 'HTTP 429' }
  }

  let error: string
  try {
    const res = await $.http.fetch(USAGE_URL, {
      method: 'GET',
      headers: { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      auth: auth.handle,
    })
    runtime.lastFetchAt = now
    if (res.ok) {
      runtime.lastRaw = res.text
      const parsed = parseAccountUsage(JSON.parse(res.text))
      const data: AccountCache = { at: now, windows: parsed.windows, extra: parsed.extra, breakdown: parsed.breakdown }
      await $.store.set('account', data).catch(() => undefined)

      return { data }
    }
    error = `HTTP ${res.status}`
    if (res.status === 429) await $.store.set('backoffUntil', now + 3 * 60_000).catch(() => undefined)
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 120) : 'network'
  }

  return isUsable(cache, STALE_MS) ? { data: cache, error } : { error }
}

/** Writes the endpoint's last body beside the mod, for checking its shape. */
export async function saveRaw($: Dollar): Promise<string | undefined> {
  if (!runtime.lastRaw) return undefined
  const path = `${$.plugin.root}/last-usage-response.local.json`
  try {
    await $.fs.write(path, runtime.lastRaw)

    return path
  } catch {
    return undefined
  }
}

/** Restores the 5-hour readings kept from earlier sessions. */
export async function loadHistory($: Dollar): Promise<void> {
  const stored = (await $.store.get('history').catch(() => undefined)) as UsageSample[] | undefined
  if (!Array.isArray(stored)) return
  const now = await $.clock.now()
  const fresh = stored.filter(s => s && typeof s.t === 'number' && typeof s.p === 'number' && now - s.t <= HISTORY_KEEP_MS)
  await update($, historyAtom, list => (list.length >= fresh.length ? list : fresh))
}

async function recordHistory($: Dollar, snap: UsageSnapshot, now: number): Promise<void> {
  const w5 = snap.windows.find(w => w.id === 'five_hour')
  if (!w5) return
  let kept: UsageSample[] = []
  await update($, historyAtom, list => {
    const last = list[list.length - 1]
    const isNew = !last || last.p !== w5.percent || last.r !== w5.resetsAt || now - last.t >= 5 * 60_000
    kept = (isNew ? [...list, { t: now, p: w5.percent, r: w5.resetsAt }] : list).filter(s => now - s.t <= HISTORY_KEEP_MS)

    return kept
  })
  await $.store.set('history', kept).catch(() => undefined)
}

async function checkAlerts($: Dollar, cfg: Config, snap: UsageSnapshot, now: number): Promise<void> {
  const { thresholds, t, lang } = cfg
  if (thresholds.length === 0 || snap.windows.length === 0) return
  const fired = ((await $.store.get('alerts').catch(() => undefined)) as string[] | undefined) ?? []
  const added: string[] = []
  const top = thresholds[thresholds.length - 1]
  for (const w of snap.windows) {
    const crossed = thresholds.filter(x => w.percent >= x)
    const highest = crossed[crossed.length - 1]
    if (highest === undefined) continue
    const id = `${w.id}|${w.resetsAt ?? ''}|${highest}`
    if (fired.includes(id) || added.includes(id)) continue
    // Mark the lower ones too, so crossing 95 first never fires 80 later.
    for (const x of crossed) added.push(`${w.id}|${w.resetsAt ?? ''}|${x}`)
    const reset = w.resetsAt ? fmtDuration(Date.parse(w.resetsAt) - now) : ''
    const text = t.alert(windowLabel(w.id, lang), fmtPct(w.percent, lang), reset)
    $.ui.toast(text)
    if (cfg.notifyNative && highest === top) void $.ui.notify(text, { title: t.title }).catch(() => undefined)
  }
  if (added.length > 0) await $.store.set('alerts', [...fired, ...added].slice(-60)).catch(() => undefined)
}

/**
 * Says so once when the 5-hour or the weekly window starts over. The record
 * is shared, so the first session to see the new window is the one that tells.
 */
async function checkResets($: Dollar, cfg: Config, snap: UsageSnapshot): Promise<void> {
  if (snap.source !== 'account') return
  type Seen = Record<string, { r?: string; p: number }>
  const seen = ((await $.store.get('resets').catch(() => undefined)) as Seen | undefined) ?? {}
  const next: Seen = { ...seen }
  let isChanged = false
  for (const w of snap.windows) {
    if (w.id !== 'five_hour' && w.id !== 'seven_day') continue
    const before = seen[w.id]
    if (!before || before.r !== w.resetsAt || before.p !== w.percent) {
      next[w.id] = { r: w.resetsAt, p: w.percent }
      isChanged = true
    }
    if (!before?.r || !w.resetsAt) continue
    const moved = Date.parse(w.resetsAt) - Date.parse(before.r)
    // A new window: the reset time jumped forward and the figure fell.
    if (moved > 30 * 60_000 && before.p >= 10 && w.percent < before.p) {
      const text = cfg.t.resetDone(windowLabel(w.id, cfg.lang))
      $.ui.toast(text)
      if (cfg.notifyNative) void $.ui.notify(text, { title: cfg.t.title }).catch(() => undefined)
    }
  }
  if (isChanged) await $.store.set('resets', next).catch(() => undefined)
}

function statusText(cfg: Config, snap: UsageSnapshot, now: number): string | undefined {
  const parts = snap.windows
    .filter(w => w.id === 'five_hour' || w.id === 'seven_day')
    .map(w => {
      const reset = w.id === 'five_hour' && w.resetsAt ? ` (${fmtDuration(Date.parse(w.resetsAt) - now)})` : ''

      return `${windowShort(w.id)} ${fmtPct(w.percent, cfg.lang)}${reset}`
    })

  return parts.length > 0 ? `Claude ${parts.join(' · ')}` : undefined
}

/** The figures as plain lines, for the command's transcript row. */
export async function summary($: Dollar, cfg: Config): Promise<string> {
  const { t, lang } = cfg
  const snap = await read($, snapshotAtom)
  if (!snap) return t.noData
  const now = await $.clock.now()
  const lines = snap.windows.map(w => {
    const reset = w.resetsAt ? ` · ${t.resetsIn} ${fmtDuration(Date.parse(w.resetsAt) - now)}` : ''

    return `${windowLabel(w.id, lang)}: ${fmtPct(w.percent, lang)}${reset}`
  })
  if (snap.context?.percent !== undefined) lines.push(`${t.context}: ${fmtPct(snap.context.percent, lang)}`)

  return lines.join('\n')
}

export async function toggleBand($: Dollar): Promise<boolean> {
  const isHidden = await read($, bandHiddenAtom)
  await update($, bandHiddenAtom, () => !isHidden)

  return !isHidden
}

export async function hideBand($: Dollar): Promise<void> {
  await update($, bandHiddenAtom, () => true)
}

// ------------------------------------------------------- tokens and days

/** Days of use kept in the shared ledger. */
const LEDGER_DAYS = 8

/**
 * Starts counting this session's cost from now, so a session the mod joins
 * late, or one resumed, adds only what it spends from here.
 */
export async function startLedger($: Dollar): Promise<void> {
  const seen = await read($, costSeenAtom)
  if (seen < 0) {
    const usd = (await $.session.usage().catch(() => null))?.cost?.usd ?? 0
    await update($, costSeenAtom, () => usd)
  }
  await syncLedger($)
}

/** Copies the shared ledger, which other sessions write too, into this session. */
async function syncLedger($: Dollar): Promise<void> {
  const stored = (await $.store.get('ledger').catch(() => undefined)) as DayTotal[] | undefined
  if (!Array.isArray(stored)) return
  await update($, ledgerAtom, () => stored)
}

/** Counts one finished response: into this conversation and into today. */
export async function recordTurn($: Dollar, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | undefined): Promise<void> {
  const counts: TokenCounts = usage
    ? {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        turns: 1,
      }
    : { ...NO_TOKENS }
  if (usage) await update($, chatTokensAtom, c => addTokens(c, counts))

  const local = await $.session.usage().catch(() => null)
  const usd = local?.cost?.usd
  let spent = 0
  if (usd !== undefined) {
    const seen = await read($, costSeenAtom)
    spent = Math.max(0, usd - Math.max(0, seen))
    await update($, costSeenAtom, () => usd)
  }
  if (!usage && spent === 0) return

  const now = await $.clock.now()
  const today = dayKey(now)
  const stored = ((await $.store.get('ledger').catch(() => undefined)) as DayTotal[] | undefined) ?? []
  const list = Array.isArray(stored) ? stored.filter(d => d && typeof d.day === 'string') : []
  const index = list.findIndex(d => d.day === today)
  const base: DayTotal = index >= 0 ? list[index]! : { ...NO_TOKENS, day: today, usd: 0 }
  const day: DayTotal = { ...addTokens(base, counts), day: today, usd: base.usd + spent }
  const next = (index >= 0 ? list.map((d, i) => (i === index ? day : d)) : [...list, day])
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-LEDGER_DAYS)
  await $.store.set('ledger', next).catch(() => undefined)
  await update($, ledgerAtom, () => next)
}
