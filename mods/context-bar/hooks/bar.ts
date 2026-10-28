import type { ContextBarView } from '../types'
import { ease } from './gfx'

// Splits `width` cells among `weights` by largest remainder, so the cells
// always sum to `width` and no weight gets more than its share plus one.
export function segmentWidths(weights: number[], width: number): number[] {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0)
  if (total <= 0 || width <= 0) return weights.map(() => 0)

  const exact = weights.map(w => (Math.max(0, w) / total) * width)
  const cells = exact.map(Math.floor)
  let left = width - cells.reduce((sum, c) => sum + c, 0)

  const byRemainder = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest)
  for (const { i } of byRemainder) {
    if (left <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    left -= 1
  }
  return cells
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

// Each category's share of the whole window, by name: what the drawn bar
// glides toward.
export function fractionsOf(rows: readonly { name: string; tokens: number }[], maxTokens: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) out[row.name] = maxTokens > 0 ? row.tokens / maxTokens : 0
  return out
}

// One frame of the glide: every drawn value moves toward its target; a
// category that left the target shrinks to nothing and is dropped.
export function glide(from: ContextBarView, to: ContextBarView): ContextBarView {
  const fractions: Record<string, number> = {}
  for (const name of new Set([...Object.keys(from.fractions), ...Object.keys(to.fractions)])) {
    const goal = to.fractions[name]
    const value = ease(from.fractions[name] ?? 0, goal ?? 0)
    if (goal !== undefined || value > 0) fractions[name] = value
  }
  return { percent: ease(from.percent, to.percent), fractions }
}

export function isSettled(from: ContextBarView, to: ContextBarView): boolean {
  const next = glide(from, to)
  return (
    next.percent === from.percent &&
    Object.keys(next.fractions).length === Object.keys(from.fractions).length &&
    Object.entries(next.fractions).every(([name, v]) => v === from.fractions[name])
  )
}
