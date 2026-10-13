import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Fleet } from '../types'
import { FLEET_SHAPE, RUN_END_GRACE_MS, emptyFleet } from '../hooks/fleet'

// The mod's state belongs to the mod: a hook of the test cannot read it, so
// these tests drive the hooks through the engine and read what the band draws.

const SCRIPT = `export const meta = { name: 'probe-run', description: 'x', phases: [{ title: 'Alpha' }, { title: 'Beta' }] }
phase('Alpha')
await agent('say ALPHA', { label: 'probe:alpha' })
`

const BAND = {
  plugin: 'agent-fleet',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'agent-fleet',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'fleet',
  props: {
    title: 'Fleet',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Set by world(): puts the surface beneath back to "no pane placed".
let hidePane: () => void = () => undefined

// What the surface beneath the plugin was asked to do, in order.
type Shell = { opens: string[]; closes: string[]; toasts: string[]; clock: ReturnType<typeof mock.clock> }

// What sits beneath the plugin in a real session: a clock, a cost ledger, a
// surface that places panes and shows toasts, the engine's own (empty) drawing.
// The upkeep tick is registered by session.start (a test that needs it calls
// `startSession`): it alone ends a run, the events set no timer of their own.
function world(on: On, options: { isPlaced?: boolean } = {}): Shell {
  on('command.register', () => ({ value: { command: 'fleet' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: 1_000_000 })
  const shell: Shell = { opens: [], closes: [], toasts: [], clock }
  let isUp = false
  hidePane = () => {
    isUp = false
  }
  on('ui.panes', () => ({
    value: isUp ? [{ id: 'fleet', title: 'Fleet', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', (_, e) => {
    shell.opens.push(e.id)
    isUp = true

    return options.isPlaced === false
      ? { value: { isPlaced: false as const, reason: 'terminal too narrow' } }
      : { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    shell.closes.push(e.id)
    isUp = false

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    shell.toasts.push(e.text)

    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, tokens: 1, percent: 0 },
      rateLimits: [],
      cost: { usd: 6.8 },
    },
  }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return Box({})
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return shell
}

async function paneText($: Engine, props: Record<string, unknown> = {}): Promise<string> {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, ...props } })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.map(t => t.text).join('')
}

// The band as drawn with the pane left as it is (the first spawn opens the pane).
async function bandTextBesidePane($: Engine, props: Record<string, unknown> = {}): Promise<string | null> {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props } })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.length === 0 ? null : texts.map(t => t.text).join('')
}

// The band with the pane closed: the band hides while the pane is placed.
async function bandText($: Engine, props: Record<string, unknown> = {}): Promise<string | null> {
  hidePane()

  return bandTextBesidePane($, props)
}

function commandRun(command: string, args = '') {
  return {
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  } as Parameters<Engine['command']['run']>[0]
}

function spawnInput(overrides: Record<string, unknown> = {}) {
  return {
    tool_use_id: 'toolu_loose',
    prompt: 'do the thing',
    description: 'Probe: trivial subagent',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    permissionMode: 'auto',
    background: true,
    fork: false,
    ...overrides,
  } as Parameters<Engine['agent']['spawn']>[0]
}

const complete = ($: Engine, agentId: string, answer: string, isAborted = false) =>
  $.turn.complete({
    answer,
    durationMs: 10,
    isAborted,
    turnId: 'x',
    agentId,
    reason: isAborted ? 'aborted' : 'answer',
  })

// The run's grace period runs out: a run counts as over only after it.
const pastGrace = (shell: Shell) => shell.clock.advance(RUN_END_GRACE_MS)

const startSession = ($: Engine) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

test('the band draws nothing before anything ran', async ($, on) => {
  world(on)
  expect(await bandText($)).toBeNull()
})

test('a started agent is a running line on the band', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  const result = await $.agent.spawn(spawnInput())
  expect(result).toMatchObject({ agentId: 'abc' })

  const text = await bandText($)
  expect(text).toContain('◉')
  expect(text).toContain('Subagents')
  expect(text).toContain('tasks 0/1')
  expect(text).toContain('1 running')
})

