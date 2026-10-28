import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { capacity } from '../hooks/calligram'

// `claude plugin test` leaves nothing beneath `$.fs`, `$.process` or `$.env`:
// the test stands for the disk with the hooks below. Everything it holds is
// invented, because this folder is published.

const PORTRAIT = '/fake/portrait.md'
const PORTRAIT_ENV = PORTRAIT
const MEMOIRES = '/fake/memoires'
const CHECK = '/fake/check.sh'
const ETAT = '/fake/etat'
const OPTIONS = { portrait: PORTRAIT, memoires: MEMOIRES, check: CHECK, propositions: ETAT }

const PORTRAIT_TEXT = `# Portrait de test

## Points clés

- Premier point synthétique du portrait.
- Deuxième point, inventé pour les tests.
- Troisième point, sans rapport avec un vrai fait.

## Qui il est

Une personne imaginaire qui sert uniquement de fixture.
`

function commandRun(args = '', command = 'portrait') {
  return {
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  } as Parameters<Engine['command']['run']>[0]
}

const memory = (type: string, description: string) => `---\nname: x\ndescription: ${description}\ntype: ${type}\n---\nCorps.\n`
const at = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime()

type Disk = {
  files: Map<string, { text: string; mtimeMs: number }>
  runs: { argv: string[]; env: Record<string, string> | undefined }[]
  writes: { path: string; text: string }[]
  opens: string[]
  closes: string[]
  // What the panel mod beneath answers to /panel.
  panel: { text: string }
  // Every command name the mod registered, in order.
  registered: string[]
  exit: number
  // When set, the fake check exits 1 once the portrait reaches this many characters.
  limit: number | undefined
  // When true, every portrait write after the first fails, as a restore would.
  isRestoreBroken: boolean
  stats: number
  // How many times the mod asked which panes exist.
  panesAsked: number
  // When true, the open pane is listed but behind another tab: not shown.
  isCovered: boolean
  // The first line the fake check prints; the default states no size.
  checkLine: string | undefined
  // The clock the fill animation runs on: it moves only when a test advances it.
  clock: MockClock
}

// The day the clock starts on, for the 30-day series.
const NOW = at(3, 10)

