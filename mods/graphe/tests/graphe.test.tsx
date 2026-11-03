import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildIndex, rank } from '../hooks/closest'
import { GLYPHS, dessiner } from '../hooks/draw'
import { placer, seedOf, sousGraphe } from '../hooks/layout'
import type { Graphe } from '../hooks/layout'
import { register } from '../hooks/register'
import { STRINGS } from '../hooks/strings'
import type { Strings } from '../hooks/strings'
import { GRAPHE, JOURNAL } from './fixture'
import { LIVE_FR, TOUR_FR } from './golden'

// `claude plugin test` leaves nothing beneath `$.fs` or `$.env`: the hooks
// below stand for the disk, a clock and a store. Everything they hold is invented.

const COFFRE = '/fake/coffre'
const JOURNAL_PATH = '/fake/etat/journal.jsonl'
const OPTIONS = { coffre: COFFRE, journal: JOURNAL_PATH }

type Disk = {
  files: Map<string, string>
  unreadable: Set<string>
  reads: number
  opens: string[]
  // The title of every pane opened, in order.
  titles: string[]
  closes: string[]
  // What the panel mod beneath answers to /panel.
  panel: { text: string }
  clock: ReturnType<typeof mock.clock>
  // Whether the open pane is the one shown, or a tab behind another.
  isShown: boolean
  panesAsked: number
  store: Map<string, unknown>
  // The model calls asked, and what answers them: a string is the reply, undefined an API error.
  models: { model: string; system?: string; prompt: string }[]
  reply: () => Promise<string | undefined>
  writes: string[]
}

function world(on: On, options: { isGraphe?: boolean; isJournal?: boolean; store?: Record<string, unknown>; isPlaced?: boolean } = {}): Disk {
  const disk: Disk = { files: new Map(), unreadable: new Set(), reads: 0, opens: [], titles: [], closes: [], panel: { text: 'Panel opened.' }, clock: mock.clock(on), isShown: true, panesAsked: 0, store: new Map(Object.entries(options.store ?? {})), models: [], reply: async () => 'NONE', writes: [] }
  on('store.get', (_, e) => ({ value: disk.store.get(e.key) }))
  on('store.set', (_, e) => {
    disk.store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    disk.store.delete(e.key)

    return { value: undefined }
  })
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', async (_, e) => {
    disk.models.push({ model: e.model, system: e.system, prompt: e.prompt })
    const text = await disk.reply()

    return {
      value: text === undefined ? { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'server_error' as const, usage } : { isAnswered: true as const, text, usage },
    }
  })
  on('fs.write', (_, e) => {
    disk.writes.push(e.path)

    return { value: undefined }
  })
  if (options.isGraphe !== false) disk.files.set(`${COFFRE}/graphe.json`, JSON.stringify(GRAPHE))
  if (options.isJournal !== false) disk.files.set(JOURNAL_PATH, JOURNAL)

  on('fs.exists', (_, e) => ({ value: disk.files.has(e.path) || disk.unreadable.has(e.path) }))
  on('fs.read', (_, e) => {
    disk.reads += 1
    if (disk.unreadable.has(e.path)) throw new Error('EDEADLK')
    const text = disk.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('env.get', () => ({ value: '/fakehome' }))
  on('command.register', () => ({ value: { command: 'graphe' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let isUp = false
  on('ui.panes', () => {
    disk.panesAsked += 1

    return { value: isUp ? [{ id: 'graphe', title: 'Graphe', isShown: disk.isShown, isFocused: false, isPlaced: true }] : [] }
  })
  on('ui.open', (_, e) => {
    disk.opens.push(e.id)
    disk.titles.push(e.title ?? '')
    isUp = true

    return { value: options.isPlaced === false ? { isPlaced: false as const, reason: 'no-surface' } : { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    disk.closes.push(e.id)
    isUp = false

    return { value: undefined }
  })
  on('command.run', { command: 'panel' }, () => ({ text: disk.panel.text }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))

  return disk
}

const commandRun = (args = '', command = 'graphe') =>
  ({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  }) as Parameters<Engine['command']['run']>[0]

const props = (bodyColumns: number) => ({
  title: 'Graphe',
  isFocused: false,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 36 },
  view: {},
})

const pane = (bodyColumns: number) =>
  ({ plugin: 'graphe', surface: 'terminal', component: 'Pane', requestId: 'graphe', props: props(bodyColumns) }) as const

async function open($: Engine, args = ''): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun(args))
}

// The outermost Texts are the rows; the spans of a drawn row sit inside one.
async function rows($: Engine, columns = 80): Promise<string[]> {
  const ui = await $.ui.mount(pane(columns))
  const out = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return out.map(t => t.text)
}

test('a missing graphe.json gives the absence line', { options: OPTIONS }, async ($, on) => {
  world(on, { isGraphe: false })
  await open($)
  expect((await rows($)).join('\n')).toContain('Pas de graphe construit : plan B, tâche B6')
})

test('a missing journal says "jamais construit"', { options: OPTIONS }, async ($, on) => {
  world(on, { isJournal: false })
  await open($)
  expect((await rows($))[0]).toContain('jamais construit')
})

test('/graphe shows the last journal line, the drawing and the glyph legend', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  const out = await rows($)
  // The last line of the journal, not the first.
  expect(out[0]).toContain('2026-01-02')
  expect(out[0]).toContain('9 nœuds')
  expect(out[0]).toContain('10 liens')
  expect(out[0]).toContain('11 % isolés')
  expect(out[0]).toContain('code 0')
  const all = out.join('\n')
  expect(all).toContain('☉ borges')
  expect(all).toContain('○ idée')
  expect(all).toContain('✎ geste')
  expect(disk.opens).toEqual(['graphe'])
})

test('/graphe borges: the centre in claude, its three links and its citation', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'borges')
  const ui = await $.ui.mount(pane(80))
  const glyph = await ui.find({ type: 'Text', text: /^☉ borges/ })
  expect(glyph?.props.color).toBe('claude')
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(all).toContain('→ habite — la bibliothèque')
  expect(all).toContain('→ pratique — écrire court')
  expect(all).toContain('← obsède — le labyrinthe')
  expect(all).toContain('Une citation inventée pour le centre du test.')
  // A centre replaces the glyph legend.
  expect(all).not.toContain('○ idée')
  await ui.unmount()
})

test('a search ignores accents and case', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'ECRIRE COURT')
  const ui = await $.ui.mount(pane(80))
  expect((await ui.find({ type: 'Text', text: /^✎ écrire court/ }))?.props.color).toBe('claude')
  await ui.unmount()
})

test('/graphe xyz says "aucun nœud"', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'xyz')
  expect((await rows($)).join('\n')).toContain('aucun nœud')
})

test('several matches give one button each, and a press centres on it', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'ri')
  const ui = await $.ui.mount(pane(80))
  const labels = (await ui.findAll({ type: 'Button' })).map(b => b.text)
  expect(labels.sort()).toEqual(['le labyrinthe', 'écrire court'])
  await ui.press({ key: 'choix:le labyrinthe' })
  expect((await ui.find({ type: 'Text', text: /^○ le labyrinthe/ }))?.props.color).toBe('claude')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('typing borges in the field redraws the same pane around it', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  const ui = await $.ui.mount(pane(80))
  expect((await ui.find({ type: 'Text', text: /^☉ borges/ }))?.props.color).not.toBe('claude')
  const reads = disk.reads
  await ui.input({ key: 'recherche', text: 'borges' })
  expect((await ui.find({ type: 'Text', text: /^☉ borges/ }))?.props.color).toBe('claude')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('→ habite — la bibliothèque')
  // No command, no second pane, no file read again.
  expect(disk.opens).toEqual(['graphe'])
  expect(disk.reads).toBe(reads)
  await ui.unmount()
})

test('a narrower pane redraws without any row past its width', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($, 'borges')
  const ui = await $.ui.mount(pane(80))
  const wide = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const reads = disk.reads
  await ui.redraw(props(40))
  const narrow = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(narrow).not.toEqual(wide)
  expect(narrow.join('\n')).toContain('borges')
  for (const line of narrow) expect(line.length).toBeLessThanOrEqual(40)
  expect(disk.reads).toBe(reads)
  await ui.unmount()
})

test('the same graph draws the same way from one opening to the next', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($)
  const first = await rows($)
  await $.command.run(commandRun(''))
  expect(await rows($)).toEqual(first)
})

test('a default path with ~ is expanded from HOME', async ($, on) => {
  const disk = world(on, { isGraphe: false })
  disk.files.set('/fakehome/Library/Mobile Documents/iCloud~md~obsidian/Documents/écrits/graphe.json', JSON.stringify(GRAPHE))
  await open($)
  expect((await rows($)).join('\n')).toContain('☉ borges')
})

