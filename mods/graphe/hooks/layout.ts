// Pure: which nodes to draw, and where. No `$`, so the tests import it as is.

export type Mention = { source_id: string; slug: string; date: string; resume: string; citation: string }
export type Noeud = { id: string; type: string; genre: string; premiere_date: string; mentions: Mention[] }
export type Lien = { from: string; to: string; relation: string; citation: string; source_id: string; genre: string }
export type Graphe = { nodes: Noeud[]; edges: Lien[] }
export type Position = { x: number; y: number }

const ITERATIONS = 300
// The ideal link length as a share of FR's sqrt(area / n): at 1 the nodes pile
// against the frame of a terminal-sized canvas; at 0.5 they keep off it.
const SPREAD = 0.5

// Edges whose two ends are nodes: a link to an id the file does not hold as a
// node counts for nothing.
const sound = (g: Graphe): Lien[] => {
  const known = new Set(g.nodes.map(n => n.id))

  return g.edges.filter(e => e.from !== e.to && known.has(e.from) && known.has(e.to))
}

function neighbours(g: Graphe): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(g.nodes.map(n => [n.id, new Set<string>()]))
  for (const e of sound(g)) {
    out.get(e.from)!.add(e.to)
    out.get(e.to)!.add(e.from)
  }

  return out
}

// Highest degree first; ties by id, so the order never depends on the file's.
const byDegree = (near: Map<string, Set<string>>) => (a: string, b: string) =>
  (near.get(b)?.size ?? 0) - (near.get(a)?.size ?? 0) || (a < b ? -1 : a > b ? 1 : 0)

// Hidden by default in every view: posts (plan B) and fiction (plan C). A node
// whose mentions mix genres is `mixte` and stays.
export const GENRES_MASQUES: readonly string[] = ['post', 'fiction']

// `source_id` prefix → genre. The tool writes a nouvelle as `nouvelle:<slug>`
// while its genre is `fiction` (my-editor-app `tools/graphe/sources.py`), so a
// prefix is never read as a genre by itself. Same map as the page's
// `GENRE_PAR_PREFIXE` (my-editor-app `src/lib/graphe/types.ts`).
export const GENRE_PAR_PREFIXE: Readonly<Record<string, string>> = { article: 'article', post: 'post', nouvelle: 'fiction' }

// A mention's genre: its prefix through the map; an unknown prefix borrows a
// single-genre node's genre and stays unknown (null) on a `mixte` node.
export function genreDeMention(m: Mention, n: Noeud): string | null {
  const prefix = m.source_id.split(':', 1)[0] ?? ''
  const genre = Object.hasOwn(GENRE_PAR_PREFIXE, prefix) ? GENRE_PAR_PREFIXE[prefix] : undefined
  if (genre !== undefined) return genre

  return n.genre === 'mixte' ? null : n.genre
}

/**
 * The first citation of `n` the view may show: with `tout`, the first one;
 * otherwise the first whose genre is not hidden (an unplaceable one never
 * shows). A `mixte` node sorts `nouvelle:` before `post:` and `article:`, so
 * its first mention can be the fiction one.
 */
export function premiereCitation(n: Noeud, tout: boolean): string | undefined {
  const m = tout
    ? n.mentions[0]
    : n.mentions.find(x => {
        const genre = genreDeMention(x, n)

        return genre !== null && !GENRES_MASQUES.includes(genre)
      })

  return m?.citation
}

/**
 * The graph a view may show: without `tout`, the nodes of a hidden genre, the
 * edges touching them and the edges a hidden-genre source drew are dropped.
 */
export function visibles(g: Graphe, tout: boolean): Graphe {
  if (tout) return g
  const hidden = (genre: string) => GENRES_MASQUES.includes(genre)
  const nodes = g.nodes.filter(n => !hidden(n.genre))
  const kept = new Set(nodes.map(n => n.id))

  return { nodes, edges: g.edges.filter(e => !hidden(e.genre) && kept.has(e.from) && kept.has(e.to)) }
}

/**
 * The nodes worth drawing, in drawing priority: with a centre, the centre
 * first, its neighbours, then distance 2, up to `max`, each ring by
 * decreasing degree; without one, the `max` nodes of highest degree. Only the
 * links between kept nodes are kept. An unknown centre gives an empty graph.
 * Hidden genres are dropped first (`visibles`) unless `tout`.
 */
export function sousGraphe(all: Graphe, centre: string | null, max: number, tout = false): Graphe {
  const g = visibles(all, tout)
  const near = neighbours(g)
  const order = byDegree(near)
  let kept: string[]

  if (centre === null) {
    kept = [...near.keys()].sort(order).slice(0, max)
  } else {
    if (!near.has(centre)) return { nodes: [], edges: [] }
    const first = [...near.get(centre)!].sort(order)
    const ring = new Set([centre, ...first])
    const second = [...new Set(first.flatMap(id => [...near.get(id)!]))].filter(id => !ring.has(id)).sort(order)
    kept = [centre, ...first, ...second].slice(0, max)
  }

  const byId = new Map(g.nodes.map(n => [n.id, n]))
  const inside = new Set(kept)

  return {
    nodes: kept.map(id => byId.get(id)!),
    edges: sound(g).filter(e => inside.has(e.from) && inside.has(e.to)),
  }
}