test('a spawn denied by a plugin beneath is a denied line, never running, and the deny reaches the caller unchanged', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ deny: 'fanout-guard: 3 agents is the limit' }))
  await startSession($)

  await $.turn.start({ text: 'go', turnId: 't1' })
  const result = await $.agent.spawn(spawnInput())
  expect(result).toEqual({ deny: 'fanout-guard: 3 agents is the limit' })

  await pastGrace(shell)
  const text = await bandText($)
  expect(text).toContain('1 denied')
  expect(text).not.toContain('running')
  expect(text).not.toContain('◉')
})

test('a workflow: the Workflow call names the run, its agents join by tool_use_id', async ($, on) => {
  world(on)
  let workflowCallId = ''
  on('tool.call', { tool: 'Workflow' }, (_, e) => {
    workflowCallId = e.tool_use_id

    return { result: { status: 'async_launched', taskId: 't1', runId: 'wf_1', workflowName: 'probe-run' } }
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'w1' }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Workflow', script: SCRIPT })
  expect(workflowCallId).not.toBe('')
  await $.agent.spawn(
    spawnInput({
      tool_use_id: workflowCallId,
      subagentType: 'workflow-subagent',
      description: 'probe:alpha',
      background: false,
      workflow: { runId: 'wf_1', agentIndex: 1 },
    }),
  )

  const text = await bandText($)
  expect(text).toContain('probe-run')
  expect(text).toContain('1 running')
  expect(text).not.toContain('Subagents')
})

test('a Workflow call refused beneath is a run that did not start', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Workflow' }, () => ({ deny: 'refused' }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Workflow', script: SCRIPT })

  const text = await bandText($)
  expect(text).toContain('probe-run')
  expect(text).toContain('not started')
  expect(text).toContain('✗')
})

test('an agent\'s turn.complete finishes it; the main loop\'s own turn.complete is ignored', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await startSession($)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())
  await complete($, 'abc', 'ALPHA')
  await $.turn.complete({ answer: 'main loop answer', durationMs: 10, isAborted: false, turnId: 'm', reason: 'answer' })

  await pastGrace(shell)
  const text = await bandText($)
  expect(text).toContain('✓')
  expect(text).toContain('tasks 1/1')
  expect(text).not.toContain('running')
})

test('an aborted agent turn is recorded failed', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await startSession($)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())
  await complete($, 'abc', '', true)

  await pastGrace(shell)
  const text = await bandText($)
  expect(text).toContain('✗')
  expect(text).toContain('1 failed')
})

test('turn.step adds the step\'s usage to the agent and passes the stream on untouched', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi' }
    return {
      turnId: 't',
      index: 0,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: 2,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 44528,
        model: 'claude-haiku-5-5',
      },
    }
  })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 3, agentId: 'abc' })
  // Read by hand: `stream.result` is not settled after a `for await` in this kit.
  const seen: unknown[] = []
  let step = await stream.next()
  while (step.done !== true) {
    seen.push(step.value)
    step = await stream.next()
  }

  expect(seen).toEqual([{ kind: 'text', index: 0, text: 'hi' }])
  expect(step.value.answer).toBe('hi')
  expect(await bandText($)).toContain('45k tok')
})

test('the band is still there in the turn the run ended in and gone one turn later', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await startSession($)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())
  await complete($, 'abc', 'ok')
  expect(await bandText($)).toContain('tasks 1/1')
  await pastGrace(shell)
  expect(await bandText($)).toContain('tasks 1/1')

  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await bandText($)).toBeNull()
})

test('the band yields to a survey', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())
  expect(await bandText($, { hasSurvey: true })).toBeNull()
})

const failedSpawn = async ($: Engine, on: On, agentId = 'abc') => {
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput({ tool_use_id: `toolu_${agentId}`, description: `Agent ${agentId}` }))
}

test('the pane draws the run it was opened on, through the Pane hook', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'abc' }))

  expect(await paneText($)).toContain('No agents yet')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())

  const text = await paneText($)
  expect(text).toContain('Subagents')
  expect(text).toContain('Running · 1')
  expect(text).toContain('▲')
  expect(text).toContain('opus')
})

test('a 60-column pane never draws a text wider than the pane', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'abc' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput({ description: 'y'.repeat(200) }))

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  expect(texts.every(t => t.length <= 60)).toBe(true)
  expect(texts.some(t => t.endsWith('…'))).toBe(true)
})

