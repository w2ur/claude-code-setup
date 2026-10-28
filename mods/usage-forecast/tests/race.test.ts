import { describe, expect, test } from 'claude-code/testing'

import { lastRise } from '../hooks/forecast'
import { HUE } from '../hooks/gfx'
import { RACE_MIN_WIDTH, canRace, dateOf, evenPace, projection, raceLines, span } from '../hooks/race'
import type { Line, RaceInput } from '../hooks/race'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// Wed 28 Oct 2026, 14:35 local: the weekdays below follow from it.
const NOW = new Date(2026, 9, 28, 14, 35).getTime()

const text = (line: Line): string => line.map(seg => seg.text).join('')
const rows = (lines: Line[]): string[] => lines.map(text)

// Rows: 0 header, 1-3 the sprites over the track, 4 the ground, 5 the axis,
// then the plain-language lines.
const GROUND = 4
const NOTES = 6

// The column of a percentage on a track `width` cells wide.
const col = (pct: number, width: number): number => 1 + Math.round((pct / 100) * (width - 3))

// 48% used, 1 h 42 left, a steady 6 points an hour: lands at 58%.
const FINISH: RaceInput = {
  kind: 'five_hour',
  pct: 48,
  resetsAt: NOW + 1.7 * HOUR,
  now: NOW,
  ratePerHour: 6,
  threshold: 85,
  lastRiseAt: NOW - MIN,
  tick: 0,
  width: 40,
}

// 80% used, 4 h 20 left, 10 points an hour: full at 16:35.
const CRASH: RaceInput = { ...FINISH, pct: 80, resetsAt: NOW + (4 + 1 / 3) * HOUR, ratePerHour: 10, threshold: 80 }

const WEEK_FINISH: RaceInput = { ...FINISH, kind: 'seven_day', pct: 50, resetsAt: NOW + 60 * HOUR, ratePerHour: undefined, threshold: 90 }
const WEEK_CRASH: RaceInput = { ...WEEK_FINISH, pct: 80, resetsAt: NOW + 72 * HOUR }

describe('the scene', () => {
  test('header, track, axis and notes, in order', () => {
    const out = rows(raceLines(FINISH))
    expect(out[0]).toBe('── 5-hour window ── resets in 1 h 42 ──')
    expect(out[GROUND]?.startsWith(' ═')).toBe(true)
    expect(out[5]).toMatch(/^ 0% +50% +100%$/)
    expect(out[NOTES]).toBe("o  You've used 48%.")
  })

  test('the runner, the ghost, the wall and the hurdle sit at their percents', () => {
    const w = 40
    const out = rows(raceLines({ ...FINISH, width: w }))
    expect(out[1]?.[col(48, w)]).toBe('o')
    expect(out[1]?.[col(66, w)]).toBe('◌')
    for (const r of [1, 2, 3, 4]) expect(out[r]?.[w - 2]).toBe('█')
    expect(out[3]?.[col(85, w)]).toBe('╥')
    expect(out[GROUND]?.[col(85, w)]).toBe('╨')
    expect(out[GROUND]?.[col(0, w)]).toBe('═')
  })

  test('positions follow the width', () => {
    for (const w of [30, 60]) {
      const out = rows(raceLines({ ...FINISH, width: w }))
      expect(out[1]?.[col(48, w)]).toBe('o')
      expect(out[1]?.[col(66, w)]).toBe('◌')
      expect(out[1]?.[w - 2]).toBe('█')
      expect(out[3]?.[col(85, w)]).toBe('╥')
    }
  })

  test('the axis labels line up under 0, 50 and 100 per cent', () => {
    const w = 60
    const axis = rows(raceLines({ ...FINISH, width: w }))[5] ?? ''
    expect(axis.indexOf('0%')).toBe(col(0, w))
    expect(axis.indexOf('50%')).toBe(col(50, w) - 1)
    expect(axis.indexOf('100%') + 3).toBe(w - 2)
  })

  test('the ghost is dim and the wall is hot', () => {
    const lines = raceLines(FINISH)
    expect(lines[1]?.find(seg => seg.text.includes('◌'))?.dim).toBe(true)
    expect(lines[1]?.find(seg => seg.text.includes('█'))?.color).toBe(HUE.hot)
    expect(lines[3]?.find(seg => seg.text.includes('╥'))?.color).toBe(HUE.warm)
  })

  test('the runner takes the heat of its percent', () => {
    expect(raceLines(FINISH)[1]?.find(seg => seg.text.includes('o'))?.color).toBe(HUE.calm)
    expect(raceLines({ ...FINISH, pct: 75 })[1]?.find(seg => seg.text.includes('o'))?.color).toBe(HUE.warm)
    expect(raceLines({ ...FINISH, pct: 95, ratePerHour: 0 })[1]?.find(seg => seg.text.includes('o'))?.color).toBe(HUE.hot)
  })

  test('the head says whether the runner is fine, doomed or just reset', () => {
    expect(rows(raceLines(FINISH))[1]).toContain(' o ')
    expect(rows(raceLines(CRASH))[1]).toContain(';o ')
    expect(rows(raceLines({ ...FINISH, pct: 2, ratePerHour: 6 }))[1]).toContain('\\o/')
  })
})

