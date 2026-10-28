import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import { GLYPHS, cut, dessiner, pack, plain } from './draw'
import { PANE_COLUMNS, spark } from './gfx'
import { placerEtapes, premiereCitation, seedOf, sousGraphe, visibles } from './layout'
import type { Graphe, Position } from './layout'

const PANE = 'graphe'
const ROWS = 36
// The drawing gets the pane's rows less the header, the stats strip, the field
// and the notes.
const DRAWING_ROWS = ROWS - 9
// ①…⑳: at most twenty labels can be numbered.
const MAX_NODES = 20

const ABSENT = 'Pas de graphe construit : plan B, tâche B6'
const UNREADABLE = 'graphe.json illisible'
// On the disk but not readable: on iCloud, a file evicted to the cloud.
const EVICTED = 'graphe.json illisible (fichier évincé par iCloud ?)'
const NO_MATCH = 'aucun nœud'
// The centre's links and the search buttons stop here, then say how many more.
const LIST_CAP = 8
// The layout settles on screen: so many images of the run, one per tick, the
// last one then held.
const IMAGES = 16
const TICK_MS = 125
// In `$.store`: true while the pane the person opened should come back.
const PANE_OPEN = 'paneOpen'
// The panel mod's two answers to /panel (mods/panel/hooks/register.tsx).
const PANEL_OPENED = 'Panel opened.'
const PANEL_CLOSED = 'Panel closed.'

async function expand($: EngineInterface, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = await $.env.get('HOME')

  return home === undefined || home === '' ? path : home + path.slice(1)
}

type FileRead = { text: string } | 'absent' | 'unreadable'

async function readText($: EngineInterface, path: string): Promise<FileRead> {
  if (!(await $.fs.exists(path).catch(() => false))) return 'absent'

  return $.fs.read(path).then(
    text => ({ text: String(text) }),
    () => 'unreadable' as const,
  )
}

const more = (hidden: number): string => `… et ${hidden} autre${hidden > 1 ? 's' : ''}`

type Build = { date?: unknown; noeuds?: unknown; liens?: unknown; isoles?: unknown; exit?: unknown }

function counts(b: Build): string {
  const nodes = Number(b.noeuds) || 0
  const share = nodes > 0 ? Math.round(((Number(b.isoles) || 0) / nodes) * 100) : 0
  const date = typeof b.date === 'string' && b.date !== '' ? b.date : 'date inconnue'

  return `Construit le ${date} · ${nodes} nœuds · ${Number(b.liens) || 0} liens · ${share} % isolés`
}

// The build journal as one header line: the last line when it ran clean; after
// a failed run, the last clean build's counts and the failed run's code, since
// a failed run's zeros say nothing about the graph on the disk.
function header(journal: FileRead): string {
  if (journal === 'unreadable') return 'journal illisible'
  const lines = (journal === 'absent' ? '' : journal.text).split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return 'jamais construit'
  let last: Build
  try {
    last = JSON.parse(lines.at(-1)!) as Build
  } catch {
    return 'journal illisible'
  }
  if (last.exit === 0) return `${counts(last)} · code 0`
  const code = `dernier lancement : code ${String(last.exit ?? '?')}`
  for (const line of lines.slice(0, -1).reverse()) {
    try {
      const b = JSON.parse(line) as Build
      if (b.exit === 0) return `${counts(b)} · ${code}`
    } catch {
      // An unreadable older line is skipped: the header looks for a clean build.
    }
  }

  return `jamais construit proprement · ${code}`
}

type Unshown = typeof ABSENT | typeof UNREADABLE | typeof EVICTED

function parse(file: FileRead): Graphe | Unshown {
  if (file === 'absent') return ABSENT
  if (file === 'unreadable') return EVICTED
  try {
    const g = JSON.parse(file.text) as Graphe
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return UNREADABLE

    return g
  } catch {
    return UNREADABLE
  }
}

// What the last /graphe read from the disk; drawing only reads this.
type Snapshot = { graphe: Graphe | Unshown; header: string }

async function load($: EngineInterface, options: PluginOptions): Promise<Snapshot> {
  const coffre = await expand($, String(options.coffre))
  const journal = await expand($, String(options.journal))

  return { graphe: parse(await readText($, `${coffre}/graphe.json`)), header: header(await readText($, journal)) }
}

