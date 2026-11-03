// Pure: which node the corpus passages put at the centre, and how a node's
// passages are laid out as text. No `$`, so the tests import it as is. The
// types mirror the corpus server's JSON (`POST /centre`, `POST /entry`).
import type { Closest } from './closest'
import { STRINGS } from './strings'
import type { Lang } from './strings'

export type Genre = 'article' | 'post' | 'fiction'

export type Neighbour = { i: number; texte: string; titre: string; genre: Genre; n: number; excerpt: string }
export type CentreHit = Neighbour & { score: number; entries: string[] }
export type EntryPassages = { passages: Array<Neighbour & { neighbours: Neighbour[] }> }

// Reciprocal-rank fusion's constant, the corpus search's own.
const K = 60

// The bar a node needs from passages alone, when the words say nothing. Its
// score is the sum, over the hits naming it, of 1 / (K + rank): 1/61 for a
// lone top-1 hit, 1/70 for a lone rank-10 hit. The bar comes from those
// fixtures: one hit in the top 5 of the 10 asked for (1/65, 0.0154) centres
// the node; a node named only by hits from rank 6 on does not (a lone rank-10
// hit scores 0.0143), unless two of them agree (1/66 + 1/67 = 0.0301).
export const MIN_PASSAGE_SCORE = 1 / (K + 5)

export type PassagePart = { part: number; title: string; rank: number }

/**
 * Each visible node's passage part: the sum, over the hits naming it, of
 * 1 / (K + the hit's rank, from 1), with the title and the rank of the first
 * hit naming it.
 */
export function passageParts(hits: readonly CentreHit[], visibleIds: ReadonlySet<string>): Map<string, PassagePart> {
  const parts = new Map<string, PassagePart>()
  hits.forEach((hit, index) => {
    for (const id of new Set(hit.entries)) {
      if (!visibleIds.has(id)) continue
      const seen = parts.get(id)
      const part = 1 / (K + index + 1)
      if (seen === undefined) parts.set(id, { part, title: hit.titre, rank: index + 1 })
      else seen.part += part
    }
  })

  return parts
}

/** A lone part at `rank` (from 1): 1 / (K + rank), the scale of fused scores. */
export const rankPart = (rank: number): number => 1 / (K + rank)

/** What one place lower costs a lone hit at `rank`: 1 / (K + rank) - 1 / (K + rank + 1). */
export const rankStep = (rank: number): number => 1 / (K + rank) - 1 / (K + rank + 1)

const byScore = (a: Closest, b: Closest): number => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The visible nodes the conversation points at, best first (a tie goes to a
 * node the words found, then by id).
 * A node's score adds up two parts, each only if the node is in that list: the
 * words' 1 / (K + lexical rank), and the passages' own score, the sum over the
 * hits naming it of 1 / (K + the hit's rank, from 1). A lone top-1 passage
 * therefore scores what a lone top-1 word match does, and a node named only by
 * weak hits scores little whatever its place among the nodes, which is what
 * MIN_PASSAGE_SCORE reads. `matched` keeps the lexical terms when there are
 * any, otherwise the title of the first hit naming the node.
 */
export function fuseCentre(lexical: readonly Closest[], hits: readonly CentreHit[], visibleIds: ReadonlySet<string>): Closest[] {
  const words = new Map<string, { part: number; matched: string[] }>()
  lexical
    .filter(c => visibleIds.has(c.id))
    .forEach((c, rank) => words.set(c.id, { part: 1 / (K + rank + 1), matched: c.matched }))

  const passages = passageParts(hits, visibleIds)

  const out: Closest[] = []
  for (const id of new Set([...words.keys(), ...passages.keys()])) {
    const w = words.get(id)
    const p = passages.get(id)
    const matched = w !== undefined && w.matched.length > 0 ? w.matched : p !== undefined ? [p.title] : []
    out.push({ id, score: (w?.part ?? 0) + (p?.part ?? 0), matched })
  }
  // A tie goes to the node the words found, then to the id: a lone top
  // passage scores what a lone top word match does, and must not win on its name.
  const byWords = (a: Closest, b: Closest): number => b.score - a.score || Number(words.has(b.id)) - Number(words.has(a.id)) || byScore(a, b)

  return out.sort(byWords)
}

// The section never grows past this many lines, heading included.
const MAX_LINES = 12
// Neighbours shown under a passage.
const NEIGHBOURS = 3

/** `text` on one line, cut with « … » to fit `width` characters. */
const fit = (text: string, width: number): string => {
  const chars = Array.from(text)

  return chars.length <= width ? chars.join('') : chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

// « titre · excerpt », or the title alone when the excerpt is empty.
const line = (p: Neighbour): string => (p.excerpt.trim() === '' ? p.titre : `${p.titre} · ${p.excerpt}`).replace(/\s+/g, ' ')

/**
 * The « passages » section of a node, as text lines of at most `width`
 * characters: a heading, then per passage « titre · excerpt » and up to 3
 * indented « ↳ titre · excerpt » neighbours. Passages and neighbours of a
 * genre `isHidden` names are dropped (the views' own predicate, `estMasque`).
 * No passage left: no lines.
 */
export function passageLines(entry: EntryPassages, width: number, isHidden: (genre: string) => boolean, lang: Lang): string[] {
  if (width < 1) return []
  const shown = (p: Neighbour): boolean => !isHidden(p.genre)
  const lines: string[] = []
  for (const p of entry.passages.filter(shown)) {
    lines.push(fit(line(p), width))
    for (const nb of p.neighbours.filter(shown).slice(0, NEIGHBOURS)) lines.push(fit(`  ↳ ${line(nb)}`, width))
  }
  if (lines.length === 0) return []

  return [fit(STRINGS[lang].passagesHeading, width), ...lines].slice(0, MAX_LINES)
}
