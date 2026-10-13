import { expect, test } from 'claude-code/testing'

import { emptyFleet, reduce, runStats, spawnEventOf } from '../hooks/fleet'
import type { FleetEvent } from '../hooks/fleet'

// No property-testing library is available in the mod runtime (no package
// manager), so this is a hand-rolled property test: a seeded PRNG builds a
// random scenario, a seeded Fisher-Yates shuffle orders its events, and the
// invariant is checked for 200 seeds. A failure names its seed; rerun that seed.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

type Scenario = { events: FleetEvent[]; expectedIn: Map<string, number>; expectedOut: Map<string, number> }

function scenario(random: () => number): Scenario {
  const int = (max: number): number => Math.floor(random() * (max + 1))
  const events: FleetEvent[] = []
  const expectedIn = new Map<string, number>()
  const expectedOut = new Map<string, number>()
  const agents = 1 + int(7)

  for (let n = 0; n < agents; n += 1) {
    const agentId = `a${n}`
    const isWorkflow = random() < 0.5
    events.push(
      spawnEventOf(
        {
          tool_use_id: isWorkflow ? 'toolu_wf' : `toolu_${n}`,
          description: `agent ${n}`,
          subagentType: isWorkflow ? 'workflow-subagent' : 'general-purpose',
          background: random() < 0.5,
          workflow: isWorkflow ? { runId: 'wf_1', agentIndex: n + 1 } : undefined,
        },
        { model: 'claude-haiku-5-5', agentId },
        100 + n,
        undefined,
      ),
    )
    let tokensIn = 0
    let tokensOut = 0
    for (let index = 0; index <= int(4); index += 1) {
      const usage = { input: int(5), output: int(900), cacheRead: int(50_000), cacheCreation: int(50_000) }
      tokensIn += usage.input + usage.cacheCreation
      tokensOut += usage.output
      events.push({ kind: 'step', at: 200 + index, agentId, index, model: 'claude-haiku-5-5', usage })
      if (random() < 0.5) events.push({ kind: 'tool', at: 200 + index, agentId, tool: 'Bash' })
    }
    events.push({ kind: 'complete', at: 300 + n, agentId, answer: `answer ${n}`, isAborted: false, reason: 'answer' })
    expectedIn.set(agentId, tokensIn)
    expectedOut.set(agentId, tokensOut)
  }
  // The main loop's own steps must never leak into any agent's tokens.
  events.push({ kind: 'step', at: 50, index: 0, model: 'claude-opus-5-5', usage: { input: 9, output: 9, cacheRead: 9, cacheCreation: 9 }, window: 1_000_000 })
  return { events, expectedIn, expectedOut }
}

test('token totals (input + cache creation + output, no cache reads) equal the sum of step usages for any event order (200 seeded shuffles)', async () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = mulberry32(seed)
    const { events, expectedIn, expectedOut } = scenario(random)
    const ordered = shuffle(events, random)

    // One turn start first: a turn boundary mid-stream would legitimately
    // move placeholders between per-turn runs, which is not under test here.
    const fleet = [{ kind: 'turn-start' } as FleetEvent, ...ordered, { kind: 'expire', at: 10 ** 12 } as FleetEvent].reduce(reduce, emptyFleet())

    const label = `seed ${seed}`
    let sumIn = 0
    let sumOut = 0
    for (const [agentId, tokensIn] of expectedIn) {
      const agent = fleet.agents[agentId]
      expect(agent?.tokensIn, `${label} ${agentId} in`).toBe(tokensIn)
      expect(agent?.tokensOut, `${label} ${agentId} out`).toBe(expectedOut.get(agentId))
      expect(agent?.status, `${label} ${agentId} status`).toBe('done')
      sumIn += tokensIn
      sumOut += expectedOut.get(agentId) ?? 0
    }
    expect(Object.keys(fleet.agents).length, `${label} agent count`).toBe(expectedIn.size)

    const viaRuns = Object.values(fleet.runs).reduce((sum, run) => sum + runStats(fleet, run).tokens, 0)
    expect(viaRuns, `${label} run totals`).toBe(sumIn + sumOut)
    expect(Object.values(fleet.runs).every(run => run.agentIds.length === 0 || run.endedAt !== undefined), `${label} runs ended`).toBe(true)
  }
})
