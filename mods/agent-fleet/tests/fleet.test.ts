import { describe, expect, test } from 'claude-code/testing'

import type { Fleet } from '../types'
import {
  PENDING_MAX,
  PREVIEW_CHARS,
  REJOIN_WINDOW_MS,
  RUNS_DETAILED,
  RUNS_KEPT,
  RUN_END_GRACE_MS,
  announce,
  bandOf,
  emptyFleet,
  formatClock,
  formatElapsed,
  formatLocalTime,
  formatTokens,
  hasExpirable,
  isAnyRunning,
  isBandVisible,
  launchOf,
  parseMeta,
  reduce,
  runStats,
  spawnEventOf,
  unlistedRunning,
} from '../hooks/fleet'
import type { FleetEvent, StepUsage } from '../hooks/fleet'

const usage = (input: number, output: number, cacheRead = 0, cacheCreation = 0): StepUsage => ({
  input,
  output,
  cacheRead,
  cacheCreation,
})

function run(events: FleetEvent[], from: Fleet = emptyFleet()): Fleet {
  return events.reduce(reduce, from)
}

// The grace period out: every settling run has ended by then.
const GRACE_OUT: FleetEvent = { kind: 'expire', at: 10 ** 12 }
// An instant past every grace: what is announced then is everything due.
const LATE = 10 ** 12

// Shapes taken from the spike log (fleet-probe.jsonl), prompts trimmed.
const SPAWN_LOOSE = {
  tool_use_id: 'toolu_loose',
  description: 'Probe: trivial subagent',
  subagentType: 'general-purpose',
  background: true,
}
const SPAWN_ALPHA = {
  tool_use_id: 'toolu_wf',
  description: 'probe:alpha',
  subagentType: 'workflow-subagent',
  background: false,
  workflow: { runId: 'wf_276d27ad-539', agentIndex: 1 },
}
const SCRIPT_3_PHASES = `export const meta = {
  name: 'three-phase',
  description: 'x',
  phases: [{ title: 'Alpha', detail: 'first' }, { title: 'Beta' }, { title: 'Gamma' }],
}
phase('Alpha')
const a = await agent('x', { label: 'probe:alpha' })
`

describe('loose subagent lifecycle', () => {
  test('spawn, step, tool, complete', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'claude-haiku-5-5', agentId: 'a1' }, 1000, 6.8),
      { kind: 'tool', at: 1100, agentId: 'a1', tool: 'Bash' },
      { kind: 'step', at: 1200, agentId: 'a1', index: 0, model: 'claude-haiku-5-5', effort: 'medium', usage: usage(2, 198, 0, 43275) },
      { kind: 'complete', at: 2000, agentId: 'a1', answer: 'ALPHA', isAborted: false, reason: 'answer', costUsd: 6.9 },
      GRACE_OUT,
    ])
    const agent = f.agents.a1
    expect(agent).toMatchObject({
      status: 'done',
      description: 'Probe: trivial subagent',
      model: 'claude-haiku-5-5',
      effort: 'medium',
      lastTool: 'Bash',
      answerPreview: 'ALPHA',
      isBackground: true,
      endedAt: 2000,
      tokensIn: 43277,
      tokensOut: 198,
    })
    expect(f.order).toEqual(['subagents:1'])
    const group = f.runs['subagents:1']
    expect(group).toMatchObject({ kind: 'subagents', agentIds: ['a1'], endedAt: 2000, endedTurn: 1 })
    expect(runStats(f, group!)).toMatchObject({ total: 1, done: 1, running: 0 })
  })

  test('a running agent reopens nothing until it ends, and the run is not ended meanwhile', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000, undefined),
    ])
    expect(f.agents.a1?.status).toBe('running')
    expect(f.runs['subagents:1']?.endedAt).toBeUndefined()
  })

  test('the reducer never mutates its input', async () => {
    const before = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined)])
    const frozen = JSON.stringify(before)
    reduce(before, { kind: 'step', at: 2, agentId: 'a1', index: 0, model: 'm', usage: usage(1, 1) })
    reduce(before, { kind: 'complete', at: 3, agentId: 'a1', answer: 'x', isAborted: false, reason: 'answer' })
    expect(JSON.stringify(before)).toBe(frozen)
  })
})

describe('workflow', () => {
  test('three phases listed up front, agents run then finish, run ends with the last', async () => {
    let f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 900, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES, costUsd: 6.82 },
      { kind: 'workflow-launched', at: 901, toolUseId: 'toolu_wf', runId: 'wf_276d27ad-539', name: 'three-phase' },
    ])
    const planned = f.runs.toolu_wf
    expect(planned).toMatchObject({ kind: 'workflow', name: 'three-phase', workflowRunId: 'wf_276d27ad-539' })
    expect(planned?.phases?.map(p => p.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(planned?.agentIds).toEqual([])

    f = run(
      [
        spawnEventOf(SPAWN_ALPHA, { model: 'claude-haiku-5-5', agentId: 'w1' }, 1000, 6.82),
        { kind: 'step', at: 1100, agentId: 'w1', index: 0, model: 'claude-haiku-5-5', usage: usage(2, 7, 0, 44528) },
      ],
      f,
    )
    expect(f.agents.w1?.status).toBe('running')
    expect(f.runs.toolu_wf?.endedAt).toBeUndefined()

    f = run([{ kind: 'complete', at: 1700, agentId: 'w1', answer: 'ALPHA', isAborted: false, reason: 'answer', costUsd: 6.9 }], f)
    expect(f.agents.w1?.status).toBe('done')
    // Every agent so far is done, but the run is settling, not over.
    expect(f.runs.toolu_wf).toMatchObject({ settlingAt: 1700 })
    expect(f.runs.toolu_wf?.endedAt).toBeUndefined()

    // The next phase spawns inside the grace period: the run never ended.
    f = run(
      [spawnEventOf({ ...SPAWN_ALPHA, description: 'probe:beta', workflow: { runId: 'wf_276d27ad-539', agentIndex: 2 } }, { model: 'm', agentId: 'w2' }, 4000, 6.9)],
      f,
    )
    expect(f.runs.toolu_wf?.endedAt).toBeUndefined()
    expect(f.runs.toolu_wf?.settlingAt).toBeUndefined()
    expect(f.runs.toolu_wf?.agentIds).toEqual(['w1', 'w2'])

    f = run([{ kind: 'complete', at: 9000, agentId: 'w2', answer: 'BETA', isAborted: false, reason: 'answer', costUsd: 7.1 }, GRACE_OUT], f)
    const done = f.runs.toolu_wf!
    expect(done.endedAt).toBe(9000)
    expect(runStats(f, done)).toMatchObject({ total: 2, done: 2, running: 0 })
    expect(Math.abs((runStats(f, done).costUsd ?? -1) - (7.1 - 6.82))).toBeLessThan(1e-6)
  })

  test('agents of a run share the Workflow call id and land in one run', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 1, undefined),
      spawnEventOf({ ...SPAWN_ALPHA, workflow: { runId: 'wf_276d27ad-539', agentIndex: 2 } }, { model: 'm', agentId: 'w2' }, 2, undefined),
    ])
    expect(f.order).toEqual(['toolu_wf'])
    expect(f.runs.toolu_wf?.agentIds).toEqual(['w1', 'w2'])
  })

  test('spawns arriving before the Workflow call is recorded still join the run', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 1000, undefined),
      { kind: 'workflow-start', at: 990, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
    ])
    expect(f.runs.toolu_wf).toMatchObject({ name: 'three-phase', agentIds: ['w1'], startedAt: 990 })
  })

  test('a Workflow call that did not launch ends its run at once, with no agents', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 10, toolUseId: 'toolu_x', script: SCRIPT_3_PHASES },
      { kind: 'workflow-end', at: 20, toolUseId: 'toolu_x' },
    ])
    expect(f.runs.toolu_x).toMatchObject({ endedAt: 20, endedTurn: 1 })
    expect(bandOf(f, 30)?.tone).toBe('failed')
  })
})

describe('launchOf', () => {
  test('async_launched carries run id and name', async () => {
    expect(launchOf({ result: { status: 'async_launched', runId: 'wf_1', workflowName: 'w' } })).toEqual({
      isLaunched: true,
      runId: 'wf_1',
      name: 'w',
    })
  })

  test('a deny, an error or a malformed answer is not a launch', async () => {
    expect(launchOf({ deny: 'no' }).isLaunched).toBe(false)
    expect(launchOf({ result: { status: 'async_launched' }, isError: true }).isLaunched).toBe(false)
    expect(launchOf(undefined).isLaunched).toBe(false)
    expect(launchOf({ result: 'text' }).isLaunched).toBe(false)
  })
})

describe('failures and refusals', () => {
  test('an aborted agent is failed, and so is one that did not end on an answer', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't2' }, { model: 'm', agentId: 'a2' }, 2, undefined),
      { kind: 'complete', at: 10, agentId: 'a1', answer: '', isAborted: true, reason: 'aborted' },
      { kind: 'complete', at: 11, agentId: 'a2', answer: 'partial', isAborted: false, reason: 'error' },
      GRACE_OUT,
    ])
    expect(f.agents.a1?.status).toBe('failed')
    expect(f.agents.a2?.status).toBe('failed')
    expect(f.agents.a1?.answerPreview).toBeUndefined()
    expect(runStats(f, f.runs['subagents:1']!)).toMatchObject({ failed: 2, done: 0, running: 0 })
    expect(bandOf(f, 20)?.tone).toBe('failed')
  })

  test('a spawn denied by a plugin beneath is a denied row, never running', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_ALPHA, { deny: 'fanout-guard: too many agents' }, 1000, undefined),
      GRACE_OUT,
    ])
    const rows = Object.values(f.agents)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'denied', denyReason: 'fanout-guard: too many agents' })
    expect(rows.some(a => a.status === 'running')).toBe(false)
    const stats = runStats(f, f.runs.toolu_wf!)
    expect(stats).toMatchObject({ denied: 1, running: 0, total: 0 })
    expect(f.runs.toolu_wf?.endedAt).toBe(1000)
  })

  test('two denied spawns of one workflow stay two rows', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_ALPHA, { deny: 'a' }, 1, undefined),
      spawnEventOf({ ...SPAWN_ALPHA, workflow: { runId: 'wf_1', agentIndex: 2 } }, { deny: 'b' }, 2, undefined),
    ])
    expect(Object.keys(f.agents)).toHaveLength(2)
  })

  test('a spawn with neither agentId nor deny records nothing', async () => {
    const f = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm' }, 1, undefined)])
    expect(Object.keys(f.agents)).toEqual([])
  })
})

describe('nested spawn', () => {
  test('a child spawned by a workflow agent joins the parent run and keeps parentId', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 1, undefined),
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 'toolu_child', parentAgentId: 'w1' }, { model: 'm', agentId: 'c1' }, 2, undefined),
    ])
    expect(f.agents.c1).toMatchObject({ parentId: 'w1', runId: 'toolu_wf' })
    expect(f.runs.toolu_wf?.agentIds).toEqual(['w1', 'c1'])
    expect(f.runs['subagents:1']).toBeUndefined()
  })

  test('a child of a loose agent stays in that agent\'s run', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'turn-start' },
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't2', parentAgentId: 'a1' }, { model: 'm', agentId: 'c1' }, 2, undefined),
    ])
    expect(f.agents.c1?.runId).toBe('subagents:1')
  })
})