// A synthetic star: one centre with twelve neighbours whose ids all hold "branche".
const STAR = {
  nodes: [
    { id: 'étoile', type: 'idee', genre: 'article', premiere_date: '2026-01-02', mentions: [] },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `branche ${String(i + 1).padStart(2, '0')}`, type: 'idee', genre: 'article', premiere_date: '2026-01-02', mentions: [] })),
  ],
  edges: Array.from({ length: 12 }, (_, i) => ({ from: 'étoile', to: `branche ${String(i + 1).padStart(2, '0')}`, relation: 'porte', citation: '', source_id: '', genre: 'article' })),
}

test('the centre lists eight links, then how many more', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.files.set(`${COFFRE}/graphe.json`, JSON.stringify(STAR))
  await open($, 'étoile')
  const out = await rows($)
  expect(out.filter(l => l.startsWith('→ porte — '))).toHaveLength(8)
  expect(out).toContain('… et 4 autres')
})

test('a search lists eight buttons, then how many more', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.files.set(`${COFFRE}/graphe.json`, JSON.stringify(STAR))
  await open($, 'branche')
  const ui = await $.ui.mount(pane(80))
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(8)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('… et 4 autres')
  await ui.unmount()
})

test('a graphe.json that exists but cannot be read is not called absent', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.unreadable.add(`${COFFRE}/graphe.json`)
  await open($)
  const out = (await rows($)).join('\n')
  expect(out).toContain('graphe.json illisible (fichier évincé par iCloud ?)')
  expect(out).not.toContain('Pas de graphe construit')
})

test('a journal line without a date says so instead of undefined', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.files.set(JOURNAL_PATH, '{"noeuds":2,"liens":1,"isoles":0,"exit":0}\n')
  await open($)
  const head = (await rows($))[0]!
  expect(head).toContain('date inconnue')
  expect(head).not.toContain('undefined')
})

// Regression: fix(mods): graphe hides posts and fiction by default — a post and a
// fiction node were drawn in every view, against the plan's "masqué par défaut".
test('a post node and a fiction node are hidden by default, shown with --tout', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'la promenade')
  const hidden = (await rows($)).join('\n')
  expect(hidden).toContain('← accompagne — le carnet')
  expect(hidden).not.toContain('le brouillon')
  expect(hidden).not.toContain('la tempête')
  await $.command.run(commandRun('brouillon'))
  expect((await rows($)).join('\n')).toContain('aucun nœud')
  await $.command.run(commandRun('tempête'))
  expect((await rows($)).join('\n')).toContain('aucun nœud')

  await $.command.run(commandRun('--tout la promenade'))
  const shown = (await rows($)).join('\n')
  expect(shown).toContain('→ annonce — le brouillon')
  expect(shown).toContain('← traverse — la tempête')
})

// Regression: fix(mods): graphe header survives a failed run — after a failed run
// the header read « 0 nœuds · code 2 » and hid the last good build.
test('after a failed run the header keeps the last good build and names the code', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.files.set(
    JOURNAL_PATH,
    '{"date":"2026-01-01","sources":4,"extraits_neufs":4,"differes":0,"noeuds":7,"liens":6,"isoles":1,"exit":0}\n' +
      '{"date":"2026-01-08","sources":0,"extraits_neufs":0,"differes":0,"noeuds":0,"liens":0,"isoles":0,"exit":2}\n',
  )
  await open($)
  const head = (await rows($, 120))[0]!
  expect(head).toContain('2026-01-01')
  expect(head).toContain('7 nœuds')
  expect(head).toContain('6 liens')
  expect(head).toContain('dernier lancement : code 2')
  expect(head).not.toContain('0 nœuds')
})

// The settle: sixteen images at 125 ms, then the last one held.
const SETTLE_MS = 16 * 125

// A drawn row of the static layout, as the pane draws it at 80 columns: the
// pane's 36 rows less nine.
function staticRows(centre: string | null): string[] {
  const sub = sousGraphe(GRAPHE, centre, 20)

  return dessiner(sub, placer(sub, 80, 27, seedOf(sub)), 80, 27, centre).map(row => row.map(span => span.texte).join(''))
}

test('/graphe borges settles on screen, then holds the static layout', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($, 'borges')
  const start = await rows($)
  const expected = staticRows('borges').filter(row => row.trim() !== '')
  // The control that can fail: the first image is not the static layout.
  expect(expected.every(row => start.includes(row))).toBe(false)
  await disk.clock.advance(SETTLE_MS)
  const end = await rows($)
  for (const row of expected) expect(end).toContain(row)
  expect(end.join('\n')).toContain('☉ borges')
  // Settled: nothing moves, and the tick asks for no pane any more.
  const asked = disk.panesAsked
  await disk.clock.advance(10_000)
  expect(await rows($)).toEqual(end)
  expect(disk.panesAsked).toBe(asked)
})

test('the centre beats while the layout settles, never after', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($, 'borges')
  const glyph = async () => {
    const ui = await $.ui.mount(pane(80))
    const lit = await ui.find({ type: 'Text', text: /^☉ borges/ })
    // Blank: the glyph's cell, then the gap before the label, in the centre's colour.
    const blank = await ui.find({ type: 'Text', text: /^  borges/ })
    await ui.unmount()

    return lit !== undefined ? 'lit' : blank !== undefined ? 'blank' : 'none'
  }
  expect(await glyph()).toBe('lit')
  await disk.clock.advance(3 * 125)
  expect(await glyph()).toBe('blank')
  await disk.clock.advance(125)
  expect(await glyph()).toBe('lit')
  await disk.clock.advance(SETTLE_MS)
  for (let i = 0; i < 4; i++) {
    expect(await glyph()).toBe('lit')
    await disk.clock.advance(125)
  }
})

test('a pane behind another tab does not settle until it is shown', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($, 'borges')
  const start = await rows($)
  disk.isShown = false
  await disk.clock.advance(SETTLE_MS)
  expect(await rows($)).toEqual(start)
  disk.isShown = true
  await disk.clock.advance(SETTLE_MS)
  expect(await rows($)).not.toEqual(start)
})

test('a search that recentres settles again; one that finds nothing does not', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await disk.clock.advance(SETTLE_MS)
  const ui = await $.ui.mount(pane(80))
  const settled = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.input({ key: 'recherche', text: 'xyz' })
  const missed = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(missed).toContain('aucun nœud')
  expect(missed.filter(line => line !== 'aucun nœud')).toEqual(settled)
  await ui.input({ key: 'recherche', text: 'borges' })
  const asked = disk.panesAsked
  await disk.clock.advance(125)
  // A tick that finds an image left asks whether the pane is shown.
  expect(disk.panesAsked).toBeGreaterThan(asked)
  await ui.unmount()
})

test('under the header, the degrees of the drawn nodes and the counts', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'borges')
  // borges, la bibliothèque, écrire court, le labyrinthe 3; le silence, le miroir 2; la nuit, le carnet 1.
  expect((await rows($))[1]).toBe('degrés ████▆▆▃▃ · 8 nœuds · 9 liens')
})

test('/graphe remembers the pane it opened', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  expect(disk.store.get('paneOpen')).toBe(true)
  expect(disk.opens).toEqual(['graphe'])
})

test('session.start reopens a remembered pane, drawn', { options: OPTIONS }, async ($, on) => {
  const disk = world(on, { store: { paneOpen: true } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(disk.opens).toEqual(['graphe'])
  expect((await rows($)).join('\n')).toContain('☉ borges')
})

test('session.start opens nothing when no pane is remembered', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(disk.opens).toEqual([])
})

// The test kit raises no `ui.close` of the person's: the mod's own hook is
// taken from `register` and handed a store that records.
test('a close by the person forgets the pane; a plugin close or an unload does not', async () => {
  const hooks = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const capture = (event: string, ...rest: unknown[]) => {
    hooks.set(event, rest.at(-1) as (...args: unknown[]) => Promise<unknown>)
  }
  register(capture as unknown as On, OPTIONS)
  const deleted: string[] = []
  const engine = { store: { delete: async (key: string) => void deleted.push(key) } }
  const close = hooks.get('ui.close')!
  const next = async (e: unknown) => e
  for (const kind of ['plugin', 'unload'] as const) await close(engine, { id: 'graphe', origin: { kind } }, next)
  await close(engine, { id: 'une autre', origin: { kind: 'person' } }, next)
  expect(deleted).toEqual([])
  await close(engine, { id: 'graphe', origin: { kind: 'person' } }, next)
  expect(deleted).toEqual(['paneOpen'])
})

test('the panel answer opens, then closes, this tab', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun('', 'panel'))
  disk.panel.text = 'Panel closed.'
  await $.command.run(commandRun('', 'panel'))
  expect(disk.opens).toEqual(['graphe'])
  expect(disk.closes).toEqual(['graphe'])
  expect(disk.store.get('paneOpen')).toBe(false)
})

