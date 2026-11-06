import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import { GLYPHS, cut, dessiner, pack, plain } from './draw'
import { MIN_SCORE, best, buildIndex, rank } from './closest'
import type { Closest, Index } from './closest'
import { PANE_COLUMNS, spark } from './gfx'
import { estMasque, placerEtapes, premiereCitation, seedOf, sousGraphe, visibles } from './layout'
import type { Graphe, Position } from './layout'
import { MIN_PASSAGE_SCORE, fuseCentre, passageLines, passageParts, rankPart, rankStep } from './passages'
import type { EntryPassages, PassagePart } from './passages'
import { askCentre, askEntry, clearStatus, readySocket, startServer, stopServer } from './server'
import type { CentreAnswer, Via } from './server'
import { STRINGS, langOf } from './strings'
import type { Lang, Strings } from './strings'

const PANE = 'graphe'
const ROWS = 36
// The drawing gets the pane's rows less the header, the stats strip, the field
// and the notes.
const DRAWING_ROWS = ROWS - 9
// ①…⑳: at most twenty labels can be numbered.
const MAX_NODES = 20

// The strings of the `lang` option, set once by register.
let t: Strings = STRINGS.fr
let lang: Lang = 'fr'
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

type Build = { date?: unknown; noeuds?: unknown; liens?: unknown; isoles?: unknown; exit?: unknown }

function counts(b: Build): string {
  const nodes = Number(b.noeuds) || 0
  const share = nodes > 0 ? Math.round(((Number(b.isoles) || 0) / nodes) * 100) : 0
  const date = typeof b.date === 'string' && b.date !== '' ? b.date : t.unknownDate

  return t.built(date, nodes, Number(b.liens) || 0, share)
}

// The build journal as one header line: the last line when it ran clean; after
// a failed run, the last clean build's counts and the failed run's code, since
// a failed run's zeros say nothing about the graph on the disk.
function header(journal: FileRead): string {
  if (journal === 'unreadable') return t.journalUnreadable
  const lines = (journal === 'absent' ? '' : journal.text).split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return t.neverBuilt
  let last: Build
  try {
    last = JSON.parse(lines.at(-1)!) as Build
  } catch {
    return t.journalUnreadable
  }
  if (last.exit === 0) return `${counts(last)} · ${t.cleanCode}`
  const code = t.lastRun(String(last.exit ?? '?'))
  for (const line of lines.slice(0, -1).reverse()) {
    try {
      const b = JSON.parse(line) as Build
      if (b.exit === 0) return `${counts(b)} · ${code}`
    } catch {
      // An unreadable older line is skipped: the header looks for a clean build.
    }
  }

  return t.neverBuiltClean(code)
}

// Why the graph cannot be drawn, a key of the strings table.
type Unshown = 'absent' | 'unreadable' | 'evicted'

