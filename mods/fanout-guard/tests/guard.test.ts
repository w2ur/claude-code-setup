import { expect, test } from 'claude-code/testing'

import { isFanOut, overThreshold, untilReset } from '../hooks/guard'

test('overThreshold names only the windows past their threshold', async () => {
  expect(overThreshold([{ kind: 'five_hour', percentUsed: 84 }, { kind: 'seven_day', percentUsed: 89 }], 0)).toBeUndefined()
  expect(overThreshold([{ kind: 'five_hour', percentUsed: 85 }], 0)).toBe('5h at 85%')
  expect(overThreshold([{ kind: 'five_hour', percentUsed: 60 }, { kind: 'seven_day', percentUsed: 91 }], 0)).toBe('7d at 91%')
  expect(overThreshold([{ kind: 'spend_limit', percentUsed: 99 }], 0)).toBeUndefined()
})

test('a 7d reset reads as days, never as a clock time', async () => {
  const resetsAt = new Date(4 * 86_400_000 + 2 * 3_600_000).toISOString()
  expect(overThreshold([{ kind: 'seven_day', percentUsed: 91, resetsAt }], 0)).toBe('7d at 91% (resets in 4d2h)')
  expect(untilReset(43 * 60_000)).toBe('43m')
})

test('isFanOut: every Workflow, and the second Agent of a turn', async () => {
  expect(isFanOut('Workflow', 0)).toBe(true)
  expect(isFanOut('Agent', 1)).toBe(false)
  expect(isFanOut('Agent', 2)).toBe(true)
  expect(isFanOut('Bash', 5)).toBe(false)
})

test('a Workflow under the thresholds runs without a question', async ($, on) => {
  on("session.usage", () => ({ value: {
    startedAt: 0,
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
  } }))
  let ran = false
  on('tool.call', { tool: 'Workflow' }, () => {
    ran = true
    return { result: "done", text: "done" }
  })
  const result = await $.tool.call({ tool: 'Workflow', tool_use_id: 't1', script: 'x' })
  expect(ran).toBe(true)
  expect(result.deny).toBeUndefined()
})

test('a Workflow past 5h 85% is held when the question is dismissed', async ($, on) => {
  on("session.usage", () => ({ value: {
    startedAt: 0,
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 90 }],
  } }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: "dismissed" }))
  on("clock.now", () => ({ value: 0 }))
  let ran = false
  on('tool.call', { tool: 'Workflow' }, () => {
    ran = true
    return { result: "done", text: "done" }
  })
  const result = await $.tool.call({ tool: 'Workflow', tool_use_id: 't2', script: 'x' })
  expect(ran).toBe(false)
  expect(String(result.deny ?? result.text)).toContain('5h at 90%')
})

// Documents the contract rather than guarding the catch: the engine also skips
// a hook that throws, so this passes with or without gate()'s try/catch.
test('a Workflow runs when usage cannot be read', async ($, on) => {
  on("session.usage", () => ({ deny: 'no reading' }))
  let ran = false
  on('tool.call', { tool: 'Workflow' }, () => {
    ran = true
    return { result: "done", text: "done" }
  })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 't3', script: 'x' })
  expect(ran).toBe(true)
})
