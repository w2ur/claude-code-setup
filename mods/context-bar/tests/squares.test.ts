import { describe, expect, test } from 'claude-code/testing'

import type { ContextBarRow } from '../types'
import { PALETTE, hueOf } from '../hooks/palette'
import { markerSquare, sideFor, squareCounts, squareLines } from '../hooks/squares'
import type { Line } from '../hooks/squares'

const text = (line: Line): string => line.map(s => s.text).join('')
const rows = (lines: Line[]): string[] => lines.map(text)
const count = (lines: string[], glyph: string): number => lines.join('').split(glyph).length - 1
// The grid is the first cells of the `side` rows after the header and its blank
// line: 2 x side - 1 of them spaced, `side` packed.
const gridOf = (lines: Line[], side: number, isSpaced = true): string[] =>
  rows(lines).slice(2, 2 + side).map(r => r.slice(0, isSpaced ? side * 2 - 1 : side))

const ROWS: ContextBarRow[] = [
  { name: 'System prompt', tokens: 6000, color: '#3366cc', isFree: false, kind: 'used' },
  { name: 'Messages', tokens: 30_000, color: '#cc6633', isFree: false, kind: 'used' },
  { name: 'Free space', tokens: 64_000, color: '#888888', isFree: true, kind: 'free' },
]
const input = (columns: number, over: Partial<Parameters<typeof squareLines>[0]> = {}) => ({
  rows: ROWS,
  usedTokens: 36_000,
  maxTokens: 100_000,
  percent: 36,
  columns,
  ...over,
})
// 36k used, a 17k reserve, 47k free: the autocompact threshold sits at 83k.
const WITH_BUFFER: ContextBarRow[] = [
  ROWS[0]!,
  ROWS[1]!,
  { name: 'Free space', tokens: 47_000, color: '#888888', isFree: true, kind: 'free' },
  { name: 'Autocompact buffer', tokens: 17_000, color: '#777777', isFree: false, kind: 'buffer' },
]
const withItems = (n: number): ContextBarRow[] => [
  { ...ROWS[0]!, name: 'MCP tools', items: Array.from({ length: n }, (_, i) => ({ name: `server-${i + 1}`, tokens: 5000 - i * 100 })) },
  ROWS[1]!,
  ROWS[2]!,
]

describe('squareCounts', () => {
  test('the filled squares equal the used share of the window in whole squares', () => {
    expect(squareCounts([6000, 30_000], 36_000, 100_000)).toEqual([6, 30])
    expect(squareCounts([1, 1, 1], 3, 7).reduce((a, b) => a + b, 0)).toBe(43)
    expect(squareCounts([6000, 30_000], 36_000, 100_000, 400)).toEqual([24, 120])
  })

  test('a full or overfull window fills at most all the squares', () => {
    expect(squareCounts([5, 5], 10, 8).reduce((a, b) => a + b, 0)).toBe(100)
    expect(squareCounts([5, 5], 10, 8, 400).reduce((a, b) => a + b, 0)).toBe(400)
  })

  test('a category under half a square draws nothing', () => {
    expect(squareCounts([40, 99_960], 100_000, 100_000)).toEqual([0, 100])
    expect(squareCounts([10, 99_990], 100_000, 100_000, 400)).toEqual([0, 400])
  })

  test('no window or no usage fills nothing', () => {
    expect(squareCounts([5, 5], 10, 0)).toEqual([0, 0])
    expect(squareCounts([0, 0], 0, 100)).toEqual([0, 0])
  })
})