let snapshot: Snapshot | undefined
let centre: string | null = null
// `/graphe --tout` shows every genre; otherwise posts and fiction stay hidden.
let tout = false
let notice: string | undefined
let choices: string[] = []
// The settle's image on screen. A fresh load starts settled: a reload while
// the pane stays up does not replay it.
let image = IMAGES - 1
// The settle's images for one (subgraph, width): the run is made once, never
// per tick.
let settled: { key: string; images: Map<string, Position>[] } | undefined

let timer: Timer | undefined

// Replays the settle from its first image on the one timer this module keeps;
// the tick stops it once the last image is reached.
const settle = ($: EngineInterface): void => {
  image = 0
  timer?.cancel()
  timer = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => undefined)
  })
}

function imagesOf(sub: Graphe, width: number): Map<string, Position>[] {
  const key = [width, ...sub.nodes.map(n => n.id), ...sub.edges.map(e => `${e.from} → ${e.to}`)].join('\n')
  if (settled?.key !== key) settled = { key, images: placerEtapes(sub, width, DRAWING_ROWS, seedOf(sub), IMAGES) }

  return settled.images
}

// One tick: the next image, only while one is left and the pane is seen.
async function tick($: EngineInterface): Promise<void> {
  if (image >= IMAGES - 1) {
    timer?.cancel()
    timer = undefined
    return
  }
  if (!(await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)) return
  image += 1
  $.ui.invalidate('ui.render')
}

const plural = (count: number, word: string): string => `${count} ${word}${count > 1 ? 's' : ''}`

// The drawn subgraph in one line: its degrees, highest first, as a sparkline,
// then how many nodes and links.
function stats(sub: Graphe, width: number): string {
  const degrees = new Map(sub.nodes.map(n => [n.id, 0]))
  for (const e of sub.edges) {
    degrees.set(e.from, (degrees.get(e.from) ?? 0) + 1)
    degrees.set(e.to, (degrees.get(e.to) ?? 0) + 1)
  }
  const sorted = [...degrees.values()].sort((a, b) => b - a)

  return cut(`degrés ${spark(sorted, sorted.length)} · ${plural(sub.nodes.length, 'nœud')} · ${plural(sub.edges.length, 'lien')}`, width)
}

// A search, without accents or case, over the node ids: an exact id wins,
// else one match is the new centre, several are offered, none says so.
function search(query: string): void {
  notice = undefined
  choices = []
  const wanted = plain(query.trim())
  if (wanted === '') {
    centre = null
    return
  }
  const g = snapshot?.graphe
  if (g === undefined || typeof g === 'string') return
  const ids = visibles(g, tout).nodes.map(n => n.id)
  const exact = ids.filter(id => plain(id) === wanted)
  const found = exact.length > 0 ? exact : ids.filter(id => plain(id).includes(wanted))
  if (found.length === 1) centre = found[0]!
  else if (found.length === 0) notice = NO_MATCH
  else choices = found.sort()
}