// Regression: review fix — the /panel open path and the session.start reopen
// replay the settle, like /graphe does, so the layout animates on opening.
test('the panel opening and the reopening settle on screen', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun('', 'panel'))
  const start = await rows($)
  await disk.clock.advance(SETTLE_MS)
  expect(await rows($)).not.toEqual(start)
})

test('session.start reopening a remembered pane settles it', { options: OPTIONS }, async ($, on) => {
  const disk = world(on, { store: { paneOpen: true } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const start = await rows($)
  await disk.clock.advance(SETTLE_MS)
  expect(await rows($)).not.toEqual(start)
})

// Regression: review fix — the 125 ms timer is cancelled once settled.
test('once settled, the timer is cancelled and asks for nothing', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($, 'borges')
  await disk.clock.advance(SETTLE_MS + 125)
  const asked = disk.panesAsked
  await disk.clock.advance(10_000)
  expect(disk.panesAsked).toBe(asked)
  await open($, 'borges')
  await disk.clock.advance(SETTLE_MS)
  expect(disk.panesAsked).toBeGreaterThan(asked)
})

// The live centre. A prompt as the engine raises it for what the person typed.
const typed = (text: string, kind: 'composer' | 'bridge' | 'peer' = 'composer') => ({ text, wait: false, origin: { kind } }) as Parameters<Engine['prompt']['submit']>[0]

// What a prompt did, once the fire-and-forget model step has run as far as it can.
async function say($: Engine, disk: Disk, text: string, kind: 'composer' | 'bridge' | 'peer' = 'composer'): Promise<void> {
  await $.prompt.submit(typed(text, kind))
  await disk.clock.settle()
}

const header = async ($: Engine) => (await rows($, 120))[0]!
const centreOf = async ($: Engine, label: string): Promise<boolean> => {
  const ui = await $.ui.mount(pane(80))
  // The leaves carry the colour; the row that holds them matches the same words.
  const lit = (await ui.findAll({ type: 'Text', text: new RegExp(label.slice(0, 6)) })).some(t => t.props.color === 'claude')
  await ui.unmount()

  return lit
}
const LEXICAL = { ...OPTIONS, centrage: 'lexical' }
const AUTO_HEAD = (id: string, terms: string) => `centré sur « ${id} » : le plus proche de cette conversation (${terms})`

test('a prompt naming a node re-centres the open pane, and the header names the matched terms', { options: LEXICAL }, async ($, on) => {
  const disk = world(on)
  await open($)
  const before = await header($)
  expect(before).toContain('2026-01-02')
  expect(await centreOf($, 'la bibliothèque')).toBe(false)
  const reads = disk.reads
  await say($, disk, 'Parlons de la bibliothèque, tard dans la nuit')
  expect(await header($)).toBe(AUTO_HEAD('la bibliothèque', 'bibliothèque, nuit').replace('bibliothèque, nuit', 'bibliothèque'))
  expect(await centreOf($, 'la bibliothèque')).toBe(true)
  // The index is cached with the graph: no file is read again.
  expect(disk.reads).toBe(reads)
})

test('the header lists up to three matched terms, strongest first', { options: LEXICAL }, async ($, on) => {
  world(on)
  await open($)
  // "écrire court" holds two of the words; the third comes from its id too.
  await $.prompt.submit(typed('écrire court'))
  expect(await header($)).toBe(AUTO_HEAD('écrire court', 'court, écrire'))
})

test('no match: the pane keeps today\'s most-connected view and journal header', { options: LEXICAL }, async ($, on) => {
  const disk = world(on)
  await open($)
  const start = await rows($)
  await say($, disk, 'rien de connu ici')
  expect(await rows($)).toEqual(start)
  expect((await rows($))[0]).toContain('2026-01-02')
})

// Five invented nodes with words of their own: "aaaa bbbb" and "aaaa cccc" share "aaaa".
const WORDS: Graphe = {
  nodes: ['aaaa bbbb', 'aaaa cccc', 'dddd', 'eeee', 'gggg', 'hhhh'].map(id => ({ id, type: 'idee', genre: 'article', premiere_date: '2026-01-02', mentions: [] })),
  edges: [],
}

test('hysteresis: a challenger that is better, but not by 20 %, does not take the centre', { options: LEXICAL }, async ($, on) => {
  const disk = world(on)
  disk.files.set(`${COFFRE}/graphe.json`, JSON.stringify(WORDS))
  await open($)
  await say($, disk, 'aaaa bbbb')
  expect(await header($)).toContain('« aaaa bbbb »')
  // The control that can fail: after "cccc", the challenger leads, by less than 20 %.
  const index = buildIndex(WORDS)
  const scores = new Map(rank(index, ['aaaa bbbb', 'cccc']).map(r => [r.id, r.score]))
  const held = scores.get('aaaa bbbb')!
  const challenger = scores.get('aaaa cccc')!
  expect(challenger).toBeGreaterThan(held)
  expect(challenger).toBeLessThan(held * 1.2)
  await say($, disk, 'cccc')
  expect(await header($)).toContain('« aaaa bbbb »')
  // A third prompt widens the gap past 20 %: now it moves.
  await say($, disk, 'cccc')
  expect(await header($)).toContain('« aaaa cccc »')
})

test('/graphe <search> pins the centre; later prompts do not move it until /graphe', { options: LEXICAL }, async ($, on) => {
  const disk = world(on)
  await open($, 'borges')
  await say($, disk, 'la bibliothèque')
  await say($, disk, 'le miroir')
  // Pinned: still borges, with the journal header, not the conversation's.
  expect(await centreOf($, 'borges')).toBe(true)
  expect(await header($)).toContain('2026-01-02')
  expect(await header($)).not.toContain('centré sur')
  // /graphe alone hands the centre back to the conversation, prompts typed meanwhile counted.
  await $.command.run(commandRun(''))
  expect(await header($)).toBe(AUTO_HEAD('le miroir', 'miroir'))
  await say($, disk, 'la nuit')
  expect(await header($)).toContain('« la nuit »')
})

test('a search typed in the pane pins too, and an empty one unpins', { options: LEXICAL }, async ($, on) => {
  const disk = world(on)
  await open($)
  const ui = await $.ui.mount(pane(80))
  await ui.input({ key: 'recherche', text: 'borges' })
  await $.prompt.submit(typed('le miroir'))
  expect((await ui.find({ type: 'Text', text: /^☉ borges/ }))?.props.color).toBe('claude')
  await ui.input({ key: 'recherche', text: '' })
  expect((await ui.findAll({ type: 'Text' }))[0]!.text).toBe(AUTO_HEAD('le miroir', 'miroir'))
  await ui.unmount()
  expect(disk.models).toEqual([])
})

test('the prompts of a plugin, a peer or a command are not the conversation', { options: LEXICAL }, async ($, on) => {
  const disk = world(on)
  await open($)
  await say($, disk, 'la bibliothèque', 'peer')
  await $.prompt.submit({ text: 'la bibliothèque', wait: false, origin: { kind: 'plugin', name: 'autre' } } as Parameters<Engine['prompt']['submit']>[0])
  await $.prompt.submit({ ...typed('la bibliothèque'), command: { name: 'review', args: '' } } as Parameters<Engine['prompt']['submit']>[0])
  expect(await header($)).toContain('2026-01-02')
  // A message from the phone is the person's own.
  await say($, disk, 'la bibliothèque', 'bridge')
  expect(await header($)).toContain('« la bibliothèque »')
})

test('the model is not asked when the lexical step is decided', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await say($, disk, 'la bibliothèque')
  expect(await header($)).toContain('« la bibliothèque »')
  expect(disk.models).toEqual([])
})

test('no match: the model is asked once with the ids and the prompts, and a listed id centres, "choisi par Haiku"', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.reply = async () => 'le carnet'
  await open($)
  await say($, disk, 'rien de connu ici')
  expect(disk.models).toHaveLength(1)
  const call = disk.models[0]!
  expect(call.model).toBe('claude-haiku-5-5')
  expect(call.system).toContain('NONE')
  // The visible nodes only, by degree; the conversation as typed.
  for (const id of ['borges', 'le carnet', 'la promenade']) expect(call.prompt).toContain(id)
  expect(call.prompt).not.toContain('le brouillon')
  expect(call.prompt).not.toContain('la tempête')
  expect(call.prompt).toContain('rien de connu ici')
  expect(await header($)).toBe(AUTO_HEAD('le carnet', 'choisi par Haiku'))
  expect(await centreOf($, 'le carnet')).toBe(true)
})