describe('the legs', () => {
  const runnerFeet = (input: RaceInput): string[] => {
    const out = rows(raceLines(input))
    const at = col(input.pct, input.width) - 1
    return [out[2]?.slice(at, at + 3) ?? '', out[3]?.slice(at, at + 3) ?? '']
  }

  test('alternate two frames on the tick while usage rose in the last ten minutes', () => {
    const a = runnerFeet({ ...FINISH, tick: 0 })
    const b = runnerFeet({ ...FINISH, tick: 2 })
    expect(a).toEqual(['/|>', '/ >'])
    expect(b).toEqual(['<|\\', ' |\\'])
    expect(runnerFeet({ ...FINISH, tick: 4 })).toEqual(a)
  })

  test('stand still once the last rise is older than ten minutes', () => {
    const old = { ...FINISH, lastRiseAt: NOW - 11 * MIN }
    expect(runnerFeet({ ...old, tick: 0 })).toEqual([' | ', '/ \\'])
    expect(runnerFeet({ ...old, tick: 2 })).toEqual([' | ', '/ \\'])
    expect(runnerFeet({ ...FINISH, lastRiseAt: undefined, tick: 2 })).toEqual([' | ', '/ \\'])
  })

  test('the ghost walks slowly, in its own two frames', () => {
    const a = rows(raceLines({ ...FINISH, tick: 0 }))[3]
    const b = rows(raceLines({ ...FINISH, tick: 8 }))[3]
    expect(a).not.toBe(b)
    expect(rows(raceLines({ ...FINISH, tick: 1 }))[3]).toBe(a)
  })
})

