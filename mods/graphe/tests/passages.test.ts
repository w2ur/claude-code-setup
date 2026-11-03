import { expect, test } from 'claude-code/testing'

import type { Closest } from '../hooks/closest'
import { MIN_PASSAGE_SCORE, fuseCentre, passageLines } from '../hooks/passages'
import { estMasque } from '../hooks/layout'
import type { CentreHit, EntryPassages, Genre, Neighbour } from '../hooks/passages'

// Invented passages: no title or text here comes from a real work, because
// this folder is published.
const hit = (entries: string[], titre = 'Texte d’essai', genre: Genre = 'article'): CentreHit => ({
  i: 0,
  texte: 'article:essai',
  titre,
  genre,
  n: 1,
  excerpt: 'Un extrait inventé.',
  score: 1,
  entries,
})
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-12
const word = (id: string, score = 0.9, matched = ['mot']): Closest => ({ id, score, matched })
const all = (...ids: string[]) => new Set(ids)

test('fusion_mots_et_passages: both lists add up, ties go by id, matched keeps the words', () => {
  const lexical = [word('alpha', 0.9, ['aube']), word('beta', 0.5, ['brume'])]
  const hits = [hit(['beta'], 'Titre B'), hit(['gamma'], 'Titre G'), hit(['alpha'], 'Titre A')]
  const fused = fuseCentre(lexical, hits, all('alpha', 'beta', 'gamma'))
  // beta: word rank 2 + hit rank 1; alpha: word rank 1 + hit rank 3; gamma: hit rank 2 alone.
  expect(fused.map(c => c.id)).toEqual(['beta', 'alpha', 'gamma'])
  expect(near(fused[0]!.score, 1 / 62 + 1 / 61)).toBe(true)
  expect(near(fused[1]!.score, 1 / 61 + 1 / 63)).toBe(true)
  expect(near(fused[2]!.score, 1 / 62)).toBe(true)
  // The words' terms when there are any; else the title of the first hit naming the node.
  expect(fused[0]!.matched).toEqual(['brume'])
  expect(fused[2]!.matched).toEqual(['Titre G'])
  // Two nodes named by the same top hit tie, and the id decides.
  expect(fuseCentre([], [hit(['zeta', 'eta'])], all('zeta', 'eta')).map(c => c.id)).toEqual(['eta', 'zeta'])
})

test('invisible_jamais_centre: a node outside visibleIds never comes out, from either list', () => {
  const fused = fuseCentre([word('cache'), word('vu')], [hit(['cache', 'vu']), hit(['autre-cache'])], all('vu'))
  expect(fused.map(c => c.id)).toEqual(['vu'])
  // Lexical ranks count visible nodes only; a hit keeps its place whoever it names.
  expect(near(fused[0]!.score, 2 / 61)).toBe(true)
})

test('seuil_passage: a top passage centres a node alone, a rank-10 passage does not', () => {
  const top = fuseCentre([], [hit(['alpha'])], all('alpha'))[0]!
  expect(top.score).toBeGreaterThanOrEqual(MIN_PASSAGE_SCORE)

  // Nine hits name something else; the tenth names `beta`, which is still the best visible node left.
  const filler = Array.from({ length: 9 }, () => hit(['autre']))
  const weak = fuseCentre([], [...filler, hit(['beta'])], all('beta'))[0]!
  expect(weak.id).toBe('beta')
  expect(weak.score).toBeLessThan(MIN_PASSAGE_SCORE)

  // The bar is a rank, not a place among the nodes: rank 4 clears, rank 6 does not.
  const at = (rank: number) => fuseCentre([], [...Array.from({ length: rank - 1 }, () => hit(['autre'])), hit(['beta'])], all('beta'))[0]!.score
  expect(at(4)).toBeGreaterThanOrEqual(MIN_PASSAGE_SCORE)
  expect(at(6)).toBeLessThan(MIN_PASSAGE_SCORE)
  // Rank 5 sits exactly on the bar, and the bar is `>=`: it clears.
  expect(at(5)).toBe(MIN_PASSAGE_SCORE)
  // Two weak hits that agree do clear it.
  const twice = [...Array.from({ length: 5 }, () => hit(['autre'])), hit(['beta']), hit(['beta'])]
  expect(fuseCentre([], twice, all('beta'))[0]!.score).toBeGreaterThanOrEqual(MIN_PASSAGE_SCORE)
})

// The views' predicate: posts and fiction hidden by default, every genre with tout.
const DEFAUT = (genre: string): boolean => estMasque(genre, false)
const TOUT = (genre: string): boolean => estMasque(genre, true)
const nb = (titre: string, genre: Genre = 'article', excerpt = 'Un voisin inventé.'): Neighbour => ({ i: 1, texte: 'article:voisin', titre, genre, n: 2, excerpt })
const entry = (...passages: EntryPassages['passages']): EntryPassages => ({ passages })

