import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clock } from '../hooks/forecast'
import { dateOf, fullWhen } from '../hooks/race'

const HOUR = 3_600_000

const PANE = {
  plugin: 'usage-forecast',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'limits',
  props: { title: 'Limits', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BAND = {
  plugin: 'usage-forecast',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function engineBand(on: On): void {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

// The test engine has no store of its own: a Map answers the mod's store calls.
function store(on: On): void {
  const held = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, e.value)
    return { value: undefined }
  })
}

async function measure($: Engine, percentUsed: number, resetsAt: number): Promise<void> {
  await $.session.measure({
    changed: ['rateLimits'],
    rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: new Date(resetsAt).toISOString() }],
  } as never)
}

test('the pane draws the race scene for a window with a reset time', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [] }))
  engineBand(on)
  store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await measure($, 30, 1.7 * HOUR)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /── 5-hour window ── resets in 1 h 42 ──/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /even pace would be at 66%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pace: measuring/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h window/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /standby/ })).toBeDefined()
  await ui.unmount()
})

test('a pane narrower than 30 columns keeps the plain gauge', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [] }))
  engineBand(on)
  store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await measure($, 30, 1.7 * HOUR)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 28 } })
  expect(await ui.find({ type: 'Text', text: /5h window/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5-hour window/ })).toBeUndefined()
  await ui.unmount()
})

// Regression: fix/mods-review-2026-11-04 — `isGliding` was cleared only inside the
// pane's render, so a pane hidden or closed mid-glide kept the frame timer busy.
test('a pane hidden mid-glide lands the glide and the frame timer rests', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let isShown = true
  let panesAsked = 0
  on('ui.panes', () => {
    panesAsked += 1

    return { value: isShown ? [{ id: 'limits', title: 'Limits', isShown: true, isFocused: false, isPlaced: true }] : [] }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  engineBand(on)
  store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 80, 4 * HOUR)
  // One draw from empty starts the glide toward 80%.
  const ui = await $.ui.mount(PANE)
  await ui.unmount()
  isShown = false
  await clock.advance(125 * 3)
  const asked = panesAsked
  await clock.advance(125 * 40)
  expect(panesAsked).toBe(asked)
})

// Regression: fix/mods-review-2026-11-04 — the 7-day band read `full ~HH:MM` from the
// burn rate, as if today, against the race scene's average pace.
test('the 7-day full time names the day and agrees with the race scene', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [] }))
  engineBand(on)
  store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // Half the week gone at 80%: the average pace fills the window 21 h from now.
  const fullAt = 21 * HOUR
  await $.session.measure({
    changed: ['rateLimits'],
    rateLimits: [{ kind: 'seven_day', percentUsed: 80, resetsAt: new Date(3.5 * 24 * HOUR).toISOString() }],
  } as never)
  const expected = fullWhen('seven_day', fullAt)
  expect(expected).toBe(`on ${dateOf(fullAt)} at ~${clock(fullAt)}`)

  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: ` full ${expected}` })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: new RegExp(`on ${dateOf(fullAt)} around ${clock(fullAt)}`) })).toBeDefined()
  await pane.unmount()
})

test('the 5-hour full time stays a bare clock time', async () => {
  expect(fullWhen('five_hour', 21 * HOUR)).toBe(`~${clock(21 * HOUR)}`)
})

// Regression: fix/mods-review-2026-11-04 — the 7-day "≈N% at reset" came from the burn rate while its full time came from the average pace.
test('the 7-day landing follows the average pace, like its full time', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.panes', () => ({ value: [] }))
  engineBand(on)
  store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // Half the week gone at 40%: the average pace lands at 80%, a single reading has no burn rate.
  await $.session.measure({
    changed: ['rateLimits'],
    rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(3.5 * 24 * HOUR).toISOString() }],
  } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 28 } })
  expect(await ui.find({ type: 'Text', text: /≈80% at reset/ })).toBeDefined()
  await ui.unmount()
})