function world(on: On, options: { isPortrait?: boolean } = {}): Disk {
  const disk: Disk = {
    files: new Map(),
    runs: [],
    writes: [],
    opens: [],
    closes: [],
    panel: { text: 'Panel opened.' },
    registered: [],
    exit: 0,
    limit: undefined,
    isRestoreBroken: false,
    stats: 0,
    panesAsked: 0,
    isCovered: false,
    checkLine: undefined,
    clock: mock.clock(on, { now: NOW }),
  }
  if (options.isPortrait !== false) disk.files.set(PORTRAIT, { text: PORTRAIT_TEXT, mtimeMs: at(1, 1) })
  disk.files.set(`${MEMOIRES}/alpha/memory/feedback_one.md`, { text: memory('feedback', 'Une règle de test sur les boutons'), mtimeMs: at(3, 3) })
  disk.files.set(`${MEMOIRES}/alpha/memory/project_two.md`, {
    text: memory('project', 'Un projet de test avec une description volontairement très longue pour dépasser la largeur du volet'),
    mtimeMs: at(2, 2),
  })
  disk.files.set(`${MEMOIRES}/beta/memory/user_three.md`, { text: memory('user', 'Une préférence de test'), mtimeMs: at(1, 1) })
  // The nested layout most real memories use: `type` sits under `metadata:`.
  disk.files.set(`${MEMOIRES}/beta/memory/reference_four.md`, {
    text: '---\nname: four\nmetadata:\n  type: reference\n  node_type: memory\ndescription: Une référence de test\n---\nCorps.\n',
    mtimeMs: at(2, 20),
  })
  disk.files.set(`${MEMOIRES}/beta/memory/MEMORY.md`, { text: '- index, must be ignored', mtimeMs: at(4, 4) })

  const children = (dir: string) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of disk.files.keys()) {
      if (!path.startsWith(dir + '/')) continue
      const rest = path.slice(dir.length + 1).split('/')
      names.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
    }

    return names
  }

  on('fs.exists', (_, e) => ({ value: disk.files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: disk.files.get(e.path)?.text ?? '' }))
  on('fs.stat', (_, e) => {
    disk.stats += 1
    const file = disk.files.get(e.path)
    if (file === undefined) throw new Error('ENOENT')

    return { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.list', (_, e) => {
    const names = children(e.path)
    if (names.size === 0) throw new Error('ENOENT')

    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.write', (_, e) => {
    if (disk.isRestoreBroken && e.path === PORTRAIT && disk.writes.some(w => w.path === PORTRAIT)) throw new Error('EACCES')
    disk.writes.push({ path: e.path, text: e.text })
    disk.files.set(e.path, { text: e.text, mtimeMs: at(5, 5) })

    return { value: undefined }
  })
  on('env.get', () => ({ value: '/fakehome' }))
  on('process.run', (_, e) => {
    disk.runs.push({ argv: [...e.argv], env: e.init?.env })
    const done = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    // `$.fs` has no delete: the mod removes a moved proposition with /bin/rm.
    if (e.argv[0] === '/bin/rm') {
      const path = e.argv.at(-1)!
      const isThere = disk.files.delete(path)

      return done(isThere ? 0 : 1, '')
    }
    const size = disk.files.get(PORTRAIT)?.text.length ?? 0
    const exit = disk.limit !== undefined && size >= disk.limit ? 1 : disk.exit

    return done(exit, `${disk.checkLine ?? `portrait-check: ${PORTRAIT} is fine`}\n`)
  })
  on('command.register', (_, e) => {
    disk.registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let isUp = false
  on('ui.panes', () => (disk.panesAsked += 1, {
    value: isUp ? [{ id: 'portrait', title: 'Portrait', isShown: !disk.isCovered, isFocused: false, isPlaced: true }] : [],
  }))
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

const pane = (bodyColumns: number) =>
  ({
    plugin: 'portrait',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'portrait',
    props: { title: 'Portrait', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

async function open($: Engine, args = ''): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun(args))
}

async function lines($: Engine, columns = 60): Promise<string[]> {
  const ui = await $.ui.mount(pane(columns))
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.map(t => t.text)
}

test('the pane starts at the first key point and leaves "Qui il est" out', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($)
  const out = await lines($)
  // The gauge or the verdict sits above; the key points start at the first bullet.
  expect(out.find(l => l.startsWith('- '))).toBe('- Premier point synthétique du portrait.')
  expect(out.join('\n')).toContain('Troisième point')
  expect(out.join('\n')).not.toContain('Qui il est')
})

test('/portrait tout shows the whole portrait', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'tout')
  expect((await lines($)).join('\n')).toContain('Qui il est')
})

test('a missing portrait gives one line, and the recent block and the footer stay', { options: OPTIONS }, async ($, on) => {
  world(on, { isPortrait: false })
  await open($)
  const out = (await lines($)).join('\n')
  expect(out).toContain('Pas de portrait : plan A, tâche A2')
  expect(out).toContain('Une règle de test')
  expect(out).toContain('Une préférence de test')
  expect(out).toContain('Un projet de test')
  expect(out).toContain('Une référence de test')
  expect(out).toContain('portrait-check: is fine')
})

test('recent memories run newest to oldest and MEMORY.md is not one', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  const out = (await lines($)).join('\n')
  expect(out.indexOf('2026-03-03')).toBeGreaterThan(-1)
  expect(out.indexOf('2026-03-03')).toBeLessThan(out.indexOf('2026-02-20'))
  expect(out.indexOf('2026-02-20')).toBeLessThan(out.indexOf('2026-02-02'))
  // `type` is found under `metadata:`, and `node_type:` is not taken for it.
  expect(out).toContain('reference')
  expect(out).not.toContain('memory Une')
  expect(out.indexOf('2026-02-02')).toBeLessThan(out.indexOf('2026-01-01'))
  expect(out).not.toContain('index, must be ignored')

  // Inverted control: the oldest file becomes the newest and rises to the top.
  disk.files.get(`${MEMOIRES}/beta/memory/user_three.md`)!.mtimeMs = at(4, 5)
  await $.command.run(commandRun(''))
  const again = (await lines($)).join('\n')
  expect(again.indexOf('2026-04-05')).toBeGreaterThan(-1)
  expect(again.indexOf('2026-04-05')).toBeLessThan(again.indexOf('2026-03-03'))
  expect(again).not.toContain('2026-01-01')
})

test('the footer is the check line without the portrait path, run once per command', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  for (const columns of [60, 40, 60]) expect((await lines($, columns)).at(-1)).toBe('portrait-check: is fine')
  expect(disk.runs).toEqual([{ argv: [CHECK], env: { PORTRAIT: PORTRAIT_ENV } }])
  const statted = disk.stats
  await lines($)
  expect(disk.stats).toBe(statted)
})

