import { expect, test } from 'claude-code/testing'

import { placer, placerEtapes, premiereCitation, seedOf, sousGraphe } from '../hooks/layout'
import type { Mention, Noeud } from '../hooks/layout'
import { GRAPHE } from './fixture'

const ids = (g: { nodes: { id: string }[] }) => g.nodes.map(n => n.id)

test('around a centre: the centre, its three neighbours, then distance 2 up to max', async () => {
  const g = sousGraphe(GRAPHE, 'borges', 6)
  expect(g.nodes).toHaveLength(6)
  expect(ids(g)[0]).toBe('borges')
  for (const id of ['la bibliothèque', 'écrire court', 'le labyrinthe']) expect(ids(g)).toContain(id)
  // Distance 3 never comes in, and only links between kept nodes are kept.
  expect(ids(g)).not.toContain('la promenade')
  for (const e of g.edges) {
    expect(ids(g)).toContain(e.from)
    expect(ids(g)).toContain(e.to)
  }
})

test('without a centre: the max nodes of highest degree and the links between them', async () => {
  const g = sousGraphe(GRAPHE, null, 4)
  expect([...ids(g)].sort()).toEqual(['borges', 'la bibliothèque', 'le labyrinthe', 'écrire court'].sort())
  expect(g.edges).toHaveLength(3)
})

test('an unknown centre gives an empty graph', async () => {
  expect(sousGraphe(GRAPHE, 'personne de ce nom', 6).nodes).toHaveLength(0)
})

test('placer is deterministic for a seed, and another seed moves something', async () => {
  const g = sousGraphe(GRAPHE, 'borges', 9)
  const a = placer(g, 60, 28, 7)
  const b = placer(g, 60, 28, 7)
  const c = placer(g, 60, 28, 8)
  expect([...a]).toEqual([...b])
  // The control that can fail: a different seed must change at least one position.
  expect([...a]).not.toEqual([...c])
})

test('every position is inside the frame, and the centre is pinned to the middle', async () => {
  for (const [columns, rows] of [[60, 28], [40, 28], [24, 10]] as const) {
    const g = sousGraphe(GRAPHE, 'borges', 9)
    const pos = placer(g, columns, rows, seedOf(g))
    // "la promenade" is at distance 3: 8 nodes.
    expect(pos.size).toBe(8)
    for (const { x, y } of pos.values()) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true)
      expect(x >= 0 && x < columns).toBe(true)
      expect(y >= 0 && y < rows).toBe(true)
    }
    const centre = pos.get('borges')!
    expect(Math.abs(centre.x - columns / 2) <= 2).toBe(true)
    expect(Math.abs(centre.y - rows / 2) <= 2).toBe(true)
  }
})

// `placer` as it stood before the settle replayed its run: borges and nine
// nodes at most, on 60 × 28, seeded by the ids. A change to the run moves these.
const STATIC_LAYOUT: [string, { x: number; y: number }][] = [
  ['borges', { x: 30, y: 14 }],
  ['la bibliothèque', { x: 32, y: 5 }],
  ['le labyrinthe', { x: 17, y: 13 }],
  ['écrire court', { x: 30, y: 22 }],
  ['le carnet', { x: 38, y: 27 }],
  ['le miroir', { x: 16, y: 20 }],
  ['le silence', { x: 19, y: 6 }],
  ['la nuit', { x: 41, y: 0 }],
]

test('the last image of the settle is the static layout', async () => {
  const g = sousGraphe(GRAPHE, 'borges', 9)
  expect([...placerEtapes(g, 60, 28, seedOf(g), 16).at(-1)!]).toEqual(STATIC_LAYOUT)
  expect([...placer(g, 60, 28, seedOf(g))]).toEqual(STATIC_LAYOUT)
  for (const [centre, columns, rows, images] of [[null, 80, 27, 16], ['le labyrinthe', 40, 28, 7], ['borges', 24, 10, 2]] as const) {
    const sub = sousGraphe(GRAPHE, centre, 20)
    expect([...placerEtapes(sub, columns, rows, seedOf(sub), images).at(-1)!]).toEqual([...placer(sub, columns, rows, seedOf(sub))])
  }
})

