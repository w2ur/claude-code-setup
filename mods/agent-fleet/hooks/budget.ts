// Without a metered budget, how long the end write may take; with one, the
// share left for `next(e)` and the engine is kept back by END_MARGIN_MS.
export const END_WAIT_MS = 1000
export const END_MARGIN_MS = 300

// How long session.end waits on its snapshot write, or undefined when it must
// not wait at all (a finite budget already spent: call `next(e)` at once).
export function endWaitMs(remainingMs: number): number | undefined {
  if (!Number.isFinite(remainingMs)) return END_WAIT_MS - END_MARGIN_MS
  if (remainingMs <= 0) return undefined

  return Math.max(0, remainingMs - END_MARGIN_MS)
}
