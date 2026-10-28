import { expect, test } from 'claude-code/testing'

import { cut, dessiner } from '../hooks/draw'
import type { Ligne } from '../hooks/draw'
import { placer, seedOf, sousGraphe } from '../hooks/layout'
import type { Graphe } from '../hooks/layout'
import { GRAPHE } from './fixture'

const text = (row: Ligne) => row.map(s => s.texte).join('')
const all = (rows: Ligne[]) => rows.map(text).join('\n')

const tiny = (ids: string[], links: [string, string][]): Graphe => ({
  nodes: ids.map(id => ({ id, type: 'idee', genre: 'article', premiere_date: '2026-01-02', mentions: [] })),
  edges: links.map(([from, to]) => ({ from, to, relation: 'r', citation: '', source_id: '', genre: 'article' })),
})

test('every direct neighbour label is in the drawing', async () => {
  const g = sousGraphe(GRAPHE, 'borges', 9)
  const out = all(dessiner(g, placer(g, 80, 28, seedOf(g)), 80, 28, 'borges'))
  // Labels are cut to 14 characters: "la bibliothèque" is one longer.
  for (const id of ['borges', 'la bibliothèque', 'écrire court', 'le labyrinthe']) expect(out).toContain(cut(id, 14))
  expect(out).toContain('la bibliothèq…')
})

test('a link leaves a dot between its ends, and two unlinked far nodes leave none', async () => {
  const g = tiny(['a', 'b', 'c', 'd'], [['a', 'b']])
  const pos = new Map([
    ['a', { x: 2, y: 2 }],
    ['b', { x: 30, y: 2 }],
    ['c', { x: 2, y: 10 }],
    ['d', { x: 30, y: 10 }],
  ])
  const rows = dessiner(g, pos, 60, 20, null)
  expect(text(rows[2]!).slice(3, 30)).toContain('·')
  expect(text(rows[10]!)).not.toContain('·')
  // The dots are drawn in the inactive colour.
  expect(rows[2]!.some(s => s.texte.includes('·') && s.couleur === 'inactive')).toBe(true)
})

test('a glyph per type, and the label cut to 14 characters', async () => {
  const g = tiny(['une étiquette beaucoup trop longue'], [])
  g.nodes[0]!.type = 'geste'
  const rows = dessiner(g, new Map([['une étiquette beaucoup trop longue', { x: 0, y: 0 }]]), 60, 3, null)
  expect(text(rows[0]!).trimEnd()).toBe('✎ une étiquette…')
})

test('no row is longer than the width, at 40 and at 60 columns', async () => {
  for (const columns of [40, 60]) {
    for (const centre of ['borges', null]) {
      const g = sousGraphe(GRAPHE, centre, 20)
      const rows = dessiner(g, placer(g, columns, 28, seedOf(g)), columns, 28, centre)
      expect(rows.length).toBeGreaterThanOrEqual(28)
      for (const row of rows) expect(text(row).length).toBeLessThanOrEqual(columns)
    }
  }
})

test('a label that would overwrite another goes left of its glyph', async () => {
  const g = tiny(['aa', 'bb'], [])
  const rows = dessiner(g, new Map([['aa', { x: 10, y: 1 }], ['bb', { x: 10, y: 1 }]]), 40, 3, null)
  expect(text(rows[1]!)).toContain('bb ○ aa')
})

test('two labels forced to the same place: one is numbered and the legend names it', async () => {
  const g = tiny(['aa', 'bb'], [])
  const rows = dessiner(g, new Map([['aa', { x: 1, y: 1 }], ['bb', { x: 1, y: 1 }]]), 40, 3, null)
  const out = all(rows)
  expect(text(rows[1]!)).toContain('○ aa')
  expect(text(rows[1]!)).not.toContain('bb')
  // Under the drawing, the legend gives the number back its label.
  expect(rows.length).toBeGreaterThan(3)
  expect(all(rows.slice(3))).toContain('① bb')
  expect(out.split('①').length - 1).toBe(2)
})

test('the centre is drawn in claude, a neighbour in text, distance 2 in subtle', async () => {
  const g = tiny(['c', 'n', 'm'], [['c', 'n'], ['n', 'm']])
  const pos = new Map([['c', { x: 0, y: 0 }], ['n', { x: 0, y: 2 }], ['m', { x: 0, y: 4 }]])
  const rows = dessiner(g, pos, 30, 5, 'c')
  const colour = (y: number) => rows[y]!.find(s => s.texte.includes('○'))?.couleur
  expect([colour(0), colour(2), colour(4)]).toEqual(['claude', 'text', 'subtle'])
})

test('a beating glyph goes blank one tick in four, and its label never moves', async () => {
  const g = tiny(['aa', 'bb'], [])
  const pos = new Map([['aa', { x: 2, y: 0 }], ['bb', { x: 2, y: 2 }]])
  const at = (tick: number) => dessiner(g, pos, 30, 3, null, { id: 'aa', tick }).map(text)
  for (const tick of [0, 1, 2, 4]) expect(at(tick)[0]).toBe('  ○ aa')
  expect(at(3)[0]).toBe('    aa')
  // Only the beating node: the other glyph stays lit.
  expect(at(3)[2]).toBe('  ○ bb')
  expect(dessiner(g, pos, 30, 3, null).map(text)).toEqual(at(0))
})
