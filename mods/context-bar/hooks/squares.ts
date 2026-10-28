import type { ContextBarRow } from '../types'
import { formatTokens, segmentWidths } from './bar'
import { BUFFER_HUE, FREE_HUE, KIND_GLYPH, MARKER_HUE, hueOf } from './palette'

// The pane's grid as data: lines of styled segments, already cut to the pane's
// width. register.tsx only maps them to Text elements, so the layout is
// testable without a renderer.

// `press` names the category a run of segments presses open: consecutive
// segments sharing it are one Button.
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean; press?: string }
export type Line = Seg[]

const NARROW_SIDE = 10
const WIDE_SIDE = 20
// The spaced 20-wide grid is 39 cells; two more keep it off the pane's edge.
const WIDE_MIN_COLUMNS = 41
const GUTTER = '   '
const ITEMS_SHOWN = 12
const MARKER = '◆'
const WARN_HUE = '#d9a521'

const seg = (text: string, style: Omit<Seg, 'text'> = {}): Seg => ({ text, ...style })
const widthOf = (line: Line): number => line.reduce((sum, s) => sum + s.text.length, 0)

// Cuts a line to `cols` cells; the last kept segment ends in an ellipsis.
export function fit(line: Line, cols: number): Line {
  const out: Line = []
  let used = 0
  for (const s of line) {
    const room = cols - used
    if (room <= 0) break
    if (s.text.length <= room) {
      out.push(s)
      used += s.text.length
      continue
    }
    out.push({ ...s, text: room > 1 ? `${s.text.slice(0, room - 1)}…` : '…' })
    break
  }
  return out
}

// Squares per side: the wide grid where the pane has room for it.
export const sideFor = (columns: number): number => (columns >= WIDE_MIN_COLUMNS ? WIDE_SIDE : NARROW_SIDE)

// Squares per used category: the filled total is the window's share rounded to
// whole squares, split by largest remainder so no category is off by more than one.
export function squareCounts(tokens: readonly number[], usedTokens: number, windowTokens: number, squares = NARROW_SIDE ** 2): number[] {
  if (!(windowTokens > 0) || !(usedTokens > 0)) return tokens.map(() => 0)
  const filled = Math.round(Math.min(1, usedTokens / windowTokens) * squares)

  return segmentWidths([...tokens], filled)
}

// The square holding token `at` of the window.
export function markerSquare(at: number, windowTokens: number, squares: number): number {
  return Math.min(squares - 1, Math.max(0, Math.floor((at / windowTokens) * squares)))
}

type Autocompact = { at?: number; isEnabled?: boolean }

// `detail` draws the open category's items; they sit right under its row.
function legendOf(
  rows: readonly ContextBarRow[],
  usedTokens: number,
  windowTokens: number,
  auto: Autocompact,
  expanded: string | null,
  detail: (items: readonly { name: string; tokens: number }[]) => Line[] = () => [],
): Line[] {
  const used = rows.filter(r => r.kind === 'used')
  const buffer = rows.find(r => r.kind === 'buffer')
  const shown = [...used, ...(buffer === undefined ? [] : [buffer])]
  const nameWidth = Math.max(4, ...shown.map(r => r.name.length))
  const free = rows.find(r => r.kind === 'free')?.tokens ?? Math.max(0, windowTokens - usedTokens)
  const tokensWidth = Math.max(...[...shown.map(r => r.tokens), free].map(t => formatTokens(t).length))
  const tokens = (n: number): string => formatTokens(n).padStart(tokensWidth)

  const row = (r: ContextBarRow): Line => {
    const hasItems = (r.items?.length ?? 0) > 0
    const style = hasItems ? { press: r.name } : {}

    return [
      seg(KIND_GLYPH[r.kind === 'buffer' ? 'buffer' : 'used'], { color: hueOf(r), dim: r.kind === 'buffer', ...style }),
      seg(` ${r.name.padEnd(nameWidth)}  ${tokens(r.tokens)}`, style),
      ...(hasItems ? [seg(expanded === r.name ? ' ▾' : ' ▸', { dim: true, ...style })] : []),
    ]
  }
  const lines: Line[] = [
    ...used.flatMap(r => (expanded === r.name && (r.items?.length ?? 0) > 0 ? [row(r), ...detail(r.items ?? [])] : [row(r)])),
    [seg(KIND_GLYPH.free, { color: FREE_HUE, dim: true }), seg(` ${'free'.padEnd(nameWidth)}  ${tokens(free)}`)],
    ...(buffer === undefined ? [] : [row(buffer)]),
  ]

  if (auto.isEnabled === false) lines.push([seg('Autocompact is off', { color: WARN_HUE })])
  else if (auto.at !== undefined && windowTokens > 0) {
    const pct = Math.round((auto.at / windowTokens) * 100)
    const toGo = Math.max(0, auto.at - usedTokens)
    // Two short lines, not one long one: the legend's width decides whether it
    // fits beside the grid.
    lines.push([seg(MARKER, { color: MARKER_HUE }), seg(` Autocompact ${formatTokens(auto.at)} (${pct}%)`)])
    lines.push([seg(`  ${formatTokens(toGo)} to go`, { dim: true })])
  }
  return lines
}

