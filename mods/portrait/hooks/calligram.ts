import { bar, cut, heat } from './gfx'

// The portrait's size as a bust drawn in its own words, as data: lines of styled
// segments, already cut to the pane's width. register.tsx only maps them to
// Text elements, so the layout is testable without a renderer. A status is a
// theme semantic token (`tone`); a drawing takes a raw hex (`color`).

export type Tone = 'error'
export type Seg = { text: string; tone?: Tone; color?: string; dim?: boolean; bold?: boolean }
export type Line = Seg[]

// Below this width the bust is unreadable and the pane keeps its gauge line.
export const MIN_COLUMNS = 30
// The silhouette is drawn on a 38 by 17 grid, then scaled to the pane; it never
// grows wider than MAX_WIDTH, so a wide pane does not get a tall bust.
const BASE_WIDTH = 38
const BASE_HEIGHT = 17
const MAX_WIDTH = 48
const CURSOR = '▌'
const EMPTY = '░'
const SPACE = '·'

// One run of the silhouette on a row: its first column and its length.
export type Run = { from: number; count: number }

// Whether the point (u, v) of the 38 by 17 grid is inside the bust: a head
// ellipse, a neck, then shoulders widening by three columns per row.
function inside(u: number, v: number): boolean {
  const hx = (u - 19) / 10.5
  const hy = (v - 5.5) / 5.6
  if (hx * hx + hy * hy <= 1) return true
  if (v >= 10.5 && v < 12.5) return Math.abs(u - 19) <= 4
  if (v >= 12.5) return Math.abs(u - 19) <= 9 + (v - 13) * 3

  return false
}

// The bust's rows from the top, centred in `width`; each row is one run.
export function silhouette(width: number): Run[] {
  const wide = Math.min(width, MAX_WIDTH)
  const scale = wide / BASE_WIDTH
  const margin = Math.floor((width - wide) / 2)
  const rows: Run[] = []
  for (let y = 0; y < Math.round(BASE_HEIGHT * scale); y++) {
    const xs: number[] = []
    for (let x = 0; x < wide; x++) if (inside((x + 0.5) / scale, (y + 0.5) / scale - 0.5)) xs.push(x)
    if (xs.length > 0) rows.push({ from: margin + xs[0]!, count: xs.length })
  }

  return rows
}

export const capacity = (width: number): number => silhouette(width).reduce((sum, row) => sum + row.count, 0)

// The text poured into the bust: heading markers and list dashes dropped,
// every whitespace run shown as one '·'. Never empty, so a cell always has a letter.
export function pourable(text: string): string {
  const flat = text
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim()
    .replace(/\s+/g, SPACE)

  return flat === '' ? SPACE : flat
}

// What the pending propositions would make of the portrait: its size afterwards,
// and the text they add, which draws the ghost cells.
export type Projection = { size: number; text: string }

export type CalligramInput = {
  // The whole portrait file, or undefined when it is missing.
  portrait: string | undefined
  n: number
  limit: number
  // The fill tween, 0 to 1.
  fill: number
  width: number
  projection?: Projection
}

type Kind = 'letter' | 'cursor' | 'ghost' | 'empty'

const share = (n: number, limit: number, cells: number): number => Math.max(0, Math.round((n / limit) * cells))

// The cells: filled in reading order, then, once the fill has landed, a cursor
// and the ghost cells of the pending propositions, then what stays free.
export function layout(input: CalligramInput): { filled: number; ghost: number } {
  const cells = capacity(input.width)
  const target = Math.min(cells, share(input.n, input.limit, cells))
  const filled = Math.min(cells, Math.round(target * Math.min(1, Math.max(0, input.fill))))
  if (input.projection === undefined || input.fill < 1) return { filled, ghost: 0 }
  const extra = Math.min(share(input.projection.size, input.limit, cells), cells) - target

  return { filled, ghost: Math.max(0, Math.min(extra, cells - filled - 1)) }
}

// Under the bust: the size in words, then the size the propositions would make.
function summary(input: CalligramInput): Line[] {
  const pct = Math.round((input.n / input.limit) * 100)
  const base = `${input.n} / ${input.limit} caractères · ${pct} %`
  if (input.projection === undefined) return [[{ text: cut(base, input.width) }]]
  const after = `${input.projection.size} après propositions`
  if (base.length + 3 + after.length <= input.width) return [[{ text: `${base} · ${after}` }]]

  return [[{ text: cut(base, input.width) }], [{ text: cut(after, input.width) }]]
}

// The bust, then the overflow line when the portrait is past its threshold, then
// the summary. Undefined when the pane is too narrow: the caller keeps its gauge.
export function calligram(input: CalligramInput): Line[] | undefined {
  if (input.width < MIN_COLUMNS || input.limit <= 0) return undefined
  const letters = pourable(input.portrait ?? '')
  const ghosts = pourable(input.projection?.text ?? '')
  const { filled, ghost } = layout(input)
  const color = heat(input.n / input.limit, 0.85, 0.97)
  const out: Line[] = []
  let at = 0
  for (const row of silhouette(input.width)) {
    const kinds: { kind: Kind; text: string }[] = []
    for (let i = at; i < at + row.count; i++) {
      const kind: Kind = i < filled ? 'letter' : ghost > 0 && i === filled ? 'cursor' : ghost > 0 && i <= filled + ghost ? 'ghost' : 'empty'
      const char = kind === 'letter' ? letters[i % letters.length]! : kind === 'cursor' ? CURSOR : kind === 'ghost' ? ghosts[(i - filled - 1) % ghosts.length]! : EMPTY
      const last = kinds.at(-1)
      if (last?.kind === kind) last.text += char
      else kinds.push({ kind, text: char })
    }
    at += row.count
    const line: Line = row.from > 0 ? [{ text: ' '.repeat(row.from) }] : []
    for (const { kind, text } of kinds) {
      if (kind === 'letter') line.push({ text, color })
      else if (kind === 'cursor') line.push({ text, bold: true })
      else line.push({ text, dim: true })
    }
    out.push(line)
  }
  if (input.n > input.limit && filled >= capacity(input.width)) {
    out.push([{ text: cut(`+${input.n - input.limit} car. au-delà du seuil`, input.width), tone: 'error' }])
  }

  return [...out, ...summary(input)]
}

// Today's gauge line, kept for a pane too narrow for the bust.
export function gauge(n: number, limit: number, fill: number, width: number): Line {
  const ratio = n / limit
  const label = ` ${n} / ${limit} car.`
  const [on, off] = bar(ratio * fill, Math.max(0, width - 'Taille '.length - label.length))

  return [{ text: 'Taille ', bold: true }, { text: on, color: heat(ratio, 0.85, 0.97) }, { text: off, dim: true }, { text: label }]
}