test('a second /portrait redraws without a second opening', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await $.command.run(commandRun('tout'))
  expect(disk.opens).toEqual(['portrait'])
  expect((await lines($)).join('\n')).toContain('Qui il est')
})

test('no line is longer than the pane at 40 columns', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($, 'tout')
  const out = await lines($, 40)
  expect(out.length).toBeGreaterThan(8)
  expect(out.some(l => l.includes('…'))).toBe(true)
  for (const line of out) expect(line.length).toBeLessThanOrEqual(40)
})

test('a default path with ~ is expanded from HOME', async ($, on) => {
  const disk = world(on)
  disk.files.set('/fakehome/.claude/portrait.md', { text: PORTRAIT_TEXT, mtimeMs: at(1, 1) })
  await open($)
  expect((await lines($)).find(l => l.startsWith('- '))).toBe('- Premier point synthétique du portrait.')
})

test('the footer colour follows the check exit code', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  const tones: unknown[] = []
  for (const exit of [0, 1, 2]) {
    disk.exit = exit
    await $.command.run(commandRun(''))
    const ui = await $.ui.mount(pane(60))
    const foot = await ui.find({ type: 'Text', text: /is fine/ })
    tones.push((foot as { props?: { color?: string } } | undefined)?.props?.color)
    await ui.unmount()
  }
  expect(tones).toEqual(['success', 'warning', 'error'])
})

// Propositions: every text below is invented.
const DATE = '2026-11-01'
const PROPOSAL = `${ETAT}/proposition-${DATE}.md`
const DONE = `${ETAT}/traitees/proposition-${DATE}.md`
const PROPOSAL_TEXT = [
  '1. [+] Un fait neuf inventé pour le test. — /fake/memoires/alpha/memory/feedback_one.md',
  '2. [~] ancien: Deuxième point, inventé pour les tests. | nouveau: Deuxième point, corrigé par le test. — /fake/memoires/beta/memory/user_three.md',
  '3. [-] - Troisième point, sans rapport avec un vrai fait. — /fake/memoires/alpha/memory/project_two.md',
  '',
].join('\n')

function withProposal(disk: Disk): void {
  disk.files.set(PROPOSAL, { text: PROPOSAL_TEXT, mtimeMs: at(4, 1) })
}

const portraitNow = (disk: Disk): string | undefined => disk.files.get(PORTRAIT)?.text

test('a pending proposition is listed between Farben and the footer', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  // A treated one stays out of the list.
  disk.files.set(`${ETAT}/traitees/proposition-2026-10-25.md`, { text: 'écartée\n1. [+] Déjà traitée. — x', mtimeMs: at(4, 1) })
  await open($)
  const out = await lines($)
  const joined = out.join('\n')
  expect(joined).toContain('Propositions')
  expect(joined).toContain(DATE)
  expect(joined).toContain('1. [+] Un fait neuf inventé')
  expect(joined).not.toContain('Déjà traitée')
  expect(joined.indexOf('Farben')).toBeLessThan(joined.indexOf('Propositions'))
  expect(out.at(-1)).toBe('portrait-check: is fine')
})

test('no pending proposition says so', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($)
  expect((await lines($)).join('\n')).toContain('aucune proposition')
})

test('applique writes the chosen lines, runs the check and moves the proposition', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  await open($)
  const reply = await $.command.run(commandRun(`applique ${DATE} 1 2 3`))
  const text = portraitNow(disk)!
  // `+` lands under a heading of its own at the end; the owner files it by hand.
  expect(text).toMatch(/\n## À ranger\n\n- Un fait neuf inventé pour le test\.\n$/)
  expect(text).toContain('- Deuxième point, corrigé par le test.')
  expect(text).not.toContain('Deuxième point, inventé pour les tests.')
  expect(text).not.toContain('Troisième point')
  expect(text).toContain('- Premier point synthétique du portrait.')
  expect(disk.runs.some(r => r.argv[0] === CHECK && r.env?.PORTRAIT === PORTRAIT)).toBe(true)
  expect(disk.files.has(PROPOSAL)).toBe(false)
  expect(disk.files.get(DONE)?.text).toBe(`appliquées: 1, 2, 3\n${PROPOSAL_TEXT}`)
  expect(JSON.stringify(reply)).toContain('appliquées')
  expect((await lines($)).join('\n')).toContain('aucune proposition')
})

