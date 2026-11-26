// Usage Monitor: live Claude plan usage beside the chat.
//
//   • a panel (docked, or a widget in the desktop app) with every limit of
//     the plan, its reset, a pace tick, a projection, the weekly split by
//     product and a 5-hour history;
//   • a one-line band right above the message box;
//   • alerts at the thresholds the person picks;
//   • `/uso` (`/usage-monitor` in English) to open it, refresh or toggle the band.
//
// Surfaces that draw SVG (desktop, mobile, VS Code) get rings, bars and a
// chart from ./svg.ts; the terminal gets the same figures in block glyphs.
// The figures are read in ./data.ts; the pure helpers are in ./lib.ts.

import { atom, read } from 'claude-code'
import type { Elements, Register } from 'claude-code'

import type { UsageSample, UsageSnapshot, UsageWindow } from '../types'
import { hideBand, lastFetchAt, lastRaw, loadHistory, refresh, saveRaw, summary, toggleBand } from './data'
import type { Config } from './data'
import { strings } from './i18n'
import {
  LEVEL_COLOR,
  bar,
  budget,
  elapsedFraction,
  fmtClock,
  fmtDuration,
  fmtPct,
  fmtTokens,
  fmtUsd,
  level,
  pace,
  parseThresholds,
  project,
  sparkline,
  windowLabel,
  windowShort,
} from './lib'
import type { Lang, Pace, Segment } from './lib'
import { HEX, PALETTE, area, meter, ring, stacked } from './svg'

const PANE = 'usage-monitor'