test('/fleet opens the pane, asked, and a second /fleet closes it', async ($, on) => {
  const shell = world(on)

  const opened = await $.command.run(commandRun('fleet'))
  expect(opened.text).toBe('Fleet pane opened.')
  expect(shell.opens).toEqual(['fleet'])

  const closed = await $.command.run(commandRun('fleet'))
  expect(closed.text).toBe('Fleet pane closed.')
  expect(shell.closes).toEqual(['fleet'])

  await $.command.run(commandRun('fleet'))
  expect(shell.opens).toEqual(['fleet', 'fleet'])
})

test('/fleet on a terminal too narrow says the pane is waiting instead of claiming it opened', async ($, on) => {
  world(on, { isPlaced: false })
  const ran = await $.command.run(commandRun('fleet'))
  expect(ran.text).toContain('waiting: terminal too narrow')
})

test('/fleet with an unknown argument explains itself and opens nothing', async ($, on) => {
  const shell = world(on)
  const ran = await $.command.run(commandRun('fleet', 'bogus'))
  expect(ran.text).toContain('Usage')
  expect(shell.opens).toEqual([])
})

test('/fleet clear drops finished runs and keeps a running one', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', (_, e) => ({
    model: 'claude-haiku-5-5',
    agentId: e.description === 'still going' ? 'live' : 'old',
  }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_old', description: 'finished one' }))
  await complete($, 'old', 'ok')
  await pastGrace(shell)
  await $.turn.start({ text: 'next', turnId: 't2' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_live', description: 'still going' }))
  expect(await paneText($)).toContain('earlier runs')

  const ran = await $.command.run(commandRun('fleet', 'clear'))
  expect(ran.text).toBe('Cleared 1 finished run.')
  const text = await paneText($)
  expect(text).not.toContain('earlier runs')
  expect(text).toContain('still going')

  expect((await $.command.run(commandRun('fleet', 'clear'))).text).toBe('No finished runs to clear.')
})

test('/fleet clear on a fleet with only finished runs leaves the empty pane', async ($, on) => {
  const shell = world(on)
  await failedSpawn($, on)
  await complete($, 'abc', 'ok')
  await pastGrace(shell)
  await $.command.run(commandRun('fleet', 'clear'))
  expect(await paneText($)).toContain('No agents yet')
})

test('the pane opens on the first successful spawn of the session and never again', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', { description: 'Refused' }, () => ({ deny: 'fanout-guard: limit' }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_denied', description: 'Refused' }))
  expect(shell.opens).toEqual([])

  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_1' }))
  expect(shell.opens).toEqual(['fleet'])

  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_2' }))
  expect(shell.opens).toEqual(['fleet'])
})

test('a pane the person closed stays closed: later spawns do not reopen it', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_1' }))
  await $.command.run(commandRun('fleet'))
  expect(shell.closes).toEqual(['fleet'])

  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_2' }))
  expect(shell.opens).toEqual(['fleet'])
})

test('a failure toasts once, the run end toasts once, and a repeat of the same events says nothing more', async ($, on) => {
  const shell = world(on)
  await failedSpawn($, on)

  await complete($, 'abc', '', true)
  expect(shell.toasts).toEqual(['Agent abc failed'])
  await pastGrace(shell)
  expect(shell.toasts).toHaveLength(2)
  expect(shell.toasts[1]).toMatch(/Subagents · \d\d:\d\d finished · 0\/1 done · 1 failed/)

  await complete($, 'abc', '', true)
  await $.turn.complete({ answer: 'main', durationMs: 1, isAborted: false, turnId: 'm', reason: 'answer' })
  expect(shell.toasts).toHaveLength(2)
})

test('a successful run toasts its end once, only when its last agent is done', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', { description: 'Agent b' }, () => ({ model: 'claude-haiku-5-5', agentId: 'b' }))
  on('agent.spawn', { description: 'Agent a' }, () => ({ model: 'claude-haiku-5-5', agentId: 'a' }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a', description: 'Agent a' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_b', description: 'Agent b' }))

  await complete($, 'a', 'ok')
  expect(shell.toasts).toEqual([])
  await complete($, 'b', 'ok')
  await pastGrace(shell)
  expect(shell.toasts).toHaveLength(1)
  expect(shell.toasts[0]).toMatch(/Subagents · \d\d:\d\d finished · 2\/2 done/)
})

