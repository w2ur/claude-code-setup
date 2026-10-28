import { describe, expect, test } from 'claude-code/testing'

import { calligram, capacity, gauge, pourable, silhouette } from '../hooks/calligram'
import type { Line } from '../hooks/calligram'
import { HUE } from '../hooks/gfx'

// Every portrait text below is invented: this folder is published.
const TEXT = '# Titre\n\n- alpha beta\n- gamma\n\nDelta epsilon.\n'

const flat = (line: Line): string => line.map(s => s.text).join('')
const segs = (lines: Line[] | undefined) => (lines ?? []).flat()
// The cells of one kind: filled letters carry a heat colour, the ghost cells
// are dim letters, the free ones a dim '░', the cursor one bold '▌'.
const letters = (lines: Line[] | undefined): string =>
  segs(lines)
    .filter(s => s.color !== undefined)
    .map(s => s.text)
    .join('')
const ghosts = (lines: Line[] | undefined): string =>
  segs(lines)
    .filter(s => s.dim === true && !/^░+$/.test(s.text))
    .map(s => s.text)
    .join('')
const empties = (lines: Line[] | undefined): number => segs(lines).filter(s => /^░+$/.test(s.text)).reduce((sum, s) => sum + s.text.length, 0)
const cursors = (lines: Line[] | undefined): number => segs(lines).filter(s => s.text === '▌').length

const draw = (n: number, fill = 1, width = 40, extra: object = {}) => calligram({ portrait: TEXT, n, limit: 4000, fill, width, ...extra })

describe('silhouette', () => {
  test('is about 17 rows at 38 columns and stays inside the pane at every width', () => {
    expect(silhouette(38)).toHaveLength(17)
    for (const width of [30, 38, 40, 60, 120]) {
      for (const row of silhouette(width)) expect(row.from + row.count).toBeLessThanOrEqual(width)
    }
  })

  test('the head is narrower than the shoulders, the bust is centred', () => {
    const rows = silhouette(40)
    expect(rows[0]!.count).toBeLessThan(rows.at(-1)!.count)
    for (const row of rows) expect(Math.abs(row.from * 2 + row.count - 40)).toBeLessThanOrEqual(1)
  })
})

describe('pourable', () => {
  test('drops heading markers and list dashes and shows whitespace runs as one dot', () => {
    expect(pourable(TEXT)).toBe('Titre·alpha·beta·gamma·Delta·epsilon.')
    expect(pourable('')).toBe('·')
  })
})

describe('calligram cells', () => {
  test('count filled, ghost and free cells for a size and a fill', () => {
    const cells = capacity(40)
    for (const [n, fill] of [[1000, 1], [1000, 0.5], [1000, 0], [4000, 1], [0, 1]] as const) {
      const out = draw(n, fill)
      const filled = Math.round(Math.round((n / 4000) * cells) * fill)
      expect(letters(out)).toHaveLength(filled)
      expect(ghosts(out)).toHaveLength(0)
      expect(empties(out)).toBe(cells - filled)
    }
  })

  test('fill in reading order: the top row first, left to right, with the text poured in', () => {
    const cells = capacity(40)
    const out = draw(1000)!
    const filled = Math.round(0.25 * cells)
    const poured = pourable(TEXT)
    expect(letters(out)).toBe(Array.from({ length: filled }, (_, i) => poured[i % poured.length]).join(''))
    // The rows below the last filled cell hold nothing but free cells.
    const rows = out.slice(0, silhouette(40).length)
    const firstFree = rows.findIndex(r => r.some(s => /^░+$/.test(s.text)))
    for (const row of rows.slice(firstFree + 1)) expect(row.every(s => s.color === undefined)).toBe(true)
  })

  test('cycles the text when it is shorter than the filled count', () => {
    const out = calligram({ portrait: 'ab', n: 4000, limit: 4000, fill: 1, width: 40 })
    expect(letters(out)).toBe(Array.from({ length: capacity(40) }, (_, i) => 'ab'[i % 2]).join(''))
  })

  test('letters take the heat colour of the ratio', () => {
    const colour = (n: number) => segs(draw(n)).find(s => s.color !== undefined)?.color
    expect([colour(3300), colour(3400), colour(3900)]).toEqual([HUE.calm, HUE.warm, HUE.hot])
  })
})

