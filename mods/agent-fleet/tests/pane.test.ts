import { describe, expect, test } from 'claude-code/testing'

import type { Fleet } from '../types'
import { emptyFleet, reduce, spawnEventOf } from '../hooks/fleet'
import type { FleetEvent } from '../hooks/fleet'
import { fit, paneLines, tierOf } from '../hooks/pane'
import type { Line } from '../hooks/pane'

const run = (events: FleetEvent[], from: Fleet = emptyFleet()): Fleet => events.reduce(reduce, from)
const text = (line: Line): string => line.map(seg => seg.text).join('')
const rows = (lines: Line[]): string[] => lines.map(text)
const indexOfRow = (all: string[], needle: string): number => all.findIndex(row => row.includes(needle))

const NOW = 100_000

const SCRIPT = `export const meta = {
  name: 'review-changes',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Report' }],
}
`

function spawn(id: string, description: string, model: string, at: number, workflow = true) {
  return spawnEventOf(
    {
      tool_use_id: 'toolu_wf',
      description,
      subagentType: workflow ? 'workflow-subagent' : 'general-purpose',
      background: false,
      workflow: workflow ? { runId: 'wf_1', agentIndex: at } : undefined,
    },
    { model, agentId: id },
    at,
    undefined,
  )
}

function workflowFleet(): Fleet {
  return run([
    { kind: 'turn-start' },
    { kind: 'step', at: 1, index: 0, model: 'claude-opus-5-5', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, window: 1_000_000 },
    { kind: 'workflow-start', at: 1000, toolUseId: 'toolu_wf', script: SCRIPT, costUsd: 6.8 },
    { kind: 'workflow-launched', at: 1001, toolUseId: 'toolu_wf', runId: 'wf_1', name: 'review-changes' },
    spawn('a1', 'scan the diff', 'claude-opus-5-5', 1100),
    spawn('a2', 'review module A', 'claude-sonnet-5-5', 1200),
    spawn('a3', 'review module B', 'claude-haiku-5-5', 1300),
    spawn('a4', 'second opinion', 'claude-fable-5', 1400),
    { kind: 'step', at: 1500, agentId: 'a1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', usage: { input: 10, output: 600, cacheRead: 0, cacheCreation: 59_990 } },
    { kind: 'tool', at: 1600, agentId: 'a1', tool: 'Bash' },
    { kind: 'step', at: 1700, agentId: 'a2', index: 0, model: 'claude-sonnet-5-5', effort: 'high', usage: { input: 5, output: 20, cacheRead: 0, cacheCreation: 500 } },
    { kind: 'complete', at: 40_000, agentId: 'a2', answer: 'Module A is fine\nno findings', isAborted: false, reason: 'answer', costUsd: 7.05 },
    { kind: 'complete', at: 50_000, agentId: 'a3', answer: '', isAborted: true, reason: 'aborted', costUsd: 7.06 },
  ])
}

describe('tierOf', () => {
  test('the resolved model family picks the glyph, four distinct shapes', () => {
    expect(tierOf('claude-fable-5')).toEqual({ name: 'fable', glyph: '★' })
    expect(tierOf('claude-opus-5-5')).toEqual({ name: 'opus', glyph: '▲' })
    expect(tierOf('claude-sonnet-5-5')).toEqual({ name: 'sonnet', glyph: '◆' })
    expect(tierOf('claude-haiku-5-5')).toEqual({ name: 'haiku', glyph: '●' })
    expect(tierOf('')).toEqual({ name: 'unknown', glyph: '·' })
    expect(tierOf('future-model-x').name).toBe('future-model-x')
  })
})

describe('fit', () => {
  test('cuts the last segment with an ellipsis and keeps the earlier ones', () => {
    const out = fit([{ text: 'abcd' }, { text: 'efghij', dim: true }], 7)
    expect(text(out)).toBe('abcdef…')
    expect(out[1]?.dim).toBe(true)
  })
})