describe('tokens and context', () => {
  test('totals count input + cache creation + output, never cache reads; context size still includes them', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 2, agentId: 'a1', index: 0, model: 'm', usage: usage(2, 100, 10, 1000) },
      { kind: 'step', at: 3, agentId: 'a1', index: 1, model: 'm', usage: usage(2, 50, 1010, 5) },
      { kind: 'step', at: 4, agentId: 'a1', index: 2, model: 'm', usage: null },
    ])
    expect(f.agents.a1).toMatchObject({ tokensIn: 1002 + 7, tokensOut: 150, lastInputTokens: 1017, lastStepIndex: 2 })
    expect(runStats(f, f.runs['subagents:1']!).tokens).toBe(1002 + 7 + 150)
  })

  test('a late step does not roll the last input size back', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 3, agentId: 'a1', index: 1, model: 'm', usage: usage(0, 1, 0, 900) },
      { kind: 'step', at: 2, agentId: 'a1', index: 0, model: 'm', usage: usage(0, 1, 0, 100) },
    ])
    expect(f.agents.a1?.lastInputTokens).toBe(900)
    expect(f.agents.a1?.tokensIn).toBe(1000)
  })

  test('ctx window shows only for an agent on the session model', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 1, index: 0, model: 'claude-opus-5-5', usage: usage(1, 1), window: 1_000_000 },
      spawnEventOf(SPAWN_LOOSE, { model: 'claude-opus-5-5', agentId: 'same' }, 2, undefined),
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't2' }, { model: 'claude-haiku-5-5', agentId: 'other' }, 2, undefined),
      { kind: 'step', at: 3, agentId: 'same', index: 0, model: 'claude-opus-5-5', usage: usage(1, 1) },
      { kind: 'step', at: 3, agentId: 'other', index: 0, model: 'claude-haiku-5-5', usage: usage(1, 1) },
    ])
    expect(f.agents.same?.window).toBe(1_000_000)
    expect(f.agents.other?.window).toBeUndefined()
    expect(f.mainModel).toBe('claude-opus-5-5')
  })

  test('main-loop steps never count as agent tokens', async () => {
    const f = run([{ kind: 'turn-start' }, { kind: 'step', at: 1, index: 0, model: 'm', usage: usage(5, 5), window: 10 }])
    expect(Object.keys(f.agents)).toEqual([])
  })
})

describe('current tool replaces todo progress', () => {
  test('the latest tool call of an agent is kept', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'tool', at: 2, agentId: 'a1', tool: 'ToolSearch' },
      { kind: 'tool', at: 3, agentId: 'a1', tool: 'Bash' },
    ])
    expect(f.agents.a1?.lastTool).toBe('Bash')
  })
})

describe('out-of-order events', () => {
  test('complete before a step: the status stays done and the late step still counts', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 5, agentId: 'a1', answer: 'ok', isAborted: false, reason: 'answer' },
      { kind: 'step', at: 4, agentId: 'a1', index: 0, model: 'm', usage: usage(3, 4) },
    ])
    expect(f.agents.a1).toMatchObject({ status: 'done', tokensIn: 3, tokensOut: 4, endedAt: 5 })
  })

  test('step and complete before the spawn result is recorded: the spawn fills in the row', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 2, agentId: 'a1', index: 0, model: 'm', usage: usage(3, 4) },
      { kind: 'complete', at: 3, agentId: 'a1', answer: 'ok', isAborted: false, reason: 'answer' },
      spawnEventOf(SPAWN_ALPHA, { model: 'claude-haiku-5-5', agentId: 'a1' }, 1, undefined),
      GRACE_OUT,
    ])
    expect(f.agents.a1).toMatchObject({
      status: 'done',
      description: 'probe:alpha',
      runId: 'toolu_wf',
      tokensIn: 3,
      model: 'claude-haiku-5-5',
      startedAt: 1,
    })
    expect(f.runs['subagents:1']).toBeUndefined()
    expect(f.order).toEqual(['toolu_wf'])
    expect(f.runs.toolu_wf?.agentIds).toEqual(['a1'])
    expect(f.runs.toolu_wf?.endedAt).toBe(3)
  })

  test('a second turn.complete of a finished agent does not change its status', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 5, agentId: 'a1', answer: 'first', isAborted: false, reason: 'answer' },
      { kind: 'complete', at: 9, agentId: 'a1', answer: 'second', isAborted: true, reason: 'aborted' },
    ])
    expect(f.agents.a1).toMatchObject({ status: 'done', answerPreview: 'first', endedAt: 5 })
  })
})

describe('parseMeta', () => {
  test('reads name and phases as a data literal', async () => {
    expect(parseMeta(SCRIPT_3_PHASES)).toEqual({
      name: 'three-phase',
      phases: [{ title: 'Alpha', detail: 'first' }, { title: 'Beta' }, { title: 'Gamma' }],
    })
  })

  test('accepts quotes, backticks, comments, trailing commas and string phases', async () => {
    const script = `export const meta = {
      // a comment
      "name": \`quoted \\u0041\`, /* inline */
      phases: ['One', { title: "Two", }],
      description: 'it\\'s',
    }`
    expect(parseMeta(script)).toEqual({ name: 'quoted A', phases: [{ title: 'One' }, { title: 'Two' }] })
  })

  test('an absent meta gives nothing', async () => {
    expect(parseMeta(undefined)).toEqual({})
    expect(parseMeta('const x = 1')).toEqual({})
    expect(parseMeta('')).toEqual({})
  })

  test('a malformed meta gives nothing and does not throw', async () => {
    expect(parseMeta("export const meta = { name: 'x', phases: [")).toEqual({})
    expect(parseMeta("export const meta = { name: 'unterminated }")).toEqual({})
    expect(parseMeta('export const meta = { name x }')).toEqual({})
    expect(parseMeta('export const meta = ')).toEqual({})
  })

  test('a non-literal meta gives nothing, even when part of it is literal', async () => {
    expect(parseMeta("export const meta = { name: 'x', phases: makePhases() }")).toEqual({})
    expect(parseMeta('export const meta = { name: someVar }')).toEqual({})
    expect(parseMeta("export const meta = { name: 'a' + 'b' }")).toEqual({})
    expect(parseMeta('export const meta = { name: `x${1}` }')).toEqual({})
    expect(parseMeta("export const meta = { name: 'x', phases: [{ title: t }] }")).toEqual({})
    expect(parseMeta("export const meta = { ['name']: 'x' }")).toEqual({})
  })

  test('a __proto__ key is refused rather than assigned', async () => {
    expect(parseMeta("export const meta = { __proto__: { name: 'x' }, name: 'y' }")).toEqual({})
    expect(({} as { name?: string }).name).toBeUndefined()
  })

  test('nesting and size are bounded', async () => {
    const deep = `export const meta = { name: 'x', phases: ${'['.repeat(20)}${']'.repeat(20)} }`
    expect(parseMeta(deep)).toEqual({})
    const many = `export const meta = { phases: [${Array.from({ length: 900 }, () => "'p'").join(',')}] }`
    expect(parseMeta(many)).toEqual({})
  })

  test('phase titles that are not strings are skipped', async () => {
    expect(parseMeta("export const meta = { phases: [{ title: 3 }, { title: 'ok' }, null] }")).toEqual({
      phases: [{ title: 'ok' }],
    })
  })

  test('a workflow whose meta cannot be read still gets a run, named by the launch answer', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_w', script: 'export const meta = { name: nope() }' },
      { kind: 'workflow-launched', at: 2, toolUseId: 'toolu_w', runId: 'wf_9', name: 'from-result' },
    ])
    expect(f.runs.toolu_w).toMatchObject({ name: 'from-result', workflowRunId: 'wf_9' })
    expect(f.runs.toolu_w?.phases).toBeUndefined()
  })
})

describe('bounds', () => {
  // Each run ends and is announced, as `record` does: only an announced run is reduced.
  function oneRunPerTurn(count: number): Fleet {
    let f = emptyFleet()
    for (let i = 1; i <= count; i += 1) {
      f = announce(
        run(
          [
            { kind: 'turn-start' },
            spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `t${i}` }, { model: 'm', agentId: `a${i}` }, i * 10, undefined),
            { kind: 'step', at: i * 10 + 1, agentId: `a${i}`, index: 0, model: 'm', usage: usage(10, 5) },
            { kind: 'complete', at: i * 10 + 2, agentId: `a${i}`, answer: 'ok', isAborted: false, reason: 'answer', costUsd: i },
            GRACE_OUT,
          ],
          f,
        ),
        LATE,
      ).fleet
    }
    return f
  }

  test('RUNS_DETAILED + 1 runs reduce the oldest to a summary and drop its agents', async () => {
    const f = oneRunPerTurn(RUNS_DETAILED + 1)
    const oldest = f.runs['subagents:1']!
    expect(oldest.agentIds).toEqual([])
    expect(oldest.summary).toMatchObject({ name: 'Subagents · 00:00', total: 1, done: 1, failed: 0, tokens: 15 })
    expect(f.agents.a1).toBeUndefined()
    const newest = f.runs[`subagents:${RUNS_DETAILED + 1}`]!
    expect(newest.summary).toBeUndefined()
    expect(f.agents[`a${RUNS_DETAILED + 1}`]).toBeDefined()
    expect(runStats(f, oldest)).toMatchObject({ total: 1, done: 1, tokens: 15 })
  })

  test('exactly RUNS_DETAILED runs keep every agent', async () => {
    const f = oneRunPerTurn(RUNS_DETAILED)
    expect(Object.values(f.runs).every(r => r.summary === undefined)).toBe(true)
    expect(Object.keys(f.agents)).toHaveLength(RUNS_DETAILED)
  })

  test('a run with an agent still running keeps its agents however old it is', async () => {
    let f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'long' }, 1, undefined),
    ])
    f = run(
      Array.from({ length: RUNS_DETAILED + 2 }, (_, i): FleetEvent[] => [
        { kind: 'turn-start' },
        spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `n${i}` }, { model: 'm', agentId: `n${i}` }, 5 + i, undefined),
        { kind: 'complete', at: 6 + i, agentId: `n${i}`, answer: 'x', isAborted: false, reason: 'answer' },
      ]).flat(),
      f,
    )
    expect(f.runs['subagents:1']?.summary).toBeUndefined()
    expect(f.agents.long?.status).toBe('running')
  })

  test('a spawn into a summarized run brings its agents back and clears the summary', async () => {
    const base = run([{ kind: 'turn-start' }, { kind: 'workflow-start', at: 1, toolUseId: 'toolu_old', script: SCRIPT_3_PHASES }])
    const f1 = announce(
      run(
        [spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 2, undefined), { kind: 'complete', at: 3, agentId: 'w1', answer: 'x', isAborted: false, reason: 'answer' }, GRACE_OUT],
        base,
      ),
      LATE,
    ).fleet
    const aged = run(
      Array.from({ length: RUNS_DETAILED }, (_, i): FleetEvent[] => [
        { kind: 'turn-start' },
        spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `k${i}` }, { model: 'm', agentId: `k${i}` }, 10 + i, undefined),
      ]).flat(),
      f1,
    )
    expect(aged.runs.toolu_wf?.summary).toBeDefined()
    const reopened = run([spawnEventOf({ ...SPAWN_ALPHA, workflow: { runId: 'wf_276d27ad-539', agentIndex: 2 } }, { model: 'm', agentId: 'w2' }, 50, undefined)], aged)
    expect(reopened.runs.toolu_wf?.summary).toBeUndefined()
    expect(reopened.runs.toolu_wf?.agentIds).toEqual(['w2'])
  })

  test('the answer preview is capped at PREVIEW_CHARS on one line', async () => {
    const answer = `line one\n\nline two ${'x'.repeat(PREVIEW_CHARS * 3)}`
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 2, agentId: 'a1', answer, isAborted: false, reason: 'answer' },
    ])
    const preview = f.agents.a1?.answerPreview ?? ''
    expect(preview.length).toBe(PREVIEW_CHARS)
    expect(preview).not.toContain('\n')
    expect(preview.startsWith('line one line two')).toBe(true)
    expect(preview.endsWith('…')).toBe(true)
  })

  test('descriptions are capped too', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf({ ...SPAWN_LOOSE, description: 'd'.repeat(5000) }, { model: 'm', agentId: 'a1' }, 1, undefined),
    ])
    expect((f.agents.a1?.description ?? '').length).toBeLessThan(100)
  })
})

