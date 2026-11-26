// SVG drawings for the surfaces that draw them (desktop, mobile, VS Code).
// Pure strings. The colors are mid-tone and the tracks translucent, so every
// drawing reads on a dark theme and a light one alike; words stay in `Text`
// elements, which follow the person's theme.

import type { UsageSample } from '../types'
import { HOUR } from './lib'
import type { Level } from './lib'

export const HEX: Record<Level | 'claude' | 'muted', string> = {
  ok: '#3FB27F',
  warn: '#E0A43B',
  high: '#E5534B',
  claude: '#D97757',
  muted: '#8B8F96',
}

/** Product colors for the weekly split, in order of use. */
export const PALETTE = ['#D97757', '#6A9BCC', '#7FB069', '#A78BDB', '#E0A43B', '#8B8F96']

/** Room at the left of the chart for the 50% and 100% labels. */
const AXIS = 30

const TRACK = 'rgba(140,140,150,0.22)'
const FONT = "font-family='-apple-system,Segoe UI,system-ui,sans-serif'"

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;')
}

function n(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/**
 * A ring gauge: the used share as an arc from the top, the figure in the
 * middle, and a tick where the window's elapsed time stands.
 */
export function ring(percent: number, color: string, label: string, size: number, elapsed?: number): string {
  const stroke = Math.max(5, Math.round(size * 0.1))
  const r = (size - stroke) / 2 - 1
  const c = size / 2
  const circ = 2 * Math.PI * r
  const used = Math.min(1, Math.max(0, percent / 100))
  const dash = `${n(circ * used)} ${n(circ)}`
  let tick = ''
  if (elapsed !== undefined) {
    const a = elapsed * 2 * Math.PI - Math.PI / 2
    const r1 = r - stroke / 2 - 2
    const r2 = r + stroke / 2 + 2
    tick =
      `<line x1='${n(c + r1 * Math.cos(a))}' y1='${n(c + r1 * Math.sin(a))}' x2='${n(c + r2 * Math.cos(a))}' y2='${n(c + r2 * Math.sin(a))}' ` +
      `stroke='${HEX.muted}' stroke-width='2.5' stroke-linecap='round'/>`
  }
  const fs = Math.round(size * (label.length > 3 ? 0.24 : 0.28))

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>` +
    `<circle cx='${c}' cy='${c}' r='${n(r)}' fill='none' stroke='${TRACK}' stroke-width='${stroke}'/>` +
    (used > 0
      ? `<circle cx='${c}' cy='${c}' r='${n(r)}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round' ` +
        `stroke-dasharray='${dash}' transform='rotate(-90 ${c} ${c})'/>`
      : '') +
    tick +
    `<text x='${c}' y='${c}' text-anchor='middle' dominant-baseline='central' ${FONT} font-size='${fs}' font-weight='650' fill='${color}'>${esc(label)}</text>` +
    `</svg>`
  )
}

/** A rounded bar, with an optional tick for the elapsed share of the window. */
export function meter(percent: number, color: string, width: number, height = 8, elapsed?: number): string {
  const w = Math.max(20, Math.round(width))
  const h = height
  const rx = h / 2
  const fill = Math.min(w, Math.max(0, (percent / 100) * w))
  const tickX = elapsed === undefined ? undefined : Math.min(w - 1.5, Math.max(1.5, elapsed * w))
  const pad = tickX === undefined ? 0 : 3

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h + pad * 2}' viewBox='0 0 ${w} ${h + pad * 2}'>` +
    `<rect x='0' y='${pad}' width='${w}' height='${h}' rx='${rx}' fill='${TRACK}'/>` +
    (fill > 0 ? `<rect x='0' y='${pad}' width='${n(Math.max(fill, h))}' height='${h}' rx='${rx}' fill='${color}'/>` : '') +
    (tickX === undefined
      ? ''
      : `<line x1='${n(tickX)}' y1='0' x2='${n(tickX)}' y2='${h + pad * 2}' stroke='${HEX.muted}' stroke-width='2' stroke-linecap='round'/>`) +
    `</svg>`
  )
}

