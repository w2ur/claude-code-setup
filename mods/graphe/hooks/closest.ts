// Pure: which node is closest to a conversation. No `$`, so the tests import
// it as is. Lexical on purpose: the words of the last prompts against the
// words of each node's id and mention summaries, weighted by how rare they are.
import { visibles } from './layout'
import type { Graphe } from './layout'

// A term whose latest occurrence is `k` prompts back counts RECENCY ** k.
export const RECENCY = 0.8

// The score a node needs to be offered as a centre. A term's weight is its IDF
// scaled to 0..1 (1 for a term only one visible node holds, 0 for a term every
// node holds), so the bar reads the same on a 9-node fixture and a 500-node
// graph. 0.6 comes from the fixtures: a lone rare word (weight 1) centres up
// to 2 prompts back (0.8² = 0.64) and not at 3 (0.512); a word in 3 of 9 nodes
// (weight 0.5) or a word in every node (weight 0) never centres alone; two
// words of weight 0.5 said together do, which is a real match.
export const MIN_SCORE = 0.6

export type Closest = { id: string; score: number; matched: string[] }

// How many matched terms the header can name.
const MATCHED = 3

const STOPWORDS = new Set(
  (
    'les des une aux que qui pas pour par sur dans avec sans est sont etait ete etre avoir fait faire ' +
    'mais donc car ont elle elles ils nous vous ces cet cette son ses leur leurs mon mes ton tes notre votre ' +
    'tout tous plus moins tres comme aussi alors cela ceci peut peux veux dit fais ' +
    'the and for are was were with that this these those from into have has had not but you your they them ' +
    'its his her their our can could would should will just than then there what when where which who how ' +
    'all any some more most also about over out one'
  ).split(' '),
)

const strip = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '')

type Word = { key: string; shown: string }

/**
 * The words of a text: lowercased, split on anything that is not a letter,
 * the short ones (under 3 letters) and the stopwords dropped. `key` is the word
 * without its accents, what is compared; `shown` keeps them, what is displayed.
 */
export function words(text: string): Word[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{M}]+/u)
    .map(shown => ({ key: strip(shown), shown }))
    .filter(w => w.key.length >= 3 && !STOPWORDS.has(w.key))
}

export const tokens = (text: string): string[] => words(text).map(w => w.key)

// What `closest` reads of a graph: each node's terms, and a weight per term.
// Built once per graph load, then scored against every new prompt.
export type Index = { terms: Map<string, Set<string>>; weight: Map<string, number> }

/** The index of the nodes `visibles(g, tout)` returns, and only those. */
export function buildIndex(g: Graphe, tout = false): Index {
  const shown = visibles(g, tout).nodes
  const terms = new Map<string, Set<string>>(shown.map(n => [n.id, new Set(tokens([n.id, ...n.mentions.map(m => m.resume)].join(' ')))]))
  const holders = new Map<string, number>()
  for (const set of terms.values()) for (const t of set) holders.set(t, (holders.get(t) ?? 0) + 1)
  const n = shown.length
  const weight = new Map<string, number>()
  for (const [term, df] of holders) weight.set(term, n > 1 ? Math.log(n / df) / Math.log(n) : 0)

  return { terms, weight }
}

// The conversation's distinct terms: `k` (prompts back of the latest
// occurrence, 0 = the newest prompt) and the form to display.
function conversation(prompts: readonly string[]): Map<string, { k: number; shown: string }> {
  const out = new Map<string, { k: number; shown: string }>()
  for (let back = 0; back < prompts.length; back++) {
    for (const w of words(prompts[prompts.length - 1 - back]!)) if (!out.has(w.key)) out.set(w.key, { k: back, shown: w.shown })
  }

  return out
}

/**
 * Every node with a score above 0, best first (ties by id): the sum, over the
 * conversation's distinct terms the node has, of weight × RECENCY^k. `prompts`
 * run oldest to newest.
 */
export function rank(index: Index, prompts: readonly string[]): Closest[] {
  const talk = conversation(prompts)
  const out: Closest[] = []
  for (const [id, terms] of index.terms) {
    const parts: { shown: string; value: number }[] = []
    for (const [key, { k, shown }] of talk) {
      if (!terms.has(key)) continue
      const value = (index.weight.get(key) ?? 0) * RECENCY ** k
      if (value > 0) parts.push({ shown, value })
    }
    if (parts.length === 0) continue
    parts.sort((a, b) => b.value - a.value || (a.shown < b.shown ? -1 : a.shown > b.shown ? 1 : 0))
    out.push({ id, score: parts.reduce((sum, p) => sum + p.value, 0), matched: parts.slice(0, MATCHED).map(p => p.shown) })
  }

  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The best node of a ranking, if it reaches MIN_SCORE. */
export const best = (ranked: readonly Closest[]): Closest | undefined => (ranked[0] !== undefined && ranked[0].score >= MIN_SCORE ? ranked[0] : undefined)

/** The node closest to the conversation, among the visible ones, or none. */
export function closest(g: Graphe, prompts: readonly string[], tout = false): Closest | undefined {
  return best(rank(buildIndex(g, tout), prompts))
}
