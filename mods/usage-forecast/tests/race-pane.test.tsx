import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOUR = 3_600_000

const PANE = {
  plugin: 'usage-forecast',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'limits',
  props: { title: 'Limits', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
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