describe('the arrival', () => {
  // At 60 columns the runner (48%) sits at 28, the camp's apex where 58.2% lands, the ghost (66%) clear of both.
  const w = 60
  const apex = col(58.2, w)

  test('under the limit, a camp stands where the usage lands', () => {
    const out = rows(raceLines({ ...FINISH, width: w }))
    expect(out[1]?.slice(apex, apex + 2)).toBe('/\\')
    expect(out[2]?.[apex - 1]).toBe('/')
    expect(out[2]?.[apex + 2]).toBe('\\')
    expect(out[3]?.slice(apex - 2, apex + 4)).toBe('/____\\')
    expect(out.join('').includes('✶')).toBe(false)
  })

  test('the camp carries no colour: the theme text colour, black or white', () => {
    const lines = raceLines({ ...FINISH, width: w })
    const camp = lines.slice(1, 4).flatMap(line => line.filter(seg => seg.text.includes('/\\') || seg.text.includes('/____\\')))
    expect(camp).toHaveLength(2)
    for (const seg of camp) {
      expect(seg.color).toBeUndefined()
      expect(seg.tone).toBeUndefined()
      expect(seg.dim).toBeUndefined()
    }
  })

  test('the camp lights up at night, by the local clock, and stays dark by day', () => {
    const night = new Date(2026, 9, 28, 23, 0).getTime()
    const lit = raceLines({ ...FINISH, now: night, resetsAt: night + 1.7 * HOUR, lastRiseAt: night - MIN, width: w })
    expect(rows(lit)[2]?.slice(apex, apex + 2)).toBe('··')
    expect(lit[2]?.find(seg => seg.text === '··')?.color).toBe(HUE.warm)
    expect(rows(raceLines({ ...FINISH, width: w }))[2]?.slice(apex, apex + 2)).toBe('  ')
  })

  test('the trail is dim, in the runner colour, from the runner to the camp', () => {
    const lines = raceLines({ ...FINISH, width: w })
    const trail = lines[3]?.find(seg => seg.text.includes('┈'))
    expect(trail?.dim).toBe(true)
    expect(trail?.color).toBe(HUE.calm)
    const feet = rows(lines)[3] ?? ''
    expect(feet.indexOf('┈')).toBe(col(48, w) + 2)
    expect(feet.lastIndexOf('┈')).toBe(apex - 3)
  })

  test('reaching 100% before the reset, the trail runs into the wall and ends in a hot star', () => {
    const lines = raceLines({ ...CRASH, width: 40 })
    const out = rows(lines)
    expect(out[3]?.[37]).toBe('✶')
    expect(lines[3]?.find(seg => seg.text.includes('✶'))?.color).toBe(HUE.hot)
    expect(out[3]?.[38]).toBe('█')
    expect(out[3]).toContain('┈')
    expect(out.join('')).not.toContain('/____\\')
  })

  test('no pace yet: no trail, no camp, and the line says so', () => {
    const out = rows(raceLines({ ...FINISH, ratePerHour: undefined }))
    expect(out.slice(0, 6).join('')).not.toMatch(/[┈✶]|____/)
    expect(out).toContain('·  Measuring your pace.')
  })

  test('no burn: the camp waits just ahead of the runner and the line says nothing moves', () => {
    const out = rows(raceLines({ ...FINISH, ratePerHour: 0, width: w }))
    expect(out).toContain('⌂  Not rising now: you camp at 48%')
    expect(out).toContain('   when the window resets.')
    expect(out[3]).toContain('/____\\')
  })
})

describe('the plain-language lines', () => {
  test('5-hour, room to spare', () => {
    expect(rows(raceLines({ ...FINISH, width: 60 })).slice(NOTES)).toEqual([
      "o  You've used 48%.",
      '◌  An even pace would be at 66% now.',
      '⌂  At this pace, you camp at 58%',
      '   when the window resets.',
      '   ✓ You have room.',
    ])
    const lines = raceLines({ ...FINISH, width: 60 })
    expect(lines[NOTES + 4]?.[2]?.tone).toBe('success')
  })

  test('5-hour, a crash, and the hurdle line once past the threshold', () => {
    const lines = raceLines({ ...CRASH, width: 80 })
    expect(rows(lines).slice(NOTES)).toEqual([
      "o  You've used 80%.",
      '◌  An even pace would be at 13% now.',
      '✶  At this pace, you hit the limit',
      '   at 16:35, 2 h 20 before the reset.',
      '╥  Past 80%, fan-outs ask before starting.',
    ])
    expect(lines[NOTES + 3]?.[0]?.tone).toBe('error')
    expect(lines[NOTES + 2]?.[2]?.tone).toBe('error')
  })

  test('the crash time stays on one line at 40 columns', () => {
    expect(rows(raceLines({ ...CRASH, width: 40 }))).toContain('   at 16:35, 2 h 20 before the reset.')
  })

  test('7-day, a clear date for 100% at the average pace', () => {
    expect(rows(raceLines({ ...WEEK_CRASH, width: 80 })).slice(NOTES)).toEqual([
      "o  You've used 80%.",
      '◌  An even pace would be at 57% now.',
      '✶  At your average pace, you hit the limit',
      '   on Thu 29 Oct around 14:35, 2 d 0 h before the reset.',
    ])
  })

  test('7-day, landing under the limit names the reset date and time', () => {
    expect(rows(raceLines({ ...WEEK_FINISH, width: 80 })).slice(NOTES)).toEqual([
      "o  You've used 50%.",
      '◌  An even pace would be at 64% now.',
      '⌂  At your average pace, you camp at 78%',
      '   when the window resets on Sat 31 Oct at 02:35.',
      '   ✓ You have room.',
    ])
  })

  test('the 7-day date ignores the 5-hour style burn rate it is handed', () => {
    const out = rows(raceLines({ ...WEEK_FINISH, ratePerHour: 40, width: 80 }))
    expect(out[NOTES + 2]).toBe('⌂  At your average pace, you camp at 78%')
  })

  test('a 7-day window barely begun has no average pace yet', () => {
    const out = rows(raceLines({ ...WEEK_FINISH, resetsAt: NOW + 7 * DAY - 30 * MIN, width: 80 }))
    expect(out).toContain('·  Measuring your pace.')
  })

  test('the hurdle line stays away below the threshold', () => {
    expect(rows(raceLines(FINISH)).join('\n')).not.toContain('fan-outs ask')
  })
})