describe('the grid size', () => {
  test('is 10 below 41 columns and 20 from 41', () => {
    expect([20, 40, 41, 60, 80].map(sideFor)).toEqual([10, 10, 20, 20, 20])
  })

  test('at 40 columns: ten rows of ten packed squares, the legend kept beside the grid', () => {
    const lines = squareLines(input(40))
    const cells = gridOf(lines, 10, false)
    expect(cells.every(r => r.length === 10)).toBe(true)
    expect(count(cells, '■')).toBe(36)
    expect(count(cells, '□')).toBe(64)
    expect(rows(lines)).toHaveLength(2 + 10)
    expect(rows(lines)[2]?.slice(10)).toContain('   ■ System prompt')
  })

  test('at 60 columns: twenty rows of twenty squares, each 0.25%, packed so the legend stays beside', () => {
    const lines = squareLines(input(60))
    const cells = gridOf(lines, 20, false)
    expect(cells.every(r => r.length === 20)).toBe(true)
    expect(count(cells, '■')).toBe(144)
    expect(count(cells, '□')).toBe(256)
    const out = rows(lines)
    expect(out).toHaveLength(2 + 20)
    expect(out[2]?.slice(20)).toContain('   ■ System prompt')
    expect(out[4]).toContain('□ free')
  })

  test('at 80 columns: twenty rows, the legend beside the grid after a three-space gutter', () => {
    const out = rows(squareLines(input(80)))
    expect(out).toHaveLength(2 + 20)
    expect(out[2]?.slice(39, 42)).toBe('   ')
    expect(out[2]).toContain('■ System prompt')
    expect(out[3]).toContain('■ Messages')
    expect(out[4]).toContain('□ free')
    expect(out[4]).toContain('64k')
  })

  test('the narrow grid keeps a legend beside it when the names are short', () => {
    const short = ROWS.map(r => ({ ...r, name: r.isFree ? 'Free' : r.name.slice(0, 4) }))
    const out = rows(squareLines(input(40, { rows: short })))
    expect(out).toHaveLength(2 + 10)
    expect(out[2]).toContain('■ Syst')
  })

  test('the legend drops under the grid only when even the packed grid leaves it no room', () => {
    const out = rows(squareLines(input(30)))
    expect(out[2]?.includes('System')).toBe(false)
    expect(out.slice(2 + 10).join('\n')).toContain('■ System prompt')
  })

  test('no line is wider than the pane, whatever is switched on', () => {
    const full = input(0, { rows: withItems(30).concat(WITH_BUFFER.slice(2)), autoCompactAt: 83_000, isAutoCompactEnabled: true, expanded: 'MCP tools' })
    for (const columns of [10, 20, 40, 41, 60, 80, 120]) {
      for (const base of [input(columns), { ...full, columns }, { ...full, columns, isAutoCompactEnabled: false }]) {
        for (const line of rows(squareLines(base))) expect(line.length).toBeLessThanOrEqual(columns)
      }
    }
  })

  test('an unknown window draws a hint, not a grid', () => {
    for (const maxTokens of [0, -1, Number.NaN]) {
      expect(rows(squareLines(input(40, { maxTokens })))).toEqual(['Context window size unknown.'])
    }
  })

  test('the header reads used / window', () => {
    expect(text(squareLines(input(60))[0] ?? [])).toBe('36%  36k / 100k')
  })

  test('an empty context draws an all-free grid and a free legend', () => {
    const empty = [{ name: 'Free space', tokens: 100_000, color: '#888', isFree: true, kind: 'free' as const }]
    const lines = squareLines(input(60, { rows: empty, usedTokens: 0, percent: 0 }))
    expect(count(gridOf(lines, 20), '□')).toBe(400)
    expect(count(gridOf(lines, 20), '■')).toBe(0)
    expect(rows(lines).join('\n')).toContain('100k')
  })
})

describe('the colours', () => {
  test('every hue of the palette is clearly apart from every other', () => {
    const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    for (const [i, a] of PALETTE.entries()) {
      expect(a).toMatch(/^#[0-9a-f]{6}$/)
      for (const b of PALETTE.slice(i + 1)) {
        const [x, y] = [rgb(a), rgb(b)]
        const distance = Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!)
        expect(distance, `${a} ${b}`).toBeGreaterThan(45)
      }
    }
  })

  test('each kind has its own hue, and the used categories each have theirs', () => {
    const names = ['Messages', 'System prompt', 'System tools', 'MCP tools', 'Custom agents', 'Memory files', 'Skills', 'Slash commands']
    const used = names.map(name => hueOf({ name, kind: 'used' }))
    const kinds = [hueOf({ name: 'x', kind: 'free' }), hueOf({ name: 'x', kind: 'buffer' }), hueOf({ name: 'Unheard-of', kind: 'used' })]
    expect(new Set([...used, ...kinds]).size).toBe(names.length + 3)
    expect(hueOf({ name: 'MCP tools (deferred)', kind: 'used' })).toBe(hueOf({ name: 'MCP tools', kind: 'used' }))
  })

  test('the grid and the legend draw in the pane hues, not the theme colours', () => {
    const lines = squareLines(input(80))
    const squares = lines.flat().filter(s => s.text === '■')
    expect(squares.some(s => s.color === hueOf(ROWS[0]!))).toBe(true)
    expect(squares.some(s => s.color === '#3366cc' || s.color === '#cc6633')).toBe(false)
  })
})

