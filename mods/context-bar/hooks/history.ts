import type { ContextBarReading } from '../types'
import { rule } from './gfx'
import type { Line, Seg } from './squares'
import { fit } from './squares'

// The session's readings as a titled chart, in segments like the grid, so the
// layout is testable without a renderer.

// A fall of more than this many points between two readings is a compaction.
export const DROP_POINTS = 20
const LABEL = 5
const ROWS = 3
const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const WARN_HUE = '#d9a521'

const seg = (text: string, style: Omit<Seg, 'text'> = {}): Seg => ({ text, ...style })

export const isDrop = (before: number, now: number): boolean => before - now > DROP_POINTS

export function agoOf(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  return minutes % 60 === 0 ? `${minutes / 60}h ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
}

export type HistoryInput = {
  readings: readonly ContextBarReading[]
  width: number
  now: number
  accent?: string
}

// One column per reading, the last of a column's readings when there are more
// readings than columns; a column is marked when any of its readings fell.
function columnsOf(readings: readonly ContextBarReading[], cols: number): { percent: number; isDrop: boolean }[] {
  const out: { percent: number; isDrop: boolean }[] = []
  readings.forEach((r, i) => {
    const at = readings.length <= cols ? i : Math.floor((i * cols) / readings.length)
    const dropped = i > 0 && isDrop(readings[i - 1]?.percent ?? 0, r.percent)
    const column = out[at]
    if (column === undefined) out.push({ percent: r.percent, isDrop: dropped })
    else {
      column.percent = r.percent
      column.isDrop ||= dropped
    }
  })
  return out
}

// Eighths of a row, three rows high: 24 steps, and any reading above 0 shows.
function glyphAt(percent: number, row: number): string {
  const steps = percent > 0 ? Math.max(1, Math.round((Math.min(100, percent) / 100) * ROWS * 8)) : 0
  const fill = Math.min(8, Math.max(0, steps - (ROWS - 1 - row) * 8))

  return fill === 0 ? ' ' : (LEVELS[fill - 1] ?? ' ')
}

export function historyLines({ readings, width, now, accent }: HistoryInput): Line[] {
  const title: Line = [seg(rule('Context over this session', width), { dim: true })]
  if (readings.length === 0) return [title, [seg('No readings yet.', { dim: true })]].map(l => fit(l, width))

  const cols = Math.max(1, width - LABEL)
  const columns = columnsOf(readings, cols)
  const pad = (text: string): Seg => seg(text.padStart(LABEL - 1) + ' ', { dim: true })
  const blank = seg(' '.repeat(LABEL))
  const color = accent === undefined ? {} : { color: accent }

  const span = Math.max(columns.length, 'start'.length + 1 + 'now'.length)
  const axis = `start${' '.repeat(span - 'start'.length - 'now'.length)}now`

  let lastCompaction: number | undefined
  readings.forEach((r, i) => {
    if (i > 0 && isDrop(readings[i - 1]?.percent ?? 0, r.percent)) lastCompaction = r.at
  })
  const count = `${readings.length} ${readings.length === 1 ? 'reading' : 'readings'}`
  const footer = `${count} · last compaction ${lastCompaction === undefined ? 'none this session' : agoOf(now - lastCompaction)}`

  return [
    title,
    [blank, seg(columns.map(c => (c.isDrop ? '↓' : ' ')).join(''), { color: WARN_HUE, bold: true })],
    ...Array.from({ length: ROWS }, (_, row): Line => [
      row === 0 ? pad('100%') : row === ROWS - 1 ? pad('0%') : blank,
      seg(columns.map(c => glyphAt(c.percent, row)).join(''), color),
    ]),
    [blank, seg(axis, { dim: true })],
    [seg(footer, { dim: true })],
  ].map(l => fit(l, width))
}