// FNV-1a over the sorted ids: the same subgraph always gets the same seed.
export function seedOf(g: Graphe): number {
  let hash = 0x811c9dc5
  for (const ch of g.nodes.map(n => n.id).sort().join('\n')) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash
}

// mulberry32: a small seeded generator, so a layout is reproducible.
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Fruchterman-Reingold, 300 iterations from seeded random positions. The
 * first node (the centre, or the highest degree) is pinned to the middle. The
 * layout runs in square units where a cell is twice as high as it is wide,
 * then lands on whole cells inside `[0, colonnes) × [0, lignes)`.
 */
export function placer(g: Graphe, colonnes: number, lignes: number, graine: number): Map<string, Position> {
  return placerEtapes(g, colonnes, lignes, graine, 1)[0]!
}

// The iteration after which image `i` of `images` is taken: the square of the
// share done, so the early images, where the nodes move most, sit closer
// together. Image 0 is the seeded start, the last one the end of the run.
const stepOf = (i: number, images: number): number =>
  images <= 1 ? ITERATIONS : Math.round(ITERATIONS * (i / (images - 1)) ** 2)

/**
 * The same run as `placer`, seen `images` times along the way (at least
 * once): each image a position map on whole cells, the last one the very map
 * `placer` returns. The simulation runs once, whatever the count.
 */
export function placerEtapes(g: Graphe, colonnes: number, lignes: number, graine: number, images: number): Map<string, Position>[] {
  const count = Math.max(1, Math.floor(images))
  const n = g.nodes.length
  if (n === 0 || colonnes <= 0 || lignes <= 0) return Array.from({ length: count }, () => new Map<string, Position>())

  const width = colonnes
  const height = lignes * 2
  const next = random(graine)
  const p = g.nodes.map(() => ({ x: next() * (width - 1), y: next() * (height - 1) }))
  p[0] = { x: Math.floor(colonnes / 2), y: Math.floor(lignes / 2) * 2 }

  const index = new Map(g.nodes.map((node, i) => [node.id, i]))
  const links = sound(g).map(e => [index.get(e.from)!, index.get(e.to)!] as const)
  const k = SPREAD * Math.sqrt((width * height) / n)
  const start = width / 8

  // Whole cells: a square unit is half a row high.
  const snapshot = (): Map<string, Position> =>
    new Map(
      g.nodes.map((node, i) => [
        node.id,
        { x: clamp(Math.round(p[i]!.x), 0, colonnes - 1), y: clamp(Math.floor(p[i]!.y / 2), 0, lignes - 1) },
      ]),
    )
  const out: Map<string, Position>[] = []
  const takeDue = (done: number) => {
    while (out.length < count && stepOf(out.length, count) <= done) out.push(snapshot())
  }

  takeDue(0)
  for (let step = 0; step < ITERATIONS; step++) {
    const d = p.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i]!.x - p[j]!.x
        let dy = p[i]!.y - p[j]!.y
        // Two nodes on the same point: part them along a seeded direction.
        if (dx === 0 && dy === 0) {
          dx = next() - 0.5
          dy = next() - 0.5
        }
        const dist = Math.max(0.01, Math.hypot(dx, dy))
        const force = (k * k) / dist
        d[i]!.x += (dx / dist) * force
        d[i]!.y += (dy / dist) * force
        d[j]!.x -= (dx / dist) * force
        d[j]!.y -= (dy / dist) * force
      }
    }
    for (const [a, b] of links) {
      const dx = p[a]!.x - p[b]!.x
      const dy = p[a]!.y - p[b]!.y
      const dist = Math.max(0.01, Math.hypot(dx, dy))
      const force = (dist * dist) / k
      d[a]!.x -= (dx / dist) * force
      d[a]!.y -= (dy / dist) * force
      d[b]!.x += (dx / dist) * force
      d[b]!.y += (dy / dist) * force
    }
    const heat = start * (1 - step / ITERATIONS)
    // From 1: the first node stays pinned.
    for (let i = 1; i < n; i++) {
      const len = Math.max(0.01, Math.hypot(d[i]!.x, d[i]!.y))
      const move = Math.min(len, heat)
      p[i]!.x = clamp(p[i]!.x + (d[i]!.x / len) * move, 0, width - 1)
      p[i]!.y = clamp(p[i]!.y + (d[i]!.y / len) * move, 0, height - 1)
    }
    takeDue(step + 1)
  }

  return out
}