// A workflow with two phases: phase 1 is agent w1, phase 2 is agent w2.
async function twoPhaseWorkflow($: Engine, on: On) {
  let workflowCallId = ''
  on('tool.call', { tool: 'Workflow' }, (_, e) => {
    workflowCallId = e.tool_use_id

    return { result: { status: 'async_launched', taskId: 't1', runId: 'wf_1', workflowName: 'probe-run' } }
  })
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'probe:alpha' ? 'w1' : 'w2' }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Workflow', script: SCRIPT })

  return (phase: 1 | 2) =>
    $.agent.spawn(
      spawnInput({
        tool_use_id: workflowCallId,
        subagentType: 'workflow-subagent',
        description: phase === 1 ? 'probe:alpha' : 'probe:beta',
        background: false,
        workflow: { runId: 'wf_1', agentIndex: phase },
      }),
    )
}

// Regression: pre-release, found in the live check of 2026-10-13 — run end was "has agents and none running", so every gap between workflow phases toasted "finished"
test('a workflow gap shorter than the grace toasts its end once, at the true end', async ($, on) => {
  const shell = world(on)
  const spawnPhase = await twoPhaseWorkflow($, on)

  await spawnPhase(1)
  await complete($, 'w1', 'ALPHA')
  await shell.clock.advance(4_000)
  expect(shell.toasts).toEqual([])
  const gap = await bandText($)
  expect(gap).toContain('◉')
  expect(gap).not.toContain('✓')

  await spawnPhase(2)
  await complete($, 'w2', 'BETA')
  await shell.clock.advance(RUN_END_GRACE_MS - 1_000)
  expect(shell.toasts).toEqual([])
  await shell.clock.advance(1_000)
  expect(shell.toasts).toHaveLength(1)
  expect(shell.toasts[0]).toContain('probe-run finished · 2/2 done')
  expect(await bandText($)).toContain('✓')
})

// The accepted limit: a gap longer than the grace is announced as an end, and
// the run reopens when the next phase spawns; its real end, a different
// outcome, is announced too (reverses a451a64's "toasts once").
// Regression: 065c839 — the reopened run's real outcome was never announced
test('a workflow gap longer than the grace toasts the premature end, then the real one', async ($, on) => {
  const shell = world(on)
  const spawnPhase = await twoPhaseWorkflow($, on)

  await spawnPhase(1)
  await complete($, 'w1', 'ALPHA')
  await pastGrace(shell)
  expect(shell.toasts).toHaveLength(1)
  expect(shell.toasts[0]).toContain('probe-run finished · 1/1 done')

  await spawnPhase(2)
  await complete($, 'w2', 'BETA')
  await pastGrace(shell)
  expect(shell.toasts).toHaveLength(2)
  expect(shell.toasts[1]).toContain('probe-run finished · 2/2 done')
  await pastGrace(shell)
  expect(shell.toasts).toHaveLength(2)
})

test('a Workflow call refused beneath toasts that the run did not start, once', async ($, on) => {
  const shell = world(on)
  on('tool.call', { tool: 'Workflow' }, () => ({ deny: 'refused' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Workflow', script: SCRIPT })
  expect(shell.toasts).toEqual(['probe-run did not start'])
})

// What `$.agent.list()` gives per agent; the fields the mod reads are id and status.
const listed = (id: string, status: 'running' | 'completed' | 'failed' | 'killed' | 'idle') => ({
  id,
  description: 'x',
  type: 'general-purpose',
  status,
})

// Regression: pre-release, found in the live check of 2026-10-13 — an agent whose turn.complete was lost (hot reload mid-run) stayed "running" for ever and held the band up
test('a running agent the engine no longer lists is lost within a tick: not running, not done, the band lets go', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  on('agent.list', () => ({ value: [] }))
  await startSession($)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())
  expect(await bandText($)).toContain('1 running')

  await shell.clock.advance(1_000)
  const text = await bandText($)
  expect(text).toContain('1 lost')
  expect(text).toContain('tasks 0/1')
  expect(text).not.toContain('running')
  expect(await paneText($)).toContain('? Probe: trivial subagent · lost')

  await pastGrace(shell)
  expect(await bandText($)).toContain('1 lost')
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await bandText($)).toBeNull()
})

test('an agent still listed as running stays running; one listed as completed takes the engine\'s outcome', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'first' ? 'a1' : 'a2' }))
  on('agent.list', () => ({ value: [listed('a1', 'running'), listed('a2', 'completed')] }))
  await startSession($)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_1', description: 'first' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_2', description: 'second' }))
  await shell.clock.advance(1_000)

  const text = await bandText($)
  expect(text).toContain('tasks 1/2')
  expect(text).toContain('1 running')
  expect(text).not.toContain('lost')
})