describe('the autocompact buffer and marker', () => {
  test('the buffer takes the last squares in a dim hatched glyph, its share of the window', () => {
    const lines = squareLines(input(80, { rows: WITH_BUFFER }))
    const cells = gridOf(lines, 20)
    expect(count(cells, '▨')).toBe(68)
    expect(count(cells, '■')).toBe(144)
    expect(count(cells, '□')).toBe(400 - 144 - 68)
    expect(lines.flat().filter(s => s.text === '▨').every(s => s.dim === true)).toBe(true)
    expect(rows(lines).join('\n')).toContain('▨ Autocompact buffer')
  })

  test('the marker sits in the square holding the threshold, with the legend line', () => {
    const lines = squareLines(input(60, { rows: WITH_BUFFER, autoCompactAt: 83_000, isAutoCompactEnabled: true }))
    const cells = gridOf(lines, 20, false)
    expect(markerSquare(83_000, 100_000, 400)).toBe(332)
    expect(count(cells, '◆')).toBe(1)
    // Square 332 is row 16, column 12 of the packed grid.
    expect(cells[16]?.[12]).toBe('◆')
    const marker = lines.flat().find(s => s.text === '◆' && s.color !== undefined)
    expect(marker?.color).toBe(PALETTE.at(-1))
    const out = rows(lines)
    const at = out.findIndex(l => l.includes('◆ Autocompact 83k (83%)'))
    expect(at).toBeGreaterThan(-1)
    expect(out[at + 1]).toContain('  47k to go')
  })

  test('the marker clamps inside the grid', () => {
    expect(markerSquare(500_000, 100_000, 100)).toBe(99)
    expect(markerSquare(0, 100_000, 100)).toBe(0)
  })

  test('past the threshold nothing is left to go', () => {
    const lines = squareLines(input(60, { rows: WITH_BUFFER, usedTokens: 90_000, autoCompactAt: 83_000, isAutoCompactEnabled: true }))
    expect(rows(lines).join('\n')).toContain('  0 to go')
  })

  test('with autocompaction off there is no marker, and a warning line says so', () => {
    const lines = squareLines(input(60, { isAutoCompactEnabled: false }))
    expect(count(gridOf(lines, 20), '◆')).toBe(0)
    const warning = lines.flat().find(s => s.text === 'Autocompact is off')
    expect(warning?.color).toBeDefined()
    expect(rows(lines).join('\n')).not.toContain('to go')
  })

  test('an engine that says nothing about autocompaction draws neither', () => {
    const out = rows(squareLines(input(60))).join('\n')
    expect(out).not.toContain('Autocompact')
    expect(out).not.toContain('◆')
  })
})

describe('the detail under the legend', () => {
  test('a row with items is pressable and says so; a row without is plain text', () => {
    const lines = squareLines(input(60, { rows: withItems(3) }))
    const mcp = lines.find(l => text(l).includes('MCP tools'))
    expect(mcp?.some(s => s.press === 'MCP tools')).toBe(true)
    expect(text(mcp ?? [])).toContain('▸')
    const messages = lines.find(l => text(l).includes('Messages'))
    expect(messages?.some(s => s.press !== undefined)).toBe(false)
    expect(text(messages ?? [])).not.toMatch(/[▸▾]/)
  })

  test('the open category lists its items biggest first, top 12 and the rest counted', () => {
    // The legend column: what follows the packed grid and its gutter.
    const out = rows(squareLines(input(60, { rows: withItems(15), expanded: 'MCP tools' }))).map(l => l.slice(23))
    const start = out.findIndex(l => l.startsWith('  server-'))
    expect(out[start]).toBe('  server-1   5.0k')
    expect(out.slice(start, start + 12).every(l => /^ {2}server-\d+ +\d/.test(l))).toBe(true)
    expect(out[start + 12]).toBe('  +3 more')
    expect(out.join('\n')).toContain('▾')
  })

  test('the items open right under their own row, before the next category', () => {
    for (const columns of [30, 60]) {
      const out = rows(squareLines(input(columns, { rows: withItems(15), expanded: 'MCP tools' })))
      const mcp = out.findIndex(l => l.includes('MCP tools'))
      expect(out[mcp + 1]).toContain('server-1 ')
      expect(out.findIndex(l => l.includes('Messages'))).toBeGreaterThan(out.findIndex(l => l.includes('+3 more')))
    }
  })

  test('opening a category does not move the legend under the grid', () => {
    const closed = rows(squareLines(input(60, { rows: withItems(15) })))
    const open = rows(squareLines(input(60, { rows: withItems(15), expanded: 'MCP tools' })))
    expect(open[2]?.slice(20)).toBe(closed[2]?.slice(20).replace('▸', '▾'))
  })

  test('closed, or open on a category with no items, lists nothing', () => {
    expect(rows(squareLines(input(60, { rows: withItems(3), expanded: null }))).join('\n')).not.toContain('server-')
    expect(rows(squareLines(input(60, { rows: withItems(3), expanded: 'Messages' }))).join('\n')).not.toContain('server-')
  })

  test('beside the grid the items stay in the legend column', () => {
    const out = rows(squareLines(input(100, { rows: withItems(3), expanded: 'MCP tools' })))
    expect(out.find(l => l.includes('server-1'))?.slice(39, 42)).toBe('   ')
    expect(out.find(l => l.includes('server-1'))?.indexOf('server-1')).toBeGreaterThan(41)
  })
})