test('applique of one number leaves the other lines out of the portrait', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  await open($)
  await $.command.run(commandRun(`applique ${DATE} 2`))
  const text = portraitNow(disk)!
  expect(text).toContain('corrigé par le test')
  expect(text).not.toContain('À ranger')
  expect(text).toContain('Troisième point')
  expect(disk.files.get(DONE)?.text.split('\n')[0]).toBe('appliquées: 2')
})

test('ecarte moves the proposition and leaves the portrait untouched', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  await open($)
  await $.command.run(commandRun(`ecarte ${DATE}`))
  expect(portraitNow(disk)).toBe(PORTRAIT_TEXT)
  expect(disk.writes.some(w => w.path === PORTRAIT)).toBe(false)
  expect(disk.files.has(PROPOSAL)).toBe(false)
  expect(disk.files.get(DONE)?.text).toBe(`écartée\n${PROPOSAL_TEXT}`)
})

test('an application that would cross the threshold is refused and reverted', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  // The portrait as it stands passes; one added line crosses the limit.
  disk.limit = PORTRAIT_TEXT.length + 5
  await open($)
  const reply = await $.command.run(commandRun(`applique ${DATE} 1`))
  expect(JSON.stringify(reply)).toContain('refusé : portrait au-dessus du seuil')
  // The over-limit text was written (the check reads the file), then the old one restored.
  expect(disk.writes.filter(w => w.path === PORTRAIT).map(w => w.text.length > PORTRAIT_TEXT.length)).toEqual([true, false])
  expect(portraitNow(disk)).toBe(PORTRAIT_TEXT)
  expect(disk.files.has(PROPOSAL)).toBe(true)
  expect(disk.files.has(DONE)).toBe(false)

  // Inverted control: under a higher limit the same application goes through.
  disk.limit = PORTRAIT_TEXT.length + 500
  await $.command.run(commandRun(`applique ${DATE} 1`))
  expect(portraitNow(disk)).toContain('À ranger')
  expect(disk.files.has(DONE)).toBe(true)
})

test('a line that no longer matches the portrait refuses the whole application', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  disk.files.set(PORTRAIT, { text: PORTRAIT_TEXT.replace('Deuxième point, inventé pour les tests.', 'Réécrit à la main.'), mtimeMs: at(1, 1) })
  const before = portraitNow(disk)
  await open($)
  const reply = await $.command.run(commandRun(`applique ${DATE} 1 2`))
  expect(JSON.stringify(reply)).toContain('introuvable')
  expect(portraitNow(disk)).toBe(before)
  expect(disk.writes.some(w => w.path === PORTRAIT)).toBe(false)
  expect(disk.files.has(PROPOSAL)).toBe(true)
})

test('applique with an unknown number or date writes nothing', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  await open($)
  expect(JSON.stringify(await $.command.run(commandRun(`applique ${DATE} 9`)))).toContain('9')
  expect(JSON.stringify(await $.command.run(commandRun('applique 2026-12-31 1')))).toContain('pas de proposition')
  expect(disk.writes).toEqual([])
  expect(disk.files.has(PROPOSAL)).toBe(true)
})

test('a ~ whose old passage appears twice is refused as ambiguous', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  const doubled = PORTRAIT_TEXT + '\n- Deuxième point, inventé pour les tests.\n'
  disk.files.set(PORTRAIT, { text: doubled, mtimeMs: at(1, 1) })
  await open($)
  const reply = await $.command.run(commandRun(`applique ${DATE} 2`))
  expect(JSON.stringify(reply)).toContain('refusé : ligne 2 ambiguë')
  expect(portraitNow(disk)).toBe(doubled)
  expect(disk.writes.some(w => w.path === PORTRAIT)).toBe(false)
  expect(disk.files.has(PROPOSAL)).toBe(true)
})

test('a proposition already copied to traitees is refused and no longer listed', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  // What a failed /bin/rm leaves: the copy under traitees/ and the original.
  disk.files.set(DONE, { text: `appliquées: 1\n${PROPOSAL_TEXT}`, mtimeMs: at(4, 2) })
  await open($)
  expect((await lines($)).join('\n')).toContain('aucune proposition')
  const reply = await $.command.run(commandRun(`applique ${DATE} 1`))
  expect(JSON.stringify(reply)).toContain('déjà traitée')
  expect(portraitNow(disk)).toBe(PORTRAIT_TEXT)
  expect(disk.writes).toEqual([])
  expect(JSON.stringify(await $.command.run(commandRun(`ecarte ${DATE}`)))).toContain('déjà traitée')
  expect(disk.files.get(DONE)?.text.split('\n')[0]).toBe('appliquées: 1')
})