// Breaks text at spaces so that no piece is longer than the width.
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`
    if (next.length <= width) {
      line = next
      continue
    }
    if (line !== '') out.push(line)
    line = cut(word, width)
  }
  if (line !== '') out.push(line)

  return out
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'graphe',
      description: 'Draw the writings graph, or one node and its neighbours; --tout shows posts and fiction too',
    })
    // The pane the person left open comes back, unasked.
    if ((await $.store.get(PANE_OPEN)) === true && !(await $.ui.panes()).some(pane => pane.id === PANE)) {
      snapshot = await load($, options)
      settle($)
      await $.ui.open({ id: PANE, title: 'Graphe', columns: PANE_COLUMNS, rows: ROWS })
    }

    return next(e)
  })

  // Closed by the person: it stays closed. A plugin's close, an unload or a
  // close a hook refused forgets nothing.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') await $.store.delete(PANE_OPEN).catch(() => undefined)

    return closed
  })

  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      if (answer.text === PANEL_OPENED) {
        snapshot = await load($, options)
        settle($)
        await $.ui.open({ id: PANE, title: 'Graphe', columns: PANE_COLUMNS, rows: ROWS })
        await $.store.set(PANE_OPEN, true).catch(() => undefined)
      } else if (answer.text === PANEL_CLOSED) {
        await $.ui.close({ id: PANE })
        await $.store.set(PANE_OPEN, false).catch(() => undefined)
      }
    } catch {
      // The tab is this mod's affair; the panel's answer stands.
    }

    return answer
  })

  on('command.run', { command: 'graphe' }, async ($, e) => {
    snapshot = await load($, options)
    centre = null
    const words = e.args.split(/\s+/).filter(w => w !== '')
    tout = words.includes('--tout')
    search(words.filter(w => w !== '--tout').join(' '))
    settle($)
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    // A second /graphe redraws the pane it opened; it never opens another.
    if (isUp) $.ui.invalidate('ui.render')
    else await $.ui.open({ id: PANE, title: 'Graphe', columns: PANE_COLUMNS, rows: ROWS })
    await $.store.set(PANE_OPEN, true).catch(() => undefined)

    return { text: centre === null ? 'Graphe.' : `Graphe autour de ${centre}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const width = e.props.bodyColumns
    // A reload while the pane stays open leaves no snapshot: read once.
    snapshot ??= await load($, options)
    const { graphe: g, header: head } = snapshot
    const redraw = () => $.ui.invalidate('ui.render')

    if (typeof g === 'string') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{cut(head, width)}</Text>
          <Text>{cut(g, width)}</Text>
        </Box>
      )
    }

    const shown = visibles(g, tout)
    const sub = sousGraphe(shown, centre, MAX_NODES, true)
    const images = imagesOf(sub, width)
    const shownImage = Math.min(image, images.length - 1)
    // While it settles, the centre (or the first node) beats; then nothing moves.
    const first = sub.nodes[0]?.id
    const beat = shownImage < images.length - 1 && first !== undefined ? { id: first, tick: shownImage } : undefined
    const rows = dessiner(sub, images[shownImage]!, width, DRAWING_ROWS, centre, beat)
    const notes: string[] = []
    if (centre === null) {
      notes.push(...pack(GLYPHS.map(([, glyph, name]) => `${glyph} ${name}`), width))
    } else {
      // → the centre does it to the other end; ← the other end does it to the centre.
      const links = shown.edges.flatMap(link =>
        link.from === link.to ? [] : link.from === centre ? [`→ ${link.relation} — ${link.to}`] : link.to === centre ? [`← ${link.relation} — ${link.from}`] : [],
      )
      notes.push(...links.slice(0, LIST_CAP).map(line => cut(line, width)))
      if (links.length > LIST_CAP) notes.push(cut(more(links.length - LIST_CAP), width))
      const centreNode = shown.nodes.find(n => n.id === centre)
      const quote = centreNode === undefined ? undefined : premiereCitation(centreNode, tout)
      if (quote !== undefined && quote !== '') notes.push(...wrap(`« ${quote} »`, width))
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{cut(head, width)}</Text>
        {sub.nodes.length > 0 && <Text dimColor>{stats(sub, width)}</Text>}
        {'Input' in elements && (
          <elements.Input
            key="recherche"
            placeholder="Chercher un nœud"
            onSubmit={value => {
              const before = centre
              search(value)
              if (centre !== before) settle($)
              redraw()
            }}
          />
        )}
        {notice !== undefined && <Text color="warning">{cut(notice, width)}</Text>}
        {choices.slice(0, LIST_CAP).map(id => (
          <Button
            key={`choix:${id}`}
            label={cut(id, width)}
            onPress={() => {
              if (centre !== id) settle($)
              centre = id
              choices = []
              redraw()
            }}
          />
        ))}
        {choices.length > LIST_CAP && <Text dimColor>{cut(more(choices.length - LIST_CAP), width)}</Text>}
        {rows.map(row => (
          <Text>
            {row.map(span => (span.couleur === undefined ? <Text>{span.texte}</Text> : <Text color={span.couleur}>{span.texte}</Text>))}
          </Text>
        ))}
        {notes.map(line => (
          <Text>{line}</Text>
        ))}
      </Box>
    )
  })
}
