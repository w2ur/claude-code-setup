import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { dessiner } from '../hooks/draw'
import { placer, seedOf, sousGraphe } from '../hooks/layout'
import { register } from '../hooks/register'
import { GRAPHE, JOURNAL } from './fixture'

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
  closes: string[]
  // What the panel mod beneath answers to /panel.
  panel: { text: string }
  clock: ReturnType<typeof mock.clock>
  // Whether the open pane is the one shown, or a tab behind another.
  isShown: boolean
  panesAsked: number
  store: Map<string, unknown>
}

function world(on: On, options: { isGraphe?: boolean; isJournal?: boolean; store?: Record<string, unknown> } = {}): Disk {
  const disk: Disk = { files: new Map(), unreadable: new Set(), reads: 0, opens: [], closes: [], panel: { text: 'Panel opened.' }, clock: mock.clock(on), isShown: true, panesAsked: 0, store: new Map(Object.entries(options.store ?? {})) }
  on('store.get', (_, e) => ({ value: disk.store.get(e.key) }))
  on('store.set', (_, e) => {
    disk.store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    disk.store.delete(e.key)

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