describe('band', () => {
  const finishedIn = (turnsAgo: number): Fleet => {
    let f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 2, agentId: 'a1', index: 0, model: 'm', usage: usage(1000, 410_000) },
      { kind: 'complete', at: 3, agentId: 'a1', answer: 'ok', isAborted: false, reason: 'answer' },
      GRACE_OUT,
    ])
    for (let i = 0; i < turnsAgo; i += 1) f = reduce(f, { kind: 'turn-start' })
    return f
  }

  test('nothing ever ran: hidden', async () => {
    expect(isBandVisible(emptyFleet())).toBe(false)
    expect(bandOf(emptyFleet(), 100)).toBeNull()
  })

  test('something running: visible with the counts', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 0, undefined),
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't2' }, { model: 'm', agentId: 'a2' }, 0, undefined),
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't3' }, { model: 'm', agentId: 'a3' }, 0, undefined),
      { kind: 'step', at: 1, agentId: 'a1', index: 0, model: 'm', usage: usage(200_000, 10_000) },
      { kind: 'complete', at: 2, agentId: 'a2', answer: 'ok', isAborted: false, reason: 'answer' },
      { kind: 'complete', at: 3, agentId: 'a3', answer: '', isAborted: true, reason: 'aborted' },
    ])
    const band = bandOf(f, 12 * 60_000)
    expect(band).toMatchObject({ tone: 'running', glyph: '◉', title: 'Subagents · 00:00' })
    expect(band?.parts).toEqual(['tasks 1/3', '1 running', '1 failed', '12m', '210k tok'])
  })

  test('finished in the last turn: visible', async () => {
    expect(isBandVisible(finishedIn(0))).toBe(true)
    const band = bandOf(finishedIn(0), 10_000)
    expect(band).toMatchObject({ tone: 'done', glyph: '✓' })
    expect(band?.parts).toEqual(['tasks 1/1', '0s', '411k tok'])
  })

  test('finished a turn ago or two turns ago: hidden', async () => {
    expect(isBandVisible(finishedIn(1))).toBe(false)
    expect(isBandVisible(finishedIn(2))).toBe(false)
    expect(bandOf(finishedIn(2), 10_000)).toBeNull()
  })

  test('a denied spawn is counted as denied and not as running', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_ALPHA, { deny: 'fanout-guard' }, 5, undefined),
      spawnEventOf({ ...SPAWN_ALPHA, workflow: { runId: 'wf_1', agentIndex: 2 } }, { model: 'm', agentId: 'w2' }, 6, undefined),
    ])
    const band = bandOf(f, 1000)
    expect(band?.tone).toBe('running')
    expect(band?.parts).toContain('1 denied')
    expect(band?.parts).toContain('1 running')
  })

  test('the band follows the run that is running, not the newest finished one', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 2, undefined),
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 3, undefined),
      { kind: 'complete', at: 4, agentId: 'a1', answer: 'x', isAborted: false, reason: 'answer' },
      GRACE_OUT,
    ])
    expect(bandOf(f, 5)?.title).toBe('three-phase')
  })
})

describe('formatting', () => {
  test('formatTokens', async () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(3100)).toBe('3.1k')
    expect(formatTokens(410_000)).toBe('410k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  test('formatElapsed', async () => {
    expect(formatElapsed(-5)).toBe('0s')
    expect(formatElapsed(45_000)).toBe('45s')
    expect(formatElapsed(12 * 60_000)).toBe('12m')
    expect(formatElapsed(65 * 60_000)).toBe('1h05m')
  })
})


describe('announce, clear and auto-open', () => {
  const failedRun = (): Fleet =>
    run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000, undefined),
      { kind: 'complete', at: 2000, agentId: 'a1', answer: '', isAborted: true, reason: 'aborted' },
      GRACE_OUT,
    ])

  test('a failure and the run end are each announced once, then the fleet has nothing more to say', async () => {
    const first = announce(failedRun(), LATE)
    expect(first.messages).toEqual([
      'Probe: trivial subagent failed',
      'Subagents · 00:00 finished · 0/1 done · 1 failed · 0:01 · 0 tok',
    ])
    expect(announce(first.fleet, LATE).messages).toEqual([])
  })

  test('nothing is announced while an agent still runs', async () => {
    const f = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000, undefined)])
    expect(announce(f, LATE).messages).toEqual([])
  })

  // A run is announced by what it ended with: the toast is due again only when
  // the outcome differs from the one last announced (reverses a451a64's "once per lifetime").
  test('a run that reopens and ends with another outcome is announced again', async () => {
    const ended = announce(failedRun(), LATE).fleet
    const reopened = run(
      [
        spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't2' }, { model: 'm', agentId: 'a2' }, 3000, undefined),
        { kind: 'complete', at: 4000, agentId: 'a2', answer: 'ok', isAborted: false, reason: 'answer' },
        GRACE_OUT,
      ],
      ended,
    )
    expect(reopened.runs['subagents:1']?.endedAt).toBe(4000)
    expect(announce(reopened, LATE).messages).toEqual(['Subagents · 00:00 finished · 1/2 done · 1 failed · 0:03 · 0 tok'])
  })

  test('announce never mutates its input', async () => {
    const f = failedRun()
    const frozen = JSON.stringify(f)
    announce(f, LATE)
    expect(JSON.stringify(f)).toBe(frozen)
  })

  test('clear drops finished runs with their agents and keeps a running one', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'old' }, 1000, undefined),
      { kind: 'complete', at: 2000, agentId: 'old', answer: 'ok', isAborted: false, reason: 'answer' },
      GRACE_OUT,
      { kind: 'turn-start' },
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't2' }, { model: 'm', agentId: 'live' }, 3000, undefined),
      { kind: 'clear' },
    ])
    expect(f.order).toEqual(['subagents:2'])
    expect(Object.keys(f.agents)).toEqual(['live'])
    expect(Object.keys(f.runs)).toEqual(['subagents:2'])
  })

  test('auto-opened is remembered in the state', async () => {
    expect(emptyFleet().hasAutoOpened).toBe(false)
    expect(run([{ kind: 'auto-opened' }]).hasAutoOpened).toBe(true)
  })

  test('formatClock reads m:ss, then h:mm:ss', async () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(79_000)).toBe('1:19')
    expect(formatClock(3_725_000)).toBe('1:02:05')
  })
})

describe('run end grace', () => {
  const phaseOneDone = (): Fleet =>
    run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 2, undefined),
      { kind: 'complete', at: 1000, agentId: 'w1', answer: 'x', isAborted: false, reason: 'answer' },
    ])

  test('the last agent ending leaves the run settling: no end recorded, nothing announced, still live', async () => {
    const f = phaseOneDone()
    expect(f.runs.toolu_wf).toMatchObject({ settlingAt: 1000 })
    expect(f.runs.toolu_wf?.endedAt).toBeUndefined()
    expect(announce(f, LATE).messages).toEqual([])
    expect(isAnyRunning(f)).toBe(true)
    expect(bandOf(f, 2000)).toMatchObject({ tone: 'running', glyph: '◉' })
  })

  test('expiring before the grace is out changes nothing; at the grace the end is the last completion', async () => {
    const early = reduce(phaseOneDone(), { kind: 'expire', at: 1000 + RUN_END_GRACE_MS - 1 })
    expect(early.runs.toolu_wf?.endedAt).toBeUndefined()
    const due = reduce(early, { kind: 'expire', at: 1000 + RUN_END_GRACE_MS })
    expect(due.runs.toolu_wf).toMatchObject({ endedAt: 1000, endedTurn: 1 })
    expect(due.runs.toolu_wf?.settlingAt).toBeUndefined()
    expect(announce(due, LATE).messages).toHaveLength(1)
    expect(isAnyRunning(due)).toBe(false)
  })

  test('a spawn of the same run inside the grace cancels the settling, so the stale expiry ends nothing', async () => {
    const reopened = reduce(
      phaseOneDone(),
      spawnEventOf({ ...SPAWN_ALPHA, workflow: { runId: 'wf_276d27ad-539', agentIndex: 2 } }, { model: 'm', agentId: 'w2' }, 4000, undefined),
    )
    expect(reopened.runs.toolu_wf?.settlingAt).toBeUndefined()
    const stale = reduce(reopened, { kind: 'expire', at: 1000 + RUN_END_GRACE_MS })
    expect(stale.runs.toolu_wf?.endedAt).toBeUndefined()
    expect(announce(stale, LATE).messages).toEqual([])
  })

  test('a settling run is never reduced to a summary however many runs follow it', async () => {
    const f = run(
      Array.from({ length: RUNS_DETAILED + 2 }, (_, i): FleetEvent[] => [
        { kind: 'turn-start' },
        spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `n${i}` }, { model: 'm', agentId: `n${i}` }, 5 + i, undefined),
      ]).flat(),
      phaseOneDone(),
    )
    expect(f.runs.toolu_wf?.summary).toBeUndefined()
    expect(f.agents.w1?.status).toBe('done')
  })
})

describe('lost agents', () => {
  const running = (): Fleet =>
    run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000, undefined),
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 'toolu_2' }, { model: 'm', agentId: 'a2' }, 1100, undefined),
      { kind: 'complete', at: 1500, agentId: 'a2', answer: 'ok', isAborted: false, reason: 'answer' },
    ])

  test('a lost agent is neither running nor done, and its run lets go of the band', async () => {
    const f = run([{ kind: 'lost', ids: ['a1'], at: 2000 }], running())
    expect(f.agents.a1).toMatchObject({ status: 'lost', endedAt: 2000 })
    const stats = runStats(f, f.runs['subagents:1']!)
    expect(stats).toMatchObject({ total: 2, running: 0, done: 1, lost: 1 })
    expect(bandOf(f, 3000)?.parts).toContain('1 lost')
    expect(isAnyRunning(f)).toBe(true)
    expect(isAnyRunning(reduce(f, GRACE_OUT))).toBe(false)
  })

  test('only an agent still running is lost: a finished one and an unknown id are left as they are', async () => {
    const f = run([{ kind: 'lost', ids: ['a2', 'nobody'], at: 2000 }], running())
    expect(f.agents.a2?.status).toBe('done')
    expect(f.agents.nobody).toBeUndefined()
  })

  test('the end of a run holding a lost agent says so', async () => {
    const f = run([{ kind: 'lost', ids: ['a1'], at: 2000 }, GRACE_OUT], running())
    expect(announce(f, LATE).messages).toEqual([expect.stringContaining('1/2 done · 1 lost')])
  })

  test('a lost agent survives the reduction of its run to a summary', async () => {
    const lost = announce(run([{ kind: 'lost', ids: ['a1'], at: 2000 }, GRACE_OUT], running()), LATE).fleet
    const f = run(
      Array.from({ length: RUNS_DETAILED }, (_, i): FleetEvent[] => [
        { kind: 'turn-start' },
        spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `n${i}` }, { model: 'm', agentId: `n${i}` }, 5000 + i, undefined),
      ]).flat(),
      lost,
    )
    expect(f.runs['subagents:1']?.summary).toMatchObject({ done: 1, lost: 1 })
  })

  test('unlistedRunning: running loose agents absent from the list, begun before it was taken', async () => {
    const f = running()
    expect(unlistedRunning(f, new Set(), 5000)).toEqual(['a1'])
    expect(unlistedRunning(f, new Set(['a1']), 5000)).toEqual([])
    expect(unlistedRunning(f, new Set(), 1000)).toEqual([])
  })

  test('unlistedRunning never names a workflow agent: the engine does not list them', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 1000, undefined),
    ])
    expect(f.agents.w1?.status).toBe('running')
    expect(unlistedRunning(f, new Set(), 5000)).toEqual([])
  })
})