describe('pane layout', () => {
  test('empty: a hint and nothing else', () => {
    expect(rows(paneLines(emptyFleet(), NOW, 80))).toEqual([
      'No agents yet. Subagents and workflow runs of this session appear here.',
    ])
  })

  test('one running agent: header, tiles, tier glyph and name, effort, tool, ctx, tokens, elapsed', () => {
    const f = run([
      { kind: 'turn-start' },
      { kind: 'step', at: 1, index: 0, model: 'claude-opus-5-5', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, window: 1_000_000 },
      spawn('a1', 'scan the diff', 'claude-opus-5-5', 1000, false),
      { kind: 'step', at: 1100, agentId: 'a1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', usage: { input: 10, output: 600, cacheRead: 4000, cacheCreation: 55_990 } },
      { kind: 'tool', at: 1200, agentId: 'a1', tool: 'Bash' },
    ])
    const all = rows(paneLines(f, 1000 + 79_000, 80))
    expect(all[0]).toBe('Subagents · 00:00')
    expect(all[1]).toBe('[ Tokens 57k ]  [ Time 1:19 ]')
    expect(all).toContain('Running · 1')
    expect(all).toContain(' ◉ ▲ scan the diff')
    expect(all).toContain('     opus · xhigh')
    expect(all).toContain('     Bash · ctx 6% · 57k · 1:19')
    expect(all.join('\n')).not.toContain('Done')
    expect(all.join('\n')).not.toContain('Cost')
  })

  test('full workflow: sections in order, cost tile, phases, one-line previews, failed expanded', () => {
    const all = rows(paneLines(workflowFleet(), NOW, 100))
    expect(all[0]).toBe('review-changes')
    expect(all[1]).toContain('[ Cost ≈$0.26 ]')
    expect(all[1]).toContain('[ Tokens ')
    expect(all[1]).toContain('[ Time 1:39 ]')

    const order = ['Running · 2', 'Phases · 3', 'Done · 1', 'Failed · 1'].map(h => indexOfRow(all, h))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    expect(all[indexOfRow(all, 'Phases · 3') + 1]).toBe('   Scan › Review › Report')
    expect(all).toContain(' ✓ review module A · 0:38 · 525 — Module A is fine no findings')
    expect(all).toContain(' ✗ ● review module B')
    expect(all.join('\n')).toContain(' ◉ ★ second opinion')
    expect(all.join('\n')).toContain('     fable')
  })

  test('the cost tile is absent when the run has no cost delta', () => {
    const f = run([
      { kind: 'turn-start' },
      spawn('a1', 'x', 'claude-haiku-5-5', 1, false),
      { kind: 'complete', at: 2, agentId: 'a1', answer: 'ok', isAborted: false, reason: 'answer', costUsd: 5 },
    ])
    expect(rows(paneLines(f, NOW, 80))[1]).not.toContain('Cost')
  })

  test('11 phases overflow: as many titles as the width allows, the rest counted, never wider than the pane', () => {
    const phases = Array.from({ length: 11 }, (_, i) => `{ title: 'Phase number ${i + 1}' }`).join(', ')
    const f = run([
      { kind: 'turn-start' },
      { kind: 'workflow-start', at: 1, toolUseId: 'toolu_wf', script: `export const meta = { name: 'big', phases: [${phases}] }` },
    ])
    const lines = rows(paneLines(f, NOW, 60))
    const header = indexOfRow(lines, 'Phases · 11')
    expect(header).toBeGreaterThan(0)
    const list = lines[header + 1] ?? ''
    expect(list).toMatch(/^ {3}Phase number 1 › Phase number 2/)
    expect(list).toMatch(/ \+\d+ more$/)
    expect(list.length).toBeLessThanOrEqual(60)
    const shown = list.split(' › ').length
    expect(list).toContain(`+${11 - shown} more`)
  })

  test('a denied spawn is a Denied row with its reason, never a running one', () => {
    const f = run([
      { kind: 'turn-start' },
      spawnEventOf(
        { tool_use_id: 'toolu_x', description: 'fourth agent', subagentType: 'general-purpose', background: true },
        { deny: 'fanout-guard: 3 agents is the limit' },
        1,
        undefined,
      ),
    ])
    const all = rows(paneLines(f, NOW, 80))
    expect(all).toContain('Denied · 1')
    expect(all).toContain(' ⊘ fourth agent — fanout-guard: 3 agents is the limit')
    expect(all.join('\n')).not.toContain('Running')
  })

  test('60 columns: no line is wider, whatever the description or preview', () => {
    const long = 'x'.repeat(200)
    const f = run(
      [
        { kind: 'turn-start' },
        spawn('l1', long, 'claude-opus-5-5', 1000, false),
        spawn('l2', long, 'claude-haiku-5-5', 1001, false),
        { kind: 'complete', at: 2000, agentId: 'l2', answer: long, isAborted: false, reason: 'answer' },
        { kind: 'tool', at: 1500, agentId: 'l1', tool: long },
      ],
      workflowFleet(),
    )
    const lines = paneLines(f, NOW, 60)
    expect(lines.length).toBeGreaterThanOrEqual(10)
    for (const line of lines) expect(text(line).length).toBeLessThanOrEqual(60)
    expect(rows(lines).some(row => row.endsWith('…'))).toBe(true)
  })

  test('earlier runs are one collapsed line each under a divider, newest first', () => {
    const f = run([
      { kind: 'turn-start' },
      spawn('o1', 'old one', 'claude-haiku-5-5', 1000, false),
      { kind: 'complete', at: 4000, agentId: 'o1', answer: 'ok', isAborted: false, reason: 'answer' },
      { kind: 'turn-start' },
      spawn('o2', 'old two', 'claude-haiku-5-5', 5000, false),
      { kind: 'complete', at: 8000, agentId: 'o2', answer: 'ok', isAborted: false, reason: 'answer' },
      { kind: 'expire', at: 60_000 },
      { kind: 'turn-start' },
      spawn('n1', 'current', 'claude-opus-5-5', 9000, false),
    ])
    const all = rows(paneLines(f, NOW, 80))
    const divider = indexOfRow(all, '── earlier runs ──')
    expect(divider).toBeGreaterThan(0)
    expect(all.slice(divider + 1)).toEqual([' ▸ Subagents · 00:00 · 1/1 · 0:03 · 0 tok', ' ▸ Subagents · 00:00 · 1/1 · 0:03 · 0 tok'])
    expect(all.join('\n')).not.toContain('old one')
  })

  test('colours are theme tokens only: success and error, nothing else', () => {
    const tones = new Set<string>()
    for (const line of paneLines(workflowFleet(), NOW, 100)) for (const seg of line) if (seg.tone !== undefined) tones.add(seg.tone)
    expect([...tones].sort()).toEqual(['error', 'success'])
  })
})

describe('lost agents in the pane', () => {
  test('a lost agent is a dim "? <desc> · lost" row under a Lost section, never under Running', async () => {
    const f = run([
      { kind: 'turn-start' },
      spawn('g1', 'gone agent', 'claude-haiku-5-5', 10, false),
      { kind: 'lost', ids: ['g1'], at: 20 },
    ])
    const lines = paneLines(f, NOW, 100)
    const all = rows(lines)
    const lostAt = indexOfRow(all, 'Lost · 1')
    expect(lostAt).toBeGreaterThan(-1)
    expect(all[lostAt + 1]).toBe(' ? gone agent · lost')
    expect(lines[lostAt + 1]?.every(seg => seg.dim === true)).toBe(true)
    expect(indexOfRow(all, 'Running')).toBe(-1)
  })
})
