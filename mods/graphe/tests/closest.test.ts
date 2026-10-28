import { expect, test } from 'claude-code/testing'

import { MIN_SCORE, RECENCY, best, buildIndex, closest, rank, tokens } from '../hooks/closest'
import type { Graphe, Noeud } from '../hooks/layout'
import { GRAPHE } from './fixture'

// An invented graph: a node is its id and what its mentions summarise.
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

const node = (id: string, resumes: string[] = [], genre = 'article'): Noeud => ({
  id,
  type: 'idee',
  genre,
  premiere_date: '2026-01-02',
  mentions: resumes.map((resume, i) => ({ source_id: `article:t${i}`, slug: `t${i}`, date: '2026-01-02', resume, citation: '' })),
})
const graph = (...nodes: Noeud[]): Graphe => ({ nodes, edges: [] })

test('tokens: lowercase, accents stripped, split on non-letters, short words and stopwords dropped', () => {
  expect(tokens('Écrire, c’est le LABYRINTHE-miroir; 42 fois!')).toEqual(['ecrire', 'labyrinthe', 'miroir', 'fois'])
  // Under three letters, then the French and English stopwords.
  expect(tokens('un de le la et of to the and pour dans avec this that')).toEqual([])
})

test('an accent or a case in the prompt still finds the node', () => {
  const g = graph(node('la bibliothèque'), node('le silence'), node('la nuit'))
  expect(closest(g, ['LA BIBLIOTHEQUE de Babel'])?.id).toBe('la bibliothèque')
  expect(closest(g, ['bibliothèque'])?.id).toBe('la bibliothèque')
})

test('a node holds the words of its id and of every mention summary', () => {
  const g = graph(node('borges', ['Un récit de labyrinthe.', 'Le sablier du temps.']), node('le silence'), node('la nuit'))
  expect(closest(g, ['sablier'])?.id).toBe('borges')
  expect(closest(g, ['labyrinthe'])?.id).toBe('borges')
})

test('IDF: a rare word outweighs a common one', () => {
  const g = graph(node('alpha commun'), node('beta commun'), node('gamma commun'), node('delta rare commun'), node('epsilon'), node('zeta'))
  // "commun" is in four of six nodes, "rare" in one: said together, the rare word decides.
  const ranked = rank(buildIndex(g), ['commun rare'])
  expect(ranked[0]!.id).toBe('delta rare commun')
  expect(ranked[0]!.matched).toEqual(['rare', 'commun'])
  const second = ranked[1]!
  expect(ranked[0]!.score).toBeGreaterThan(second.score)
})

test('a word every node holds weighs nothing', () => {
  const g = graph(node('alpha', ['même fond']), node('beta', ['même fond']), node('gamma', ['même fond']))
  expect(rank(buildIndex(g), ['fond même'])).toEqual([])
})

test('recency: a term counts RECENCY ** k for k prompts back, by its latest occurrence', () => {
  const g = graph(node('alpha'), node('beta'), node('gamma'))
  const index = buildIndex(g)
  const now = rank(index, ['alpha'])[0]!.score
  expect(near(rank(index, ['alpha', 'rien', 'rien'])[0]!.score, now * RECENCY ** 2)).toBe(true)
  // Said twice, only the latest occurrence counts, once.
  expect(near(rank(index, ['alpha', 'rien', 'alpha'])[0]!.score, now)).toBe(true)
  expect(near(rank(index, ['alpha alpha'])[0]!.score, now)).toBe(true)
})

test('a newer topic outweighs an older one', () => {
  const g = graph(node('alpha'), node('beta'), node('gamma'))
  expect(closest(g, ['alpha', 'beta'])?.id).toBe('beta')
})

test('matched: at most three terms, the strongest first, shown as the person typed them', () => {
  const g = graph(node('alpha bêta gamma delta'), node('epsilon'), node('zeta'), node('thêta'))
  const found = closest(g, ['alpha', 'rien', 'bêta gamma delta'])!
  expect(found.matched).toHaveLength(3)
  // "alpha" is the oldest, so the one left out.
  expect(found.matched).toEqual(['bêta', 'delta', 'gamma'])
})

// MIN_SCORE: a lone rare word (weight 1) centres up to two prompts back
// (0.8² = 0.64) and not at three (0.512); a word in 3 of 9 nodes (weight 0.5)
// or in all of them (weight 0) never centres alone.
test('threshold: one rare word centres while fresh, goes stale after two prompts', () => {
  const g = graph(...['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'].map(id => node(id)))
  expect(MIN_SCORE).toBeGreaterThan(RECENCY ** 3)
  expect(MIN_SCORE).toBeLessThanOrEqual(RECENCY ** 2)
  expect(closest(g, ['alpha'])?.id).toBe('alpha')
  expect(closest(g, ['alpha', 'rien'])?.id).toBe('alpha')
  expect(closest(g, ['alpha', 'rien', 'rien'])?.id).toBe('alpha')
  expect(closest(g, ['alpha', 'rien', 'rien', 'rien'])).toBeUndefined()
})

test('threshold: a single common word does not centre', () => {
  const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota']
  const common = graph(...ids.map((id, i) => node(id, [i < 3 ? 'thème partagé' : 'autre'])))
  // "partagé" is in 3 of 9 nodes: it ranks them, but not enough to centre.
  const ranked = rank(buildIndex(common), ['partagé'])
  expect(ranked).toHaveLength(3)
  expect(best(ranked)).toBeUndefined()
  expect(closest(common, ['partagé'])).toBeUndefined()
  // A word every node holds scores nothing at all.
  const all = graph(...ids.map(id => node(id, ['thème partagé'])))
  expect(closest(all, ['partagé'])).toBeUndefined()
  expect(rank(buildIndex(all), ['partagé'])).toEqual([])
})

test('hidden genres are never candidates, unless tout', () => {
  expect(closest(GRAPHE, ['brouillon'])).toBeUndefined()
  expect(closest(GRAPHE, ['tempête'])).toBeUndefined()
  expect(closest(GRAPHE, ['brouillon'], true)?.id).toBe('le brouillon')
  expect(closest(GRAPHE, ['tempête'], true)?.id).toBe('la tempête')
  // And the visible ones are found in the fixture.
  expect(closest(GRAPHE, ['promenade'])?.id).toBe('la promenade')
  // A word the hidden node holds weighs by the visible nodes only.
  const hidden = graph(node('alpha'), node('beta'), node('gamma', [], 'post'))
  expect(buildIndex(hidden).terms.has('gamma')).toBe(false)
})

test('no prompts, no words, or words no node holds: nothing', () => {
  expect(closest(GRAPHE, [])).toBeUndefined()
  expect(closest(GRAPHE, ['', 'le la et'])).toBeUndefined()
  expect(closest(GRAPHE, ['xylophone'])).toBeUndefined()
  expect(closest({ nodes: [], edges: [] }, ['borges'])).toBeUndefined()
})

test('a one-node graph has no rare word to speak of: nothing centres', () => {
  expect(closest(graph(node('borges')), ['borges'])).toBeUndefined()
})