test('largeur_etroite: at width 30, no line is longer than 30', () => {
  const long = 'Un très long extrait inventé qui dépasse de loin la largeur du panneau étroit.'
  const e = entry({ ...nb('Un titre assez long pour déborder', 'article', long), neighbours: [nb('Autre titre long', 'article', long), nb('Troisième', 'article', long)] })
  for (const lang of ['fr', 'en'] as const) {
    const lines = passageLines(e, 30, DEFAUT, lang)
    expect(lines.length).toBe(4)
    for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(30)
  }
  const lines = passageLines(e, 30, DEFAUT, 'fr')
  expect(lines[1]!.endsWith('…')).toBe(true)
  expect(lines[2]!.startsWith('  ↳ ')).toBe(true)
  // A line that fits is left alone.
  expect(passageLines(entry({ ...nb('Court', 'article', 'bref'), neighbours: [] }), 30, DEFAUT, 'fr')[1]).toBe('Court · bref')
})

test('genres_masques: fiction and post passages and neighbours show only with tout, as in every view', () => {
  const e = entry(
    { ...nb('Récit imaginaire', 'fiction'), neighbours: [] },
    { ...nb('Billet imaginaire', 'post'), neighbours: [] },
    { ...nb('Essai réel', 'article'), neighbours: [nb('Conte voisin', 'fiction'), nb('Billet voisin', 'post'), nb('Essai voisin')] },
  )
  const hidden = passageLines(e, 80, DEFAUT, 'fr').join('\n')
  expect(hidden).not.toContain('Récit imaginaire')
  expect(hidden).not.toContain('Conte voisin')
  expect(hidden).not.toContain('Billet imaginaire')
  expect(hidden).not.toContain('Billet voisin')
  expect(hidden).toContain('Essai réel')
  expect(hidden).toContain('Essai voisin')
  const shown = passageLines(e, 80, TOUT, 'fr').join('\n')
  expect(shown).toContain('Récit imaginaire')
  expect(shown).toContain('Conte voisin')
  expect(shown).toContain('Billet imaginaire')
  expect(shown).toContain('Billet voisin')
  // Nothing but fiction: no section at all, not a bare heading.
  expect(passageLines(entry({ ...nb('Récit imaginaire', 'fiction'), neighbours: [] }), 80, DEFAUT, 'fr')).toEqual([])
})

test('vide: no passages gives no lines, and the section never passes 12 lines', () => {
  expect(passageLines(entry(), 80, TOUT, 'fr')).toEqual([])
  const many = entry(...Array.from({ length: 8 }, (_, i) => ({ ...nb(`Titre ${i}`), neighbours: [nb('a'), nb('b'), nb('c'), nb('d')] })))
  const lines = passageLines(many, 80, DEFAUT, 'en')
  expect(lines.length).toBe(12)
  expect(lines[0]).toBe('Passages that echo')
  // Three neighbours at most per passage.
  expect(lines[5]).toBe('Titre 1 · Un voisin inventé.')
  expect(lines.filter(l => l.includes('↳')).length).toBe(8)
})

test('titre_de_repli: matched falls back to the first hit naming the node, also behind empty words', () => {
  // `gamma` is named by two hits; the first one's title is the one kept.
  const fused = fuseCentre([], [hit(['autre'], 'Premier'), hit(['gamma'], 'Deuxième'), hit(['gamma'], 'Troisième')], all('gamma', 'autre'))
  expect(fused.find(c => c.id === 'gamma')!.matched).toEqual(['Deuxième'])
  // A lexical entry with no terms does not hide the passages' title.
  expect(fuseCentre([word('delta', 0.9, [])], [hit(['delta'], 'Titre D')], all('delta'))[0]!.matched).toEqual(['Titre D'])
  // No words and no hit naming it: no node at all, so no empty `matched` either.
  expect(fuseCentre([], [hit(['ailleurs'])], all('delta'))).toEqual([])
})

test('extrait_vide: an empty excerpt leaves the title alone, with no trailing separator', () => {
  const lines = passageLines(entry({ ...nb('Seul titre', 'article', ''), neighbours: [nb('Voisin seul', 'article', '  ')] }), 80, DEFAUT, 'fr')
  expect(lines).toEqual(['Passages qui font écho', 'Seul titre', '  ↳ Voisin seul'])
})

test('egalite_aux_mots: a fused tie goes to the node the words found, before the id', () => {
  // Both score 1/61: "borges" by a lone top passage, "la bibliothèque" by a lone top word match.
  const fused = fuseCentre([word('la bibliothèque')], [hit(['borges'])], all('borges', 'la bibliothèque'))
  expect(near(fused[0]!.score, fused[1]!.score)).toBe(true)
  expect(fused.map(c => c.id)).toEqual(['la bibliothèque', 'borges'])
})