test('two nodes within 10 % of each other send the model to decide', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.reply = async () => 'le labyrinthe'
  await open($)
  await say($, disk, 'borges labyrinthe')
  expect(disk.models).toHaveLength(1)
  expect(await header($)).toBe(AUTO_HEAD('le labyrinthe', 'choisi par Haiku'))
})

test('an answer that is not exactly a listed id is ignored, silently', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await disk.clock.advance(3 * 60_000)
  const start = await rows($)
  const replies = ['NONE', 'borges.', 'Borges', 'je pense à borges', 'le brouillon', '']
  for (const reply of replies) {
    disk.reply = async () => reply
    await disk.clock.advance(3 * 60_000)
    // One ask per three prompts, on the first of them.
    for (const text of ['rien de connu', 'toujours rien', 'encore rien']) await say($, disk, text)
    expect(await rows($)).toEqual(start)
  }
  expect(disk.models).toHaveLength(replies.length)
})

test('an API error leaves the view as it was', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.reply = async () => undefined
  await open($)
  const start = await rows($)
  await say($, disk, 'rien de connu ici')
  expect(disk.models).toHaveLength(1)
  expect(await rows($)).toEqual(start)
})

test('the model is asked at most once per 3 prompts', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await say($, disk, 'un rien')
  expect(disk.models).toHaveLength(1)
  // Plenty of time, too few prompts.
  await disk.clock.advance(10 * 60_000)
  await say($, disk, 'deux rien')
  await say($, disk, 'trois rien')
  expect(disk.models).toHaveLength(1)
  await say($, disk, 'quatre rien')
  expect(disk.models).toHaveLength(2)
})

test('the model is asked at most once per 2 minutes', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await say($, disk, 'un rien')
  // Enough prompts, too little time.
  for (const text of ['deux rien', 'trois rien', 'quatre rien']) await say($, disk, text)
  await disk.clock.advance(2 * 60_000 - 1)
  await say($, disk, 'cinq rien')
  expect(disk.models).toHaveLength(1)
  await disk.clock.advance(1)
  await say($, disk, 'six rien')
  expect(disk.models).toHaveLength(2)
})

test('the model sees the last 5 prompts, 2000 characters at most, the newest kept', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await say($, disk, 'premier rien')
  for (const text of ['deux rien', 'trois rien']) {
    await disk.clock.advance(3 * 60_000)
    await say($, disk, text)
  }
  expect(disk.models).toHaveLength(1)
  for (const text of ['quatre rien', 'cinq rien', 'six rien']) {
    await disk.clock.advance(3 * 60_000)
    await say($, disk, text)
  }
  await disk.clock.advance(3 * 60_000)
  await say($, disk, 'sept rien')
  expect(disk.models).toHaveLength(3)
  const talk = (n: number) => disk.models[n]!.prompt.split('Conversation (oldest first):\n')[1]!
  // Five prompts: the first two are out.
  expect(talk(2)).not.toContain('premier')
  expect(talk(2)).not.toContain('deux rien')
  expect(talk(2).split('\n---\n')).toEqual(['trois rien', 'quatre rien', 'cinq rien', 'six rien', 'sept rien'])
  // Past 2000 characters the oldest goes first.
  await disk.clock.advance(3 * 60_000)
  await say($, disk, `${'x'.repeat(2500)} huit rien`)
  await say($, disk, 'neuf rien')
  await say($, disk, 'dix rien')
  const long = talk(3)
  expect(disk.models).toHaveLength(4)
  expect(long.length).toBeLessThanOrEqual(2000)
  expect(long.endsWith('dix rien')).toBe(true)
  expect(long).not.toContain('trois')
})

test('the prompt is never blocked on the model', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.reply = async () => {
    await disk.clock.sleep(60_000)

    return 'le carnet'
  }
  await open($)
  await $.prompt.submit(typed('rien de connu ici'))
  await disk.clock.settle()
  expect(disk.models).toHaveLength(1)
  expect(await header($)).toContain('2026-01-02')
  await disk.clock.advance(60_000)
  expect(await header($)).toBe(AUTO_HEAD('le carnet', 'choisi par Haiku'))
})

test('an answer that arrives after the person pinned a search is dropped', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.reply = async () => {
    await disk.clock.sleep(60_000)

    return 'le carnet'
  }
  await open($)
  await $.prompt.submit(typed('rien de connu ici'))
  await disk.clock.settle()
  await $.command.run(commandRun('borges'))
  await disk.clock.advance(60_000)
  expect(await centreOf($, 'borges')).toBe(true)
  expect(await header($)).not.toContain('Haiku')
  expect(await centreOf($, 'le carnet')).toBe(false)
})

test('the lexical setting never asks the model', { options: LEXICAL }, async ($, on) => {
  const disk = world(on)
  await open($)
  await say($, disk, 'rien de connu ici')
  await say($, disk, 'borges labyrinthe')
  expect(disk.models).toEqual([])
})

test('the off setting changes nothing: no centre, no header, no model, no memory', { options: { ...OPTIONS, centrage: 'off' } }, async ($, on) => {
  const disk = world(on)
  await open($)
  const start = await rows($)
  await say($, disk, 'la bibliothèque')
  await say($, disk, 'rien de connu ici')
  expect(await rows($)).toEqual(start)
  expect(disk.models).toEqual([])
  await $.command.run(commandRun(''))
  expect(await rows($)).toEqual(start)
})

test('prompts are never written to the store or the disk', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  const secret = 'confidentiel-xyzzy la bibliothèque'
  await say($, disk, secret)
  await say($, disk, 'rien de connu ici')
  expect(disk.writes).toEqual([])
  expect(JSON.stringify([...disk.store])).not.toContain('xyzzy')
  expect([...disk.store.keys()]).toEqual(['paneOpen'])
})

test('an answer to a question asked before a pin and an unpin is dropped too', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.reply = async () => {
    await disk.clock.sleep(60_000)

    return 'le carnet'
  }
  await open($)
  await $.prompt.submit(typed('rien de connu ici'))
  await disk.clock.settle()
  await $.command.run(commandRun('borges'))
  await $.command.run(commandRun(''))
  await disk.clock.advance(60_000)
  expect(await centreOf($, 'le carnet')).toBe(false)
  expect(await header($)).not.toContain('Haiku')
})

