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