test('a workflow\'s agents are never listed by the engine, so an empty list does not lose them', async ($, on) => {
  const shell = world(on)
  on('agent.list', () => ({ value: [] }))
  const spawnPhase = await twoPhaseWorkflow($, on)

  await spawnPhase(1)
  await shell.clock.advance(3_000)
  const text = await bandText($)
  expect(text).toContain('1 running')
  expect(text).not.toContain('lost')
})

const oldFleet = (): Fleet => ({
  runs: { 'subagents:1': { id: 'subagents:1', kind: 'subagents', startedAt: 1, agentIds: ['old'] } },
  agents: {
    old: { id: 'old', runId: 'subagents:1', description: 'old', model: 'm', status: 'running', startedAt: 1, tokensIn: 0, tokensOut: 0, lastInputTokens: 0 },
  },
  pending: {},
  workflowAlias: {},
  order: ['subagents:1'],
  hasAutoOpened: true,
  turn: 1,
})

// The persisted fleet as a session left it: served as stored, under the tag the
// atom keeps it under. `gets` counts the reads of the fleet.
function persisted(on: On, stored: unknown): { gets: () => number; written: () => unknown; replace: (value: unknown) => void } {
  let version = 1
  let gets = 0
  on('state.get', { plugin: 'agent-fleet', key: 'fleet' }, () => {
    gets += 1

    return { value: { value: stored, version } }
  })
  on('state.set', { plugin: 'agent-fleet', key: 'fleet' }, (_, e) => {
    stored = e.value
    version += 1

    return { value: { isSet: true as const, version } }
  })

  // Another writer of the same state (another window of the session): the value
  // changes without any hook of this mod seeing it.
  const replace = (value: unknown): void => {
    stored = value
    version += 1
  }

  return { gets: () => gets, written: () => stored, replace }
}

const shaped = (shape: string, value: Fleet) => ({ shape, value })

// Regression: 3326e3b — the fleet was kept under a hand-made version field; the engine's atom shape tag now decides what is read
test('a state kept under the current shape is read', async ($, on) => {
  world(on)
  persisted(on, shaped(FLEET_SHAPE, oldFleet()))
  expect(await bandText($)).toContain('1 running')
})

test('a state kept under another shape tag reads as empty', async ($, on) => {
  world(on)
  persisted(on, shaped('fleet@2', oldFleet()))
  expect(await bandText($)).toBeNull()
})

// Regression: 065c839 — run identity, announcements and outcomes changed meaning, yet a fleet kept under the old tag was still read
test('a state kept under the previous shape tag, fleet@3, reads as empty', async ($, on) => {
  world(on)
  persisted(on, shaped('fleet@3', oldFleet()))
  expect(await bandText($)).toBeNull()
})

test('a state written bare, as before the shape tag, reads as empty', async ($, on) => {
  world(on)
  persisted(on, oldFleet())
  expect(await bandText($)).toBeNull()
})

test('the band hides while the pane is placed and returns when it is closed', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())

  expect(await bandTextBesidePane($)).toBeNull()
  expect(await bandText($)).toContain('1 running')
})

test('a loose run is titled with its start clock time', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())

  expect(await bandText($)).toMatch(/Subagents · \d\d:\d\d/)
})

// Regression: pre-release, found in the live check of 2026-10-13 — a settling run's end relied on one timer; a reload lost it and the run stayed "running" for ever
test('a run left settling by a previous load of the mod ends by the tick, with no timer of its own', async ($, on) => {
  const shell = world(on)
  const now = shell.clock.now()
  const settling = oldFleet()
  settling.agents.old = { ...settling.agents.old!, status: 'done', startedAt: now - 200, endedAt: now - 100, endedTurn: 1 }
  settling.runs['subagents:1'] = { ...settling.runs['subagents:1']!, settlingAt: now - 100 }
  persisted(on, shaped(FLEET_SHAPE, settling))
  await startSession($)

  await shell.clock.advance(RUN_END_GRACE_MS)

  expect(shell.toasts).toHaveLength(1)
  expect(shell.toasts[0]).toMatch(/finished · 1\/1 done/)
})