describe('width', () => {
  const scenarios: [string, RaceInput][] = [
    ['finish', FINISH],
    ['crash', CRASH],
    ['week finish', WEEK_FINISH],
    ['week crash', WEEK_CRASH],
    ['no pace', { ...FINISH, ratePerHour: undefined }],
    ['just reset', { ...FINISH, pct: 1, ratePerHour: 3 }],
    ['at the wall', { ...CRASH, pct: 99 }],
  ]

  for (const w of [30, 40, 60]) {
    test(`no line is wider than ${w} columns`, () => {
      for (const [name, input] of scenarios) {
        for (const line of rows(raceLines({ ...input, width: w }))) {
          expect([name, line.length <= w]).toEqual([name, true])
        }
      }
    })
  }

  test('below the minimum, or for another window, there is no scene', () => {
    expect(raceLines({ ...FINISH, width: RACE_MIN_WIDTH - 1 })).toEqual([])
    expect(raceLines({ ...FINISH, kind: 'spend_limit' })).toEqual([])
    expect(canRace('five_hour', 29)).toBe(false)
    expect(canRace('five_hour', 30)).toBe(true)
    expect(canRace('spend_limit', 60)).toBe(false)
  })
})

describe('helpers', () => {
  test('span', () => {
    expect(span(102 * MIN)).toBe('1 h 42')
    expect(span(52 * HOUR)).toBe('2 d 4 h')
    expect(span(42 * MIN)).toBe('42 min')
  })

  test('dateOf reads the local calendar in English', () => {
    expect(dateOf(NOW)).toBe('Wed 28 Oct')
  })

  test('evenPace is the share of the window already gone', () => {
    expect(Math.round(evenPace('five_hour', NOW, NOW + 1.7 * HOUR))).toBe(66)
    expect(evenPace('five_hour', NOW, NOW - HOUR)).toBe(100)
    expect(evenPace('five_hour', NOW, NOW + 9 * HOUR)).toBe(0)
  })

  test('projection: burn rate for 5 hours, average pace for 7 days', () => {
    expect(projection('five_hour', 80, NOW, NOW + 4 * HOUR, 10)?.basis).toBe('burn')
    const week = projection('seven_day', 50, NOW, NOW + 60 * HOUR, 99)
    expect(week?.basis).toBe('average')
    expect(Math.round(week?.landing ?? 0)).toBe(78)
    expect(projection('five_hour', 50, NOW, NOW + HOUR, undefined)).toBeUndefined()
  })

  test('lastRise is the time of the latest reading that moved up', () => {
    const samples = [{ t: 1, pct: 10 }, { t: 2, pct: 12 }, { t: 3, pct: 12 }]
    expect(lastRise(samples)).toBe(2)
    expect(lastRise([{ t: 1, pct: 10 }, { t: 2, pct: 10 }])).toBeUndefined()
    expect(lastRise([{ t: 1, pct: 10 }])).toBeUndefined()
  })
})