// The locale. One tour walks every string the mod can show (the header in each
// journal state, the stats strip, the legend, links and quote, the search
// field's placeholder, the no-match and more-matches lines, every unreadable
// graph, the /graphe replies and the pane title), so the French tour is pinned
// whole and the English one scanned.
async function tour($: Engine, disk: Disk, all: string): Promise<string[]> {
  const out: string[] = []
  const run = async (args: string, width = 80) => {
    const reply = (await $.command.run(commandRun(args))) as { text?: string }
    out.push(`> /graphe ${args} => ${reply.text ?? ''}`)
    const ui = await $.ui.mount(pane(width))
    out.push(...(await ui.findAll({ type: 'Text' })).map(t => t.text))
    out.push(...(await ui.findAll({ type: 'Input' })).map(i => `input: ${String((i.props as { placeholder?: unknown }).placeholder)}`))
    out.push(...(await ui.findAll({ type: 'Button' })).map(b => `button: ${String((b.props as { label?: unknown }).label)}`))
    await ui.unmount()
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run('')
  await run('borges')
  await run('xyz')
  await run(`${all} e`)
  await run(`${all} la promenade`)
  const good = '{"date":"2026-01-01","noeuds":7,"liens":6,"isoles":1,"exit":0}\n'
  for (const journal of [good + '{"date":"2026-01-08","noeuds":0,"liens":0,"isoles":0,"exit":2}\n', '{"noeuds":2,"liens":1,"isoles":0,"exit":0}\n', '{"exit":2}\n', good + 'pas du json\n']) {
    disk.files.set(JOURNAL_PATH, journal)
    await run('', 120)
  }
  disk.files.delete(JOURNAL_PATH)
  disk.unreadable.add(JOURNAL_PATH)
  await run('', 120)
  disk.unreadable.delete(JOURNAL_PATH)
  await run('', 120)
  disk.unreadable.add(`${COFFRE}/graphe.json`)
  await run('')
  disk.unreadable.delete(`${COFFRE}/graphe.json`)
  disk.files.set(`${COFFRE}/graphe.json`, '{}')
  await run('')
  disk.files.set(`${COFFRE}/graphe.json`, 'pas du json')
  await run('')
  disk.files.delete(`${COFFRE}/graphe.json`)
  await run('')
  out.push(`titles: ${disk.titles.join(', ')}`)

  return out
}

// The live centre's header, chosen by the words and then by Haiku.
async function live($: Engine, disk: Disk, words: string): Promise<string[]> {
  disk.reply = async () => 'le carnet'
  await open($)
  await say($, disk, words)
  const lexical = await header($)
  await disk.clock.advance(3 * 60_000)
  for (const text of ['rien de connu', 'toujours rien', 'encore rien']) await say($, disk, text)

  return [lexical, await header($)]
}

// What the French pane says and the English one must not: each phrase below is
// in the French tour (the control test proves it), none in the invented graph.
const FRENCH = [
  'Construit le', 'nœud', 'liens', 'isolés', 'dernier lancement', 'jamais construit', 'proprement', 'illisible',
  'évincé', 'Pas de graphe', 'tâche', 'aucun', 'autres', 'date inconnue', 'degrés', 'centré sur', 'le plus proche',
  'choisi par', '○ idée', '◇ goût', '▢ référence', '◆ vécu', '☉ personne', '✎ geste', 'Chercher', '«', '»',
  'Graphe.', 'Graphe autour', 'titles: Graphe',
]
const frenchIn = (out: readonly string[]): string[] => {
  const all = out.join('\n')

  return FRENCH.filter(word => all.includes(word))
}
const EN = { ...OPTIONS, lang: 'en' }

test('fr: the tour draws and answers exactly as before the English locale', { options: OPTIONS }, async ($, on) => {
  expect(await tour($, world(on), '--tout')).toEqual([...TOUR_FR])
})

test('fr: lang "fr" set explicitly draws the same tour', { options: { ...OPTIONS, lang: 'fr' } }, async ($, on) => {
  expect(await tour($, world(on), '--tout')).toEqual([...TOUR_FR])
})

test('fr: the live centre headers read exactly as before', { options: OPTIONS }, async ($, on) => {
  expect(await live($, world(on), 'la bibliothèque')).toEqual([...LIVE_FR])
})

test('control: every French phrase scanned for is in the French tour', () => {
  expect(FRENCH.filter(word => !frenchIn([...TOUR_FR, ...LIVE_FR]).includes(word))).toEqual([])
})

test('en: the whole tour carries no French phrase', { options: EN }, async ($, on) => {
  const out = await tour($, world(on), '--all')
  expect(frenchIn(out)).toEqual([])
  const all = out.join('\n')
  expect(all).toContain('> /graphe  => Graph.')
  expect(all).toContain('> /graphe borges => Graph around borges.')
  expect(all).toContain('Built 2026-01-02 · 9 nodes · 10 links · 11% isolated · exit 0')
  expect(all).toContain('Built 2026-01-01 · 7 nodes · 6 links · 14% isolated · last run: exit 2')
  expect(all).toContain('Built unknown date · 2 nodes · 1 link · 0% isolated · exit 0')
  expect(all).toContain('never built cleanly · last run: exit 2')
  expect(all).toContain('journal is unreadable')
  expect(all).toContain('never built')
  expect(all).toContain('degrees ████▆▆▆▃▃ · 9 nodes · 10 links')
  expect(all).toContain('○ idea  ◇ taste  ▢ reference  ◆ lived  ☉ person  ✎ gesture')
  expect(all).toContain('input: Search a node')
  expect(all).toContain('no node found')
  expect(all).toContain('… and 2 more')
  // --all shows the post and the fiction, as --tout does.
  expect(all).toContain('→ annonce — le brouillon')
  expect(all).toContain('“Une citation inventée pour le centre du test.”')
  expect(all).toContain('graphe.json is unreadable (evicted by iCloud?)')
  expect(all).toContain('graphe.json is unreadable')
  expect(all).toContain('No graph built: plan B, task B6')
  expect(all).toContain('titles: Graph')
})

test('en: the live centre headers carry no French phrase', { options: EN }, async ($, on) => {
  const out = await live($, world(on), 'la bibliothèque')
  expect(frenchIn(out)).toEqual([])
  expect(out).toEqual([
    'centred on “la bibliothèque”: the closest to this conversation (bibliothèque)',
    'centred on “le carnet”: the closest to this conversation (chosen by Haiku)',
  ])
})

test('en: --tout still shows every genre', { options: EN }, async ($, on) => {
  world(on)
  await open($, '--tout la promenade')
  expect((await rows($)).join('\n')).toContain('→ annonce — le brouillon')
})

// Every entry of a table, its functions called with sample arguments, so a
// string no tour reaches is scanned too.
const rendered = (table: Strings): string[] =>
  Object.values(table).flatMap(v => (typeof v === 'function' ? [(v as (...a: unknown[]) => string)('x', 2, 3, 4)] : typeof v === 'object' ? Object.values(v) : [v]))

test('en: no entry of the English table carries a French phrase', () => {
  expect(frenchIn(rendered(STRINGS.en))).toEqual([])
  // Control: the same scan finds the French table's.
  expect(frenchIn(rendered(STRINGS.fr)).length).toBeGreaterThan(20)
})

test('the two tables have the same keys, and name the same node types', () => {
  expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.fr).sort())
  expect(Object.keys(STRINGS.en.types).sort()).toEqual(Object.keys(STRINGS.fr.types).sort())
  expect(GLYPHS.map(([type]) => type).filter(type => STRINGS.en.types[type] === undefined || STRINGS.fr.types[type] === undefined)).toEqual([])
})

// The corpus server, faked: `process.spawn` stands for the child and
// `http.fetch` for its socket, so no process starts. Every title, excerpt and
// node below is invented.
type Kid = {
  spawns: (readonly string[])[]
  alive: number
  most: number
  asked: { route: string; body: { text?: string; id?: string } }[]
  centre: (text: string) => Promise<unknown>
  entry: (id: string) => Promise<unknown>
  // Ends the running child as if it exited by itself.
  exit: () => void
  // The sweep: what `<TMPDIR>/graphe` holds, and what `rm` was asked to remove.
  dir: { name: string; kind: 'file' | 'other'; isLive: boolean; error?: string }[]
  removed: string[]
  statuses: (string | undefined)[]
  // While set, the child holds its ready line until `ready()`.
  isReadyHeld: boolean
  ready: () => void
  // So many /entry requests answer 500 first.
  entryFailures: number
}

const SERVED = { ...OPTIONS, centrage: 'lexical', node: '/fake/node', serveur: '/fake/serve.ts' }
const SERVED_HAIKU = { ...SERVED, centrage: 'haiku' }
const answered = (data: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(data) })

