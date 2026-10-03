import { describe, expect, test } from 'claude-code/testing'

import { formatTokens, segmentWidths } from '../hooks/bar'

describe('segmentWidths', () => {
  test('cells always sum to the width', async () => {
    for (const width of [10, 37, 78, 120]) {
      const cells = segmentWidths([3100, 18000, 900, 40, 137960], width)
      expect(cells.reduce((a, b) => a + b, 0)).toBe(width)
    }
  })

  test('each share is within one cell of its exact value', async () => {
    const weights = [1, 2, 3, 4]
    const cells = segmentWidths(weights, 50)
    weights.forEach((w, i) => expect(Math.abs((cells[i] ?? 0) - (w / 10) * 50)).toBeLessThan(1))
  })

  test('no weight gives no cells', async () => {
    expect(segmentWidths([0, 0], 20)).toEqual([0, 0])
  })
})

test('formatTokens', async () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(3100)).toBe('3.1k')
  expect(formatTokens(84_400)).toBe('84k')
  expect(formatTokens(1_000_000)).toBe('1.0M')
})