describe('settling and the tick', () => {
  test('hasExpirable is true once a settling run\'s grace is out, and only then', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000, undefined),
      { kind: 'complete', at: 2000, agentId: 'a1', answer: 'ok', isAborted: false, reason: 'answer' },
    ])
    expect(f.runs['subagents:1']?.settlingAt).toBe(2000)
    expect(hasExpirable(f, 2000 + RUN_END_GRACE_MS - 1)).toBe(false)
    expect(hasExpirable(f, 2000 + RUN_END_GRACE_MS)).toBe(true)
    expect(hasExpirable(reduce(f, { kind: 'expire', at: 2000 + RUN_END_GRACE_MS }), 10 ** 12)).toBe(false)
  })
})

describe('state shape', () => {
  test('a new fleet is empty, with an empty pending buffer and no workflow alias', async () => {
    expect(emptyFleet()).toEqual({ runs: {}, agents: {}, pending: {}, workflowAlias: {}, order: [], hasAutoOpened: false, turn: 0 })
  })

  test('the reducer keeps what it is given', async () => {
    const f = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined)])
    expect(reduce(f, { kind: 'turn-start' }).order).toEqual(['subagents:1'])
  })
})

describe('agents no spawn names', () => {
  // Regression: 3326e3b — steps and tool calls of the engine's own forks (compaction, memory) drew phantom agents in a loose run
  test('a step or a tool call of an unknown id creates no agent and no run', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 10, agentId: 'fork1', index: 0, model: 'm', usage: usage(5, 5) },
      { kind: 'tool', at: 11, agentId: 'fork1', tool: 'Read' },
    ])
    expect(f.agents).toEqual({})
    expect(f.runs).toEqual({})
    expect(f.order).toEqual([])
    expect(isAnyRunning(f)).toBe(false)
    expect(bandOf(f, 20)).toBeNull()
  })

  // Regression: 3326e3b — a workflow agent's early step was parked in a loose run, and the tick then marked it lost
  test('a workflow agent stepped before its spawn is never parked in a loose run, so never lost', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 10, agentId: 'w1', index: 0, model: 'm', usage: usage(1, 1) },
    ])
    expect(unlistedRunning(f, new Set(), 10 ** 9)).toEqual([])

    const spawned = run([spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 20, undefined)], f)
    expect(spawned.agents.w1).toMatchObject({ status: 'running', runId: 'toolu_wf', tokensIn: 1, tokensOut: 1 })
    expect(spawned.order).toEqual(['toolu_wf'])
  })

  // Regression: 3326e3b — a spawn inherited the `lost` status of the agent record it found
  test('a spawn sets the agent running even when it was recorded lost before', async () => {
    const lost = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined)])
    const f = run(
      [{ kind: 'lost', ids: ['a1'], at: 5 }, spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 'again' }, { model: 'm', agentId: 'a1' }, 9, undefined)],
      lost,
    )
    expect(f.agents.a1?.status).toBe('running')
    expect(f.agents.a1?.endedAt).toBeUndefined()
  })

  test('what was seen before the spawn is adopted by it: usage, last tool and a completion', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 10, agentId: 'a1', turnId: 't', index: 0, model: 'claude-haiku-5-5', usage: usage(2, 3, 100, 40) },
      { kind: 'tool', at: 11, agentId: 'a1', tool: 'Bash' },
      { kind: 'complete', at: 12, agentId: 'a1', answer: 'ALPHA', isAborted: false, reason: 'answer' },
      spawnEventOf(SPAWN_LOOSE, { model: 'claude-haiku-5-5', agentId: 'a1' }, 5, undefined),
    ])
    expect(f.agents.a1).toMatchObject({
      status: 'done',
      tokensIn: 42,
      tokensOut: 3,
      lastInputTokens: 142,
      lastTool: 'Bash',
      answerPreview: 'ALPHA',
      endedAt: 12,
      startedAt: 5,
    })
    expect(f.pending).toEqual({})
  })

  test('the pending buffer drops an id after 60 s, so a late spawn starts from nothing', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 1000, agentId: 'a1', index: 0, model: 'm', usage: usage(9, 9) },
      { kind: 'expire', at: 1000 + 59_999 },
    ])
    expect(Object.keys(f.pending)).toEqual(['a1'])
    const dropped = reduce(f, { kind: 'expire', at: 1000 + 60_000 })
    expect(dropped.pending).toEqual({})
    const spawned = reduce(dropped, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000 + 60_001, undefined))
    expect(spawned.agents.a1).toMatchObject({ tokensIn: 0, tokensOut: 0 })
  })

  test('the pending buffer is capped, keeping the newest ids', async () => {
    const events: FleetEvent[] = Array.from({ length: PENDING_MAX + 10 }, (_, i): FleetEvent => ({
      kind: 'tool',
      at: 1000 + i,
      agentId: `fork${i}`,
      tool: 'Read',
    }))
    const f = run(events)
    expect(Object.keys(f.pending)).toHaveLength(PENDING_MAX)
    expect(f.pending[`fork${PENDING_MAX + 9}`]).toBeDefined()
    expect(f.pending.fork0).toBeUndefined()
  })
})

describe('workflow runs that go silent', () => {
  const IDLE = 30 * 60_000
  const launched = (): Fleet =>
    run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 1001, toolUseId: 'toolu_wf', runId: 'wf_1', name: 'three-phase' },
    ])

  // Regression: 3326e3b — a workflow whose end never reached the mod kept its agents running and its run live for ever
  test('after 30 min without an event its running agents are lost and the run ends', async () => {
    let f = run([spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 2000, undefined)], launched())
    expect(hasExpirable(f, 2000 + IDLE - 1)).toBe(false)
    f = reduce(f, { kind: 'expire', at: 2000 + IDLE - 1 })
    expect(f.agents.w1?.status).toBe('running')

    expect(hasExpirable(f, 2000 + IDLE)).toBe(true)
    f = reduce(f, { kind: 'expire', at: 2000 + IDLE })
    expect(f.agents.w1).toMatchObject({ status: 'lost', endedAt: 2000 + IDLE })
    expect(f.runs.toolu_wf?.settlingAt).toBe(2000 + IDLE)

    f = reduce(f, { kind: 'expire', at: 2000 + IDLE + RUN_END_GRACE_MS })
    expect(f.runs.toolu_wf?.endedAt).toBe(2000 + IDLE)
    expect(isAnyRunning(f)).toBe(false)
    expect(announce(f, LATE).messages).toEqual([expect.stringContaining('0/1 done · 1 lost')])
  })

  test('any event of the run restarts the silence: a step, a tool call', async () => {
    let f = run([spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 2000, undefined)], launched())
    f = run([{ kind: 'step', at: 2000 + IDLE - 5, agentId: 'w1', index: 0, model: 'm', usage: usage(1, 1) }], f)
    expect(hasExpirable(f, 2000 + IDLE)).toBe(false)
    f = run([{ kind: 'tool', at: 2000 + IDLE + 100, agentId: 'w1', tool: 'Bash' }], f)
    expect(reduce(f, { kind: 'expire', at: 2000 + IDLE + 200 }).agents.w1?.status).toBe('running')
  })

  // Regression: 3326e3b — a launched workflow that never spawned an agent stayed "waiting for the first agent" for ever
  test('a launched run that never had an agent ends after 30 min of silence', async () => {
    const f = launched()
    expect(hasExpirable(f, 1001 + IDLE - 1)).toBe(false)
    const ended = reduce(f, { kind: 'expire', at: 1001 + IDLE })
    expect(ended.runs.toolu_wf).toMatchObject({ endedAt: 1001 + IDLE, endedTurn: 1 })
    expect(isAnyRunning(ended)).toBe(false)
    expect(announce(ended, LATE).messages).toEqual(['three-phase did not start'])
  })

  test('a loose subagents run is never ended by silence: the engine lists its agents', async () => {
    const f = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000, undefined)])
    expect(hasExpirable(f, 1000 + 10 * IDLE)).toBe(false)
  })
})

describe('workflow agents without a Workflow call id', () => {
  // Regression: 3326e3b — a resumed or server-launched run has an empty tool_use_id; its agents opened a second run, split from the run's name and phases
  test('join the run known under the workflow\'s own id', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 2, toolUseId: 'toolu_wf', runId: 'wf_1', name: 'three-phase' },
      spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: '', workflow: { runId: 'wf_1', agentIndex: 1 } }, { model: 'm', agentId: 'w1' }, 3, undefined),
      spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: '', workflow: { runId: 'wf_1', agentIndex: 2 } }, { model: 'm', agentId: 'w2' }, 4, undefined),
    ])
    expect(f.order).toEqual(['toolu_wf'])
    expect(f.runs.toolu_wf).toMatchObject({ name: 'three-phase', agentIds: ['w1', 'w2'] })
  })

  test('with no run known yet they open one provisional run keyed by the workflow id and its start, and all stay in it', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: '', workflow: { runId: 'wf_9', agentIndex: 1 } }, { model: 'm', agentId: 'w1' }, 3, undefined),
      spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: '', workflow: { runId: 'wf_9', agentIndex: 2 } }, { model: 'm', agentId: 'w2' }, 4, undefined),
    ])
    expect(f.order).toEqual(['wf:wf_9:3'])
    expect(f.runs['wf:wf_9:3']).toMatchObject({ kind: 'workflow', workflowRunId: 'wf_9', provisional: true, agentIds: ['w1', 'w2'] })
    expect(f.workflowAlias).toEqual({ wf_9: 'wf:wf_9:3' })
  })

  test('a non-empty tool_use_id still names the run', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-launched', at: 2, toolUseId: 'toolu_other', runId: 'wf_1' },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 3, undefined),
    ])
    expect(f.order).toEqual(['toolu_wf'])
  })
})

describe('a real completion wins', () => {
  const finishedFromList = (): Fleet =>
    run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: false, reason: 'answer', source: 'list' },
    ])

  // Regression: 3326e3b — the engine's list said "completed" first, so the real turn.complete (answer, outcome) was dropped
  test('over a completion taken from the engine\'s list: the answer and the real outcome land', async () => {
    const f = run([{ kind: 'complete', at: 40, agentId: 'a1', answer: 'ALPHA', isAborted: false, reason: 'answer' }], finishedFromList())
    expect(f.agents.a1).toMatchObject({ status: 'done', answerPreview: 'ALPHA', endedAt: 40 })

    const aborted = run([{ kind: 'complete', at: 40, agentId: 'a1', answer: '', isAborted: true, reason: 'aborted' }], finishedFromList())
    expect(aborted.agents.a1?.status).toBe('failed')
  })

  test('over a loss', async () => {
    const started = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined)])
    const lost = run([{ kind: 'lost', ids: ['a1'], at: 30 }], started)
    const f = run([{ kind: 'complete', at: 40, agentId: 'a1', answer: 'ALPHA', isAborted: false, reason: 'answer' }], lost)
    expect(f.agents.a1).toMatchObject({ status: 'done', answerPreview: 'ALPHA' })
  })

  test('but a second real completion of an agent that has its answer changes nothing', async () => {
    const f = run(
      [
        { kind: 'complete', at: 40, agentId: 'a1', answer: 'first', isAborted: false, reason: 'answer' },
        { kind: 'complete', at: 60, agentId: 'a1', answer: 'second', isAborted: true, reason: 'aborted' },
      ],
      finishedFromList(),
    )
    expect(f.agents.a1).toMatchObject({ status: 'done', answerPreview: 'first', endedAt: 40 })
  })
})