function kid(on: On): Kid {
  const k: Kid = {
    spawns: [],
    alive: 0,
    most: 0,
    asked: [],
    centre: async () => ({ by: 'words', passages: [] }),
    entry: async () => ({ passages: [] }),
    exit: () => undefined,
    dir: [],
    removed: [],
    statuses: [],
    isReadyHeld: false,
    ready: () => undefined,
    entryFailures: 0,
  }
  on('session.id', () => ({ value: '0123456789abcdef' }))
  on('ui.status', (_, e) => {
    k.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  // world() answers every variable with /fakehome, so TMPDIR is /fakehome.
  on('fs.list', (_, e) => ({ value: e.path === '/fakehome/graphe' ? k.dir.map(d => ({ name: d.name, kind: d.kind, size: 0, mtimeMs: 0, isLink: false })) : [] }))
  on('process.run', (_, e) => {
    k.removed.push(e.argv.at(-1)!)

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async (_, e) => {
    const route = new URL(e.url).pathname
    if (route === '/health') {
      const socket = k.dir.find(d => e.init?.socketPath === `/fakehome/graphe/${d.name}`)
      // A rejection, as the engine hands one up: `{ deny }` with the error's text.
      if (socket?.isLive !== true) return { deny: socket?.error ?? 'connect ECONNREFUSED' }

      return { value: answered({ index: 'ok', meaning: 'ready', built_at: null }) }
    }
    const body = JSON.parse(e.init?.body ?? '{}') as { text?: string; id?: string }
    k.asked.push({ route, body })
    if (route === '/entry' && k.entryFailures > 0) {
      k.entryFailures -= 1

      return { value: { status: 500, ok: false, headers: {}, text: '{"error":"invented"}' } }
    }

    return { value: answered(await (route === '/centre' ? k.centre(body.text ?? '') : k.entry(body.id ?? ''))) }
  })
  on('process.spawn', async function* (_, e, next) {
    k.spawns.push(e.argv)
    k.alive += 1
    k.most = Math.max(k.most, k.alive)
    try {
      await new Promise<void>(resolve => {
        k.ready = resolve
        next.signal.addEventListener('abort', () => resolve())
        if (!k.isReadyHeld) resolve()
      })
      if (next.signal.aborted) return { value: { code: null, signal: 'SIGTERM' } }
      yield { stream: 'stdout' as const, text: '{"ready":"words"}\n' }
      await new Promise<void>(resolve => {
        k.exit = resolve
        next.signal.addEventListener('abort', () => resolve())
      })

      return { value: { code: 0, signal: null } }
    } finally {
      k.alive -= 1
    }
  })

  return k
}

const hit = (entries: string[], titre: string, genre = 'article') => ({ i: 0, texte: `${genre}:essai`, titre, genre, n: 1, excerpt: 'Un extrait inventé.', score: 1, entries })
const passage = (titre: string, genre = 'article', neighbours: unknown[] = []) => ({ i: 1, texte: `${genre}:essai`, titre, genre, n: 2, excerpt: 'Un passage inventé.', neighbours })
const voisin = (titre: string) => ({ i: 2, texte: 'article:voisin', titre, genre: 'article', n: 3, excerpt: 'Un voisin inventé.' })

async function panel($: Engine, disk: Disk, text: 'Panel opened.' | 'Panel closed.'): Promise<void> {
  disk.panel.text = text
  await $.command.run(commandRun('', 'panel'))
  await disk.clock.settle()
}

async function opened($: Engine, disk: Disk): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await panel($, disk, 'Panel opened.')
}

test('un_seul_enfant: one child per opening, ended by each stop signal, never two alive', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  expect(k.spawns).toHaveLength(1)
  expect(k.alive).toBe(1)
  expect(k.spawns[0]!.slice(0, 8)).toEqual(['/fake/node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '/fake/serve.ts', '--index', `${COFFRE}/index-corpus.json`, '--graphe', `${COFFRE}/graphe.json`, '--socket'])
  expect(k.spawns[0]![8]).toMatch(/^\/fakehome\/graphe\/01234567-[a-z0-9]{4}\.sock$/)
  // An open while one lives starts nothing.
  await panel($, disk, 'Panel opened.')
  expect(k.spawns).toHaveLength(1)
  // The panel's « Panel closed. » answer.
  await panel($, disk, 'Panel closed.')
  expect(k.alive).toBe(0)
  await panel($, disk, 'Panel opened.')
  expect(k.spawns).toHaveLength(2)
  await panel($, disk, 'Panel closed.')
  await panel($, disk, 'Panel opened.')
  expect(k.spawns).toHaveLength(3)
  expect(k.alive).toBe(1)
  expect(k.most).toBe(1)
  // Each opening has a socket of its own.
  expect(new Set(k.spawns.map(argv => argv[8])).size).toBe(3)
})

// The test kit raises no `ui.close` of the person's: the mod's
// hooks are taken from a second `register`, over a `$` of the test's own whose
// `process.spawn` stands for the child. That registration has a module state
// of its own, apart from the one the kit loaded.
function bare() {
  const child = { spawns: 0, alive: 0, most: 0 }
  // What `$.ui.panes()` lists after a close: empty, unless a hook refused it.
  const panes: { id: string }[] = []
  // Every `$.clock.sleep` asked, held until the test resolves it.
  const sleeps: { ms: number; resolve: () => void }[] = []
  const spawn = () => {
    child.spawns += 1
    child.alive += 1
    child.most = Math.max(child.most, child.alive)
    let isReadySent = false
    let isDone = false
    let end = () => undefined as void
    const over = { done: true as const, value: { code: null, signal: 'SIGTERM' } }

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => {
        if (!isReadySent) {
          isReadySent = true

          return Promise.resolve({ done: false as const, value: { stream: 'stdout' as const, text: '{"ready":"words"}\n' } })
        }

        return isDone ? Promise.resolve(over) : new Promise(resolve => (end = () => resolve(over)))
      },
      return: async () => {
        if (!isDone) {
          isDone = true
          child.alive -= 1
          end()
        }

        return over
      },
    }
  }
  const $ = {
    env: { get: async () => '/fakehome' },
    fs: { exists: async () => false, read: async () => '', list: async () => [] },
    store: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    clock: { every: () => ({ cancel: () => undefined }), now: async () => 0, sleep: (ms: number) => new Promise<void>(resolve => sleeps.push({ ms, resolve })) },
    ui: { open: async () => ({ isPlaced: true }), log: () => undefined, status: () => undefined, invalidate: () => undefined, panes: async () => panes },
    session: { id: async () => '0123456789abcdef' },
    process: { spawn, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  }
  const hooks = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const capture = (event: string, ...rest: unknown[]) => {
    const filter = rest.length > 1 ? JSON.stringify(rest[0]) : ''
    hooks.set(event + filter, rest.at(-1) as (...args: unknown[]) => Promise<unknown>)
  }
  register(capture as unknown as On, SERVED)
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }
  const openPanel = async () => {
    await hooks.get('command.run{"command":"panel"}')!($, { command: 'panel', args: '' }, async () => ({ text: 'Panel opened.' }))
    await settle()
  }
  const close = async (kind: 'person') => {
    await hooks.get('ui.close')!($, { id: 'graphe', origin: { kind } }, async (e: unknown) => e)
    await settle()
  }

  const wake = async (ms: number) => {
    for (const s of sleeps.filter(s => s.ms === ms)) s.resolve()
    await settle()
  }

  return { child, openPanel, close, panes, wake }
}

// An unload is not tested here: its `ui.close` runs none of the opener's
// hooks; the engine ends the spawn loop, which kills the child.
test('un_seul_enfant: the person\'s close ends the child too', async () => {
  const { child, openPanel, close } = bare()
  await openPanel()
  expect(child.alive).toBe(1)
  await close('person')
  expect(child.alive).toBe(0)
  await openPanel()
  expect(child.spawns).toBe(2)
  expect(child.most).toBe(1)
})

test('a close another hook refused leaves the pane and its child up', async () => {
  const { child, openPanel, close, panes, wake } = bare()
  await openPanel()
  panes.push({ id: 'graphe' })
  await close('person')
  expect(child.alive).toBe(1)
  // Still listed at the second look: still up.
  await wake(250)
  expect(child.alive).toBe(1)
})

test('a close the engine lists a little longer still ends the child at the second look', async () => {
  const { child, openPanel, close, panes, wake } = bare()
  await openPanel()
  // The pane is listed when the close resolves, gone by the second look.
  panes.push({ id: 'graphe' })
  await close('person')
  expect(child.alive).toBe(1)
  panes.length = 0
  await wake(250)
  expect(child.alive).toBe(0)
})

test('un_seul_enfant: a pane that is not placed starts no child', { options: SERVED }, async ($, on) => {
  const disk = world(on, { isPlaced: false })
  const k = kid(on)
  await opened($, disk)
  await open($, 'borges')
  await disk.clock.settle()
  expect(k.spawns).toEqual([])
})

test('a child that ends by itself is not restarted in the same opening, and the status says so', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.exit()
  await disk.clock.settle()
  expect(k.alive).toBe(0)
  expect(k.statuses).toEqual(['Graphe : passages du corpus indisponibles'])
  await panel($, disk, 'Panel opened.')
  expect(k.spawns).toHaveLength(1)
  // Closed and opened again: a new child, and the status cleared.
  await panel($, disk, 'Panel closed.')
  expect(k.statuses.at(-1)).toBeUndefined()
  await panel($, disk, 'Panel opened.')
  expect(k.spawns).toHaveLength(2)
})

test('the sweep removes the sockets nobody answers on, and nothing else', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.dir = [
    { name: 'morte.sock', kind: 'other', isLive: false },
    { name: 'vivante.sock', kind: 'other', isLive: true },
    { name: 'notes.txt', kind: 'other', isLive: false },
    { name: 'fichier.sock', kind: 'file', isLive: false },
    { name: 'disparue.sock', kind: 'other', isLive: false, error: 'connect ENOENT /fakehome/graphe/disparue.sock' },
    { name: 'bun.sock', kind: 'other', isLive: false, error: 'FailedToOpenSocket: Was there a typo in the url or port?' },
    // Refused for another cause (a web-fetch policy, say): not known to be dead.
    { name: 'refusee.sock', kind: 'other', isLive: false, error: 'request refused by the web fetch policy' },
  ]
  await opened($, disk)
  expect(k.removed.sort()).toEqual(['/fakehome/graphe/bun.sock', '/fakehome/graphe/disparue.sock', '/fakehome/graphe/morte.sock'])
  expect(k.spawns).toHaveLength(1)
})

test('reponse_perimee_ignoree: an older /centre answer arriving last is dropped', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  // The first answer waits for the test to release it (not on the clock:
  // advancing the mocked clock under a live child slows the kit to a crawl).
  let release = () => undefined as void
  let calls = 0
  k.centre = async () => {
    calls += 1
    if (calls === 1) {
      await new Promise<void>(resolve => {
        release = resolve
      })

      return { by: 'words', passages: [hit(['le carnet'], 'Titre ancien')] }
    }

    return { by: 'meaning', passages: [hit(['le miroir'], 'Titre récent')] }
  }
  await say($, disk, 'rien de connu ici')
  await say($, disk, 'toujours rien')
  expect(await centreOf($, 'le miroir')).toBe(true)
  release()
  await disk.clock.settle()
  expect(calls).toBe(2)
  expect(await centreOf($, 'le miroir')).toBe(true)
  expect(await centreOf($, 'le carnet')).toBe(false)
  expect(await header($)).toBe(AUTO_HEAD('le miroir', 'passages, par le sens : Titre récent'))
})

