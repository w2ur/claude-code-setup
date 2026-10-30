import type { Line } from './calligram'
import { HUE, cut, rule, spark } from './gfx'
import { STRINGS } from './strings'
import type { Strings } from './strings'

// The memory folders as data, in the same lines-of-segments shape as calligram.ts:
// Farben, one square per memory coloured by type, and the 30-day activity series.

// The memory types, in legend order, each with its own hex hue; any other type,
// or none, counts as `autre`.
export const TYPES = ['feedback', 'project', 'user', 'reference', 'autre'] as const
export type MemoryType = (typeof TYPES)[number]
export const TYPE_HUE: Readonly<Record<MemoryType, string>> = {
  feedback: '#d4825a',
  project: '#4a90c8',
  user: '#8a7fc9',
  reference: '#8a8f98',
  autre: '#b5a05a',
}
export type Stamp = { mtimeMs: number; type: MemoryType }

// The heading, or its short form when the long one would be cut by the pane.
const heading = (long: string, short: string, width: number): Line => [
  { text: rule(`── ${long} `.length <= width ? long : short, width), bold: true },
]

// Farben: every memory, oldest first, as one '■' in its type's hue and wrapped
// to the width; one dim '□' per pending proposition item after them; then a
// legend that names every type present and wraps rather than drops one.
export function farben(all: readonly Stamp[], pending: number, width: number, t: Strings = STRINGS.fr): Line[] {
  const sorted = [...all].sort((a, b) => a.mtimeMs - b.mtimeMs)
  const out: Line[] = [[{ text: rule(t.farbenHeading(sorted.length), width), bold: true }]]
  const cells: { text: string; color?: string; dim?: boolean }[] = [
    ...sorted.map(s => ({ text: '■', color: TYPE_HUE[s.type] })),
    ...Array.from({ length: pending }, () => ({ text: '□', dim: true })),
  ]
  for (let from = 0; from < cells.length; from += Math.max(1, width)) {
    const row: Line = []
    for (const cell of cells.slice(from, from + Math.max(1, width))) {
      const last = row.at(-1)
      if (last !== undefined && last.color === cell.color && last.dim === cell.dim) last.text += cell.text
      else row.push({ ...cell })
    }
    out.push(row)
  }

  let row: Line = []
  let used = 0
  for (const type of TYPES) {
    const count = sorted.filter(s => s.type === type).length
    if (count === 0) continue
    const named = cut(` ${t.typeLabels[type]} ${count}`, Math.max(0, width - 1))
    const size = 1 + named.length
    if (row.length > 0 && used + 2 + size > width) {
      out.push(row)
      row = []
      used = 0
    }
    if (row.length > 0) {
      row.push({ text: '  ' })
      used += 2
    }
    row.push({ text: '■', color: TYPE_HUE[type] }, { text: named })
    used += size
  }
  if (row.length > 0) out.push(row)
  if (pending > 0) out.push([{ text: '□', dim: true }, { text: cut(` ${t.pendingItems(pending)}`, Math.max(0, width - 1)) }])

  return out
}

// The files modified per day over the last 30 days, today last: a heading, the
// sparkline and the total, on one line when they fit and on two when not.
export function activity(days: readonly number[], width: number, t: Strings = STRINGS.fr): Line[] {
  const total = days.reduce((sum, n) => sum + n, 0)
  const tail = t.filesChanged(total)
  const series = spark(days, Math.min(days.length, width))
  const head = heading(t.activityLong, t.activityShort, width)
  if (series.length + 1 + tail.length <= width) return [head, [{ text: series, color: HUE.cold }, { text: ` ${tail}`, dim: true }]]

  return [head, [{ text: series, color: HUE.cold }], [{ text: cut(tail, width), dim: true }]]
}