test('a restore that fails says the portrait is left over the threshold', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  disk.limit = PORTRAIT_TEXT.length + 5
  disk.isRestoreBroken = true
  await open($)
  const reply = await $.command.run(commandRun(`applique ${DATE} 1`))
  expect(JSON.stringify(reply)).toContain('restauration impossible : portrait au-dessus du seuil')
  expect(disk.files.has(PROPOSAL)).toBe(true)
})

// The alias: an invented name, since this folder is published. The owner's real
// alias lives in settings.json, which is not.
const ALIAS = 'raccourci'

test('without an alias only /portrait is registered', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  expect(disk.registered).toEqual(['portrait'])
})

test('an alias is registered beside /portrait and answers the same way', { options: { ...OPTIONS, alias: ALIAS } }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(disk.registered).toEqual(['portrait', ALIAS])
  await $.command.run(commandRun('', ALIAS))
  expect(disk.opens).toEqual(['portrait'])
  const out = (await lines($)).join('\n')
  expect(out).toContain('- Premier point synthétique du portrait.')
  // The usage line repeats the name the owner typed.
  expect(out).toContain(`/${ALIAS} applique ${DATE}`)
  const reply = await $.command.run(commandRun('applique', ALIAS))
  expect(JSON.stringify(reply)).toContain(`usage : /${ALIAS} applique`)
})

test('an alias equal to the command, or written with its slash, registers no duplicate', { options: { ...OPTIONS, alias: '/portrait' } }, async ($, on) => {
  const disk = world(on)
  await open($)
  expect(disk.registered).toEqual(['portrait'])
})

// The calligram, Farben, the 30-day series and the remembered pane. Every
// path and number below is invented.
const CHECK_LINE = (n: number) => `portrait-check: ${PORTRAIT} is ${n} characters (threshold 4000)`
const HEAT = { calm: '#3fae7a', warm: '#d9a521', hot: '#e0592f' }

type Node = { text: string; props?: { color?: string; dimColor?: boolean } }

// The Text nodes of the pane as drawn now, with their colours.
async function drawn($: Engine, columns = 60): Promise<Node[]> {
  const ui = await $.ui.mount(pane(columns))
  const found = (await ui.findAll({ type: 'Text' })) as Node[]
  await ui.unmount()

  return found
}

// The summary line under the bust, found by its words.
const summary = (nodes: Node[]): Node | undefined => nodes.find(n => n.text.includes(' caractères · '))
// The gauge line of a pane too narrow for the bust.
const gauge = (nodes: Node[]): Node | undefined => nodes.find(n => n.text.startsWith('Taille '))
// The free cells of the bust: the dim runs of '░'. A row as a whole carries no
// dimColor, so no cell is counted twice.
const free = (nodes: Node[]): number => nodes.filter(n => n.props?.dimColor === true && /^░+$/.test(n.text)).reduce((sum, n) => sum + n.text.length, 0)
// The squares of Farben as colours, in order: the first rows of squares alone,
// not the squares in front of the legend's names.
const squares = (nodes: Node[], count: number): (string | undefined)[] =>
  nodes
    .filter(n => n.props?.color !== undefined && /^■+$/.test(n.text))
    .flatMap(n => [...n.text].map(() => n.props?.color))
    .slice(0, count)

test('the summary states the size against the threshold, and the letters take the colour of its heat', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await disk.clock.advance(2000)
  const colours: (string | undefined)[] = []
  const said: (string | undefined)[] = []
  for (const n of [1000, 3500, 3996]) {
    disk.checkLine = CHECK_LINE(n)
    await $.command.run(commandRun(''))
    await disk.clock.advance(2000)
    const nodes = await drawn($)
    said.push(summary(nodes)?.text)
    colours.push(nodes.find(x => Object.values(HEAT).includes(x.props?.color ?? ''))?.props?.color)
  }
  expect(said).toEqual(['1000 / 4000 caractères · 25 %', '3500 / 4000 caractères · 88 %', '3996 / 4000 caractères · 100 %'])
  expect(colours).toEqual([HEAT.calm, HEAT.warm, HEAT.hot])
})

test('a check line that states no size falls back to the coloured verdict line on top', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  await open($)
  await disk.clock.advance(2000)
  const first = (await drawn($))[0]!
  expect(first.text).toBe('portrait-check: is fine')
  expect(first.props?.color).toBe('success')
  expect(summary(await drawn($))).toBeUndefined()
  // Inverted control: a size in the line brings the bust and takes the top line.
  disk.checkLine = CHECK_LINE(1000)
  await $.command.run(commandRun(''))
  expect(summary(await drawn($))).toBeDefined()
  // A threshold of zero is no bust either.
  disk.checkLine = `portrait-check: ${PORTRAIT} is 10 characters (threshold 0)`
  await $.command.run(commandRun(''))
  expect(summary(await drawn($))).toBeUndefined()
})