// The same values ./data.ts writes; read here while drawing, which redraws on
// each write. Change a `shape` tag when that value's fields change.
const snapshotAtom = atom({ plugin: 'usage-monitor', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const historyAtom = atom({ plugin: 'usage-monitor', key: 'history' } as const, [], { shape: 'history-1' })
const refreshingAtom = atom({ plugin: 'usage-monitor', key: 'isRefreshing' } as const, false)
const bandHiddenAtom = atom({ plugin: 'usage-monitor', key: 'isBandHidden' } as const, false)

type UI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type RichUI = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>

/** What one drawing of the panel works from. */
type View = {
  cfg: Config
  snap: UsageSnapshot
  history: readonly UsageSample[]
  now: number
  cols: number
  /** The body's width in CSS pixels, on a surface that draws SVG. */
  px: number
  onRefresh: () => unknown
  isRefreshing: boolean
}

/** Desktop cells come to about this many CSS pixels across. */
const PX_PER_COL = 7.6

const MAIN = new Set(['five_hour', 'seven_day'])

export const register: Register = (on, options) => {
  const lang: Lang = options.language === 'en' ? 'en' : 'pt'
  const cfg: Config = {
    lang,
    t: strings(lang),
    refreshMs: Math.max(30, Number(options.refreshSeconds) || 60) * 1000,
    showBand: options.showBand !== false,
    openOnStart: options.openPanelOnStart !== false,
    showStatus: options.showStatusLine === true,
    thresholds: parseThresholds(String(options.alertThresholds ?? '80,95')),
    notifyNative: options.desktopNotifications !== false,
    command: lang === 'pt' ? 'uso' : 'usage-monitor',
  }
  const { t } = cfg

  // ------------------------------------------------------------ lifecycle

  on('session.start', async ($, e, next) => {
    await loadHistory($)
    await $.command.register({ name: cfg.command, description: t.commandDesc, argumentHint: t.commandHint })

    $.clock.every(cfg.refreshMs, () => void refresh($, cfg))
    void refresh($, cfg, true)

    if (cfg.openOnStart && e.surface !== null && e.surface !== 'terminal') {
      void $.ui.open({ id: PANE, title: t.title, placement: 'widget' })
    }

    return next(e)
  })

  // Pushed by the engine after each turn and when a window moves a point.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (now - lastFetchAt() > 15_000) void refresh($, cfg)

    return next(e)
  })

  // ------------------------------------------------------------- command

  on('command.run', { command: cfg.command }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'barra' || arg === 'band') {
      const isHidden = await toggleBand($)

      return { text: isHidden ? t.bandOff : t.bandOn }
    }

    if (arg === 'atualizar' || arg === 'refresh') {
      await refresh($, cfg, true)

      return { text: `${t.refreshed}\n${await summary($, cfg)}` }
    }

    if (arg === 'debug') {
      await refresh($, cfg, true)
      const path = await saveRaw($)
      const snap = await read($, snapshotAtom)
      const raw = lastRaw()

      return {
        text: [
          `source: ${snap?.source ?? 'none'}${snap?.error ? ` (${snap.error})` : ''}`,
          path ? `${t.debugSaved} ${path}` : 'raw: (none)',
          raw ? `raw: ${raw.slice(0, 1500)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }

    await $.ui.open({ id: PANE, title: t.title })

    return { text: `${t.opened}\n${await summary($, cfg)}` }
  })

  // ------------------------------------------------------------- the panel

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const snap = await read($, snapshotAtom)
    const history = await read($, historyAtom)
    const isRefreshing = await read($, refreshingAtom)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns || 40
    const isWidget = e.props.placement === 'widget'

    if (!snap) {
      const { Text } = table

      return <Text dimColor>{t.refreshing}</Text>
    }

    const view: View = {
      cfg,
      snap,
      history,
      now,
      cols,
      px: Math.round(cols * PX_PER_COL),
      onRefresh: () => refresh($, cfg, true),
      isRefreshing,
    }

    if (e.surface !== 'terminal' && 'Svg' in table) return isWidget ? RichGlance(table, view) : RichPane(table, view)

    return isWidget ? TermGlance(table, view) : TermPane(table, view)
  })

  // ------------------------------------------------- the band above the prompt

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.showBand || e.props.hasSurvey) return next(e)
    if (await read($, bandHiddenAtom)) return next(e)
    const snap = await read($, snapshotAtom)
    if (!snap || (snap.windows.length === 0 && snap.context?.percent === undefined)) return next(e)

    const table = $.ui.resolve(e)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns || 80
    const onOpen = () => $.ui.open({ id: PANE, title: t.title })
    const onHide = () => hideBand($)

    if (e.surface !== 'terminal' && 'Svg' in table) return RichBand(table, cfg, snap, now, cols, onOpen, onHide)

    return TermBand(table, cfg, snap, now, cols, onOpen, onHide)
  })
}

// =================================================================== shared

function paceText(cfg: Config, p: Pace | undefined): string | undefined {
  if (p === 'ahead') return cfg.t.paceAhead
  if (p === 'even') return cfg.t.paceEven
  if (p === 'behind') return cfg.t.paceBehind

  return undefined
}

const PACE_COLOR: Record<Pace, string> = { ahead: 'warning', even: 'subtle', behind: 'success' }

function resetParts(cfg: Config, w: UsageWindow, now: number): { left?: string; at?: string } {
  if (!w.resetsAt) return {}
  const reset = Date.parse(w.resetsAt)
  if (!Number.isFinite(reset)) return {}
  const ms = reset - now

  return { left: fmtDuration(ms), at: fmtClock(reset, cfg.lang, ms > 20 * 3_600_000) }
}

/** `~31%/dia`, `~15%/h`, or what is left in all near the end. */
function budgetText(cfg: Config, w: UsageWindow, now: number): string | undefined {
  const b = budget(w, now)
  if (!b) return undefined
  const pct = fmtPct(Math.round(b.amount), cfg.lang)
  if (b.kind === 'day') return `~${pct}${cfg.t.perDay}`
  if (b.kind === 'hour') return `~${pct}${cfg.t.perHour}`

  return cfg.t.restUntil(pct, fmtDuration(b.leftMs))
}

/** When the 5-hour window would reach 100%, by the clock where it is known. */
function projectionText(cfg: Config, proj: { inMs: number }, w: UsageWindow | undefined, now: number): string {
  const reset = w?.resetsAt ? Date.parse(w.resetsAt) : NaN
  const before = Number.isFinite(reset) ? fmtDuration(reset - (now + proj.inMs)) : ''
  const clock = fmtClock(now + proj.inMs, cfg.lang, false)
  if (!before) return `${cfg.t.hitsIn} ~${fmtDuration(proj.inMs)}`

  return clock ? cfg.t.hitsAt(clock, before) : cfg.t.hitsIn2(fmtDuration(proj.inMs), before)
}

/** One plain sentence on the pace of the 5-hour window, else the week's. */
function paceLine(cfg: Config, hero: readonly UsageWindow[], now: number): string | undefined {
  const { t, lang } = cfg
  for (const w of hero) {
    const elapsed = elapsedFraction(w, now)
    const p = pace(w, now)
    if (elapsed === undefined || p === undefined) continue
    const mood = p === 'ahead' ? t.moodAhead : p === 'even' ? t.moodEven : t.moodBehind
    const scope = w.id === 'five_hour' ? t.scopeSession : t.scopeWeek

    return t.paceSentence(fmtPct(w.percent, lang), fmtPct(Math.round(elapsed * 100), lang), scope, mood)
  }

  return undefined
}

/** When the current 5-hour window began. */
function windowStart(w: UsageWindow | undefined): number | undefined {
  if (!w?.resetsAt) return undefined
  const reset = Date.parse(w.resetsAt)

  return Number.isFinite(reset) ? reset - 5 * 3_600_000 : undefined
}

function sourceLine(cfg: Config, snap: UsageSnapshot, now: number): string {
  const { t, lang } = cfg
  const ago = Math.max(0, Math.round((now - snap.fetchedAt) / 1000))
  const when = ago < 60 ? `${ago}s` : fmtDuration(ago * 1000)
  const src = snap.source === 'account' ? t.live : snap.source === 'session' ? t.sessionOnly : t.noData

  return `${src} · ${t.updatedAt} ${lang === 'pt' ? `${t.ago} ${when}` : `${when} ago`}`
}

function notice(cfg: Config, snap: UsageSnapshot): string | undefined {
  const { t } = cfg
  if (snap.error === 'api-key') return t.apiKey
  if (snap.error === 'no-login') return t.noLogin
  if (snap.error && snap.source === 'session') return `${t.fetchFailed} (${snap.error}) · ${t.usingSession}`
  if (snap.error && snap.source === 'account') return `${t.fetchFailed} (${snap.error}) · ${t.usingCached}`
  if (snap.error) return `${t.fetchFailed} (${snap.error})`
  if (snap.windows.length === 0) return t.waitingFirst

  return undefined
}

/** Whether the readings span enough of the last five hours to chart. */
function hasChart(history: readonly UsageSample[], now: number): boolean {
  const recent = history.filter(s => now - s.t <= 5 * 3_600_000)
  const first = recent[0]

  return recent.length >= 2 && first !== undefined && now - first.t >= 15 * 60_000
}

// ============================================================= SVG surfaces

function RichPane(ui: RichUI, v: View) {
  const { Box, Text, Button, Svg } = ui
  const { cfg, snap, now, px } = v
  const { t, lang } = cfg
  const note = notice(cfg, snap)
  const hero = snap.windows.filter(w => MAIN.has(w.id))
  const others = snap.windows.filter(w => !MAIN.has(w.id))
  const five = snap.windows.find(w => w.id === 'five_hour')
  const proj = five ? project(five, v.history, now) : undefined
  const isWide = v.cols >= 66
  const ctx = snap.context
  const products = (snap.breakdown ?? []).filter(r => r.share > 0)
  const isLive = snap.source === 'account' && !v.isRefreshing

  return (
    <Box flexDirection="column" gap={2} paddingX={1}>
      {/* status */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text size="footnote">
          <Text color={isLive ? 'success' : 'warning'}>● </Text>
          <Text dimColor>{v.isRefreshing ? t.refreshing : sourceLine(cfg, snap, now)}</Text>
        </Text>
        <Button key="refresh" label={`↻ ${t.refresh}`} plain onPress={v.onRefresh} />
      </Box>

      {note && (
        <Text color={snap.error && snap.source !== 'account' ? 'warning' : 'subtle'} size="footnote">
          {note}
        </Text>
      )}

      {/* the two limits that matter most */}
      {hero.length > 0 && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection={isWide ? 'row' : 'column'} gap={1}>
            {hero.map(w => Gauge(ui, cfg, w, now, isWide))}
          </Box>
          {proj?.kind === 'hits' && (
            <Box borderStyle="round" borderColor="warning" paddingX={2} paddingY={1} flexDirection="column">
              <Text color="warning" weight="semibold" size="footnote">
                ⚠ {t.hitsTitle}
              </Text>
              <Text size="footnote">{projectionText(cfg, proj, five, now)}</Text>
            </Box>
          )}
          {proj?.kind === 'safe' && five && five.percent >= 50 && (
            <Text color="success" size="footnote">
              ✓ {t.safe}
            </Text>
          )}
          {paceLine(cfg, hero, now) && (
            <Text dimColor size="footnote">
              {paceLine(cfg, hero, now)}
            </Text>
          )}
        </Box>
      )}

      {/* Sonnet, Opus and any limit added later */}
      {others.length > 0 && (
        <Box flexDirection="column" gap={1}>
          {SectionTitle(ui, t.otherLimits)}
          {others.map(w => {
            const color = HEX[level(w.percent)]
            const { left } = resetParts(cfg, w, now)

            return (
              <Box flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  <Text weight="medium">{windowLabel(w.id, lang)}</Text>
                  <Text>
                    {left ? (
                      <Text dimColor size="footnote">
                        {t.resetsIn} {left}
                        {'   '}
                      </Text>
                    ) : (
                      ''
                    )}
                    <Text color={LEVEL_COLOR[level(w.percent)]} weight="semibold" tabular>
                      {fmtPct(w.percent, lang)}
                    </Text>
                  </Text>
                </Box>
                <Svg source={meter(w.percent, color, px - 16, 8, elapsedFraction(w, now))} alt={`${windowLabel(w.id, lang)} ${fmtPct(w.percent, lang)}`} />
              </Box>
            )
          })}
        </Box>
      )}

      {/* the week, product by product */}
      {products.length > 0 && (
        <Box flexDirection="column" gap={1}>
          {SectionTitle(ui, t.breakdown)}
          <Svg
            source={stacked(
              products.map((r, i) => ({ share: r.share, color: PALETTE[i % PALETTE.length]! })),
              px - 16,
              10,
            )}
            alt={products.map(r => `${r.label} ${fmtPct(r.share, lang)}`).join(', ')}
          />
          <Box flexDirection="column">
            {products.map((r, i) => (
              <Box flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text color={PALETTE[i % PALETTE.length]}>● </Text>
                  <Text>{r.label}</Text>
                </Text>
                <Text>
                  <Text weight="semibold" tabular>
                    {fmtPct(r.share, lang)}
                  </Text>
                  <Text dimColor size="footnote">
                    {'  '}
                    {fmtPct(r.ofLimit, lang)} {t.ofLimit}
                  </Text>
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* the last five hours */}
      <Box flexDirection="column" gap={1}>
        {SectionTitle(ui, t.history)}
        {hasChart(v.history, now) ? (
          <Box flexDirection="column">
            <Svg source={area(v.history, now, px - 16, 72, windowStart(five))} alt={t.history} />
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor size="caption">
                {t.hoursAgo}
              </Text>
              <Text dimColor size="caption">
                {t.now}
              </Text>
            </Box>
          </Box>
        ) : (
          <Text dimColor size="footnote">
            {t.collecting}
          </Text>
        )}
      </Box>

      {/* this conversation */}
      {(ctx?.percent !== undefined || snap.costUsd !== undefined) && (
        <Box flexDirection="column" gap={1}>
          {SectionTitle(ui, t.thisChat)}
          {ctx && ctx.percent !== undefined && (
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text weight="medium">{t.context}</Text>
                <Text>
                  <Text dimColor size="footnote">
                    {fmtTokens(ctx.tokens ?? 0)} / {fmtTokens(ctx.window)} {t.tokens}
                    {'   '}
                  </Text>
                  <Text color={LEVEL_COLOR[level(ctx.percent)]} weight="semibold" tabular>
                    {fmtPct(ctx.percent, lang)}
                  </Text>
                </Text>
              </Box>
              <Svg source={meter(ctx.percent, HEX[level(ctx.percent)], px - 16, 8)} alt={`${t.context} ${fmtPct(ctx.percent, lang)}`} />
            </Box>
          )}
          {snap.costUsd !== undefined && (
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text weight="medium">{t.cost}</Text>
                <Text weight="semibold" tabular>
                  {fmtUsd(snap.costUsd, lang)}
                </Text>
              </Box>
              <Text dimColor size="caption">
                {t.costNote}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {snap.extra?.isEnabled && snap.extra.percent !== undefined && (
        <Box flexDirection="column" gap={1}>
          {SectionTitle(ui, t.extra)}
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{t.extraOn}</Text>
            <Text color={LEVEL_COLOR[level(snap.extra.percent)]} weight="semibold" tabular>
              {fmtPct(snap.extra.percent, lang)}
            </Text>
          </Box>
          <Svg source={meter(snap.extra.percent, HEX[level(snap.extra.percent)], px - 16, 8)} alt={t.extra} />
        </Box>
      )}
    </Box>
  )
}

function SectionTitle(ui: RichUI, text: string) {
  const { Text } = ui

  return (
    <Text dimColor weight="semibold" size="caption">
      {text.toUpperCase()}
    </Text>
  )
}

/** A card: the ring, then what the window is, when it resets and the pace. */
function Gauge(ui: RichUI, cfg: Config, w: UsageWindow, now: number, isWide: boolean) {
  const { Box, Text, Svg } = ui
  const { t, lang } = cfg
  const lvl = level(w.percent)
  const elapsed = elapsedFraction(w, now)
  const p = pace(w, now)
  const { left, at } = resetParts(cfg, w, now)
  const isSession = w.id === 'five_hour'
  const title = isSession ? t.sessionShort : t.weekShort
  const sub = isSession ? t.sessionSub : t.weekSub
  const size = 84

  return (
    <Box
      flexDirection="row"
      alignItems="center"
      gap={2}
      flexGrow={isWide ? 1 : 0}
      borderStyle="round"
      borderColor="subtle"
      paddingX={2}
      paddingY={1}
    >
      <Svg
        source={ring(w.percent, HEX[lvl], fmtPct(w.percent, lang), size, elapsed)}
        alt={`${title} ${fmtPct(w.percent, lang)}`}
        width={size}
        height={size}
      />
      <Box flexDirection="column">
        <Text weight="semibold">{title}</Text>
        <Text dimColor size="caption">
          {sub}
        </Text>
        {left && (
          <Text size="footnote">
            {t.resetsIn} <Text weight="semibold">{left}</Text>
          </Text>
        )}
        {at && (
          <Text dimColor size="caption">
            {t.resetsAt} {at}
          </Text>
        )}
        {budgetText(cfg, w, now) && (
          <Text size="caption">
            <Text dimColor>{t.available} </Text>
            <Text weight="semibold">{budgetText(cfg, w, now)}</Text>
          </Text>
        )}
        {p && (
          <Text color={PACE_COLOR[p]} size="caption" weight="medium">
            ● {paceText(cfg, p)}
          </Text>
        )}
      </Box>
    </Box>
  )
}

/** The desktop's minimized widget: two small rings and the time left. */
function RichGlance(ui: RichUI, v: View) {
  const { Box, Text, Svg } = ui
  const { cfg, snap, now } = v
  const { t, lang } = cfg
  const hero = snap.windows.filter(w => MAIN.has(w.id))
  if (hero.length === 0) {
    return (
      <Text dimColor size="footnote">
        {notice(cfg, snap) ?? t.noData}
      </Text>
    )
  }

  return (
    <Box flexDirection="row" gap={3} alignItems="center">
      {hero.map(w => {
        const { left } = resetParts(cfg, w, now)

        return (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Svg
              source={ring(w.percent, HEX[level(w.percent)], fmtPct(w.percent, lang), 44, elapsedFraction(w, now))}
              alt={`${windowShort(w.id)} ${fmtPct(w.percent, lang)}`}
              width={44}
              height={44}
            />
            <Box flexDirection="column">
              <Text weight="semibold" size="footnote">
                {w.id === 'five_hour' ? t.sessionShort : t.weekShort}
              </Text>
              {left && (
                <Text dimColor size="caption">
                  ↻ {left}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function RichBand(
  ui: RichUI,
  cfg: Config,
  snap: UsageSnapshot,
  now: number,
  cols: number,
  onOpen: () => unknown,
  onHide: () => unknown,
) {
  const { Box, Text, Button, Svg } = ui
  const { t, lang } = cfg
  const five = snap.windows.find(w => w.id === 'five_hour')
  const week = snap.windows.find(w => w.id === 'seven_day')
  const isNarrow = cols < 80
  const ctx = snap.context?.percent

  const item = (w: UsageWindow, label: string, barPx: number, withReset: boolean) => {
    const { left } = resetParts(cfg, w, now)

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text dimColor size="footnote">
          {label}
        </Text>
        <Svg source={meter(w.percent, HEX[level(w.percent)], barPx, 6, elapsedFraction(w, now))} alt={`${label} ${fmtPct(w.percent, lang)}`} />
        <Text color={LEVEL_COLOR[level(w.percent)]} weight="semibold" size="footnote" tabular>
          {fmtPct(w.percent, lang)}
        </Text>
        {withReset && left && (
          <Text dimColor size="caption">
            ↻ {left}
          </Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={2} alignItems="center">
      <Text color="claude" weight="bold">
        ◆
      </Text>
      {five && item(five, t.sessionShort, isNarrow ? 40 : 64, true)}
      {week && item(week, t.weekShort, isNarrow ? 32 : 48, !isNarrow)}
      {ctx !== undefined && !isNarrow && (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor size="footnote">
            {t.context}
          </Text>
          <Text color={LEVEL_COLOR[level(ctx)]} weight="semibold" size="footnote" tabular>
            {fmtPct(ctx, lang)}
          </Text>
        </Box>
      )}
      {snap.source === 'session' && (
        <Text color="warning" size="caption">
          ●
        </Text>
      )}
      <Button key="open" label={t.panel} plain onPress={onOpen} />
      <Button key="hide" label="×" plain role="dismiss" onPress={onHide} />
    </Box>
  )
}

// ================================================================= terminal

function Bar(ui: UI, segs: Segment[], color: string) {
  const { Text } = ui

  return (
    <Text>
      {segs.map(s =>
        s.kind === 'fill' ? (
          <Text color={color}>{s.text}</Text>
        ) : s.kind === 'mark' ? (
          <Text color="text" weight="bold">
            {s.text}
          </Text>
        ) : (
          <Text dimColor>{s.text}</Text>
        ),
      )}
    </Text>
  )
}

function TermPane(ui: UI, v: View) {
  const { Box, Text, Button } = ui
  const { cfg, snap, now, history } = v
  const { t, lang } = cfg
  const width = Math.max(14, Math.min(v.cols - 2, 44))
  const note = notice(cfg, snap)
  const ctx = snap.context
  const products = (snap.breakdown ?? []).filter(r => r.share > 0)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>{v.isRefreshing ? t.refreshing : sourceLine(cfg, snap, now)}</Text>
        <Button key="refresh" label={t.refresh} plain onPress={v.onRefresh} />
      </Box>
      {note && <Text color="warning">{note}</Text>}
      {snap.windows.map(w => TermWindow(ui, cfg, w, now, width, history))}
      {products.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor bold>
            {t.breakdown.toUpperCase()}
          </Text>
          {products.map(r => (
            <Text>
              {r.label.padEnd(14).slice(0, 14)} <Text bold>{fmtPct(r.share, lang).padStart(4)}</Text>
              <Text dimColor>
                {' '}
                · {fmtPct(r.ofLimit, lang)} {t.ofLimit}
              </Text>
            </Text>
          ))}
        </Box>
      )}
      {hasChart(history, now) && (
        <Box flexDirection="column">
          <Text dimColor bold>
            {t.history.toUpperCase()}
          </Text>
          <Text color="claude">{sparkline(history, now, width)}</Text>
        </Box>
      )}
      {ctx && ctx.percent !== undefined && (
        <Box flexDirection="column">
          <Text>
            <Text bold>{t.context}</Text>
            <Text dimColor>
              {' '}
              {fmtTokens(ctx.tokens ?? 0)}/{fmtTokens(ctx.window)}{' '}
            </Text>
            <Text color={LEVEL_COLOR[level(ctx.percent)]} bold>
              {fmtPct(ctx.percent, lang)}
            </Text>
          </Text>
          {Bar(ui, bar(ctx.percent, width), LEVEL_COLOR[level(ctx.percent)])}
        </Box>
      )}
      {snap.costUsd !== undefined && (
        <Text>
          <Text bold>{t.cost}</Text>
          <Text dimColor> ({t.estimate}) </Text>
          {fmtUsd(snap.costUsd, lang)}
        </Text>
      )}
    </Box>
  )
}

function TermWindow(ui: UI, cfg: Config, w: UsageWindow, now: number, width: number, history: readonly UsageSample[]) {
  const { Box, Text } = ui
  const { t, lang } = cfg
  const color = LEVEL_COLOR[level(w.percent)]
  const label = windowLabel(w.id, lang)
  const pct = fmtPct(w.percent, lang)
  const { left, at } = resetParts(cfg, w, now)
  const paceLabel = paceText(cfg, pace(w, now))
  const proj = w.id === 'five_hour' ? project(w, history, now) : undefined
  const line = [left ? `${t.resetsIn} ${left}${at ? ` (${t.resetsAt} ${at})` : ''}` : '', paceLabel ?? ''].filter(Boolean).join(' · ')

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{label}</Text>
        {' '.repeat(Math.max(1, width - label.length - pct.length))}
        <Text color={color} bold>
          {pct}
        </Text>
      </Text>
      {Bar(ui, bar(w.percent, width, elapsedFraction(w, now)), color)}
      {line && <Text dimColor>{line}</Text>}
      {proj?.kind === 'hits' && (
        <Text color="warning">
          ⚠ {projectionText(cfg, proj, w, now)}
        </Text>
      )}
    </Box>
  )
}

function TermGlance(ui: UI, v: View) {
  const { Text } = ui
  const { cfg, snap, now } = v
  const parts = snap.windows
    .filter(w => MAIN.has(w.id))
    .map(w => `${windowShort(w.id)} ${fmtPct(w.percent, cfg.lang)}`)

  return <Text>{parts.length > 0 ? parts.join(' · ') : (notice(cfg, snap) ?? cfg.t.noData)}</Text>
}

function TermBand(
  ui: UI,
  cfg: Config,
  snap: UsageSnapshot,
  now: number,
  cols: number,
  onOpen: () => unknown,
  onHide: () => unknown,
) {
  const { Box, Text, Button } = ui
  const { t, lang } = cfg
  const isNarrow = cols < 72
  const shown = snap.windows.filter(w => MAIN.has(w.id))

  return (
    <Box flexDirection="row" gap={1}>
      <Text color="claude" bold>
        ◆
      </Text>
      {shown.map((w, i) => {
        const color = LEVEL_COLOR[level(w.percent)]
        const { left } = resetParts(cfg, w, now)

        return (
          <Text>
            {i > 0 ? <Text dimColor>│ </Text> : ''}
            <Text dimColor>{w.id === 'five_hour' ? t.sessionShort : t.weekShort} </Text>
            {i === 0 ? Bar(ui, bar(w.percent, isNarrow ? 6 : 10, elapsedFraction(w, now)), color) : ''}
            <Text color={color} bold>
              {i === 0 ? ' ' : ''}
              {fmtPct(w.percent, lang)}
            </Text>
            {i === 0 && left ? <Text dimColor> ↻ {left}</Text> : ''}
          </Text>
        )
      })}
      {!isNarrow && snap.context?.percent !== undefined && (
        <Text>
          <Text dimColor>│ {t.ctxShort} </Text>
          <Text color={LEVEL_COLOR[level(snap.context.percent)]}>{fmtPct(snap.context.percent, lang)}</Text>
        </Text>
      )}
      <Button key="open" label={t.panel} plain onPress={onOpen} />
      <Button key="hide" label="×" plain onPress={onHide} />
    </Box>
  )
}
