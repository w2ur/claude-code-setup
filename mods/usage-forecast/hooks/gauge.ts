import { HUE, bar, heat } from './gfx'

// The window gauge as data: styled segments, so the drawing is testable
// without a renderer.

export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }

type Cell = { ch: string; color?: string; dim?: boolean }

// `width` cells: the used share in eighths, coloured by heat; ahead of it, the
// share the window reaches by its reset at this pace (▒); the guard threshold
// as a ┃ marker. Cells are merged back into runs of one style.
export function gauge(percent: number, projected: number | undefined, threshold: number | undefined, width: number): Seg[] {
  if (width <= 0) return []
  const hotAt = threshold === undefined ? 0.9 : threshold / 100
  const [filled, empty] = bar(percent / 100, width)
  const fill = heat(percent / 100, Math.min(0.7, hotAt - 0.1), hotAt)
  const cells: Cell[] = [...filled].map(ch => ({ ch, color: fill }))
  const ghostEnd = projected === undefined ? 0 : Math.round((projected / 100) * width)
  const ghost = projected !== undefined && projected >= 100 ? HUE.hot : HUE.warm
  for (const ch of empty) {
    cells.push(cells.length < ghostEnd ? { ch: '▒', color: ghost } : { ch, dim: true })
  }
  if (threshold !== undefined) {
    const at = Math.min(width - 1, Math.round((threshold / 100) * width))
    const held = cells[at]
    if (held !== undefined) cells[at] = { ch: '┃', color: held.color === fill ? fill : HUE.hot }
  }

  const out: Seg[] = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.color === cell.color && last.dim === cell.dim) last.text += cell.ch
    else out.push({ text: cell.ch, color: cell.color, dim: cell.dim })
  }
  return out
}