describe('step index per turn', () => {
  // Regression: 3326e3b — the step index restarts with each turn; a new turn's step 0 was taken for a late step and the context size froze
  test('a step of a new turn updates the context size even at a lower index', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 2, agentId: 'a1', turnId: 't1', index: 6, model: 'm', usage: usage(0, 1, 0, 900) },
      { kind: 'step', at: 3, agentId: 'a1', turnId: 't2', index: 0, model: 'm', usage: usage(0, 1, 0, 120) },
    ])
    expect(f.agents.a1).toMatchObject({ lastInputTokens: 120, lastStepIndex: 0, lastTurnId: 't2' })
  })

  test('a late step of the same turn still does not roll the context size back', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 3, agentId: 'a1', turnId: 't1', index: 1, model: 'm', usage: usage(0, 1, 0, 900) },
      { kind: 'step', at: 2, agentId: 'a1', turnId: 't1', index: 0, model: 'm', usage: usage(0, 1, 0, 100) },
    ])
    expect(f.agents.a1).toMatchObject({ lastInputTokens: 900, lastStepIndex: 1 })
  })
})

describe('loose run titles', () => {
  test('formatLocalTime: UTC, a positive offset, a negative offset, across midnight both ways', async () => {
    const at = Date.UTC(2026, 9, 13, 18, 41)
    expect(formatLocalTime(at, 0)).toBe('18:41')
    expect(formatLocalTime(at, 120)).toBe('20:41')
    expect(formatLocalTime(at, -330)).toBe('13:11')
    expect(formatLocalTime(Date.UTC(2026, 9, 13, 23, 30), 60)).toBe('00:30')
    expect(formatLocalTime(Date.UTC(2026, 9, 13, 0, 5), -60)).toBe('23:05')
  })

  test('a loose run is named by its start time in the offset of the turn', async () => {
    const at = Date.UTC(2026, 9, 13, 18, 41)
    const f = run([{ kind: 'turn-start', tzOffsetMin: 120 }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, at, undefined)])
    expect(bandOf(f, at)?.title).toBe('Subagents · 20:41')
  })

  test('two loose runs of one session are told apart', async () => {
    const t1 = Date.UTC(2026, 9, 13, 18, 41)
    const t2 = Date.UTC(2026, 9, 13, 19, 7)
    const f = run([
      { kind: 'turn-start', tzOffsetMin: 0 },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, t1, undefined),
      { kind: 'turn-start' },
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 'toolu_2' }, { model: 'm', agentId: 'a2' }, t2, undefined),
    ])
    expect(f.order.map(id => f.runs[id]?.name)).toEqual(['Subagents · 18:41', 'Subagents · 19:07'])
  })

  test('a workflow run keeps its own name', async () => {
    const f = run([{ kind: 'turn-start', tzOffsetMin: 120 }, { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES }])
    expect(f.runs.toolu_wf?.name).toBe('three-phase')
  })
})

// A spawn of a workflow run whose Workflow call id the engine left empty.
const emptyIdSpawn = (runId: string, agentIndex: number, agentId: string, at: number, costUsd?: number): FleetEvent =>
  spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: '', workflow: { runId, agentIndex } }, { model: 'm', agentId }, at, costUsd)

// A spawn of a workflow run under the given Workflow call id.
const callSpawn = (toolUseId: string, runId: string, agentIndex: number, agentId: string, at: number): FleetEvent =>
  spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: toolUseId, workflow: { runId, agentIndex } }, { model: 'm', agentId }, at, undefined)

const done = (agentId: string, at: number, costUsd?: number): FleetEvent => ({
  kind: 'complete',
  at,
  agentId,
  answer: 'ok',
  isAborted: false,
  reason: 'answer',
  costUsd,
})

describe('a run split before the launch is known', () => {
  // Regression: a451a64 — an empty-id spawn before workflow-launched opened a run of its own, and later spawns landed in either run
  test('the launch merges the stray run into the Workflow call\'s run, and later spawns join it', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
      emptyIdSpawn('wf_1', 1, 'w1', 3),
      emptyIdSpawn('wf_1', 2, 'w2', 4),
      { kind: 'workflow-launched', at: 5, toolUseId: 'toolu_wf', runId: 'wf_1' },
      emptyIdSpawn('wf_1', 3, 'w3', 6),
    ])
    expect(f.order).toEqual(['toolu_wf'])
    expect(f.runs.wf_1).toBeUndefined()
    expect(f.runs.toolu_wf).toMatchObject({ name: 'three-phase', workflowRunId: 'wf_1', startedAt: 1 })
    expect([...(f.runs.toolu_wf?.agentIds ?? [])].sort()).toEqual(['w1', 'w2', 'w3'])
    expect(['w1', 'w2', 'w3'].map(id => f.agents[id]?.runId)).toEqual(['toolu_wf', 'toolu_wf', 'toolu_wf'])
  })

  // Regression: a451a64 — a merge must keep the earliest start and cost sample and the highest end cost
  test('the merge keeps the earliest start, the first cost sample and the highest end cost', async () => {
    const f = run([
      { kind: 'turn-start' },
      emptyIdSpawn('wf_1', 1, 'w1', 0, 4),
      done('w1', 2, 6.5),
      { kind: 'workflow-start', at: 5, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES, costUsd: 5 },
      { kind: 'workflow-launched', at: 6, toolUseId: 'toolu_wf', runId: 'wf_1' },
      emptyIdSpawn('wf_1', 2, 'w2', 7),
      done('w2', 8, 6.2),
    ])
    expect(f.order).toEqual(['toolu_wf'])
    expect(f.runs.toolu_wf?.startedAt).toBe(0)
    expect(Math.abs((runStats(f, f.runs.toolu_wf!).costUsd ?? -1) - 2.5)).toBeLessThan(1e-6)
  })
})

describe('which run an empty-id spawn joins', () => {
  // Regression: a451a64 — the first run carrying the workflow id was taken, not the newest live one
  test('the run of the latest Workflow call launched under the id, while it is open', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 5, toolUseId: 'toolu_a', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 6, toolUseId: 'toolu_a', runId: 'wf_1' },
      callSpawn('toolu_a', 'wf_1', 1, 'a1', 10),
      { kind: 'workflow-start', at: 15, toolUseId: 'toolu_b', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 16, toolUseId: 'toolu_b', runId: 'wf_1' },
      callSpawn('toolu_b', 'wf_1', 2, 'b1', 20),
      emptyIdSpawn('wf_1', 3, 'x1', 30),
    ])
    expect(f.runs.toolu_a?.agentIds).toEqual(['a1'])
    expect(f.runs.toolu_b?.agentIds).toEqual(['b1', 'x1'])
  })

  // Regression: a451a64 — an older unended run lost to a newer ended one, or the reverse
  // Open, or ended less than REJOIN_WINDOW_MS ago, the latest launched run is the one joined (reverses a451a64's "an ended run is never joined": the ended run reopens, the alias decides)
  test('the latest launched run is joined even ended, never an older run of the id still open', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 5, toolUseId: 'toolu_a', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 6, toolUseId: 'toolu_a', runId: 'wf_1' },
      callSpawn('toolu_a', 'wf_1', 1, 'a1', 10),
      { kind: 'workflow-start', at: 15, toolUseId: 'toolu_b', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 16, toolUseId: 'toolu_b', runId: 'wf_1' },
      callSpawn('toolu_b', 'wf_1', 2, 'b1', 20),
      done('b1', 21),
      { kind: 'expire', at: 21 + RUN_END_GRACE_MS },
      emptyIdSpawn('wf_1', 3, 'x1', 30 + RUN_END_GRACE_MS),
    ])
    expect(f.runs.toolu_a?.agentIds).toEqual(['a1'])
    expect(f.runs.toolu_b?.agentIds).toEqual(['b1', 'x1'])
    expect(f.runs.toolu_b?.endedAt).toBeUndefined()
    expect(f.order).toEqual(['toolu_a', 'toolu_b'])
  })

  // Regression: a451a64 — a spawn reopened a run already reduced to a summary and wiped the summary
  test('never a summarized run: it opens a fresh one and the summary stays', async () => {
    const ended = announce(run([{ kind: 'turn-start' }, callSpawn('toolu_a', 'wf_1', 1, 'a1', 10), done('a1', 11), GRACE_OUT]), LATE).fleet
    const f = run(
      [
        ...Array.from({ length: RUNS_DETAILED }, (_, i): FleetEvent[] => [
          { kind: 'turn-start' },
          spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `n${i}` }, { model: 'm', agentId: `n${i}` }, 100 + i, undefined),
        ]).flat(),
        emptyIdSpawn('wf_1', 2, 'x1', 200),
      ],
      ended,
    )
    expect(f.runs.toolu_a?.summary).toBeDefined()
    expect(f.runs.toolu_a?.agentIds).toEqual([])
    const home = f.agents.x1?.runId
    expect(home).not.toBe('toolu_a')
    expect(f.runs[home ?? '']).toMatchObject({ kind: 'workflow', agentIds: ['x1'] })
  })
})

describe('an agent that was only silent', () => {
  const IDLE = 30 * 60_000
  const silent = (): Fleet =>
    run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 1001, toolUseId: 'toolu_wf', runId: 'wf_1' },
      spawnEventOf(SPAWN_ALPHA, { model: 'm', agentId: 'w1' }, 2000, undefined),
      { kind: 'expire', at: 2000 + IDLE },
      { kind: 'expire', at: 2000 + IDLE + RUN_END_GRACE_MS },
    ])

  // Regression: a451a64 — idle expiry marked a silent but alive agent lost for good
  test('a step revives a lost agent and reopens its run', async () => {
    const lost = silent()
    expect(lost.agents.w1?.status).toBe('lost')
    expect(lost.runs.toolu_wf?.endedAt).toBeDefined()

    const f = reduce(lost, { kind: 'step', at: 2000 + IDLE + 60_000, agentId: 'w1', index: 0, model: 'm', usage: usage(1, 1) })
    expect(f.agents.w1).toMatchObject({ status: 'running' })
    expect(f.agents.w1?.endedAt).toBeUndefined()
    expect(f.runs.toolu_wf?.endedAt).toBeUndefined()
    expect(f.runs.toolu_wf?.settlingAt).toBeUndefined()
    expect(isAnyRunning(f)).toBe(true)
  })

  // Regression: a451a64 — a tool call of a lost agent left it lost
  test('a tool call revives a lost agent', async () => {
    const f = reduce(silent(), { kind: 'tool', at: 2000 + IDLE + 60_000, agentId: 'w1', tool: 'Bash' })
    expect(f.agents.w1).toMatchObject({ status: 'running', lastTool: 'Bash' })
    expect(isAnyRunning(f)).toBe(true)
  })

  // The lost end was premature: the real outcome differs, so it is announced too (reverses a451a64's "toasts once").
  test('a run that ended with a lost agent is announced again when the agent comes back and finishes', async () => {
    const ended = announce(silent(), LATE)
    expect(ended.messages).toEqual([expect.stringContaining('0/1 done · 1 lost')])

    const back = run(
      [{ kind: 'tool', at: 2000 + IDLE + 60_000, agentId: 'w1', tool: 'Bash' }, done('w1', 2000 + IDLE + 90_000), GRACE_OUT],
      ended.fleet,
    )
    expect(back.agents.w1?.status).toBe('done')
    expect(back.runs.toolu_wf?.endedAt).toBeDefined()
    const again = announce(back, LATE)
    expect(again.messages).toEqual([expect.stringContaining('three-phase finished · 1/1 done')])
    expect(announce(again.fleet, LATE).messages).toEqual([])
  })
})

