import { expect, test } from 'claude-code/testing'

import { buildIndex, rank } from '../hooks/closest'
import type { Index } from '../hooks/closest'
import type { Graphe } from '../hooks/layout'

// fast-check is not in the kit: a seeded loop, mulberry32, so a failure replays.
function random(seed: number): () => number {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCAB = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
// Absent from every node and every stopword list.
const UNRELATED = 'zzyzx qwxz'

const pick = <T,>(next: () => number, xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!
const sentence = (next: () => number, max: number): string =>
  Array.from({ length: 1 + Math.floor(next() * max) }, () => pick(next, VOCAB)).join(' ')

function randomGraph(next: () => number): Graphe {
  const count = 2 + Math.floor(next() * 14)

  return {
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `${sentence(next, 2)} n${String.fromCharCode(97 + i)}`,
      type: 'idee',
      genre: 'article',
      premiere_date: '2026-01-02',
      mentions: [{ source_id: 'article:t', slug: 't', date: '2026-01-02', resume: sentence(next, 6), citation: '' }],
    })),
    edges: [],
  }
}

const scoreOf = (index: Index, prompts: string[], id: string): number => rank(index, prompts).find(r => r.id === id)?.score ?? 0

const RUNS = 300
const TOLERANCE = 1e-9

test('property: a score is never negative, never NaN, and ranks come sorted', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const next = random(seed)
    const index = buildIndex(randomGraph(next))
    const prompts = Array.from({ length: Math.floor(next() * 25) }, () => sentence(next, 5))
    const ranked = rank(index, prompts)
    for (const r of ranked) {
      expect(Number.isFinite(r.score)).toBe(true)
      expect(r.score).toBeGreaterThan(0)
      expect(r.matched.length).toBeLessThanOrEqual(3)
    }
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score)
  }
})

test('property: a newest prompt with no node word never raises a score, and a matching one never scores less than it', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const next = random(seed)
    const g = randomGraph(next)
    const index = buildIndex(g)
    const prompts = Array.from({ length: Math.floor(next() * 8) }, () => sentence(next, 5))
    const matching = sentence(next, 3)
    for (const node of g.nodes) {
      const before = scoreOf(index, prompts, node.id)
      const unrelated = scoreOf(index, [...prompts, UNRELATED], node.id)
      const matched = scoreOf(index, [...prompts, matching], node.id)
      // The unrelated prompt only ages the older ones.
      expect(unrelated).toBeLessThanOrEqual(before + TOLERANCE)
      // The same prompts plus a matching one score at least what plus an unrelated one does.
      expect(matched).toBeGreaterThanOrEqual(unrelated - TOLERANCE)
    }
  }
})
