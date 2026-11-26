import { expect, test } from 'claude-code/testing'

import { bar, budget, fmtDuration, fmtPct, parseAccountUsage, project, sparkline } from '../hooks/lib'

const NOW = Date.parse('2026-11-26T15:00:00Z')
const IN_2H = new Date(NOW + 2 * 3_600_000 + 14 * 60_000).toISOString()
const IN_3D = new Date(NOW + 3 * 86_400_000 + 4 * 3_600_000).toISOString()

const ACCOUNT_BODY = JSON.stringify({
  five_hour: { utilization: 42, resets_at: IN_2H },
  seven_day: { utilization: 18.5, resets_at: IN_3D },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 7, resets_at: IN_3D },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  seven_day_breakdown: {
    rows: [
      { key: 'claude_code', display_name: 'Claude Code', percent: 99, percent_of_limit: 65 },
      { key: 'chat', display_name: 'Chats', percent: 0, percent_of_limit: 0 },
      { key: 'cowork', display_name: 'Cowork', percent: 1, percent_of_limit: 0 },
    ],
  },
})

const SESSION_USAGE = {
  startedAt: NOW - 600_000,
  context: { tokens: 72_000, window: 200_000, percent: 36 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: IN_2H }],
  cost: { usd: 1.84 },
}

const PANE = {
  plugin: 'usage-monitor',
  component: 'Pane',
  requestId: 'usage-monitor',
  props: {
    title: 'Uso do Claude',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'usage-monitor',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

type On = Parameters<Parameters<typeof test>[1]>[1]

function engine(on: On, fetch: { status: number; text: string }) {
  on('command.register', () => ({ value: { command: 'uso' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('session.usage', () => ({ value: SESSION_USAGE }))
  on('session.authorize', () => ({ value: { handle: 'h-1', kind: 'bearer' } }))
  on('clock.every', () => ({ value: undefined }))
  // What the engine draws where the mod draws nothing.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('http.fetch', () => ({
    value: { status: fetch.status, ok: fetch.status >= 200 && fetch.status < 300, headers: {}, text: fetch.text },
  }))
}

test('the panel shows the account windows, on every surface', async ($, on) => {
  engine(on, { status: 200, text: ACCOUNT_BODY })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'uso', args: 'atualizar' })

  // The SVG surfaces: rings for the two main limits, cards, a split bar.
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 }, surface })
    expect((await ui.find({ type: 'Svg', alt: /Sessão 42%/ }))?.type).toBe('Svg')
    expect(await ui.find({ type: 'Svg', alt: /Semana 19%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2h 14m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Semana · Sonnet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /conta · ao vivo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /US\$ 1,84/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude Code$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Chats/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Uso extra/ })).toBeUndefined()
    await ui.unmount()
  }

  // The terminal: the same figures in glyphs.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /Sessão atual/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /reinicia em 2h 14m/ })).toBeDefined()
  expect((await term.find({ type: 'Text', text: /Claude Code/ }))?.text).toContain('99%')
  await term.unmount()
})

test('the band sums it up above the prompt', async ($, on) => {
  engine(on, { status: 200, text: ACCOUNT_BODY })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'uso', args: 'atualizar' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
    await ui.press({ key: 'hide' })
    await ui.unmount()
    const hidden = await $.ui.mount({ ...BAND, surface })
    expect(await hidden.find({ type: 'Text', text: /42%/ })).toBeUndefined()
    await hidden.unmount()
    await $.command.run({ command: 'uso', args: 'barra' })
  }
})

test('without the account endpoint it falls back to this session', async ($, on) => {
  engine(on, { status: 401, text: '{}' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'uso', args: 'atualizar' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg', alt: /Sessão 40%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /HTTP 401/ })).toBeDefined()
  await ui.unmount()
})

test('the helpers', () => {
  const parsed = parseAccountUsage(JSON.parse(ACCOUNT_BODY))
  expect(parsed.windows.map(w => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day_sonnet'])
  expect(parsed.extra?.isEnabled).toBe(false)

  expect(fmtDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m')
  expect(fmtDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h')
  expect(fmtPct(18.5, 'pt')).toBe('19%')
  expect(fmtPct(7.5, 'pt')).toBe('7,5%')

  const cells = bar(50, 10, 0.2)
    .map(s => s.text)
    .join('')
  expect(cells).toBe('██┃██░░░░░')

  const w = { id: 'five_hour', percent: 60, resetsAt: IN_2H }
  const samples = [{ t: NOW - 40 * 60_000, p: 30, r: IN_2H }]
  const p = project(w, samples, NOW)
  expect(p?.kind).toBe('hits')

  // 34% left over 3 days 4 hours: about 10.7% a day.
  const week = budget({ id: 'seven_day', percent: 66, resetsAt: IN_3D }, NOW)
  expect(week?.kind).toBe('day')
  expect(Math.round(week?.amount ?? 0)).toBe(11)
  // 58% left over 2h 14m: about 26% an hour.
  expect(budget({ id: 'five_hour', percent: 42, resetsAt: IN_2H }, NOW)?.kind).toBe('hour')
  // Under a day left in the week: what is left in all.
  const soon = new Date(NOW + 5 * 3_600_000).toISOString()
  expect(budget({ id: 'seven_day', percent: 66, resetsAt: soon }, NOW)?.kind).toBe('rest')

  expect(sparkline([{ t: NOW - 60_000, p: 100 }], NOW, 10).trim()).toBe('█')
})
