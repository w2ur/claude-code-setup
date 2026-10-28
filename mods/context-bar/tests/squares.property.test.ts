import { expect, test } from 'claude-code/testing'

import { squareCounts } from '../hooks/squares'

// fast-check is not importable in the mod runtime (no package manager), so this
// is a hand-rolled property test: a seeded PRNG builds 500 scenarios and the
// invariants are checked on each. A failure names its seed; rerun that seed.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

for (const squares of [100, 400]) {
  test(`filled squares equal round(min(1, used / window) x ${squares}), each category within one of its share`, () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = mulberry32(seed)
      const tokens = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => (rand() < 0.2 ? 0 : Math.floor(rand() ** 3 * 500_000)))
      const used = tokens.reduce((a, b) => a + b, 0)
      const windowTokens = 1 + Math.floor(rand() * 2_000_000)

      const counts = squareCounts(tokens, used, windowTokens, squares)
      const filled = used > 0 ? Math.round(Math.min(1, used / windowTokens) * squares) : 0

      expect(counts.reduce((a, b) => a + b, 0), `seed ${seed}`).toBe(filled)
      tokens.forEach((t, i) => {
        const exact = used > 0 ? (t / used) * filled : 0
        expect(Math.abs((counts[i] ?? 0) - exact), `seed ${seed} category ${i}`).toBeLessThan(1 + 1e-9)
      })
    }
  })
}