describe('calligram overflow', () => {
  test('past the threshold every cell is filled and a line in error tone gives the excess', () => {
    const out = draw(4500)!
    expect(empties(out)).toBe(0)
    const over = out.find(l => flat(l).startsWith('+'))!
    expect(flat(over)).toBe('+500 car. au-delà du seuil')
    expect(over[0]!.tone).toBe('error')
    // At the threshold, or while the fill is still coming, there is no such line.
    expect(draw(4000)!.some(l => flat(l).startsWith('+'))).toBe(false)
    expect(draw(4500, 0.2)!.some(l => flat(l).startsWith('+'))).toBe(false)
  })
})

describe('calligram summary', () => {
  test('states the size in words, with the projection when there is one', () => {
    expect(flat(draw(1000)!.at(-1)!)).toBe('1000 / 4000 caractères · 25 %')
    expect(flat(draw(1000, 1, 60, { projection: { size: 1200, text: 'x' } })!.at(-1)!)).toBe('1000 / 4000 caractères · 25 % · 1200 après propositions')
  })

  test('the projection goes to its own line when the pane is narrow', () => {
    const out = draw(1000, 1, 30, { projection: { size: 1200, text: 'x' } })!
    expect(flat(out.at(-2)!)).toBe('1000 / 4000 caractères · 25 %')
    expect(flat(out.at(-1)!)).toBe('1200 après propositions')
  })
})

describe('calligram pending propositions', () => {
  const cells = capacity(40)
  const projection = { size: 2000, text: 'nouveau fait' }

  test('a cursor at the current end, then ghost letters of the proposed text, then free cells', () => {
    const out = draw(1000, 1, 40, { projection })
    const filled = Math.round(0.25 * cells)
    const ghost = Math.round(0.5 * cells) - filled
    expect(letters(out)).toHaveLength(filled)
    expect(cursors(out)).toBe(1)
    expect(ghosts(out)).toBe(Array.from({ length: ghost }, (_, i) => pourable(projection.text)[i % pourable(projection.text).length]).join(''))
    expect(empties(out)).toBe(cells - filled - 1 - ghost)
  })

  test('draws none while the fill is coming, none when the proposals shrink the portrait', () => {
    expect(cursors(draw(1000, 0.5, 40, { projection }))).toBe(0)
    expect(ghosts(draw(1000, 0.5, 40, { projection }))).toBe('')
    const smaller = draw(1000, 1, 40, { projection: { size: 800, text: 'x' } })
    expect(cursors(smaller)).toBe(0)
    expect(ghosts(smaller)).toBe('')
  })

  test('the ghost cells stop at the capacity', () => {
    const out = draw(3000, 1, 40, { projection: { size: 9000, text: 'nouveau fait' } })
    expect(letters(out)).toHaveLength(Math.round(0.75 * cells))
    expect(empties(out)).toBe(0)
    expect(cursors(out) + ghosts(out).length + letters(out).length).toBe(cells)
  })
})

describe('calligram width', () => {
  test('no line is wider than the pane at 30, 40 and 60 columns', () => {
    const projection = { size: 4300, text: 'nouveau fait inventé' }
    for (const width of [30, 40, 60]) {
      for (const n of [0, 1000, 3999, 4000, 123456]) {
        for (const extra of [{}, { projection }]) {
          for (const line of draw(n, 1, width, extra)!) expect(flat(line).length).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test('is not drawn below 30 columns, nor when the threshold is zero; the gauge line stays', () => {
    expect(draw(1000, 1, 29)).toBeUndefined()
    expect(calligram({ portrait: TEXT, n: 10, limit: 0, fill: 1, width: 40 })).toBeUndefined()
    expect(draw(1000, 1, 30)).toBeDefined()
    const line = gauge(1000, 4000, 1, 29)
    expect(flat(line).startsWith('Taille ')).toBe(true)
    expect(flat(line)).toContain('1000 / 4000 car.')
    expect(flat(line).length).toBeLessThanOrEqual(29)
  })
})
