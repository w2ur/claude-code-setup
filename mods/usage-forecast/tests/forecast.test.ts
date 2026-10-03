import { describe, expect, test } from 'claude-code/testing'

import { addSample, burnRate, duration, levelToAlert, projectFull } from '../hooks/forecast'

const MIN = 60_000
const HOUR = 60 * MIN

describe('burnRate', () => {
  test('points per hour over the kept span', async () => {
    const samples = [{ t: 0, pct: 40 }, { t: 30 * MIN, pct: 50 }]
    expect(burnRate(samples, 5 * MIN)).toBe(20)
  })

  test('refuses a span shorter than the minimum', async () => {
    expect(burnRate([{ t: 0, pct: 40 }, { t: 2 * MIN, pct: 45 }], 5 * MIN)).toBeUndefined()
  })

  test('one sample is no rate', async () => {
    expect(burnRate([{ t: 0, pct: 40 }], 5 * MIN)).toBeUndefined()
  })
})

describe('addSample', () => {
  test('a new resetsAt starts a new window', async () => {
    const held = { resetsAt: 'A', samples: [{ t: 0, pct: 90 }] }
    expect(addSample(held, 'B', { t: MIN, pct: 2 }, HOUR).samples).toEqual([{ t: MIN, pct: 2 }])
  })

  test('drops samples older than the span', async () => {
    const held = { resetsAt: 'A', samples: [{ t: 0, pct: 10 }, { t: 50 * MIN, pct: 20 }] }
    expect(addSample(held, 'A', { t: 60 * MIN, pct: 25 }, 45 * MIN).samples.length).toBe(2)
  })
})

describe('projectFull', () => {
  test('fills before the reset', async () => {
    expect(projectFull(80, 10, 0, 5 * HOUR)).toBe(2 * HOUR)
  })

  test('resets first: no projection', async () => {
    expect(projectFull(80, 10, 0, HOUR)).toBeUndefined()
  })

  test('no burn: no projection', async () => {
    expect(projectFull(80, 0, 0, 5 * HOUR)).toBeUndefined()
  })
})

test('levelToAlert takes the highest new level once', async () => {
  expect(levelToAlert(79, [])).toBeUndefined()
  expect(levelToAlert(81, [])).toBe(80)
  expect(levelToAlert(96, [])).toBe(95)
  expect(levelToAlert(96, [80, 95])).toBeUndefined()
  expect(levelToAlert(96, [80])).toBe(95)
})

test('duration', async () => {
  expect(duration(43 * MIN)).toBe('43m')
  expect(duration(125 * MIN)).toBe('2h05')
  expect(duration(52 * HOUR)).toBe('2d4h')
})