// Regression: 3326e3b — every event that left a run settling armed a timer of its own; the tick alone ends a run now
test('an event sets no timer of its own: only the tick ends a settling run', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())
  await complete($, 'abc', 'ok')

  await pastGrace(shell)
  expect(shell.toasts).toEqual([])

  await startSession($)
  expect(shell.toasts).toHaveLength(1)
  expect(shell.toasts[0]).toMatch(/finished · 1\/1 done/)
})

// Regression: 3326e3b — a tick read the fleet three times, four with a reconcile
test('a tick reads the fleet once', async ($, on) => {
  const shell = world(on)
  on('agent.list', () => ({ value: [listed('old', 'running')] }))
  const state = persisted(on, shaped(FLEET_SHAPE, oldFleet()))
  await startSession($)

  const before = state.gets()
  await shell.clock.advance(1_000)
  expect(state.gets() - before).toBe(1)
})

// Regression: 3326e3b — the engine's list said "completed" before the real turn.complete arrived, which was then dropped: no answer on the row
test('a real turn.complete after the engine\'s list ended the agent still lands its answer', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  on('agent.list', () => ({ value: [listed('abc', 'completed')] }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())

  await shell.clock.advance(1_000)
  const fromList = await paneText($)
  expect(fromList).toContain('Done · 1')
  expect(fromList).not.toContain('ALPHA')

  await complete($, 'abc', 'ALPHA')
  expect(await paneText($)).toContain('— ALPHA')
})

// Regression: 3326e3b — a launched workflow that spawned nothing stayed "waiting for the first agent" for ever
test('a launched workflow that never spawned an agent ends by the tick after 30 min of silence', async ($, on) => {
  const shell = world(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.call', { tool: 'Workflow' }, () => ({
    result: { status: 'async_launched', taskId: 't1', runId: 'wf_1', workflowName: 'probe-run' },
  }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Workflow', script: SCRIPT })

  await shell.clock.advance(30 * 60_000 - 1_000)
  expect(shell.toasts).toEqual([])
  expect(await paneText($)).toContain('waiting for the first agent')

  await shell.clock.advance(1_000)
  expect(shell.toasts).toEqual(['probe-run did not start'])
  expect(await paneText($)).toContain('not started')
})

