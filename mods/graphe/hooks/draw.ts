// Pure: a placed graph as rows of coloured spans. No `$`, so the tests import it as is.

import type { ThemeKey } from 'claude-code'

import { pulse } from './gfx'
import type { Graphe, Position } from './layout'

export type Ligne = { texte: string; couleur?: ThemeKey }[]

const LABEL = 14
const NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

// Node types as the extraction writes them (`idee`, `vecu`…), accents optional.
// Their names in the legend are in strings.ts, keyed by the same type.
export const GLYPHS: readonly (readonly [type: string, glyph: string])[] = [
  ['idee', '○'],
  ['gout', '◇'],
  ['reference', '▢'],
  ['vecu', '◆'],
  ['personne', '☉'],
  ['geste', '✎'],
]

export const plain = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const glyphOf = (type: string): string => GLYPHS.find(([t]) => t === plain(type))?.[1] ?? '•'

export const cut = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'

// Entries joined by two spaces, as many per row as the width holds.
export function pack(entries: string[], width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const entry of entries.map(e => cut(e, width))) {
    if (line !== '' && line.length + 2 + entry.length > width) {
      out.push(line)
      line = ''
    }
    line = line === '' ? entry : `${line}  ${entry}`
  }
  if (line !== '') out.push(line)

  return out
}

type Cell = { ch: string; couleur?: ThemeKey; isTaken: boolean }

// Distance from the centre inside the drawn graph, by breadth-first search.
function distances(g: Graphe, centre: string): Map<string, number> {
  const out = new Map([[centre, 0]])
  let ring = [centre]
  while (ring.length > 0) {
    const next: string[] = []
    for (const e of g.edges) {
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) {
        if (ring.includes(a) && !out.has(b)) {
          out.set(b, out.get(a)! + 1)
          next.push(b)
        }
      }
    }
    ring = next
  }

  return out
}

// Bresenham, the two ends left out: they hold the glyphs.
function segment(a: Position, b: Position): Position[] {
  const out: Position[] = []
  let { x, y } = a
  const dx = Math.abs(b.x - a.x)
  const dy = -Math.abs(b.y - a.y)
  const sx = a.x < b.x ? 1 : -1
  const sy = a.y < b.y ? 1 : -1
  let err = dx + dy
  while (x !== b.x || y !== b.y) {
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
    if (x !== b.x || y !== b.y) out.push({ x, y })
  }

  return out
}

function spans(row: Cell[]): Ligne {
  let end = row.length
  while (end > 0 && row[end - 1]!.ch === ' ') end--
  const out: Ligne = []
  for (const cell of row.slice(0, end)) {
    const last = out[out.length - 1]
    if (last !== undefined && last.couleur === cell.couleur) last.texte += cell.ch
    else out.push(cell.couleur === undefined ? { texte: cell.ch } : { texte: cell.ch, couleur: cell.couleur })
  }

  return out.length > 0 ? out : [{ texte: ' ' }]
}

/**
 * The graph on a `colonnes × lignes` grid, then, when a label found no room,
 * legend rows giving each number its label. Links first, as `·` dots; nodes
 * over them, a glyph per type and the label cut to 14 characters, right of
 * the glyph, else left, else replaced by a number `①…⑳`. Nodes are labelled
 * in the graph's order, so the first ones keep theirs. No row is longer than
 * `colonnes`. With `battement`, that node's glyph beats on its tick (gfx
 * `pulse`): blank one tick in four, its cell still held, so no label moves.
 */
export function dessiner(
  g: Graphe,
  pos: Map<string, Position>,
  colonnes: number,
  lignes: number,
  centre: string | null,
  battement?: { id: string; tick: number },
): Ligne[] {
  const grid: Cell[][] = Array.from({ length: lignes }, () =>
    Array.from({ length: colonnes }, (): Cell => ({ ch: ' ', isTaken: false })),
  )
  const at = (p: Position): Cell | undefined => grid[p.y]?.[p.x]
  const isFree = (p: Position) => {
    const cell = at(p)

    return cell !== undefined && !cell.isTaken
  }
  const put = (p: Position, ch: string, couleur?: ThemeKey) => {
    const cell = at(p)
    if (cell === undefined) return
    cell.ch = ch
    cell.isTaken = true
    if (couleur === undefined) delete cell.couleur
    else cell.couleur = couleur
  }

  for (const e of g.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (a === undefined || b === undefined) continue
    for (const p of segment(a, b)) {
      const cell = at(p)
      if (cell === undefined) continue
      cell.ch = '·'
      cell.couleur = 'inactive'
    }
  }

  const far = centre === null ? undefined : distances(g, centre)
  const colourOf = (id: string): ThemeKey => {
    if (far === undefined) return 'text'
    const d = far.get(id)

    return d === 0 ? 'claude' : d === 1 ? 'text' : 'subtle'
  }

  const drawn = g.nodes.filter(n => pos.has(n.id))
  for (const n of drawn) {
    const glyph = glyphOf(n.type)
    put(pos.get(n.id)!, battement?.id === n.id ? pulse(battement.tick, glyph) : glyph, colourOf(n.id))
  }

  const legend: string[] = []
  for (const n of drawn) {
    const { x, y } = pos.get(n.id)!
    const label = cut(n.id.normalize('NFC'), LABEL)
    const couleur = colourOf(n.id)
    // " label" right of the glyph, or "label " left of it.
    const right = Array.from({ length: label.length + 1 }, (_, i) => ({ x: x + 1 + i, y }))
    const left = Array.from({ length: label.length + 1 }, (_, i) => ({ x: x - 1 - label.length + i, y }))
    if (right.every(isFree)) {
      right.forEach((p, i) => put(p, i === 0 ? ' ' : label[i - 1]!, couleur))
    } else if (left.every(isFree)) {
      left.forEach((p, i) => put(p, i === label.length ? ' ' : label[i]!, couleur))
    } else if (legend.length < NUMBERS.length) {
      const number = NUMBERS[legend.length]!
      legend.push(`${number} ${label}`)
      const spot = [{ x: x + 1, y }, { x: x - 1, y }].find(isFree)
      if (spot !== undefined) put(spot, number, couleur)
    }
  }

  return [...grid.map(spans), ...pack(legend, colonnes).map(line => [{ texte: line }])]
}
