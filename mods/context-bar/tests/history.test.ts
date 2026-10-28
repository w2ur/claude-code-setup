import { describe, expect, test } from 'claude-code/testing'

import type { ContextBarReading } from '../types'
import { agoOf, historyLines } from '../hooks/history'
import type { Line } from '../hooks/squares'

const rows = (lines: Line[]): string[] => lines.map(l => l.map(s => s.text).join(''))
const at = (percents: number[], gap = 60_000): ContextBarReading[] => percents.map((percent, i) => ({ percent, at: 1_000_000 + i * gap }))

describe('historyLines', () => {
  test('is a title, a marker row, three chart rows, the x labels and a footer', () => {
    const out = rows(historyLines({ readings: at([10, 50, 90]), width: 60, now: 1_200_000 }))
    expect(out).toHaveLength(7)
    expect(out[0]).toMatch(/^── Context over this session ─+$/)
    expect(out[2]?.startsWith('100% ')).toBe(true)
    expect(out[4]?.startsWith('  0% ')).toBe(true)
    expect(out[5]).toMatch(/^ {5}start +now$/)
    expect(out[6]).toBe('3 readings · last compaction none this session')
  })

  test('the bars rise with the reading, three rows high', () => {
    const out = rows(historyLines({ readings: at([0, 50, 100]), width: 40, now: 0 }))
    expect(out[2]?.slice(5)).toBe('  █')
    expect(out[3]?.slice(5)).toBe(' ▄█')
    expect(out[4]?.slice(5)).toBe(' ██')
  })

  test('a fall of more than 20 points is marked above its column, a smaller one is not', () => {
    const out = rows(historyLines({ readings: at([30, 80, 70, 20, 21]), width: 40, now: 5_000_000 }))
    expect(out[1]?.slice(5)).toBe('   ↓ ')
    expect(rows(historyLines({ readings: at([80, 60]), width: 40, now: 0 }))[1]?.includes('↓')).toBe(false)
    expect(rows(historyLines({ readings: at([80, 59]), width: 40, now: 0 }))[1]?.includes('↓')).toBe(true)
  })

  test('the footer says when the last compaction was', () => {
    const readings = at([10, 80, 10, 40], 60_000)
    const out = rows(historyLines({ readings, width: 60, now: readings[3]!.at + 4 * 60_000 }))
    expect(out[6]).toBe('4 readings · last compaction 5m ago')
  })

  test('one reading is singular, none draws a hint', () => {
    expect(rows(historyLines({ readings: at([5]), width: 40, now: 0 }))[6]).toMatch(/^1 reading ·/)
    expect(rows(historyLines({ readings: [], width: 40, now: 0 }))[1]).toBe('No readings yet.')
  })

  test('more readings than columns are bucketed, keeping each drop', () => {
    const percents = Array.from({ length: 100 }, (_, i) => (i < 50 ? 70 : 10))
    const out = rows(historyLines({ readings: at(percents), width: 25, now: 0 }))
    expect(out[1]?.length).toBeLessThanOrEqual(20 + 5)
    expect((out[1]?.match(/↓/g) ?? []).length).toBe(1)
    expect(out[6]).toMatch(/^100 readings/)
  })

  test('no line is wider than the pane', () => {
    for (const width of [6, 12, 25, 60]) {
      for (const line of rows(historyLines({ readings: at([10, 90, 5, 40]), width, now: 0 }))) expect(line.length).toBeLessThanOrEqual(width)
    }
  })
})

test('agoOf reads minutes then hours', () => {
  expect([0, 59_000, 60_000, 3_540_000, 3_600_000, 5_400_000].map(agoOf)).toEqual(['just now', 'just now', '1m ago', '59m ago', '1h ago', '1h 30m ago'])
})
