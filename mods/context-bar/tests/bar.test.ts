import { describe, expect, test } from 'claude-code/testing'

import type { ContextBarView } from '../types'
import { formatTokens, glide, isSettled, segmentWidths } from '../hooks/bar'

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

describe('glide', () => {
  const to = { percent: 50, fractions: { Messages: 0.5 } }

  test('moves toward the target and lands on it', async () => {
    let drawn: ContextBarView = { percent: 10, fractions: { Messages: 0.1, Old: 0.2 } }
    const first = glide(drawn, to)
    expect(first.percent).toBeGreaterThan(10)
    expect(first.percent).toBeLessThan(50)
    for (let i = 0; i < 60; i++) drawn = glide(drawn, to)
    expect(drawn).toEqual(to)
    expect(isSettled(drawn, to)).toBe(true)
  })

  test('a category absent from the target shrinks away and is dropped', async () => {
    let drawn: ContextBarView = { percent: 50, fractions: { Messages: 0.5, Old: 0.2 } }
    expect(glide(drawn, to).fractions['Old']).toBeLessThan(0.2)
    for (let i = 0; i < 60; i++) drawn = glide(drawn, to)
    expect(Object.keys(drawn.fractions)).toEqual(['Messages'])
  })

  test('a view away from its target is not settled', async () => {
    expect(isSettled({ percent: 10, fractions: {} }, to)).toBe(false)
  })
})