// Regression: a451a64 — a launched workflow with no agent kept the 1 Hz tick, and its reconcile, alive for as long as it waited
test('a launched workflow with no agent does not wake the 1 Hz reconcile', async ($, on) => {
  const shell = world(on)
  let listCalls = 0
  on('agent.list', () => {
    listCalls += 1

    return { value: [] }
  })
  on('tool.call', { tool: 'Workflow' }, () => ({
    result: { status: 'async_launched', taskId: 't1', runId: 'wf_1', workflowName: 'probe-run' },
  }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Workflow', script: SCRIPT })

  const before = listCalls
  await shell.clock.advance(5_000)
  expect(listCalls - before).toBe(0)
})

test('a running agent does wake the 1 Hz reconcile', async ($, on) => {
  const shell = world(on)
  let listCalls = 0
  on('agent.list', () => {
    listCalls += 1

    return { value: [listed('abc', 'running')] }
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())

  const before = listCalls
  await shell.clock.advance(5_000)
  expect(listCalls - before).toBe(5)
})

// Idle workflows are found by a coarse timer, not the 1 Hz tick: a silent run with a running agent is still ended
test('a workflow whose running agent went silent is lost after 30 min, found by the coarse check', async ($, on) => {
  const shell = world(on)
  on('agent.list', () => ({ value: [] }))
  const spawnPhase = await twoPhaseWorkflow($, on)

  await spawnPhase(1)
  await shell.clock.advance(30 * 60_000 - 1_000)
  expect(await bandText($)).toContain('1 running')

  await shell.clock.advance(61_000)
  expect(await bandText($)).toContain('1 lost')
})

// Regression: 065c839 — a failure taken from the engine's list was toasted at the tick, before the real turn.complete could correct it
test('a failure the engine\'s list reports is not toasted before the real turn.complete can correct it', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  on('agent.list', () => ({ value: [listed('abc', 'failed')] }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())

  await shell.clock.advance(1_000)
  expect(shell.toasts).toEqual([])
  await complete($, 'abc', 'ALPHA')
  await pastGrace(shell)
  expect(shell.toasts).toHaveLength(1)
  expect(shell.toasts[0]).toMatch(/finished · 1\/1 done/)
})

test('a failure the engine\'s list reports, still standing after the grace, is toasted with the run end', async ($, on) => {
  const shell = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'abc' }))
  on('agent.list', () => ({ value: [listed('abc', 'failed')] }))
  await startSession($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(spawnInput())

  await shell.clock.advance(1_000)
  await shell.clock.advance(RUN_END_GRACE_MS - 1_000)
  expect(shell.toasts).toEqual([])
  await shell.clock.advance(1_000)
  expect(shell.toasts).toHaveLength(2)
  expect(shell.toasts[0]).toBe('Probe: trivial subagent failed')
  expect(shell.toasts[1]).toMatch(/finished · 0\/1 done · 1 failed/)
})

// The coarse idle check costs one read a minute even with no workflow run to
// watch: the cached flag that saved it went stale (reverses 065c839's "reads nothing").
test('with no open workflow run the coarse idle check still reads once a minute, beside the 1 Hz tick\'s reads', async ($, on) => {
  const shell = world(on)
  const state = persisted(on, shaped(FLEET_SHAPE, emptyFleet()))
  await startSession($)

  const before = state.gets()
  await shell.clock.advance(60_000)
  expect(state.gets() - before).toBe(61)
})

test('with an open workflow run the coarse idle check does read', async ($, on) => {
  const shell = world(on)
  const now = shell.clock.now()
  const waiting: Fleet = {
    ...emptyFleet(),
    runs: { toolu_wf: { id: 'toolu_wf', kind: 'workflow', name: 'probe-run', startedAt: now, lastActivityAt: now, agentIds: [] } },
    order: ['toolu_wf'],
    turn: 1,
  }
  const state = persisted(on, shaped(FLEET_SHAPE, waiting))
  await startSession($)

  const before = state.gets()
  await shell.clock.advance(60_000)
  expect(state.gets() - before).toBe(61)
})

// A launched workflow that never spawned, as another writer leaves it in the state.
const silentLaunch = (now: number): Fleet => ({
  ...emptyFleet(),
  runs: { toolu_wf: { id: 'toolu_wf', kind: 'workflow', name: 'probe-run', startedAt: now, lastActivityAt: now, agentIds: [] } },
  order: ['toolu_wf'],
  turn: 1,
})

// Regression: 6c5d7eb — the coarse idle check trusted a module-level flag set by this mod's own writes, so a workflow run that reached the state another way was never watched and never ended
test('the coarse idle check reads the state itself: a silent workflow run it was never told about still ends', async ($, on) => {
  const shell = world(on)
  const state = persisted(on, shaped(FLEET_SHAPE, emptyFleet()))
  await startSession($)

  state.replace(shaped(FLEET_SHAPE, silentLaunch(shell.clock.now())))
  await shell.clock.advance(30 * 60_000 + 60_000)
  expect(shell.toasts).toEqual(['probe-run did not start'])
})

// A run that ended under a previous load of the mod, its end not yet announced.
const endedUnannounced = (now: number): Fleet => {
  const f = oldFleet()
  f.agents.old = { ...f.agents.old!, status: 'done', startedAt: now - 200, endedAt: now - 100, endedTurn: 1 }
  f.runs['subagents:1'] = { ...f.runs['subagents:1']!, endedAt: now - 100, endedTurn: 1 }
  return f
}

// Regression: 6c5d7eb — every step and every tool call went through the announcing write; only an event that can change a status or open or end a run announces now
test('a step or a tool call of an agent says nothing aloud: a due run end waits for the next recorded event', async ($, on) => {
  const shell = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  on('turn.step', async function* () {
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
    }
  })
  persisted(on, shaped(FLEET_SHAPE, endedUnannounced(shell.clock.now())))

  // The kit's call input has no agentId; the hook reads it off the event all the same.
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'old' } as unknown as Parameters<Engine['tool']['call']>[0])
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'old' })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  expect(shell.toasts).toEqual([])
  // The step itself still landed: a finished row draws its tokens, not its last tool.
  expect(await paneText($)).toContain('Tokens 2')

  // A completion is recorded: it announces what is due.
  await complete($, 'old', 'ok')
  expect(shell.toasts).toHaveLength(1)
  expect(shell.toasts[0]).toMatch(/finished · 1\/1 done/)
})