// The open category's items, biggest first, as `  name  tokens`; `room` is
// the width the lines may take.
function itemLines(items: readonly { name: string; tokens: number }[], room: number): Line[] {
  const shown = items.slice(0, ITEMS_SHOWN)
  const tokensWidth = Math.max(...shown.map(i => formatTokens(i.tokens).length))
  const nameRoom = Math.max(4, room - 2 - 2 - tokensWidth)
  const cut = (name: string): string => (name.length <= nameRoom ? name : `${name.slice(0, nameRoom - 1)}…`)
  const nameWidth = Math.max(...shown.map(i => cut(i.name).length))
  const lines: Line[] = shown.map(i => [seg(`  ${cut(i.name).padEnd(nameWidth)}  ${formatTokens(i.tokens).padStart(tokensWidth)}`)])
  if (items.length > shown.length) lines.push([seg(`  +${items.length - shown.length} more`, { dim: true })])

  return lines
}

export type SquaresInput = {
  rows: readonly ContextBarRow[]
  usedTokens: number
  maxTokens: number
  percent: number
  // The theme-independent hue of the percent figure in the header.
  accent?: string
  columns: number
  // The token count where auto-compaction runs, and whether it is on at all.
  autoCompactAt?: number
  isAutoCompactEnabled?: boolean
  // The name of the category whose items are listed under the legend.
  expanded?: string | null
}

export function squareLines(input: SquaresInput): Line[] {
  const { rows, usedTokens, maxTokens, columns } = input
  if (!(maxTokens > 0)) return [[seg('Context window size unknown.', { dim: true })]]

  const header: Line = [
    seg(`${Math.round(input.percent)}%`, { bold: true, ...(input.accent === undefined ? {} : { color: input.accent }) }),
    seg(`  ${formatTokens(usedTokens)} / ${formatTokens(maxTokens)}`),
  ]

  const side = sideFor(columns)
  const squares = side * side
  const spacedColumns = side * 2 - 1
  const used = rows.filter(r => r.kind === 'used')
  const buffer = rows.find(r => r.kind === 'buffer')
  const counts = squareCounts(used.map(r => r.tokens), usedTokens, maxTokens, squares)
  const cells: Seg[] = used.flatMap((r, i) => Array.from({ length: counts[i] ?? 0 }, () => seg(KIND_GLYPH.used, { color: hueOf(r) })))
  // The buffer sits at the window's end, in the squares the free space leaves it.
  const reserve = buffer === undefined ? 0 : Math.min(squares - cells.length, Math.round((buffer.tokens / maxTokens) * squares))
  while (cells.length < squares - reserve) cells.push(seg(KIND_GLYPH.free, { color: FREE_HUE, dim: true }))
  while (cells.length < squares) cells.push(seg(KIND_GLYPH.buffer, { color: BUFFER_HUE, dim: true }))

  const auto: Autocompact = { at: input.autoCompactAt, isEnabled: input.isAutoCompactEnabled }
  if (auto.isEnabled !== false && auto.at !== undefined) cells[markerSquare(auto.at, maxTokens, squares)] = seg(MARKER, { color: MARKER_HUE })

  // Placement is decided on the closed legend, so opening a category never moves it.
  const legendWidth = Math.max(...legendOf(rows, usedTokens, maxTokens, auto, null).map(widthOf))
  // The legend belongs beside the grid: spaced squares when both fit, packed
  // squares when only that fits, and under the grid as a last resort.
  const isSpaced = spacedColumns + GUTTER.length + legendWidth <= columns || side + GUTTER.length + legendWidth > columns
  const gridColumns = isSpaced ? spacedColumns : side
  const isBeside = gridColumns + GUTTER.length + legendWidth <= columns
  const grid: Line[] = Array.from({ length: side }, (_, row) =>
    cells.slice(row * side, (row + 1) * side).flatMap((cell, i) => (i === 0 || !isSpaced ? [cell] : [seg(' '), cell])),
  )

  const room = isBeside ? columns - gridColumns - GUTTER.length : columns
  const legend = legendOf(rows, usedTokens, maxTokens, auto, input.expanded ?? null, items => itemLines(items, room))

  const body: Line[] = isBeside
    ? Array.from({ length: Math.max(grid.length, legend.length) }, (_, i) => [
        ...(grid[i] ?? [seg(' '.repeat(gridColumns))]),
        seg(GUTTER),
        ...(legend[i] ?? []),
      ])
    : [...grid, [seg(' ')], ...legend]

  return [header, [seg(' ')], ...body].map(line => fit(line, columns))
}
