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

function world(on: On, options: { isGraphe?: boolean; isJournal?: boolean; store?: Record<string, unknown> } = {}): Disk {
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

    return { value: { isPlaced: true as const } }
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