function parse(file: FileRead): Graphe | Unshown {
  if (file === 'absent') return 'absent'
  if (file === 'unreadable') return 'evicted'
  try {
    const g = JSON.parse(file.text) as Graphe
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return 'unreadable'

    return g
  } catch {
    return 'unreadable'
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

// The live centre. `auto`: the centre follows the conversation; `pinned`: the
// person typed a search, which stays until a search-less /graphe.
let mode: 'auto' | 'pinned' = 'auto'
// What the conversation chose (`by`), and the terms that matched when the
// lexical score chose it, or the titles of the passages that did (`via` how
// the corpus server found them). Set only while the drawn `centre` is that node.
// `fused`: a passage-chosen centre's fused score in the server's last answer.
type Chosen = { id: string; matched: string[]; by: 'lexical' | 'haiku' | 'passages'; via?: Via; fused?: number }
let chosen: Chosen | undefined
// The last prompts the person typed, oldest first. Memory only: never written
// to `$.state`, `$.store` or the disk, and gone with the process.
let prompts: string[] = []
let promptCount = 0
// Bumped whenever a model answer in flight stops being wanted (a pin, a reload).
let epoch = 0
let asking = false
let lastAsk: { at: number; count: number } | undefined
let indexed: { graphe: Graphe; tout: boolean; index: Index } | undefined
// The corpus server's passages for the drawn centre, and the latest request of
// each kind: an answer to an older one is dropped.
let entry: { id: string; passages: EntryPassages } | undefined
// The centre whose /entry is in flight: asked once, asked again after a failure.
let entryAsked: string | undefined
let centreRequest = 0
let entryRequest = 0

const KEPT_PROMPTS = 20
// The centre changes only for a challenger this much better (hysteresis).
const SWITCH_RATIO = 1.2
// Two scores this close are a tie, which the model breaks.
const TIE_RATIO = 0.9
const HAIKU = 'claude-haiku-5-5'
const ASK_EVERY_PROMPTS = 3
const ASK_EVERY_MS = 2 * 60_000
const ASK_PROMPTS = 5
const ASK_CHARS = 2000
// The /centre text, newest end kept: the server embeds the first 2048 tokens
// only, which a longer text would fill with its oldest prompts.
const CENTRE_CHARS = 4000
const ASK_NODES = 200
const ASK_TIMEOUT_MS = 15_000
const INSTRUCTION =
  'You pick the node of a knowledge graph closest to a conversation. Reply with exactly one id from the list, copied as written, or NONE. No other words.'

type Centrage = 'haiku' | 'lexical' | 'off'
// The flag that shows every genre, in either language.
const isFlagAll = (word: string): boolean => word === STRINGS.fr.flagAll || word === STRINGS.en.flagAll

const centrageOf = (options: PluginOptions): Centrage => (options.centrage === 'lexical' || options.centrage === 'off' ? options.centrage : 'haiku')

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

// One tick: the next image, only while one is left and the pane is seen. A pane
// found hidden or closed lands the settle on its last image and ends the timer:
// nothing tells this mod when a tab comes forward, so no timer waits for it.
async function tick($: EngineInterface): Promise<void> {
  const mine = timer
  const isSeen = image >= IMAGES - 1 ? false : (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  // A replay during the wait has started a newer timer: this tick is stale.
  if (timer !== mine) return
  if (!isSeen) {
    image = IMAGES - 1
    timer?.cancel()
    timer = undefined
    return
  }
  image += 1
  $.ui.invalidate('ui.render')
}

// The header while the conversation chose the centre.
const autoHeader = (c: Chosen): string =>
  t.centredOn(c.id, c.by === 'haiku' ? t.byHaiku : c.by === 'passages' ? t.byPassages(c.via ?? 'words', c.matched.join(', ')) : c.matched.join(', '))

// The drawn subgraph in one line: its degrees, highest first, as a sparkline,
// then how many nodes and links.
function stats(sub: Graphe, width: number): string {
  const degrees = new Map(sub.nodes.map(n => [n.id, 0]))
  for (const e of sub.edges) {
    degrees.set(e.from, (degrees.get(e.from) ?? 0) + 1)
    degrees.set(e.to, (degrees.get(e.to) ?? 0) + 1)
  }
  const sorted = [...degrees.values()].sort((a, b) => b - a)

  return cut(t.stats(spark(sorted, sorted.length), sub.nodes.length, sub.edges.length), width)
}

function indexFor(g: Graphe, isAll: boolean): Index {
  if (indexed?.graphe !== g || indexed.tout !== isAll) indexed = { graphe: g, tout: isAll, index: buildIndex(g, isAll) }

  return indexed.index
}

type Steer = { ranked: readonly Closest[]; moved: boolean; redraw: boolean }

// In auto mode, the centre for the conversation so far. It moves to the best
// node only when that beats the current centre's own score by SWITCH_RATIO;
// with no match at all it falls back to the most-connected view, unless the
// model chose the centre, which a quiet prompt does not undo.
function steer(setting: Centrage): Steer | undefined {
  const g = snapshot?.graphe
  if (setting === 'off' || mode !== 'auto' || g === undefined || typeof g === 'string') return undefined
  const ranked = rank(indexFor(g, tout), prompts)
  const top = best(ranked)
  const was = chosen
  const held = was === undefined ? undefined : ranked.find(r => r.id === was.id)
  let next = was
  // A centre the passages chose stays for them to decide, unless the words'
  // winner, on the fused scale (a lone top word match), clears the hold
  // against its last fused score: no move here and back in askPassages.
  const isPassageHeld = was?.by === 'passages' && readySocket() !== undefined && top !== undefined && top.id !== was.id && rankPart(1) < (was.fused ?? 0) * SWITCH_RATIO
  if (isPassageHeld) {
    next = was
  } else if (top !== undefined && (was === undefined || top.id === was.id || top.score >= (held?.score ?? 0) * SWITCH_RATIO)) {
    next = { id: top.id, matched: top.matched, by: 'lexical' }
  } else if (top === undefined) {
    if (was?.by === 'lexical') next = undefined
  } else if (was?.by === 'lexical' && held !== undefined) {
    next = { id: was.id, matched: held.matched, by: 'lexical' }
  }
  const moved = (next?.id ?? null) !== centre
  const redraw = moved || JSON.stringify(next) !== JSON.stringify(was)
  chosen = next
  centre = next?.id ?? null

  return { ranked, moved, redraw }
}

// Whether the lexical ranking leaves the model something to decide.
const isUndecided = (ranked: readonly Closest[]): boolean =>
  best(ranked) === undefined || (ranked[1] !== undefined && ranked[1].score >= ranked[0]!.score * TIE_RATIO)

// The model's pick for the conversation, out of the ids it was shown. Never
// awaited by the prompt: any failure leaves the view as the lexical step made it.
async function askModel($: EngineInterface): Promise<void> {
  const g = snapshot?.graphe
  if (asking || g === undefined || typeof g === 'string' || prompts.length === 0) return
  asking = true
  // Taken at entry: a close or a pin during any wait below drops the answer.
  const wanted = epoch
  try {
    const now = await $.clock.now()
    if (epoch !== wanted) return
    if (lastAsk !== undefined && (promptCount - lastAsk.count < ASK_EVERY_PROMPTS || now - lastAsk.at < ASK_EVERY_MS)) return
    lastAsk = { at: now, count: promptCount }
    const ids = sousGraphe(visibles(g, tout), null, ASK_NODES, true).nodes.map(n => n.id)
    if (ids.length === 0) return
    const talk = prompts.slice(-ASK_PROMPTS).join('\n---\n').slice(-ASK_CHARS)
    const answer = await $.model.complete({
      model: HAIKU,
      system: INSTRUCTION,
      prompt: `Nodes:\n${ids.join('\n')}\n\nConversation (oldest first):\n${talk}`,
      maxTokens: 64,
      effort: 'low',
      timeoutMs: ASK_TIMEOUT_MS,
    })
    // A pin, or a reload, since the question: the answer is for a view that is gone.
    if (!answer.isAnswered || mode !== 'auto' || epoch !== wanted) return
    const id = answer.text.trim()
    if (!ids.includes(id)) return
    if (chosen?.id !== id) {
      chosen = { id, matched: [], by: 'haiku' }
      centre = id
      settle($)
      wantEntry($)
    }
    $.ui.invalidate('ui.render')
  } catch {
    // No model, an error, a timeout: the lexical view stands.
  } finally {
    asking = false
  }
}

// The corpus server's passages for the drawn centre, fetched once per centre
// while the server is ready. Never awaited by a hook.
function wantEntry($: EngineInterface): void {
  const id = centre
  if (id === null || readySocket() === undefined || entry?.id === id || entryAsked === id) return
  const wanted = ++entryRequest
  entryAsked = id
  void askEntry($, id).then(
    passages => {
      if (wanted !== entryRequest) return
      entryAsked = undefined
      if (centre !== id) return
      entry = { id, passages }
      $.ui.invalidate('ui.render')
    },
    () => {
      // Failed: the next prompt asks again while this centre holds.
      if (wanted === entryRequest) entryAsked = undefined
    },
  )
}

// The passages a visible-node ranking may read: those of a hidden genre (posts,
// fiction) only under `tout`, as `visibles` shows their nodes.
const shownHits = (answer: CentreAnswer) => answer.passages.filter(p => !estMasque(p.genre, tout))

// The server's last answer backs a passage-chosen centre with nothing: steer
// no longer holds it for the passages.
function forgetFused(): void {
  if (chosen?.by === 'passages') chosen = { ...chosen, fused: 0 }
}

/**
 * Re-centres on the corpus server's passages for the last prompts, fused with
 * the words' ranking. A winner the words found moves the centre only if its
 * lexical score clears MIN_SCORE; one only the passages found, if its passage
 * part clears MIN_PASSAGE_SCORE. No passages: the lexical step stands, as
 * without the server. Never awaited by the prompt; the latest request wins.
 */
async function askPassages($: EngineInterface, setting: Centrage): Promise<void> {
  const wanted = ++centreRequest
  const wantedEpoch = epoch
  let answer: CentreAnswer | undefined
  try {
    answer = await askCentre($, prompts.slice(-ASK_PROMPTS).join('\n\n').slice(-CENTRE_CHARS))
  } catch {
    // No answer: the lexical step stands, and the model decides as before.
  }
  const g = snapshot?.graphe
  if (wanted !== centreRequest || epoch !== wantedEpoch || g === undefined || typeof g === 'string') return
  const lexical = rank(indexFor(g, tout), prompts)
  const hits = answer === undefined ? [] : shownHits(answer)
  if (answer === undefined || hits.length === 0) {
    forgetFused()
    if (setting === 'haiku' && isUndecided(lexical)) void askModel($)
    return
  }
  const shown = new Set(visibles(g, tout).nodes.map(n => n.id))
  const fused = fuseCentre(lexical, hits, shown)
  const parts = passageParts(hits, shown)
  const words = new Map(lexical.map(c => [c.id, c]))
  const top = fused[0]
  if (top === undefined) {
    forgetFused()
    return
  }
  const own = words.get(top.id)
  // Each bar is judged on its own scale, never a fused score against MIN_SCORE.
  // A winner the words found: their bar, and 0.4.0's hysteresis against a
  // centre the words chose. A passage-only winner: the passage bar. Either
  // way, a challenger beats the held centre's fused score by SWITCH_RATIO.
  const held = chosen?.by === 'lexical' && chosen.id === centre && chosen.id !== top.id ? (words.get(chosen.id)?.score ?? 0) : undefined
  const heldFused = centre === null || centre === top.id ? 0 : (fused.find(c => c.id === centre)?.score ?? 0)
  const clearsBar = own !== undefined ? own.score >= MIN_SCORE && (held === undefined || own.score >= held * SWITCH_RATIO) : top.score >= MIN_PASSAGE_SCORE
  const moves = clearsBar && top.score >= heldFused * SWITCH_RATIO
  if (moves && top.id !== centre) {
    chosen = own !== undefined ? { id: top.id, matched: own.matched, by: 'lexical' } : { id: top.id, matched: top.matched, by: 'passages', via: answer.by }
    centre = top.id
    settle($)
    $.ui.invalidate('ui.render')
  }
  if (chosen?.by === 'passages' && chosen.id === centre) chosen = { ...chosen, fused: fused.find(c => c.id === centre)?.score ?? 0 }
  wantEntry($)
  if (setting === 'haiku' && isUndecidedFused(top, fused[1], lexical, parts)) void askModel($)
}

// Whether the model should break the fused ranking's tie, by the part that
// chose the winner: the words' own rule when the words found it (the fused
// scores of neighbouring ranks are always within TIE_RATIO); for a passage-only
// winner, a miss of the passage bar, or a runner-up whose passage part is
// within one rank of the winner's.
function isUndecidedFused(top: Closest, second: Closest | undefined, lexical: readonly Closest[], parts: ReadonlyMap<string, PassagePart>): boolean {
  if (lexical.some(c => c.id === top.id)) return isUndecided(lexical)
  const mine = parts.get(top.id)
  if (mine === undefined || mine.part < MIN_PASSAGE_SCORE) return true
  const theirs = second === undefined ? 0 : (parts.get(second.id)?.part ?? 0)

  // A tolerance: a runner-up exactly one rank behind sits on the line.
  return mine.part - theirs <= rankStep(mine.rank) + 1e-12
}

// Opens the pane; once it is drawn, the corpus server starts for this opening.
async function openPane($: EngineInterface, options: PluginOptions, setting: Centrage): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: t.paneTitle, columns: PANE_COLUMNS, rows: ROWS })
  if (!opened.isPlaced || setting === 'off') return
  const serveur = String(options.serveur ?? '').trim()
  if (serveur === '') return
  const coffre = await expand($, String(options.coffre))
  startServer($, {
    node: await expand($, String(options.node ?? 'node')),
    serveur: await expand($, serveur),
    index: `${coffre}/index-corpus.json`,
    graphe: `${coffre}/graphe.json`,
    unavailable: t.passagesUnavailable,
    onReady: () => {
      wantEntry($)
      // Prompts typed while it started: one query with them.
      if (mode === 'auto' && prompts.length > 0) void askPassages($, setting)
    },
    onGone: () => {
      entry = undefined
      $.ui.invalidate('ui.render')
    },
  })
}

