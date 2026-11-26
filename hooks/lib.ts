// Pure helpers: parsing the account response, formatting, pacing, the
// projection and the bars. Nothing here touches `$`.

import type { BreakdownRow, ExtraUsage, UsageSample, UsageWindow } from '../types'

export type Lang = 'pt' | 'en'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/** How long each known window lasts, for the pace marker. */
export function windowLength(id: string): number | undefined {
  if (id === 'five_hour') return 5 * HOUR
  if (id.startsWith('seven_day')) return 7 * DAY
  return undefined
}

const LABELS: Record<Lang, Record<string, string>> = {
  pt: {
    five_hour: 'Sessão atual · 5 h',
    seven_day: 'Semana · todos os modelos',
    seven_day_opus: 'Semana · Opus',
    seven_day_sonnet: 'Semana · Sonnet',
    seven_day_oauth_apps: 'Semana · apps conectados',
  },
  en: {
    five_hour: 'Current session · 5 h',
    seven_day: 'Week · all models',
    seven_day_opus: 'Week · Opus',
    seven_day_sonnet: 'Week · Sonnet',
    seven_day_oauth_apps: 'Week · connected apps',
  },
}

const SHORT: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
  seven_day_oauth_apps: 'Apps',
}

export function windowLabel(id: string, lang: Lang): string {
  const known = LABELS[lang][id]
  if (known) return known
  const words = id.replace(/_/g, ' ').replace(/\bseven day\b/, lang === 'pt' ? 'semana' : 'week')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function windowShort(id: string): string {
  return SHORT[id] ?? id.replace(/^seven_day_/, '').slice(0, 8)
}

// ---------------------------------------------------------------- parsing

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Order the windows the way the settings page does. */
const ORDER = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_oauth_apps']

/**
 * Reads the account usage endpoint's body: every top-level object with a
 * numeric `utilization` is a window, so a window added later shows up too.
 */
export function parseAccountUsage(body: unknown): {
  windows: UsageWindow[]
  extra?: ExtraUsage
  breakdown?: BreakdownRow[]
} {
  const windows: UsageWindow[] = []
  let extra: ExtraUsage | undefined
  if (body === null || typeof body !== 'object') return { windows }
  const breakdown = parseBreakdown((body as Record<string, unknown>).seven_day_breakdown)

  for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (id === 'extra_usage') {
      extra = {
        isEnabled: v.is_enabled === true,
        percent: num(v.utilization),
        usedCredits: num(v.used_credits),
        monthlyLimit: num(v.monthly_limit),
      }
      continue
    }
    const percent = num(v.utilization)
    if (percent === undefined) continue
    windows.push({ id, percent: round1(percent), resetsAt: str(v.resets_at) })
  }

  windows.sort((a, b) => rank(a.id) - rank(b.id))

  return { windows, extra, breakdown }
}

function parseBreakdown(v: unknown): BreakdownRow[] | undefined {
  if (v === null || typeof v !== 'object') return undefined
  const rows = (v as Record<string, unknown>).rows
  if (!Array.isArray(rows)) return undefined
  const out: BreakdownRow[] = []
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const key = str(row.key)
    const share = num(row.percent)
    if (!key || share === undefined) continue
    out.push({ key, label: str(row.display_name) ?? key, share, ofLimit: num(row.percent_of_limit) ?? 0 })
  }
  out.sort((a, b) => b.share - a.share)

  return out.length > 0 ? out : undefined
}

function rank(id: string): number {
  const i = ORDER.indexOf(id)

  return i === -1 ? ORDER.length : i
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ------------------------------------------------------------- formatting

export function fmtPct(p: number, lang: Lang): string {
  const shown = p < 10 && !Number.isInteger(p) ? round1(p).toFixed(1) : String(Math.round(p))

  return `${lang === 'pt' ? shown.replace('.', ',') : shown}%`
}

/** `2h 14m`, `3d 4h`, `45m`, `<1m`. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return '<1m'
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`

  return `${m}m`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${round1(n / 1_000_000)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`

  return String(n)
}

export function fmtUsd(n: number, lang: Lang): string {
  const fixed = n.toFixed(2)

  return lang === 'pt' ? `US$ ${fixed.replace('.', ',')}` : `$${fixed}`
}

/** Local wall-clock time, or undefined where the sandbox only knows UTC. */
export function fmtClock(ms: number, lang: Lang, withDay: boolean): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!zone || zone === 'UTC' || zone === 'Etc/UTC') return undefined
    const locale = lang === 'pt' ? 'pt-BR' : 'en-US'
    const opts: Intl.DateTimeFormatOptions = withDay
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }

    return new Date(ms).toLocaleString(locale, opts)
  } catch {
    return undefined
  }
}

// -------------------------------------------------------- pace and levels

export type Level = 'ok' | 'warn' | 'high'

export function level(p: number): Level {
  if (p >= 90) return 'high'
  if (p >= 70) return 'warn'

  return 'ok'
}

export const LEVEL_COLOR: Record<Level, string> = {
  ok: 'success',
  warn: 'warning',
  high: 'error',
}