test('a size in the check line drops the verdict footer it would repeat', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.checkLine = CHECK_LINE(1000)
  await open($)
  await disk.clock.advance(2000)
  const nodes = await drawn($)
  expect(nodes.some(n => n.text.startsWith('portrait-check'))).toBe(false)
  // The pane ends on the propositions section.
  expect(nodes.at(-1)!.text).toBe('aucune proposition')
})

test('below 30 columns the bust gives way to the gauge line', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.checkLine = CHECK_LINE(2000)
  await open($)
  await disk.clock.advance(2000)
  expect(gauge(await drawn($, 30))).toBeUndefined()
  const narrow = await drawn($, 29)
  expect(gauge(narrow)?.text).toBe('Taille ' + narrow.find(n => n.text.startsWith('Taille '))!.text.slice('Taille '.length))
  expect(gauge(narrow)?.text).toContain('2000 / 4000 car.')
  expect(summary(narrow)).toBeUndefined()
  for (const n of narrow) expect(n.text.length).toBeLessThanOrEqual(29)
})

test('the bust fills in from empty over about a second, then rests', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.checkLine = CHECK_LINE(2000)
  await open($)
  const cells = capacity(60)
  expect(free(await drawn($))).toBe(cells)
  await disk.clock.advance(125)
  const early = free(await drawn($))
  expect(early).toBeLessThan(cells)
  await disk.clock.advance(1000)
  const done = free(await drawn($))
  expect(done).toBe(cells - Math.round(cells / 2))
  expect(done).toBeLessThan(early)
  // At rest it no longer moves.
  await disk.clock.advance(2000)
  expect(free(await drawn($))).toBe(done)
  // A new run plays it again from empty.
  await $.command.run(commandRun(''))
  expect(free(await drawn($))).toBe(cells)
})

test('Farben counts every memory by type, not only the eight shown', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  for (let i = 0; i < 9; i++) disk.files.set(`${MEMOIRES}/gamma/memory/project_old${i}.md`, { text: memory('project', `Ancien ${i}`), mtimeMs: at(1, 2) })
  disk.files.set(`${MEMOIRES}/gamma/memory/odd.md`, { text: memory('bizarre', 'Sans type connu'), mtimeMs: at(1, 2) })
  disk.files.set(`${MEMOIRES}/gamma/memory/bare.md`, { text: 'pas de front matter', mtimeMs: at(1, 2) })
  await open($)
  await disk.clock.advance(2000)
  const nodes = await drawn($, 80)
  // 1 feedback, 1 + 9 project, 1 user, 1 reference, 2 of no known type.
  expect(nodes.some(n => n.text === '■ feedback 1  ■ projet 10  ■ utilisateur 1  ■ référence 1  ■ autre 2')).toBe(true)
  expect(nodes.some(n => n.text.startsWith('── Farben · 15 souvenirs'))).toBe(true)
  // Oldest first: the 1 January user memory, then the 2 January ones, and the
  // newest three last, in date order.
  const hues = squares(nodes, 15)
  expect(hues).toHaveLength(15)
  expect(hues[0]).toBe('#8a7fc9')
  expect(hues.slice(-3)).toEqual(['#4a90c8', '#8a8f98', '#d4825a'])
  expect(hues.slice(1, 12).filter(h => h === '#4a90c8')).toHaveLength(9)
  expect(hues.slice(1, 12).filter(h => h === '#b5a05a')).toHaveLength(2)
})

test('a narrow pane wraps Farben and its legend and drops no type', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  for (let i = 0; i < 40; i++) disk.files.set(`${MEMOIRES}/gamma/memory/project_old${i}.md`, { text: memory('project', `Ancien ${i}`), mtimeMs: at(1, 2) })
  await open($)
  await disk.clock.advance(2000)
  const nodes = await drawn($, 30)
  const text = nodes.map(n => n.text).join('\n')
  for (const word of ['feedback 1', 'projet 41', 'utilisateur 1', 'référence 1']) expect(text).toContain(word)
  expect(nodes.filter(n => /^■+$/.test(n.text) && n.props?.color === undefined).map(n => n.text.length)).toEqual([30, 14])
  for (const n of nodes) expect(n.text.length).toBeLessThanOrEqual(30)
})