test('the settle gives as many images as asked, at least one', async () => {
  const g = sousGraphe(GRAPHE, 'borges', 9)
  expect(placerEtapes(g, 60, 28, seedOf(g), 16)).toHaveLength(16)
  expect(placerEtapes(g, 60, 28, seedOf(g), 1)).toHaveLength(1)
  expect(placerEtapes(g, 60, 28, seedOf(g), 0)).toHaveLength(1)
  // Nothing to place: as many images, all empty.
  const empty = placerEtapes({ nodes: [], edges: [] }, 60, 28, 1, 16)
  expect(empty).toHaveLength(16)
  for (const image of empty) expect(image.size).toBe(0)
})

test('every image keeps each node inside the frame, the centre pinned, and the nodes move', async () => {
  for (const [columns, rows] of [[60, 28], [40, 28], [24, 10]] as const) {
    const g = sousGraphe(GRAPHE, 'borges', 9)
    const images = placerEtapes(g, columns, rows, seedOf(g), 16)
    for (const image of images) {
      expect(image.size).toBe(g.nodes.length)
      for (const { x, y } of image.values()) {
        expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true)
        expect(x >= 0 && x < columns).toBe(true)
        expect(y >= 0 && y < rows).toBe(true)
      }
      expect(image.get('borges')).toEqual(images.at(-1)!.get('borges'))
    }
    // The control that can fail: the first image is the seeded start, not the end.
    expect([...images[0]!]).not.toEqual([...images.at(-1)!])
  }
})

test('the seed depends on the node ids only, not on their order', async () => {
  const g = sousGraphe(GRAPHE, null, 9)
  const reversed = { ...g, nodes: [...g.nodes].reverse() }
  expect(seedOf(reversed)).toBe(seedOf(g))
  expect(seedOf(sousGraphe(GRAPHE, null, 8))).not.toBe(seedOf(g))
})

test('an edge to an id that is not a node is ignored, not thrown on', async () => {
  const dangling = { from: 'borges', to: 'un nœud disparu', relation: 'cite', citation: '', source_id: '', genre: 'article' }
  const g = { ...GRAPHE, edges: [...GRAPHE.edges, dangling, { ...dangling, from: 'un autre disparu', to: 'le carnet' }] }
  const around = sousGraphe(g, 'borges', 9)
  expect(ids(around)).not.toContain('un nœud disparu')
  expect(around.edges.some(e => e.to === 'un nœud disparu')).toBe(false)
  // Same subgraph as without the dangling edges: they count for no degree.
  expect(ids(around)).toEqual(ids(sousGraphe(GRAPHE, 'borges', 9)))
  expect(ids(sousGraphe(g, null, 4))).toEqual(ids(sousGraphe(GRAPHE, null, 4)))
  expect(placer(around, 60, 28, seedOf(around)).size).toBe(around.nodes.length)
})

// Regression: fix(mods,scripts): graphe pane picks a visible citation — the centre's quote was `mentions[0].citation`, and a mixte
// node's ids sort `nouvelle:` first, so the default view quoted the fiction.
test('the centre quotes its first visible mention, never a hidden nouvelle', async () => {
  const fiction: Mention = { source_id: 'nouvelle:le-phare', slug: 'le-phare', date: '2026-01-02', resume: 'R.', citation: 'Phrase de fiction inventée.' }
  const mixte: Noeud = {
    id: 'la brume',
    type: 'idee',
    genre: 'mixte',
    premiere_date: '2026-01-02',
    mentions: [
      fiction,
      { source_id: 'post:un-post', slug: 'un-post', date: '2026-01-03', resume: 'R.', citation: 'Phrase de post inventée.' },
      { source_id: 'article:un-texte', slug: 'un-texte', date: '2026-01-04', resume: 'R.', citation: 'Phrase d’article inventée.' },
    ],
  }
  // The control: the first mention IS the fiction one.
  expect(mixte.mentions[0]?.citation).toBe('Phrase de fiction inventée.')
  expect(premiereCitation(mixte, false)).toBe('Phrase d’article inventée.')
  expect(premiereCitation(mixte, true)).toBe('Phrase de fiction inventée.')
  // An unplaceable mention on a mixte node never shows; nothing left → undefined.
  expect(premiereCitation({ ...mixte, mentions: [{ ...fiction, source_id: 'inconnu:x' }] }, false)).toBeUndefined()
})