describe('a real completion over a list-derived failure', () => {
  const killedByList = (): Fleet =>
    run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: false, reason: 'failed', source: 'list' },
    ])

  // Regression: a451a64 — only a done agent with no answer yielded to the real completion; a failed one stayed failed
  test('replaces a failed agent with no answer: outcome, answer and the real end time land', async () => {
    const before = killedByList()
    expect(before.agents.a1).toMatchObject({ status: 'failed', answerPreview: undefined })

    const f = reduce(before, { kind: 'complete', at: 80, agentId: 'a1', answer: 'ALPHA', isAborted: false, reason: 'answer' })
    expect(f.agents.a1).toMatchObject({ status: 'done', answerPreview: 'ALPHA', endedAt: 80 })
  })

  test('a failed agent that has its answer is left as it is', async () => {
    const f = run(
      [
        { kind: 'complete', at: 60, agentId: 'a1', answer: 'boom', isAborted: true, reason: 'aborted' },
        { kind: 'complete', at: 80, agentId: 'a1', answer: 'late', isAborted: false, reason: 'answer' },
      ],
      killedByList(),
    )
    // The real failure confirmed the list's: its answer landed, the earlier end stayed.
    expect(f.agents.a1).toMatchObject({ status: 'failed', answerPreview: 'boom', endedAt: 50 })
  })
})

describe('the pending buffer keeps what was seen last', () => {
  // Regression: a451a64 — the 60 s counted from the first sighting, so an id seen steadily was dropped while still being heard from
  test('a step, a tool call or a completion renews the id\'s time to live', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 1000, agentId: 'a1', index: 0, model: 'm', usage: usage(1, 1) },
      { kind: 'tool', at: 30_000, agentId: 'a1', tool: 'Bash' },
      { kind: 'step', at: 55_000, agentId: 'a1', index: 1, model: 'm', usage: usage(1, 1) },
      { kind: 'expire', at: 70_000 },
    ])
    expect(Object.keys(f.pending)).toEqual(['a1'])
    expect(reduce(f, { kind: 'expire', at: 55_000 + 60_000 }).pending).toEqual({})

    const completed = run([
      { kind: 'step', at: 1000, agentId: 'a2', index: 0, model: 'm', usage: usage(1, 1) },
      done('a2', 50_000),
      { kind: 'expire', at: 90_000 },
    ])
    expect(Object.keys(completed.pending)).toEqual(['a2'])
  })

  // Regression: a451a64 — a completion parked before its spawn lost its cost and the run showed none
  test('a parked completion keeps its cost and the adopting spawn applies it', async () => {
    const f = run([
      { kind: 'turn-start' },
      done('a1', 40, 6.9),
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 30, 6.8),
    ])
    expect(f.agents.a1?.status).toBe('done')
    expect(Math.abs((runStats(f, f.runs['subagents:1']!).costUsd ?? -1) - 0.1)).toBeLessThan(1e-6)
  })
})

describe('a late step of an earlier turn', () => {
  // Regression: a451a64 — a step of another turn was always taken as the latest, so a late one rolled the context size and turn back
  test('does not overwrite the context size or the turn of a later step', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 10, agentId: 'a1', turnId: 't2', index: 0, model: 'm', usage: usage(0, 1, 0, 900) },
      { kind: 'step', at: 5, agentId: 'a1', turnId: 't1', index: 5, model: 'm', usage: usage(0, 1, 0, 100) },
    ])
    expect(f.agents.a1).toMatchObject({ lastInputTokens: 900, lastTurnId: 't2', lastStepIndex: 0, tokensIn: 1000, tokensOut: 2 })
  })

  test('the same holds before the spawn names the agent', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 10, agentId: 'a1', turnId: 't2', index: 0, model: 'm', usage: usage(0, 1, 0, 900) },
      { kind: 'step', at: 5, agentId: 'a1', turnId: 't1', index: 5, model: 'm', usage: usage(0, 1, 0, 100) },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 11, undefined),
    ])
    expect(f.agents.a1).toMatchObject({ lastInputTokens: 900, lastTurnId: 't2' })
  })

  test('within one turn a later step with a lower index is still refused', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 10, agentId: 'a1', turnId: 't1', index: 3, model: 'm', usage: usage(0, 1, 0, 900) },
      { kind: 'step', at: 11, agentId: 'a1', turnId: 't1', index: 1, model: 'm', usage: usage(0, 1, 0, 100) },
    ])
    expect(f.agents.a1).toMatchObject({ lastInputTokens: 900, lastStepIndex: 3 })
  })
})

describe('a run is one attempt', () => {
  const HOURS_4 = 4 * 3_600_000
  const firstAttempt = (): Fleet =>
    announce(
      run([
        { kind: 'turn-start' },
        { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_1', script: SCRIPT_3_PHASES, costUsd: 1 },
        { kind: 'workflow-launched', at: 1001, toolUseId: 'toolu_1', runId: 'wf_1' },
        callSpawn('toolu_1', 'wf_1', 1, 'w1', 1002),
        done('w1', 2000, 2),
        { kind: 'expire', at: 2000 + RUN_END_GRACE_MS },
      ]),
      LATE,
    ).fleet

  // Regression: 065c839 — a resumed workflow (new Workflow call, same run id) had the previous attempt's ended run merged in: no end toast, hours of elapsed time, unrelated spend in its cost
  test('a resumed workflow gets a run of its own: its own start, its own cost, its own end toast', async () => {
    const f = run(
      [
        { kind: 'workflow-start', at: HOURS_4, toolUseId: 'toolu_2', script: SCRIPT_3_PHASES, costUsd: 50 },
        { kind: 'workflow-launched', at: HOURS_4 + 1, toolUseId: 'toolu_2', runId: 'wf_1' },
        callSpawn('toolu_2', 'wf_1', 1, 'w2', HOURS_4 + 2),
        done('w2', HOURS_4 + 60_000, 51),
        { kind: 'expire', at: HOURS_4 + 60_000 + RUN_END_GRACE_MS },
      ],
      firstAttempt(),
    )
    expect(f.order).toEqual(['toolu_1', 'toolu_2'])
    expect(f.runs.toolu_1).toMatchObject({ agentIds: ['w1'], endedAt: 2000 })
    expect(f.runs.toolu_2).toMatchObject({ startedAt: HOURS_4, agentIds: ['w2'], endedAt: HOURS_4 + 60_000 })
    expect(Math.abs((runStats(f, f.runs.toolu_2!).costUsd ?? -1) - 1)).toBeLessThan(1e-6)
    expect(announce(f, LATE).messages).toEqual(['three-phase finished · 1/1 done · 1:00 · 0 tok'])
  })

  // Regression: 065c839 — an empty-id spawn of a resumed workflow reopened the previous attempt's ended run
  test('an empty-id spawn of the resumed workflow joins the new call\'s run, never the ended one', async () => {
    const f = run(
      [
        { kind: 'workflow-start', at: HOURS_4, toolUseId: 'toolu_2', script: SCRIPT_3_PHASES },
        { kind: 'workflow-launched', at: HOURS_4 + 1, toolUseId: 'toolu_2', runId: 'wf_1' },
        emptyIdSpawn('wf_1', 2, 'w2', HOURS_4 + 2),
      ],
      firstAttempt(),
    )
    expect(f.agents.w2?.runId).toBe('toolu_2')
    expect(f.runs.toolu_1).toMatchObject({ agentIds: ['w1'], endedAt: 2000 })
  })

  // An ended run the alias names is joined and reopened within REJOIN_WINDOW_MS (6c5d7eb, bounded by 862e3a4's fix); a provisional run opens once the alias names no run, or one ended longer ago
  test('an empty-id spawn after the attempt\'s run was cleared opens a provisional run', async () => {
    const cleared = reduce(firstAttempt(), { kind: 'clear' })
    expect(cleared.workflowAlias).toEqual({})
    const f = run([emptyIdSpawn('wf_1', 2, 'x1', 50_000), emptyIdSpawn('wf_1', 3, 'x2', 50_001)], cleared)
    expect(f.runs['wf:wf_1:50000']).toMatchObject({ kind: 'workflow', provisional: true, workflowRunId: 'wf_1', agentIds: ['x1', 'x2'] })
    expect(f.order).toEqual(['wf:wf_1:50000'])
  })

  // Regression: 065c839 — the launch merged every run of the workflow id into the new call's run, an ended one included
  test('the launch folds only a provisional run still open and unannounced', async () => {
    const ended = announce(
      run([
        { kind: 'turn-start' },
        emptyIdSpawn('wf_1', 1, 'x1', 3),
        done('x1', 4),
        { kind: 'expire', at: 4 + RUN_END_GRACE_MS },
      ]),
      LATE,
    ).fleet
    const f = run(
      [
        { kind: 'workflow-start', at: 100_000, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
        { kind: 'workflow-launched', at: 100_001, toolUseId: 'toolu_wf', runId: 'wf_1' },
      ],
      ended,
    )
    expect(f.runs['wf:wf_1:3']).toMatchObject({ agentIds: ['x1'], endedAt: 4 })
    expect(f.runs.toolu_wf?.agentIds).toEqual([])
    expect(f.workflowAlias).toEqual({ wf_1: 'toolu_wf' })
  })
})

describe('a run end is announced by its outcome', () => {
  const phaseOneEnded = (): Fleet =>
    announce(
      run([
        { kind: 'turn-start' },
        { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_wf', script: SCRIPT_3_PHASES },
        callSpawn('toolu_wf', 'wf_1', 1, 'w1', 1000),
        done('w1', 2000),
        { kind: 'expire', at: 2000 + RUN_END_GRACE_MS },
      ]),
      LATE,
    ).fleet

  // Regression: 065c839 — the first, premature end was the only one ever announced; the real outcome of the reopened run was not
  test('a premature end that reopens and ends with another outcome is announced again', async () => {
    const f = run(
      [
        callSpawn('toolu_wf', 'wf_1', 2, 'w2', 30_000),
        { kind: 'complete', at: 40_000, agentId: 'w2', answer: '', isAborted: true, reason: 'aborted' },
        { kind: 'expire', at: 40_000 + RUN_END_GRACE_MS },
      ],
      phaseOneEnded(),
    )
    expect(announce(f, LATE).messages).toEqual(['probe:alpha failed', 'three-phase finished · 1/2 done · 1 failed · 0:39 · 0 tok'])
  })

  test('an end with an unchanged outcome is never announced twice', async () => {
    const listed = announce(
      run([
        { kind: 'turn-start' },
        spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
        { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: false, reason: 'answer', source: 'list' },
        { kind: 'expire', at: 50 + RUN_END_GRACE_MS },
      ]),
      LATE,
    )
    expect(listed.messages).toEqual([expect.stringContaining('1/1 done')])
    const real = run([done('a1', 80), { kind: 'expire', at: 80 + RUN_END_GRACE_MS }], listed.fleet)
    // The confirming completion keeps the list's end: the run never reopened (6c5d7eb).
    expect(real.runs['subagents:1']?.endedAt).toBe(50)
    expect(announce(real, LATE).messages).toEqual([])
  })
})

describe('an outcome taken from the engine\'s list', () => {
  const failedByList = (): Fleet =>
    run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: true, reason: 'killed', source: 'list' },
    ])

  // Regression: 065c839 — a failure taken from the engine's list was toasted at once, before the real turn.complete could correct it
  test('a list failure is not announced before the grace has passed with it still standing', async () => {
    const f = failedByList()
    expect(announce(f, 50).messages).toEqual([])
    expect(announce(f, 50 + RUN_END_GRACE_MS - 1).messages).toEqual([])
    expect(f.agents.a1).toMatchObject({ status: 'failed', outcomeSource: 'list' })

    const corrected = reduce(f, done('a1', 60))
    expect(corrected.agents.a1).toMatchObject({ status: 'done', outcomeSource: 'real' })
    expect(announce(reduce(corrected, GRACE_OUT), LATE).messages).toEqual(['Subagents · 00:00 finished · 1/1 done · 0:00 · 0 tok'])

    const standing = reduce(f, { kind: 'expire', at: 50 + RUN_END_GRACE_MS })
    expect(announce(standing, 50 + RUN_END_GRACE_MS).messages).toEqual([
      'Probe: trivial subagent failed',
      'Subagents · 00:00 finished · 0/1 done · 1 failed · 0:00 · 0 tok',
    ])
  })

  // Regression: 065c839 — an empty answer stood for "taken from the list", so a real completion with no answer was overwritten by a later one
  test('a real completion with an empty answer is real: a later completion does not overwrite it', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: true, reason: 'aborted' },
      done('a1', 80),
    ])
    expect(f.agents.a1).toMatchObject({ status: 'failed', endedAt: 50, outcomeSource: 'real' })
    expect(f.agents.a1?.answerPreview).toBeUndefined()
  })

  test('a list outcome never overrides a real one', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      done('a1', 50),
      { kind: 'complete', at: 60, agentId: 'a1', answer: '', isAborted: true, reason: 'killed', source: 'list' },
    ])
    expect(f.agents.a1).toMatchObject({ status: 'done', answerPreview: 'ok', endedAt: 50, outcomeSource: 'real' })
  })
})

