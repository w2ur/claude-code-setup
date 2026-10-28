import { describe, expect, test } from 'claude-code/testing'

import { bar, cut, ease, heat, HUE, marquee, rule, spark, spinner } from '../hooks/gfx'

describe('bar', () => {
  test('always spans the width', async () => {
    for (const f of [0, 0.01, 0.33, 0.5, 0.999, 1, 2, -1, NaN]) {
      const [filled, empty] = bar(f, 17)
      expect(filled.length + empty.length).toBe(17)
    }
  })

  test('draws eighths of a cell', async () => {
    expect(bar(0.5, 1)).toEqual(['▌', ''])
    expect(bar(1 / 8, 1)).toEqual(['▏', ''])
    expect(bar(0.5, 4)).toEqual(['██', '░░'])
  })
})

describe('spark', () => {
  test('one cell per value, scaled to the max', async () => {
    expect(spark([0, 5, 10], 10)).toBe('▁▅█')
    expect(spark([1, 2, 3, 4], 2)).toBe('▆█')
    expect(spark([], 5)).toBe('')
  })
})

test('heat crosses its thresholds', async () => {
  expect(heat(0.1)).toBe(HUE.calm)
  expect(heat(0.75)).toBe(HUE.warm)
  expect(heat(0.95)).toBe(HUE.hot)
})

test('spinner wraps, negative ticks included', async () => {
  expect(spinner(0)).toBe(spinner(10))
  expect(spinner(-1)).toBe(spinner(9))
})

test('ease lands on its target', async () => {
  let v = 0
  for (let i = 0; i < 40; i++) v = ease(v, 1)
  expect(v).toBe(1)
})

test('marquee keeps its width', async () => {
  expect(marquee('court', 10, 3)).toBe('court')
  expect(marquee('a much longer text', 6, 5).length).toBe(6)
})

test('rule and cut fit the width', async () => {
  expect(rule('Fenêtres', 20).length).toBe(20)
  expect(cut('abcdef', 4)).toBe('abc…')
})