// Pending propositions reach Farben, and the bust draws what they would add.
test('pending items add hollow squares to Farben, and a portrait they shrink draws no ghost cell', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  disk.checkLine = CHECK_LINE(1000)
  await open($)
  await disk.clock.advance(2000)
  const nodes = await drawn($)
  // What the three items make of the portrait, worked out by hand.
  const after =
    PORTRAIT_TEXT.replace('inventé pour les tests.', 'corrigé par le test.')
      .replace('- Troisième point, sans rapport avec un vrai fait.\n', '')
      .replace(/\n+$/, '') + '\n\n## À ranger\n\n- Un fait neuf inventé pour le test.\n'
  const projected = 1000 + after.length - PORTRAIT_TEXT.length
  expect(summary(nodes)?.text).toBe(`1000 / 4000 caractères · 25 % · ${projected} après propositions`)
  expect(nodes.some(n => n.text === '□□□' && n.props?.dimColor === true)).toBe(true)
  expect(nodes.some(n => n.text === '□ 3 propositions en attente')).toBe(true)
  // The items leave the portrait smaller than it is: nothing is added to draw.
  expect(projected).toBeLessThan(1000)
  expect(nodes.some(n => n.text === '▌')).toBe(false)
  // The projection is what an application really does to the portrait.
  await $.command.run(commandRun(`applique ${DATE} 1 2 3`))
  expect(portraitNow(disk)).toBe(after)
})

test('when an item no longer matches, the projected size is the estimate', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.files.set(PROPOSAL, {
    text: ['1. [+] Un fait neuf nettement plus long que la ligne retirée. — x', '2. [-] - Ligne absente du portrait. — y', ''].join('\n'),
    mtimeMs: at(4, 1),
  })
  disk.checkLine = CHECK_LINE(1000)
  await open($)
  await disk.clock.advance(2000)
  const delta = '- Un fait neuf nettement plus long que la ligne retirée.'.length + 1 - ('- Ligne absente du portrait.'.length + 1)
  const nodes = await drawn($)
  expect(summary(nodes)?.text).toBe(`1000 / 4000 caractères · 25 % · ${1000 + delta} après propositions`)
  // A cursor at the current end, then the added text as dim letters.
  const cells = capacity(60)
  const ghost = Math.round(((1000 + delta) / 4000) * cells) - Math.round(0.25 * cells)
  expect(ghost).toBeGreaterThan(0)
  expect(nodes.filter(n => n.text === '▌')).toHaveLength(1)
  const dim = nodes.filter(n => n.props?.dimColor === true && /^\S+$/.test(n.text) && !/^[░□■]+$/.test(n.text))
  expect(dim.map(n => n.text).join('')).toBe('Un·fait·neuf·nettement·plus·long·que·la·ligne·retirée.'.slice(0, ghost))
})

test('no line is wider than the pane at 30, 40 and 60 columns, with proposals and many memories', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  withProposal(disk)
  for (let i = 0; i < 70; i++) disk.files.set(`${MEMOIRES}/gamma/memory/user_old${i}.md`, { text: memory(i % 2 === 0 ? 'user' : 'feedback', `Ancien ${i}`), mtimeMs: at(1, 2) })
  disk.checkLine = CHECK_LINE(3996)
  await open($)
  await disk.clock.advance(2000)
  for (const columns of [30, 40, 60]) {
    const nodes = await drawn($, columns)
    expect(summary(nodes)).toBeDefined()
    for (const n of nodes) expect(n.text.length).toBeLessThanOrEqual(columns)
  }
})

test('the 30-day series counts memory files per calendar day, today last', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  // Today is 10 March: 3 March is 7 days back, 20 February 18 back; 2 February and 1 January fall outside.
  // 9 February is the 29th day back, the first cell; 8 February is the 30th, out. 20 March is the future, out.
  disk.files.set(`${MEMOIRES}/gamma/memory/edge_in.md`, { text: memory('user', 'Au bord, dedans'), mtimeMs: at(2, 9) })
  disk.files.set(`${MEMOIRES}/gamma/memory/edge_out.md`, { text: memory('user', 'Au bord, dehors'), mtimeMs: at(2, 8) })
  disk.files.set(`${MEMOIRES}/gamma/memory/future.md`, { text: memory('user', 'Datée du futur'), mtimeMs: at(3, 20) })
  disk.files.set(`${MEMOIRES}/gamma/memory/today_a.md`, { text: memory('user', 'Aujourd hui A'), mtimeMs: at(3, 10) })
  disk.files.set(`${MEMOIRES}/gamma/memory/today_b.md`, { text: memory('user', 'Aujourd hui B'), mtimeMs: at(3, 10) })
  await open($)
  const nodes = await drawn($)
  const days = Array.from({ length: 30 }, () => 0)
  days[0] = 1
  days[11] = 1
  days[22] = 1
  days[29] = 2
  // The scale is the busiest day (2), so a single file sits at the middle-high level.
  const expected = days.map(n => (n === 0 ? '▁' : n === 2 ? '█' : '▅')).join('') + ' 5 fichiers modifiés'
  expect(nodes.some(n => n.text === expected)).toBe(true)
  expect(nodes.some(n => n.text.startsWith('── Activité · 30 derniers jours'))).toBe(true)
})