describe('a sighting of a lost agent', () => {
  const lostAt200 = (): Fleet =>
    run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'step', at: 100, agentId: 'a1', turnId: 't', index: 1, model: 'm', usage: usage(1, 1) },
      { kind: 'lost', ids: ['a1'], at: 200 },
    ])

  // Regression: 065c839 — a late step (seen before the agent's latest step) still revived a lost agent, so it flapped running/lost
  test('a late step counts its tokens but does not revive the agent', async () => {
    const f = reduce(lostAt200(), { kind: 'step', at: 50, agentId: 'a1', turnId: 't', index: 0, model: 'm', usage: usage(5, 5) })
    expect(f.agents.a1).toMatchObject({ status: 'lost', endedAt: 200, tokensIn: 6, tokensOut: 6 })
    expect(f.runs['subagents:1']?.settlingAt).toBe(200)
  })

  // Regression: 065c839 — a step or tool call seen before the loss was taken as proof the agent lived on after it
  test('a step or a tool call from before the loss does not revive it either', async () => {
    const stepped = reduce(lostAt200(), { kind: 'step', at: 150, agentId: 'a1', turnId: 't', index: 2, model: 'm', usage: usage(1, 1) })
    expect(stepped.agents.a1?.status).toBe('lost')
    const tooled = reduce(lostAt200(), { kind: 'tool', at: 150, agentId: 'a1', tool: 'Bash' })
    expect(tooled.agents.a1).toMatchObject({ status: 'lost', lastTool: 'Bash' })
  })

  test('a step or a tool call after the loss revives it and reopens its run', async () => {
    const stepped = reduce(lostAt200(), { kind: 'step', at: 300, agentId: 'a1', turnId: 't', index: 2, model: 'm', usage: usage(1, 1) })
    expect(stepped.agents.a1?.status).toBe('running')
    expect(stepped.runs['subagents:1']?.settlingAt).toBeUndefined()
    const tooled = reduce(lostAt200(), { kind: 'tool', at: 300, agentId: 'a1', tool: 'Bash' })
    expect(tooled.agents.a1?.status).toBe('running')
  })
})

describe('an attempt with empty call ids across a phase gap', () => {
  const GAP = RUN_END_GRACE_MS + 5_000

  // Regression: 6c5d7eb — the alias was followed only while its run was open, so an attempt with empty call ids split into a new run at every phase gap longer than the grace
  test('a spawn after the gap rejoins the ended provisional run and reopens it', async () => {
    const f = run([
      { kind: 'turn-start' },
      emptyIdSpawn('wf_1', 1, 'x1', 1000),
      done('x1', 2000),
      { kind: 'expire', at: 2000 + RUN_END_GRACE_MS },
      emptyIdSpawn('wf_1', 2, 'x2', 2000 + GAP),
    ])
    expect(f.order).toEqual(['wf:wf_1:1000'])
    expect(f.runs['wf:wf_1:1000']?.agentIds).toEqual(['x1', 'x2'])
    expect(f.runs['wf:wf_1:1000']?.endedAt).toBeUndefined()
    expect(isAnyRunning(f)).toBe(true)
  })

  // Regression: 6c5d7eb — the same split hit a launched attempt: its next empty-id phase opened a provisional run beside it
  test('a launched attempt rejoins its own run too; only a new launch starts another', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_1', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 1001, toolUseId: 'toolu_1', runId: 'wf_1' },
      emptyIdSpawn('wf_1', 1, 'x1', 1002),
      done('x1', 2000),
      { kind: 'expire', at: 2000 + RUN_END_GRACE_MS },
      emptyIdSpawn('wf_1', 2, 'x2', 2000 + GAP),
    ])
    expect(f.order).toEqual(['toolu_1'])
    expect(f.runs.toolu_1?.agentIds).toEqual(['x1', 'x2'])
    expect(f.runs.toolu_1?.endedAt).toBeUndefined()
  })
})

describe('a run is reduced to a summary only once announced', () => {
  // Newer runs, each still running, that push the first run out of the detailed window.
  const newerRuns = (): FleetEvent[] =>
    Array.from({ length: RUNS_DETAILED }, (_, i): FleetEvent[] => [
      { kind: 'turn-start' },
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `n${i}` }, { model: 'm', agentId: `n${i}` }, 100 + i, undefined),
    ]).flat()

  // Regression: 6c5d7eb — bound() reduced a run to a summary in the same reduce that ended it, so announce() never saw its end nor its due list failure
  test('the reduce that ends a run out of the window leaves it for announce, the next one reduces it', async () => {
    const settling = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: true, reason: 'killed', source: 'list' },
      ...newerRuns(),
    ])
    const ended = reduce(settling, { kind: 'expire', at: 50 + RUN_END_GRACE_MS })
    const said = announce(ended, 50 + RUN_END_GRACE_MS)
    expect(said.messages).toEqual(['Probe: trivial subagent failed', 'Subagents · 00:00 finished · 0/1 done · 1 failed · 0:00 · 0 tok'])

    const bounded = reduce(said.fleet, { kind: 'expire', at: 50 + RUN_END_GRACE_MS + 1 })
    expect(bounded.runs['subagents:1']?.summary).toMatchObject({ total: 1, failed: 1 })
    expect(bounded.agents.a1).toBeUndefined()
  })
})

describe('a denied spawn of an attempt with empty call ids', () => {
  const deniedEmpty = (runId: string, agentIndex: number, at: number): FleetEvent =>
    spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: '', workflow: { runId, agentIndex } }, { deny: 'refused' }, at, undefined)

  // Regression: 6c5d7eb — the denied row's id was `denied:<workflow run id>#<index>`, so the same index denied in the next attempt took over the first attempt's row
  test('the same index denied in two attempts is two rows, one in each run', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_1', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 2, toolUseId: 'toolu_1', runId: 'wf_1' },
      deniedEmpty('wf_1', 1, 3),
      { kind: 'expire', at: 3 + RUN_END_GRACE_MS },
      { kind: 'workflow-start', at: 100_000, toolUseId: 'toolu_2', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 100_001, toolUseId: 'toolu_2', runId: 'wf_1' },
      deniedEmpty('wf_1', 1, 100_002),
    ])
    const [first] = f.runs.toolu_1?.agentIds ?? []
    const [second] = f.runs.toolu_2?.agentIds ?? []
    expect(first).not.toBe(second)
    expect(f.agents[first ?? '']?.runId).toBe('toolu_1')
    expect(f.agents[second ?? '']?.runId).toBe('toolu_2')
    expect(runStats(f, f.runs.toolu_1!).denied).toBe(1)
    expect(runStats(f, f.runs.toolu_2!).denied).toBe(1)
  })
})

describe('a real completion that confirms the list\'s outcome', () => {
  // Regression: 6c5d7eb — a real completion with the status the list already gave moved the end to its own time and reopened the ended run
  test('keeps the end where it was and leaves the run ended; the answer and the source land', async () => {
    const ended = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: false, reason: 'answer', source: 'list' },
      { kind: 'expire', at: 50 + RUN_END_GRACE_MS },
    ])
    const f = reduce(ended, done('a1', 80))
    expect(f.agents.a1).toMatchObject({ status: 'done', endedAt: 50, answerPreview: 'ok', outcomeSource: 'real' })
    expect(f.runs['subagents:1']).toMatchObject({ endedAt: 50 })
    expect(f.runs['subagents:1']?.settlingAt).toBeUndefined()
  })
})

describe('a loss against a later sighting', () => {
  const spawned = (): Fleet => run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined)])

  // Regression: 6c5d7eb — a loss taken at `at` overrode a step or a tool call seen after it, so an agent seen alive after the list was taken was recorded lost
  test('an agent stepped or calling a tool after the loss\'s instant is not lost', async () => {
    const stepped = run(
      [
        { kind: 'step', at: 300, agentId: 'a1', turnId: 't', index: 0, model: 'm', usage: usage(1, 1) },
        { kind: 'lost', ids: ['a1'], at: 200 },
      ],
      spawned(),
    )
    expect(stepped.agents.a1?.status).toBe('running')
    const tooled = run(
      [
        { kind: 'tool', at: 300, agentId: 'a1', tool: 'Bash' },
        { kind: 'lost', ids: ['a1'], at: 200 },
      ],
      spawned(),
    )
    expect(tooled.agents.a1?.status).toBe('running')
  })

  test('one last sighted before the loss is lost', async () => {
    const f = run(
      [
        { kind: 'tool', at: 100, agentId: 'a1', tool: 'Bash' },
        { kind: 'lost', ids: ['a1'], at: 200 },
      ],
      spawned(),
    )
    expect(f.agents.a1).toMatchObject({ status: 'lost', endedAt: 200 })
  })

  test('a sighting before the spawn named the agent counts against a loss too', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'tool', at: 300, agentId: 'a1', tool: 'Bash' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, undefined),
      { kind: 'lost', ids: ['a1'], at: 200 },
    ])
    expect(f.agents.a1?.status).toBe('running')
    expect(f.agents.a1?.lastSeenAt).toBe(300)
  })

  test('the latest of a step and a tool call is the sighting a loss is weighed against', async () => {
    const f = run(
      [
        { kind: 'step', at: 300, agentId: 'a1', turnId: 't', index: 0, model: 'm', usage: usage(1, 1) },
        { kind: 'tool', at: 250, agentId: 'a1', tool: 'Bash' },
      ],
      spawned(),
    )
    expect(f.agents.a1?.lastSeenAt).toBe(300)
    expect(reduce(f, { kind: 'lost', ids: ['a1'], at: 299 }).agents.a1?.status).toBe('running')
    expect(reduce(f, { kind: 'lost', ids: ['a1'], at: 301 }).agents.a1?.status).toBe('lost')
  })
})

