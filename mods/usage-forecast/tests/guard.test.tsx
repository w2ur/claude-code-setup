import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { armedBy, isFanOut } from '../hooks/forecast'
import { gauge } from '../hooks/gauge'

const MIN = 60_000
const HOUR = 60 * MIN

test('armedBy names only the windows past their threshold', async () => {
  expect(armedBy([{ kind: 'five_hour', percent: 84 }, { kind: 'seven_day', percent: 89 }], 0)).toEqual([])
  expect(armedBy([{ kind: 'five_hour', percent: 85 }], 0).map(a => a.why)).toEqual(['5h at 85%'])
  expect(armedBy([{ kind: 'spend_limit', percent: 99 }], 0)).toEqual([])
})

test('a 7d reset reads as days, never as a clock time', async () => {
  const resetsAt = 4 * 24 * HOUR + 2 * HOUR
  expect(armedBy([{ kind: 'seven_day', percent: 91, resetsAt }], 0)[0]?.why).toBe('7d at 91% (resets in 4d2h)')
})

test('a window projected full before reset arms below its threshold', async () => {
  const armed = armedBy([{ kind: 'five_hour', percent: 60, resetsAt: 3 * HOUR, fullAt: 2 * HOUR }], 0)
  expect(armed.map(a => a.why)).toEqual(['5h at 60%, full in 2h00 at this pace (resets in 3h00)'])
})

test('a projection under the floor is noise', async () => {
  expect(armedBy([{ kind: 'five_hour', percent: 50, resetsAt: 3 * HOUR, fullAt: 2 * HOUR }], 0)).toEqual([])
})

// Regression (review 2026-10-28): a 7-day pace from active hours, extrapolated
// over days off, armed the guard on any busy afternoon above 40%.
test('a 7-day projection never arms; its threshold still does', async () => {
  expect(armedBy([{ kind: 'seven_day', percent: 70, resetsAt: 96 * HOUR, fullAt: 37 * HOUR }], 0)).toEqual([])
  expect(armedBy([{ kind: 'seven_day', percent: 90, resetsAt: 96 * HOUR }], 0)).toHaveLength(1)
})

// Regression (review 2026-10-28): a window whose reset had passed kept the
// guard armed until the next response brought a reading.
test('a window past its reset arms nothing', async () => {
  expect(armedBy([{ kind: 'five_hour', percent: 95, resetsAt: HOUR }], 2 * HOUR)).toEqual([])
  expect(armedBy([{ kind: 'five_hour', percent: 95, resetsAt: 3 * HOUR }], 2 * HOUR)).toHaveLength(1)
})

test('isFanOut: every Workflow, and the second Agent of a turn', async () => {
  expect(isFanOut('Workflow', 0)).toBe(true)
  expect(isFanOut('Agent', 1)).toBe(false)
  expect(isFanOut('Agent', 2)).toBe(true)
  expect(isFanOut('Bash', 5)).toBe(false)
})

test('the gauge spans its width, marks the threshold and draws the ghost', async () => {
  const segs = gauge(50, 80, 85, 20)
  const text = segs.map(s => s.text).join('')
  expect(text.length).toBe(20)
  expect(text[17]).toBe('┃')
  expect(text.slice(10, 16)).toBe('▒▒▒▒▒▒')
  expect(text.slice(0, 10)).toBe('██████████')
})

test('a Workflow under the thresholds runs without a question', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] } }))
  let ran = false
  on('tool.call', { tool: 'Workflow' }, () => {
    ran = true
    return { result: 'done', text: 'done' }
  })
  const result = await $.tool.call({ tool: 'Workflow', tool_use_id: 't1', script: 'x' })
  expect(ran).toBe(true)
  expect(result.deny).toBeUndefined()
})

test('a Workflow past 5h 85% is held when the question is dismissed', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 90 }] } }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))
  on('clock.now', () => ({ value: 0 }))
  let ran = false
  on('tool.call', { tool: 'Workflow' }, () => {
    ran = true
    return { result: 'done', text: 'done' }
  })
  const result = await $.tool.call({ tool: 'Workflow', tool_use_id: 't2', script: 'x' })
  expect(ran).toBe(false)
  expect(String(result.deny ?? result.text)).toContain('5h at 90%')
})

test('a Workflow runs when usage cannot be read', async ($, on) => {
  on('session.usage', () => ({ deny: 'no reading' }))
  let ran = false
  on('tool.call', { tool: 'Workflow' }, () => {
    ran = true
    return { result: 'done', text: 'done' }
  })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 't3', script: 'x' })
  expect(ran).toBe(true)
})

const BAND = {
  plugin: 'usage-forecast',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'usage-forecast',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'limits',
  props: { title: 'Limits', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// A measurement reaching the mod, as the engine raises it after a response.
// Stands for the engine's own (empty) band beneath the plugin.
function engineBand(on: On): void {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

async function measure($: Engine, percentUsed: number): Promise<void> {
  await $.session.measure({
    changed: ['rateLimits'],
    rateLimits: [{ kind: 'five_hour', percentUsed }],
  } as never)
}

test('an armed guard shows on the band', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [] }))
  engineBand(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await measure($, 90)

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /GUARD ARMED/ }))?.text).toContain('FAN-OUT GUARD ARMED')
  await ui.unmount()
})

test('a calm window shows the gauge band while the panel is closed', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [] }))
  engineBand(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await measure($, 30)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /GUARD ARMED/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
  await ui.unmount()
})

test('a calm window leaves the band to the open panel', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [{ id: 'limits', title: 'Limits', isShown: false, isFocused: false, isPlaced: true }] }))
  engineBand(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await measure($, 30)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('the panel answer opens, then closes, this tab', async ($, on) => {
  const opens: string[] = []
  const closes: string[] = []
  let text = 'Panel opened.'
  on('command.run', { command: 'panel' }, () => ({ text }))
  on('ui.open', (_, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closes.push(e.id)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

  await $.command.run(commandRun('panel'))
  text = 'Panel closed.'
  await $.command.run(commandRun('panel'))
  expect(opens).toEqual(['limits'])
  expect(closes).toEqual(['limits'])
})

test('the pane draws a gauge per window and the guard state', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [] }))
  engineBand(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await measure($, 30)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /5h window/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /standby/ })).toBeDefined()
  await ui.unmount()
})

function commandRun(command: string, args = '') {
  return {
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  } as Parameters<Engine['command']['run']>[0]
}