test('reponse_perimee_ignoree: a /centre answer arriving after a pin is dropped', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  let release = () => undefined as void
  k.centre = async () => {
    await new Promise<void>(resolve => {
      release = resolve
    })

    return { by: 'words', passages: [hit(['le carnet'], 'Titre')] }
  }
  await say($, disk, 'rien de connu ici')
  await $.command.run(commandRun('borges'))
  release()
  await disk.clock.settle()
  expect(await centreOf($, 'borges')).toBe(true)
  expect(await centreOf($, 'le carnet')).toBe(false)
})

test('prompt_jamais_bloque: a /centre that never answers does not hold the prompt', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.centre = () => new Promise(() => undefined)
  // Resolves without the clock moving: the hook returned before the child answered.
  await $.prompt.submit(typed('Parlons de la bibliothèque'))
  expect(k.asked.filter(a => a.route === '/centre')).toHaveLength(1)
  // The lexical step still re-centred at once.
  expect(await header($)).toBe(AUTO_HEAD('la bibliothèque', 'bibliothèque'))
  await $.prompt.submit(typed('encore une'))
  expect(k.asked.filter(a => a.route === '/centre')).toHaveLength(2)
})

test('the /centre query is the last five prompts, newest last, joined by blank lines', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  for (const text of ['un', 'deux', 'trois', 'quatre', 'cinq', 'six']) await say($, disk, text)
  expect(k.asked.filter(a => a.route === '/centre').at(-1)!.body.text).toBe('deux\n\ntrois\n\nquatre\n\ncinq\n\nsix')
})

test('epingle_sans_centrage: a pinned node gets its passages and no centring', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.entry = async id => ({ passages: id === 'borges' ? [passage('Titre épinglé')] : [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun('borges'))
  await disk.clock.settle()
  expect(k.asked).toEqual([{ route: '/entry', body: { id: 'borges' } }])
  expect((await rows($)).join('\n')).toContain('Titre épinglé · Un passage inventé.')
  k.centre = async () => ({ by: 'words', passages: [hit(['le carnet'], 'Titre')] })
  await say($, disk, 'la bibliothèque')
  expect(k.asked.filter(a => a.route === '/centre')).toEqual([])
  expect(await centreOf($, 'borges')).toBe(true)
})

test('section_passages_dessinee: the centre\'s passages under the graph, at the pane\'s width', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.entry = async id => ({ passages: id === 'la bibliothèque' ? [passage('Titre inventé', 'article', [voisin('Voisin inventé')])] : [] })
  await opened($, disk)
  await say($, disk, 'Parlons de la bibliothèque')
  expect(k.asked.filter(a => a.route === '/entry')).toEqual([{ route: '/entry', body: { id: 'la bibliothèque' } }])
  const out = await rows($)
  const at = out.indexOf('Passages qui font écho')
  expect(at).toBeGreaterThan(0)
  expect(out.slice(at)).toEqual(['Passages qui font écho', 'Titre inventé · Un passage inventé.', '  ↳ Voisin inventé · Un voisin inventé.'])
  for (const line of await rows($, 30)) expect(Array.from(line).length).toBeLessThanOrEqual(30)
  // The child gone, the section goes with it.
  k.exit()
  await disk.clock.settle()
  expect(await rows($)).not.toContain('Passages qui font écho')
})

test('a passage-only winner centres from rank 1, its header names the passages and their title', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.centre = async () => ({ by: 'words', passages: [hit(['le carnet'], 'Titre du carnet')] })
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(true)
  expect(await header($)).toBe(AUTO_HEAD('le carnet', 'passages, par les mots : Titre du carnet'))
  expect(k.asked.at(-1)).toEqual({ route: '/entry', body: { id: 'le carnet' } })
})

test('a passage-only winner under MIN_PASSAGE_SCORE does not centre', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  // Five hits name a node that is not in the graph; the sixth names le carnet: 1/66, under the bar.
  k.centre = async () => ({ by: 'words', passages: [...Array.from({ length: 5 }, () => hit(['hors du graphe'], 'Ailleurs')), hit(['le carnet'], 'Titre')] })
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(false)
  expect(await header($)).toContain('2026-01-02')
})

// Nine nodes, three of which share « commun »: weight 0.5, so the word alone
// scores 0.5, under MIN_SCORE.
const COMMUN = {
  nodes: ['alpha commun', 'beta commun', 'gamma commun', 'delta', 'epsilon', 'zeta', 'theta', 'iota', 'kappa'].map(id => ({ id, type: 'idee', genre: 'article', premiere_date: '2026-01-02', mentions: [] })),
  edges: [
    { from: 'alpha commun', to: 'delta', relation: 'touche', citation: '', source_id: '', genre: 'article' },
    { from: 'beta commun', to: 'epsilon', relation: 'touche', citation: '', source_id: '', genre: 'article' },
  ],
}

test('a winner the words found centres only if its lexical score clears MIN_SCORE, never its fused score', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  disk.files.set(`${COFFRE}/graphe.json`, JSON.stringify(COMMUN))
  const k = kid(on)
  await opened($, disk)
  // alpha commun: lexical 0.5 and the top passage, the best fused score; its words do not clear the bar.
  k.centre = async () => ({ by: 'words', passages: [hit(['alpha commun'], 'Titre A')] })
  await say($, disk, 'commun')
  expect(await centreOf($, 'alpha commun')).toBe(false)
  // Two passages naming a node the words did not find centre it.
  k.centre = async () => ({ by: 'words', passages: [hit(['delta'], 'Titre D'), hit(['delta'], 'Titre D bis')] })
  await say($, disk, 'commun encore')
  expect(await centreOf($, 'delta')).toBe(true)
})

test('haiku decides on the fused ranking: a clear passage winner asks no model, a tie does', { options: SERVED_HAIKU }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  disk.reply = async () => 'le miroir'
  await opened($, disk)
  // Without the server this prompt asks the model (no lexical match); a lone top passage decides it.
  k.centre = async () => ({ by: 'words', passages: [hit(['le carnet'], 'Titre')] })
  await say($, disk, 'rien de connu ici')
  expect(disk.models).toEqual([])
  expect(await centreOf($, 'le carnet')).toBe(true)
  // Two nodes within 10 %: the model breaks the tie.
  k.centre = async () => ({ by: 'words', passages: [hit(['la nuit'], 'Titre N'), hit(['le silence'], 'Titre S')] })
  await say($, disk, 'autre chose')
  expect(disk.models).toHaveLength(1)
  expect(await header($)).toBe(AUTO_HEAD('le miroir', 'choisi par Haiku'))
})

test('fiction_suit_tout: fiction passages neither centre nor show, unless --tout', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.centre = async () => ({ by: 'words', passages: [hit(['le carnet'], 'Récit inventé', 'fiction')] })
  k.entry = async () => ({ passages: [passage('Récit inventé', 'fiction'), passage('Essai inventé')] })
  await opened($, disk)
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(false)
  await $.command.run(commandRun('le carnet'))
  await disk.clock.settle()
  let all = (await rows($)).join('\n')
  expect(all).toContain('Essai inventé')
  expect(all).not.toContain('Récit inventé')
  // --tout: the fiction passage shows, and centres.
  await $.command.run(commandRun('--tout le carnet'))
  all = (await rows($)).join('\n')
  expect(all).toContain('Récit inventé · Un passage inventé.')
  await $.command.run(commandRun('--tout'))
  await say($, disk, 'rien de connu')
  expect(await centreOf($, 'le carnet')).toBe(true)
})

test('repli_sans_enfant: a server with no index answers nothing, and the pane reads as without one', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  await say($, disk, 'Parlons de la bibliothèque')
  expect(k.asked.map(a => a.route)).toEqual(['/entry', '/centre'])
  expect(await header($)).toBe(AUTO_HEAD('la bibliothèque', 'bibliothèque'))
  expect(await rows($)).not.toContain('Passages qui font écho')
})

test('repli_sans_enfant: with no passages, the words\' hysteresis stands as without the server', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  disk.files.set(`${COFFRE}/graphe.json`, JSON.stringify(WORDS))
  const k = kid(on)
  await opened($, disk)
  await say($, disk, 'aaaa bbbb')
  // "aaaa cccc" now leads the words, by less than 20 %: the hysteresis test's control.
  await say($, disk, 'cccc')
  expect(k.asked.filter(a => a.route === '/centre')).toHaveLength(2)
  expect(await header($)).toContain('« aaaa bbbb »')
})