/** The fraction of the window already gone, 0 to 1, when it is known. */
export function elapsedFraction(w: UsageWindow, now: number): number | undefined {
  const len = windowLength(w.id)
  if (!len || !w.resetsAt) return undefined
  const reset = Date.parse(w.resetsAt)
  if (!Number.isFinite(reset)) return undefined

  return Math.min(1, Math.max(0, 1 - (reset - now) / len))
}

export type Pace = 'ahead' | 'even' | 'behind'

/** Used share against elapsed share: `ahead` spends faster than time passes. */
export function pace(w: UsageWindow, now: number): Pace | undefined {
  const elapsed = elapsedFraction(w, now)
  if (elapsed === undefined || elapsed < 0.03) return undefined
  const used = w.percent / 100
  if (used > elapsed + 0.08) return 'ahead'
  if (used < elapsed - 0.08) return 'behind'

  return 'even'
}

export type Projection =
  | { kind: 'hits'; inMs: number; beforeReset: boolean }
  | { kind: 'safe' }

/**
 * From the readings of the current 5-hour window over the last hour: when
 * the window reaches 100% at that rate, and whether that is before it resets.
 */
export function project(w: UsageWindow, samples: readonly UsageSample[], now: number): Projection | undefined {
  if (w.percent >= 100) return undefined
  const recent = samples.filter(s => s.r === w.resetsAt && now - s.t <= HOUR && s.t <= now)
  const first = recent[0]
  if (!first) return undefined
  const dt = now - first.t
  const dp = w.percent - first.p
  if (dt < 10 * 60_000) return undefined
  if (dp <= 0) return { kind: 'safe' }
  const inMs = ((100 - w.percent) / dp) * dt
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  const beforeReset = !Number.isFinite(reset) || now + inMs < reset
  if (!beforeReset) return { kind: 'safe' }

  return { kind: 'hits', inMs, beforeReset }
}

// ------------------------------------------------------------------ bars

export type Segment = { text: string; kind: 'fill' | 'empty' | 'mark' }

/**
 * A bar of `width` cells: `percent` filled, and a marker where the window's
 * elapsed time stands, so being ahead of or behind the pace reads at a glance.
 */
export function bar(percent: number, width: number, elapsed?: number): Segment[] {
  const cells = Math.max(1, Math.floor(width))
  const filled = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)))
  const mark = elapsed === undefined ? -1 : Math.min(cells - 1, Math.max(0, Math.round(elapsed * cells)))
  const out: Segment[] = []
  const push = (kind: Segment['kind'], ch: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += ch
    else out.push({ kind, text: ch })
  }
  for (let i = 0; i < cells; i++) {
    if (i === mark) push('mark', i < filled ? '┃' : '│')
    else if (i < filled) push('fill', '█')
    else push('empty', '░')
  }

  return out
}

const SPARK = '▁▂▃▄▅▆▇█'

/** The last five hours of the 5-hour window, one cell per slice of time. */
export function sparkline(samples: readonly UsageSample[], now: number, width: number): string {
  const cells = Math.max(4, Math.floor(width))
  const span = 5 * HOUR
  const slice = span / cells
  const start = now - span
  let out = ''
  let carry: number | undefined
  let idx = 0
  const sorted = samples.filter(s => s.t >= start - HOUR).sort((a, b) => a.t - b.t)
  // Value standing at the start of the span.
  while (idx < sorted.length && sorted[idx].t < start) carry = sorted[idx++].p
  for (let c = 0; c < cells; c++) {
    const end = start + (c + 1) * slice
    let peak: number | undefined
    while (idx < sorted.length && sorted[idx].t < end) {
      peak = Math.max(peak ?? 0, sorted[idx].p)
      carry = sorted[idx].p
      idx++
    }
    const v = peak ?? carry
    out += v === undefined ? ' ' : SPARK[Math.min(SPARK.length - 1, Math.floor((Math.min(100, v) / 100) * SPARK.length))]
  }

  return out
}

/** `"80, 95"` → `[80, 95]`, sorted, each within 1..100. */
export function parseThresholds(raw: string): number[] {
  return raw
    .split(/[,;\s]+/)
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => a - b)
}

export type Budget =
  | { kind: 'day' | 'hour'; amount: number }
  | { kind: 'rest'; amount: number; leftMs: number }

/**
 * What is left of a window, spread over the time it has left: a share per
 * day for a weekly window, per hour for the 5-hour one, or what is left in
 * all once less than one such unit remains.
 */
export function budget(w: UsageWindow, now: number): Budget | undefined {
  if (!w.resetsAt) return undefined
  const reset = Date.parse(w.resetsAt)
  if (!Number.isFinite(reset) || reset <= now) return undefined
  const remaining = Math.max(0, 100 - w.percent)
  const leftMs = reset - now
  const unit = w.id === 'five_hour' ? HOUR : w.id.startsWith('seven_day') ? DAY : undefined
  if (unit === undefined) return undefined
  if (leftMs < unit) return { kind: 'rest', amount: remaining, leftMs }

  return { kind: unit === DAY ? 'day' : 'hour', amount: remaining / (leftMs / unit) }
}