// Whether this mod's pane is still open; a `$` that cannot say counts as closed.
async function isPaneUp($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    return false
  }
}

// How long after a close the pane is looked for again, in case the engine
// still listed it when the close resolved.
const CLOSE_RECHECK_MS = 250

function endServer($: EngineInterface): void {
  closePane()
  clearStatus($)
}

async function recheckClose($: EngineInterface): Promise<void> {
  try {
    await $.clock.sleep(CLOSE_RECHECK_MS)
  } catch {
    return
  }
  if (!(await isPaneUp($))) endServer($)
}

// The pane closed, or the panel did: the server goes with it, and its passages.
function closePane(): void {
  stopServer()
  timer?.cancel()
  timer = undefined
  image = IMAGES - 1
  // Nothing ranks or asks the model for a pane that is closed; a reopening reads again.
  snapshot = undefined
  epoch += 1
  entry = undefined
  entryAsked = undefined
  centreRequest += 1
  entryRequest += 1
}

// A search, without accents or case, over the node ids: an exact id wins,
// else one match is the new centre, several are offered, none says so. Any
// search pins the centre; an empty one hands it back to the conversation.
function search(query: string, setting: Centrage): void {
  notice = undefined
  choices = []
  epoch += 1
  chosen = undefined
  const wanted = plain(query.trim())
  if (wanted === '') {
    mode = 'auto'
    centre = null
    steer(setting)
    return
  }
  mode = 'pinned'
  const g = snapshot?.graphe
  if (g === undefined || typeof g === 'string') return
  const ids = visibles(g, tout).nodes.map(n => n.id)
  const exact = ids.filter(id => plain(id) === wanted)
  const found = exact.length > 0 ? exact : ids.filter(id => plain(id).includes(wanted))
  if (found.length === 1) centre = found[0]!
  else if (found.length === 0) notice = t.noMatch
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
  const setting = centrageOf(options)
  lang = langOf(options.lang)
  t = STRINGS[lang]
  // A fresh registration is a fresh conversation.
  mode = 'auto'
  chosen = undefined
  prompts = []
  promptCount = 0
  epoch = 0
  asking = false
  lastAsk = undefined
  indexed = undefined
  closePane()
  centreRequest = 0
  entryRequest = 0

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed: a plugin's, a peer's or a notification's text is not the conversation.
    const isPerson = (e.origin.kind === 'composer' || e.origin.kind === 'bridge') && e.isMeta !== true && e.command === undefined
    if (setting !== 'off' && isPerson && e.text.trim() !== '') {
      prompts = [...prompts, e.text].slice(-KEPT_PROMPTS)
      promptCount += 1
      try {
        const result = steer(setting)
        if (result?.moved) {
          settle($)
          wantEntry($)
        }
        if (result?.redraw) $.ui.invalidate('ui.render')
        // An /entry that failed is asked again while the centre holds.
        wantEntry($)
        // With the corpus server ready, its passages decide first, then the model.
        if (result !== undefined && readySocket() !== undefined) void askPassages($, setting)
        else if (result !== undefined && setting === 'haiku' && isUndecided(result.ranked)) void askModel($)
      } catch {
        // The pane is this mod's affair; the prompt goes through.
      }
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'graphe',
      description: t.commandDescription,
    })
    // The pane the person left open comes back, unasked.
    if ((await $.store.get(PANE_OPEN)) === true && !(await $.ui.panes()).some(pane => pane.id === PANE)) {
      snapshot = await load($, options)
      steer(setting)
      settle($)
      await openPane($, options, setting)
    }

    return next(e)
  })

  // Closed by the person: it stays closed. A plugin's close, an unload or a
  // close a hook refused forgets nothing. Any close of the pane ends the
  // corpus server.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    // A close another hook refused leaves the pane, and its server, up. The
    // pane may still be listed when `next` resolves: look again a little later.
    if (e.id === PANE) {
      if (!(await isPaneUp($))) endServer($)
      else void recheckClose($)
    }
    if (e.id === PANE && e.origin.kind === 'person') await $.store.delete(PANE_OPEN).catch(() => undefined)

    return closed
  })

  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      if (answer.text === PANEL_OPENED) {
        snapshot = await load($, options)
        steer(setting)
        settle($)
        await openPane($, options, setting)
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
    tout = words.some(isFlagAll)
    search(words.filter(w => !isFlagAll(w)).join(' '), setting)
    settle($)
    wantEntry($)
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    // A second /graphe redraws the pane it opened; it never opens another.
    if (isUp) $.ui.invalidate('ui.render')
    else await openPane($, options, setting)
    await $.store.set(PANE_OPEN, true).catch(() => undefined)

    return { text: centre === null ? t.reply : t.replyCentred(centre) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const width = e.props.bodyColumns
    // A reload while the pane stays open leaves no snapshot: read once.
    if (snapshot === undefined) {
      snapshot = await load($, options)
      steer(setting)
    }
    const { graphe: g, header: journal } = snapshot
    const head = mode === 'auto' && chosen !== undefined && chosen.id === centre ? autoHeader(chosen) : journal
    const redraw = () => $.ui.invalidate('ui.render')

    if (typeof g === 'string') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{cut(head, width)}</Text>
          <Text>{cut(t[g], width)}</Text>
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
      notes.push(...pack(GLYPHS.map(([type, glyph]) => `${glyph} ${t.types[type] ?? type}`), width))
    } else {
      // → the centre does it to the other end; ← the other end does it to the centre.
      const links = shown.edges.flatMap(link =>
        link.from === link.to ? [] : link.from === centre ? [`→ ${link.relation} — ${link.to}`] : link.to === centre ? [`← ${link.relation} — ${link.from}`] : [],
      )
      notes.push(...links.slice(0, LIST_CAP).map(line => cut(line, width)))
      if (links.length > LIST_CAP) notes.push(cut(t.more(links.length - LIST_CAP), width))
      const centreNode = shown.nodes.find(n => n.id === centre)
      const quote = centreNode === undefined ? undefined : premiereCitation(centreNode, tout)
      if (quote !== undefined && quote !== '') notes.push(...wrap(t.quote(quote), width))
      // The corpus passages the centre's mentions fall in, while the server answers.
      if (entry?.id === centre) notes.push(...passageLines(entry.passages, width, genre => estMasque(genre, tout), lang))
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{cut(head, width)}</Text>
        {sub.nodes.length > 0 && <Text dimColor>{stats(sub, width)}</Text>}
        {'Input' in elements && (
          <elements.Input
            key="recherche"
            placeholder={t.searchPlaceholder}
            onSubmit={value => {
              const before = centre
              search(value, setting)
              if (centre !== before) settle($)
              wantEntry($)
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
              wantEntry($)
              redraw()
            }}
          />
        ))}
        {choices.length > LIST_CAP && <Text dimColor>{cut(t.more(choices.length - LIST_CAP), width)}</Text>}
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