/** One bar split into colored parts, each a share of the whole. */
export function stacked(parts: readonly { share: number; color: string }[], width: number, height = 10): string {
  const w = Math.max(40, Math.round(width))
  const h = height
  const total = parts.reduce((s, p) => s + p.share, 0) || 1
  const gap = 2
  let x = 0
  let rects = ''
  const shown = parts.filter(p => p.share > 0)
  shown.forEach((p, i) => {
    const pw = (p.share / total) * (w - gap * (shown.length - 1))
    rects += `<rect x='${n(x)}' y='0' width='${n(Math.max(pw, 2))}' height='${h}' fill='${p.color}'/>`
    x += pw + (i < shown.length - 1 ? gap : 0)
  })

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>` +
    `<defs><clipPath id='c'><rect width='${w}' height='${h}' rx='${h / 2}'/></clipPath></defs>` +
    `<g clip-path='url(#c)'><rect width='${w}' height='${h}' fill='${TRACK}'/>${rects}</g>` +
    `</svg>`
  )
}

/**
 * The 5-hour window over the last five hours: an area under the line, faint
 * guides at 50% and 100%, and a dot at the latest reading.
 */
export function area(
  samples: readonly UsageSample[],
  now: number,
  width: number,
  height = 56,
  windowStart?: number,
): string {
  const w = Math.max(80, Math.round(width))
  const h = height
  const top = 4
  const bottom = h - 2
  const start = now - 5 * HOUR
  const pts = samples
    .filter(s => s.t >= start && s.t <= now)
    .sort((a, b) => a.t - b.t)
    .map(s => ({ x: AXIS + ((s.t - start) / (5 * HOUR)) * (w - AXIS), y: bottom - (Math.min(100, s.p) / 100) * (bottom - top) }))
  const last = pts[pts.length - 1]
  const first = pts[0]
  if (!last || !first) return ''
  // Hold the latest reading up to now.
  pts.push({ x: w, y: last.y })
  // Steps, not slopes: a reading stands until the next one.
  let line = `M${n(first.x)},${n(first.y)}`
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!
    const prev = pts[i - 1]!
    line += ` L${n(p.x)},${n(prev.y)} L${n(p.x)},${n(p.y)}`
  }
  const fillPath = `${line} L${n(w)},${bottom} L${n(first.x)},${bottom} Z`
  const guide = (pct: number) => {
    const y = bottom - (pct / 100) * (bottom - top)

    return (
      `<line x1='${AXIS}' y1='${n(y)}' x2='${w}' y2='${n(y)}' stroke='${TRACK}' stroke-width='1' stroke-dasharray='3 4'/>` +
      `<text x='0' y='${n(y)}' dominant-baseline='central' ${FONT} font-size='9' fill='${HEX.muted}'>${pct}%</text>`
    )
  }
  // Where the current 5-hour window began, when that is inside the chart.
  let startMark = ''
  if (windowStart !== undefined && windowStart > start && windowStart < now) {
    const x = AXIS + ((windowStart - start) / (5 * HOUR)) * (w - AXIS)
    startMark =
      `<line x1='${n(x)}' y1='${top}' x2='${n(x)}' y2='${bottom}' stroke='${HEX.muted}' stroke-width='1' stroke-dasharray='2 3' opacity='0.7'/>` +
      `<text x='${n(x + 3)}' y='${top + 6}' ${FONT} font-size='9' fill='${HEX.muted}'>↻</text>`
  }

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>` +
    `<stop offset='0' stop-color='${HEX.claude}' stop-opacity='0.35'/><stop offset='1' stop-color='${HEX.claude}' stop-opacity='0.02'/>` +
    `</linearGradient></defs>` +
    guide(100) +
    guide(50) +
    startMark +
    `<line x1='${AXIS}' y1='${bottom}' x2='${w}' y2='${bottom}' stroke='${TRACK}' stroke-width='1'/>` +
    `<path d='${fillPath}' fill='url(#g)'/>` +
    `<path d='${line}' fill='none' stroke='${HEX.claude}' stroke-width='2' stroke-linejoin='round'/>` +
    `<circle cx='${n(w - 3)}' cy='${n(last.y)}' r='3' fill='${HEX.claude}'/>` +
    `</svg>`
  )
}
