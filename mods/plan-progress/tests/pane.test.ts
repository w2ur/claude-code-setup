import { expect, test } from 'claude-code/testing'

import { paneLines } from '../hooks/pane'
import type { Line } from '../hooks/pane'
import type { PlanView } from '../hooks/views'

const text = (line: Line): string => line.map(seg => seg.text).join('')

const TASKS = ['1', '2', '3', '4', '5'].map((id, i) => ({ id, title: `Step ${id}`, isDone: i < 2 }))

const running: PlanView = {
  file: 'a.md',
  title: 'Session watch',
  status: 'running',
  done: 2,
  total: 5,
  current: { id: '3', title: 'Step 3' },
  repo: 'claude',
  ageMs: 60_000,
  siblings: ['a-spec.md'],
  tasks: TASKS,
}

const stalled: PlanView = { ...running, file: 'b.md', title: 'Old plan', status: 'stalled', done: 1, ageMs: 3 * 86_400_000 }

test('a running plan draws done/total and the three marks', () => {
  const rows = paneLines([running], 80).map(text)
  expect(rows.some(r => r.includes('Session watch') && r.includes('2/5') && r.includes('claude'))).toBe(true)
  expect(rows.filter(r => r.includes('✓'))).toHaveLength(2)
  expect(rows.filter(r => r.includes('▸'))).toHaveLength(1)
  expect(rows.filter(r => r.includes('·') && r.includes('Step'))).toHaveLength(2)
})

test('the sibling names are dimmed', () => {
  const lines = paneLines([running], 80)
  const seg = lines.flat().find(s => s.text.includes('a-spec.md'))
  expect(seg?.dim).toBe(true)
})

test('a stalled plan is one row with its age', () => {
  const lines = paneLines([stalled], 80)
  const rows = lines.map(text).filter(r => r.includes('Old plan'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toContain('1/5')
  expect(rows[0]).toContain('claude')
  expect(rows[0]).toContain('3d')
  expect(lines.map(text).some(r => r.includes('Step 1'))).toBe(false)
})

test('no views draws one row: No plan in progress.', () => {
  expect(paneLines([], 80).map(text)).toEqual(['No plan in progress.'])
})

test('every row fits the columns', () => {
  for (const columns of [20, 33, 80]) {
    for (const line of paneLines([running, stalled], columns)) expect(text(line).length).toBeLessThanOrEqual(columns)
  }
})