describe('an ended run is rejoined by an empty-id spawn only within the rejoin window', () => {
  const HOURS_4 = 4 * 3_600_000
  // A launched attempt whose spawns carry empty call ids, ended at 2000 and announced.
  const endedAt2000 = (): Fleet =>
    announce(
      run([
        { kind: 'turn-start' },
        { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_1', script: SCRIPT_3_PHASES },
        { kind: 'workflow-launched', at: 1001, toolUseId: 'toolu_1', runId: 'wf_1' },
        emptyIdSpawn('wf_1', 1, 'x1', 1002),
        done('x1', 2000),
        { kind: 'expire', at: 2000 + RUN_END_GRACE_MS },
      ]),
      LATE,
    ).fleet

  test('a phase gap of 20 s rejoins and reopens the run', async () => {
    const f = run([emptyIdSpawn('wf_1', 2, 'x2', 22_000)], endedAt2000())
    expect(f.order).toEqual(['toolu_1'])
    expect(f.runs.toolu_1?.agentIds).toEqual(['x1', 'x2'])
    expect(f.runs.toolu_1?.endedAt).toBeUndefined()
  })

  test('a spawn just inside the window still rejoins; one at the window opens a provisional run', async () => {
    const inside = run([emptyIdSpawn('wf_1', 2, 'x2', 2000 + REJOIN_WINDOW_MS - 1)], endedAt2000())
    expect(inside.agents.x2?.runId).toBe('toolu_1')

    const at = 2000 + REJOIN_WINDOW_MS
    const outside = run([emptyIdSpawn('wf_1', 2, 'x2', at)], endedAt2000())
    expect(outside.agents.x2?.runId).toBe(`wf:wf_1:${at}`)
    expect(outside.runs[`wf:wf_1:${at}`]).toMatchObject({ provisional: true, agentIds: ['x2'] })
    expect(outside.runs.toolu_1).toMatchObject({ agentIds: ['x1'], endedAt: 2000 })
  })

  // Regression: 862e3a4 — an empty-id spawn of a resumed attempt arriving before its launch rejoined the previous attempt's ended run, however old: it reopened and toasted again
  test('a resume 4 h later: its pre-launch spawn opens a provisional run the launch folds in, the old run untouched', async () => {
    const first = endedAt2000()
    const preLaunch = run(
      [
        { kind: 'workflow-start', at: HOURS_4, toolUseId: 'toolu_2', script: SCRIPT_3_PHASES },
        emptyIdSpawn('wf_1', 1, 'y1', HOURS_4 + 2),
      ],
      first,
    )
    expect(preLaunch.runs.toolu_1).toMatchObject({ agentIds: ['x1'], endedAt: 2000 })
    expect(preLaunch.agents.y1?.runId).toBe(`wf:wf_1:${HOURS_4 + 2}`)

    const f = run(
      [
        { kind: 'workflow-launched', at: HOURS_4 + 3, toolUseId: 'toolu_2', runId: 'wf_1' },
        emptyIdSpawn('wf_1', 2, 'y2', HOURS_4 + 4),
      ],
      preLaunch,
    )
    expect(f.order).toEqual(['toolu_1', 'toolu_2'])
    expect(f.runs.toolu_1).toMatchObject({ agentIds: ['x1'], endedAt: 2000 })
    expect(f.runs.toolu_2).toMatchObject({ agentIds: ['y1', 'y2'], startedAt: HOURS_4 })
    expect(f.workflowAlias).toEqual({ wf_1: 'toolu_2' })
    expect(announce(f, LATE).messages).toEqual([])

    const over = run([done('y1', HOURS_4 + 60_000), done('y2', HOURS_4 + 60_000), GRACE_OUT], f)
    expect(announce(over, LATE).messages).toEqual(['three-phase finished · 2/2 done · 1:00 · 0 tok'])
  })
})

describe('a denied spawn of a resume inside the rejoin window', () => {
  const deniedEmpty = (runId: string, agentIndex: number, at: number): FleetEvent =>
    spawnEventOf({ ...SPAWN_ALPHA, tool_use_id: '', workflow: { runId, agentIndex } }, { deny: 'refused' }, at, undefined)

  // Regression: 862e3a4 — a resume's pre-launch spawn inside the window joins the previous run, and the same index denied again took over the previous attempt's denied row
  test('the same index denied again is a second row, not the first one overwritten', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_1', script: SCRIPT_3_PHASES },
      { kind: 'workflow-launched', at: 2, toolUseId: 'toolu_1', runId: 'wf_1' },
      deniedEmpty('wf_1', 1, 3),
      { kind: 'expire', at: 3 + RUN_END_GRACE_MS },
      { kind: 'workflow-start', at: 30_000, toolUseId: 'toolu_2', script: SCRIPT_3_PHASES },
      deniedEmpty('wf_1', 1, 30_001),
      { kind: 'workflow-launched', at: 30_002, toolUseId: 'toolu_2', runId: 'wf_1' },
    ])
    const denied = Object.values(f.agents).filter(a => a.status === 'denied')
    expect(denied).toHaveLength(2)
    expect(new Set(denied.map(a => a.endedAt))).toEqual(new Set([3, 30_001]))
  })
})

describe('a loose run that recorded no agent', () => {
  // Regression: 862e3a4 — a loose run with no member never ended, so bound() could drop neither it nor any run after it
  test('does not hold the bound: past RUNS_KEPT the oldest runs are still dropped', async () => {
    let f = run([{ kind: 'turn-start' }, spawnEventOf(SPAWN_LOOSE, { model: 'm' }, 1, undefined)])
    for (let i = 1; i <= RUNS_KEPT + 2; i += 1) {
      f = announce(
        run(
          [
            { kind: 'turn-start' },
            spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `t${i}` }, { model: 'm', agentId: `a${i}` }, i * 10, undefined),
            done(`a${i}`, i * 10 + 1),
            GRACE_OUT,
          ],
          f,
        ),
        LATE,
      ).fleet
    }
    f = reduce(f, GRACE_OUT)
    expect(f.order).toHaveLength(RUNS_KEPT)
    expect(f.runs['subagents:1']).toBeUndefined()
  })
})

describe('a kept end keeps its cost sample', () => {
  // Regression: 862e3a4 — a real completion confirming the list's outcome kept the earlier end but raised the run's end cost to its own, later sample
  test('a known agent: the run cost stays at the samples up to the kept end', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't0' }, { model: 'm', agentId: 'a0' }, 1, 1),
      spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 't1' }, { model: 'm', agentId: 'a1' }, 2, 1),
      done('a0', 40, 3),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: false, reason: 'answer', source: 'list' },
      done('a1', 80, 9),
    ])
    expect(f.agents.a1).toMatchObject({ endedAt: 50, outcomeSource: 'real' })
    expect(Math.abs((runStats(f, f.runs['subagents:1']!).costUsd ?? -1) - 2)).toBeLessThan(1e-6)
  })

  // Regression: 862e3a4 — the same, for an agent no spawn had named yet: the parked end kept its time but took the later cost
  test('an agent still pending: the parked end keeps its own cost', async () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: false, reason: 'answer', source: 'list', costUsd: 3 },
      done('a1', 80, 9),
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 30, 1),
    ])
    expect(f.agents.a1).toMatchObject({ status: 'done', endedAt: 50, outcomeSource: 'real', answerPreview: 'ok' })
    expect(Math.abs((runStats(f, f.runs['subagents:1']!).costUsd ?? -1) - 2)).toBeLessThan(1e-6)
  })

  test('a completion that moves the end still raises the end cost', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1, 1),
      { kind: 'complete', at: 50, agentId: 'a1', answer: '', isAborted: true, reason: 'killed', source: 'list' },
      done('a1', 80, 9),
    ])
    expect(f.agents.a1).toMatchObject({ status: 'done', endedAt: 80 })
    expect(Math.abs((runStats(f, f.runs['subagents:1']!).costUsd ?? -1) - 8)).toBeLessThan(1e-6)
  })
})

describe('the bound reads what is announced before counting a run', () => {
  test('an ended run never announced is neither reduced nor dropped', async () => {
    let f = run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a0' }, 1, undefined),
      done('a0', 2),
      GRACE_OUT,
    ])
    for (let i = 1; i <= RUNS_KEPT + 1; i += 1) {
      f = announce(
        run(
          [
            { kind: 'turn-start' },
            spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: `t${i}` }, { model: 'm', agentId: `a${i}` }, i * 10, undefined),
            done(`a${i}`, i * 10 + 1),
            GRACE_OUT,
          ],
          { ...f, runs: { ...f.runs, 'subagents:1': { ...f.runs['subagents:1']!, announced: undefined } } },
        ),
        LATE,
      ).fleet
    }
    expect(f.runs['subagents:1']?.summary).toBeUndefined()
    expect(f.agents.a0).toBeDefined()
  })
})

describe('an agent that ends its turn and is woken again', () => {
  // A background agent stops at 12 s while its own background work runs, is
  // woken by the task's notification, and ends for good at 130 s.
  const firstStop = (): Fleet =>
    run([
      { kind: 'turn-start' },
      spawnEventOf(SPAWN_LOOSE, { model: 'm', agentId: 'a1' }, 1000, undefined),
      { kind: 'step', at: 5000, agentId: 'a1', turnId: 't1', index: 0, model: 'm', usage: usage(1, 1) },
      done('a1', 13_000),
      GRACE_OUT,
    ])

  // Regression: 7279aeb — a step after the first end left the agent done, its elapsed time and its run's frozen at the first stop
  test('a step after its end sets it running again and reopens its run; the next completion is its end', async () => {
    const stopped = firstStop()
    expect(stopped.agents.a1).toMatchObject({ status: 'done', endedAt: 13_000 })

    const woken = reduce(stopped, { kind: 'step', at: 60_000, agentId: 'a1', turnId: 't2', index: 0, model: 'm', usage: usage(1, 1) })
    expect(woken.agents.a1?.status).toBe('running')
    expect(woken.agents.a1?.endedAt).toBeUndefined()
    expect(woken.runs['subagents:1']?.endedAt).toBeUndefined()
    expect(isAnyRunning(woken)).toBe(true)

    const ended = run([done('a1', 131_000), GRACE_OUT], woken)
    expect(ended.agents.a1).toMatchObject({ status: 'done', endedAt: 131_000 })
    const stats = runStats(ended, ended.runs['subagents:1']!)
    expect(formatClock((stats.endedAt ?? 0) - stats.startedAt)).toBe('2:10')
  })

  test('a tool call or a wake of its loop after its end sets it running again', async () => {
    expect(reduce(firstStop(), { kind: 'tool', at: 60_000, agentId: 'a1', tool: 'Bash' }).agents.a1?.status).toBe('running')
    expect(reduce(firstStop(), { kind: 'wake', at: 60_000, agentId: 'a1' }).agents.a1?.status).toBe('running')
  })

  test('a sighting that predates the end says nothing: the agent stays done', async () => {
    const f = reduce(firstStop(), { kind: 'tool', at: 12_000, agentId: 'a1', tool: 'Bash' })
    expect(f.agents.a1).toMatchObject({ status: 'done', endedAt: 13_000 })
  })

  test('a woken agent that ends with the same outcome is not announced twice', async () => {
    const first = announce(firstStop(), LATE)
    expect(first.messages).toHaveLength(1)
    const again = run(
      [{ kind: 'step', at: 60_000, agentId: 'a1', turnId: 't2', index: 0, model: 'm', usage: usage(1, 1) }, done('a1', 131_000), GRACE_OUT],
      first.fleet,
    )
    expect(announce(again, LATE).messages).toEqual([])
  })

  test('a resume spawn of a finished agent keeps it in its own run and sets it running', async () => {
    const f = run(
      [
        { kind: 'turn-start' },
        spawnEventOf(
          { ...SPAWN_LOOSE, tool_use_id: 'toolu_msg', description: 'resumed', resume: { agentId: 'a1' } },
          { model: 'm', agentId: 'a1' },
          60_000,
          undefined,
          59_000,
        ),
      ],
      firstStop(),
    )
    expect(f.agents.a1).toMatchObject({ status: 'running', runId: 'subagents:1', startedAt: 1000, description: 'Probe: trivial subagent' })
    expect(f.order).toEqual(['subagents:1'])
    expect(f.runs['subagents:1']?.endedAt).toBeUndefined()
  })

  test('a resume whose run already ended again before its result keeps that end', async () => {
    const f = run(
      [
        { kind: 'turn-start' },
        spawnEventOf({ ...SPAWN_LOOSE, tool_use_id: 'toolu_msg', resume: { agentId: 'a1' } }, { model: 'm', agentId: 'a1' }, 60_000, undefined, 10_000),
      ],
      firstStop(),
    )
    expect(f.agents.a1).toMatchObject({ status: 'done', endedAt: 13_000 })
  })
})