test('the total goes under the series and the heading shortens in a narrow pane, all within it', { options: OPTIONS }, async ($, on) => {
  world(on)
  await open($)
  const nodes = await drawn($, 30)
  expect(nodes.some(n => n.text === '2 fichiers modifiés')).toBe(true)
  expect(nodes.some(n => n.text.startsWith('── Activité · 30 jours'))).toBe(true)
  for (const columns of [24, 30]) for (const n of await drawn($, columns)) expect(n.text.length).toBeLessThanOrEqual(columns)
})

// The reopening at session start is detached from the session, so a test waits
// for it to land.
const settleStart = (disk: Disk): Promise<void> => disk.clock.advance(1)

// The kit cannot raise `ui.close` (a test's `$.ui.close` is refused and the
// engine stamps `person` on its own close mark alone), so the forgetting on a
// close by the person is the one path these tests do not reach.
test('the pane is remembered once /portrait has opened it', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  mock.store(on)
  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start()
  expect(disk.opens).toEqual([])
  await $.command.run(commandRun(''))
  expect(disk.opens).toEqual(['portrait'])
  await start()
  await settleStart(disk)
  expect(disk.opens).toEqual(['portrait', 'portrait'])
})

test('a remembered pane reopens unasked at session start, snapshot first', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  mock.store(on, { paneOpen: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settleStart(disk)
  expect(disk.opens).toEqual(['portrait'])
  // Drawn at once, with no /portrait run in between.
  expect((await lines($)).join('\n')).toContain('Premier point synthétique')
})

test('a pane nobody remembered stays closed at session start', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(disk.opens).toEqual([])
})

test('the panel answer opens, then closes, this tab', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun('', 'panel'))
  disk.panel.text = 'Panel closed.'
  await $.command.run(commandRun('', 'panel'))
  expect(disk.opens).toEqual(['portrait'])
  expect(disk.closes).toEqual(['portrait'])
})

// Regression: review fix — session.start no longer waits on the disk reads of
// the reopening: next(e) answers first.
test('session.start answers before a remembered pane has been read and opened', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  mock.store(on, { paneOpen: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(disk.opens).toEqual([])
  await settleStart(disk)
  expect(disk.opens).toEqual(['portrait'])
})

// Regression: review fix — the 125 ms timer is cancelled once the fill is full,
// and a new replay cancels the previous one.
test('the frame timer stops once the fill is full and a new run starts one timer', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.checkLine = CHECK_LINE(2000)
  await open($)
  await disk.clock.advance(2000)
  const settled = disk.panesAsked
  await disk.clock.advance(5000)
  expect(disk.panesAsked).toBe(settled)
  await $.command.run(commandRun(''))
  await $.command.run(commandRun(''))
  const before = disk.panesAsked
  await disk.clock.advance(125)
  // One frame per tick, not one per run.
  expect(disk.panesAsked - before).toBeLessThanOrEqual(1)
})

// Regression: (uncommitted) — fill timer kept firing while the pane was hidden
test('a pane opened behind another tab runs no timer, and shows the fill landed when it comes forward', { options: OPTIONS }, async ($, on) => {
  const disk = world(on)
  disk.checkLine = CHECK_LINE(2000)
  disk.isCovered = true
  await open($)
  // One frame finds the pane hidden and ends the animation there.
  await disk.clock.advance(125)
  const settled = disk.panesAsked
  await disk.clock.advance(5000)
  expect(disk.panesAsked).toBe(settled)
  // Nothing plays later: shown at last, the fill is already full.
  disk.isCovered = false
  expect(free(await drawn($))).toBe(capacity(60) - Math.round(capacity(60) / 2))
})