test('hysteresis survives a passage answer: an unrelated hit does not hand the centre to a challenger under 20 %', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  disk.files.set(`${COFFRE}/graphe.json`, JSON.stringify(WORDS))
  const k = kid(on)
  await opened($, disk)
  k.centre = async () => ({ by: 'meaning', passages: [hit(['gggg'], 'Titre G')] })
  await say($, disk, 'aaaa bbbb')
  await say($, disk, 'cccc')
  expect(k.asked.filter(a => a.route === '/centre')).toHaveLength(2)
  expect(await header($)).toContain('« aaaa bbbb »')
  // Past 20 %, the words move it, passages or not.
  await say($, disk, 'cccc')
  expect(await header($)).toContain('« aaaa cccc »')
})

test('haiku: a decided word winner plus an unrelated hit asks no model', { options: SERVED_HAIKU }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  // The unrelated hit is rank 2: the words' winner stays on top of the fused ranking.
  k.centre = async () => ({ by: 'meaning', passages: [hit(['hors du graphe'], 'Ailleurs'), hit(['borges'], 'Titre B')] })
  await say($, disk, 'Parlons de la bibliothèque')
  expect(k.asked.filter(a => a.route === '/centre')).toHaveLength(1)
  expect(disk.models).toEqual([])
  expect(await header($)).toBe(AUTO_HEAD('la bibliothèque', 'bibliothèque'))
})

test('haiku: passage-only winners two ranks apart are decided', { options: SERVED_HAIKU }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.centre = async () => ({ by: 'words', passages: [hit(['la nuit'], 'Titre N'), hit(['hors du graphe'], 'Ailleurs'), hit(['le silence'], 'Titre S')] })
  await say($, disk, 'rien de connu ici')
  expect(disk.models).toEqual([])
  expect(await centreOf($, 'la nuit')).toBe(true)
})

test('a child with no ready line within 30 s is ended, and the passages are unavailable for this opening', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.isReadyHeld = true
  await opened($, disk)
  expect(k.alive).toBe(1)
  await disk.clock.advance(30_000 - 1)
  expect(k.alive).toBe(1)
  await disk.clock.advance(1)
  expect(k.alive).toBe(0)
  expect(k.statuses).toEqual(['Graphe : passages du corpus indisponibles'])
  await panel($, disk, 'Panel opened.')
  expect(k.spawns).toHaveLength(1)
})

test('prompts typed before the ready line are sent once it comes', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.isReadyHeld = true
  await opened($, disk)
  await say($, disk, 'Parlons de la bibliothèque')
  expect(k.asked).toEqual([])
  k.ready()
  await disk.clock.settle()
  expect(k.asked.filter(a => a.route === '/centre')).toEqual([{ route: '/centre', body: { text: 'Parlons de la bibliothèque' } }])
})

test('a held centre keeps a lone top passage naming another node out', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.centre = async () => ({ by: 'meaning', passages: [hit(['borges'], 'Titre B')] })
  await say($, disk, 'Parlons de la bibliothèque')
  expect(k.asked.filter(a => a.route === '/centre')).toHaveLength(1)
  expect(await header($)).toBe(AUTO_HEAD('la bibliothèque', 'bibliothèque'))
})

test('a passage-only challenger with far stronger support takes a held centre', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  // Three top hits: 1/61 + 1/62 + 1/63 against the held centre's 1/61.
  k.centre = async () => ({ by: 'meaning', passages: [hit(['borges'], 'Titre B'), hit(['borges'], 'Titre B2'), hit(['borges'], 'Titre B3')] })
  await say($, disk, 'Parlons de la bibliothèque')
  expect(await header($)).toBe(AUTO_HEAD('borges', 'passages, par le sens : Titre B'))
})

test('a passage-only challenger only just ahead of a held passage centre does not take it', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.centre = async () => ({ by: 'words', passages: [hit(['le carnet'], 'Titre C')] })
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(true)
  // le miroir: 1/61; le carnet: 1/62 — ahead, by less than 20 %.
  k.centre = async () => ({ by: 'words', passages: [hit(['le miroir'], 'Titre M'), hit(['le carnet'], 'Titre C')] })
  await say($, disk, 'rien encore')
  expect(await centreOf($, 'le carnet')).toBe(true)
})

test('the /centre text keeps the newest end, at most 4000 characters', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  await say($, disk, 'mot '.repeat(5000))
  await say($, disk, 'le dernier mot dit')
  const text = k.asked.filter(a => a.route === '/centre').at(-1)!.body.text!
  expect(text.length).toBeLessThanOrEqual(4000)
  expect(text.length).toBeGreaterThan(3000)
  expect(text.endsWith('le dernier mot dit')).toBe(true)
})

test('genres_masques: post passages neither centre nor show, unless --tout', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.centre = async () => ({ by: 'words', passages: [hit(['le carnet'], 'Billet inventé', 'post')] })
  k.entry = async () => ({ passages: [passage('Billet inventé', 'post', [voisin('Essai voisin')]), passage('Essai inventé', 'article', [{ ...voisin('Billet voisin'), genre: 'post' }])] })
  await opened($, disk)
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(false)
  await $.command.run(commandRun('le carnet'))
  await disk.clock.settle()
  let all = (await rows($)).join('\n')
  expect(all).toContain('Essai inventé')
  expect(all).not.toContain('Billet inventé')
  expect(all).not.toContain('Billet voisin')
  await $.command.run(commandRun('--tout le carnet'))
  all = (await rows($)).join('\n')
  expect(all).toContain('Billet inventé · Un passage inventé.')
  expect(all).toContain('Billet voisin')
})

test('a centre the passages chose does not flip to the words and back within a prompt', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  const two = { by: 'meaning', passages: [hit(['le carnet'], 'Titre C'), hit(['le carnet'], 'Titre C2')] }
  k.centre = async () => two
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(true)
  // The words name la bibliothèque; the same two passages still back le carnet (1/61 + 1/62 against 1/61).
  await say($, disk, 'Parlons de la bibliothèque')
  expect(await centreOf($, 'le carnet')).toBe(true)
  expect(k.asked.filter(a => a.route === '/entry' && a.body.id === 'la bibliothèque')).toEqual([])
  // Once the passages stop naming it, the words take the centre.
  k.centre = async () => ({ by: 'meaning', passages: [hit(['hors du graphe'], 'Ailleurs')] })
  await say($, disk, 'la bibliothèque encore')
  await say($, disk, 'la bibliothèque toujours')
  expect(await centreOf($, 'la bibliothèque')).toBe(true)
})

test('a failed /entry is asked again on the next prompt while the centre holds', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  k.entryFailures = 1
  k.entry = async id => ({ passages: id === 'la bibliothèque' ? [passage('Titre inventé')] : [] })
  await opened($, disk)
  await say($, disk, 'Parlons de la bibliothèque')
  expect(await rows($)).not.toContain('Passages qui font écho')
  await say($, disk, 'toujours la bibliothèque')
  expect(k.asked.filter(a => a.route === '/entry' && a.body.id === 'la bibliothèque')).toHaveLength(2)
  expect(await rows($)).toContain('Titre inventé · Un passage inventé.')
})

test('an empty /centre answer stops holding a passage-chosen centre for the passages', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.centre = async () => ({ by: 'meaning', passages: [hit(['le carnet'], 'Titre C'), hit(['le carnet'], 'Titre C2')] })
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(true)
  // The server now answers nothing: the next prompt's words take the centre.
  k.centre = async () => ({ by: 'meaning', passages: [] })
  await say($, disk, 'Parlons de la bibliothèque')
  await say($, disk, 'la bibliothèque encore')
  expect(await centreOf($, 'la bibliothèque')).toBe(true)
})

test('an answer naming no visible node stops holding a passage-chosen centre too', { options: SERVED }, async ($, on) => {
  const disk = world(on)
  const k = kid(on)
  await opened($, disk)
  k.centre = async () => ({ by: 'meaning', passages: [hit(['le carnet'], 'Titre C'), hit(['le carnet'], 'Titre C2')] })
  await say($, disk, 'rien de connu ici')
  expect(await centreOf($, 'le carnet')).toBe(true)
  // No word match and only hits outside the graph: an empty fused ranking.
  k.centre = async () => ({ by: 'meaning', passages: [hit(['hors du graphe'], 'Ailleurs')] })
  await say($, disk, 'rien encore')
  // The next answer never comes: the words move the centre on their own.
  k.centre = () => new Promise(() => undefined)
  await say($, disk, 'Parlons de la bibliothèque')
  expect(await centreOf($, 'la bibliothèque')).toBe(true)
})
