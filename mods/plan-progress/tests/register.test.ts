import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeFs } from './fakeFs'
import type { FakeFile } from './fakeFs'

const HOME = '/home/w'
const CONFIG = `${HOME}/.claude`
const DEV = `${HOME}/Dev`
const NOW = 1_000_000_000

const PLAN_A = `# Alpha Implementation Plan\n\n### Task 1: One\n### Task 2: Two\n### Task 3: Three\n`
const PLAN_B = `# Beta Implementation Plan\n\n### Task 1: Uno\n### Task 2: Dos\n`

const PANE = {
  plugin: 'plan-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'plans',
  props: { title: 'Plans', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const ledger = (plan: string, ...done: string[]): string => `# SDD ledger — plan: ${plan}\n${done.map(id => `Task ${id}: complete`).join('\n')}\n`

type Shell = { shown: { value: boolean }; opens: string[]; closes: string[]; panel: { text: string }; stored: Map<string, unknown>; clock: ReturnType<typeof mock.clock> }

function world(on: On, files: Map<string, FakeFile>, failing = new Set<string>(), hold?: () => Promise<void>, configEnv?: string): Shell & { lists: () => string[]; reads: () => string[] } {
  on('command.register', () => ({ value: { command: 'plans' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : e.name === 'CLAUDE_CONFIG_DIR' ? configEnv : undefined }))
  const clock = mock.clock(on, { now: NOW })
  const shell = { shown: { value: false }, opens: [] as string[], closes: [] as string[], panel: { text: 'Panel opened.' }, stored: new Map<string, unknown>(), clock }
  on('command.run', { command: 'panel' }, () => ({ text: shell.panel.text }))
  on('ui.panes', () => ({ value: [{ id: 'plans', title: 'Plans', isShown: shell.shown.value, isFocused: false, isPlaced: true }] }))
  on('ui.open', (_, e) => {
    shell.opens.push(e.id)
    shell.shown.value = true

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    shell.closes.push(e.id)
    shell.shown.value = false

    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: shell.stored.get(e.key) }))
  on('store.set', (_, e) => {
    shell.stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    shell.stored.delete(e.key)

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return Box({})
  })
  const fs = fakeFs(on, files, failing, hold)

  return { ...shell, lists: fs.lists, reads: fs.reads }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

async function paneText($: Engine): Promise<string> {
  const ui = await $.ui.mount(PANE)
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return texts.map(t => t.text).join('|')
}

function commandRun(command: string, args = '') {
  return { command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as Parameters<Engine['command']['run']>[0]
}

function files(): Map<string, FakeFile> {
  return new Map<string, FakeFile>([
    [`${CONFIG}/plans/2026-11-01-alpha.md`, { text: PLAN_A, mtimeMs: 1 }],
    [`${CONFIG}/plans/sub/2026-11-02-beta.md`, { text: PLAN_B, mtimeMs: 1 }],
    [`${CONFIG}/plans/archive/old.md`, { text: PLAN_A, mtimeMs: 1 }],
    [`${DEV}/my-editor-app/.superpowers/sdd/x/progress.md`, { text: ledger(`${CONFIG}/plans/2026-11-01-alpha.md`, '1'), mtimeMs: NOW - 60_000 }],
    [`${DEV}/my-editor-app/.worktrees/feat/.superpowers/sdd/y/progress.md`, { text: ledger(`${CONFIG}/plans/sub/2026-11-02-beta.md`, '1'), mtimeMs: NOW - 120_000 }],
  ])
}

test('a hidden pane polls nothing', async ($, on) => {
  const w = world(on, files())
  await startSession($)
  await w.clock.advance(20_000)
  expect(w.lists()).toEqual([])
})

test('a shown pane finds the ledgers of a repo and of its worktree', async ($, on) => {
  const w = world(on, files())
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  const t = await paneText($)
  expect(t).toContain('Alpha')
  expect(t).toContain('Beta')
  expect(t).toContain('1/3')
  expect(t).toContain('1/2')
  expect(w.lists()).toContain(`${DEV}/my-editor-app/.superpowers/sdd`)
  expect(w.lists()).toContain(`${DEV}/my-editor-app/.worktrees/feat/.superpowers/sdd`)
  expect(w.lists().some(p => p.includes('archive'))).toBe(false)
})

// Regression: worktrees living anywhere (e.g. ~/.claude-wt/<name>) are found through
// <root>/.git/worktrees/*/gitdir, as the real ~/.claude/.git/worktrees/session-watch/gitdir shows.
test('a worktree outside the repo is found through the repo git metadata', async ($, on) => {
  const f = files()
  f.set(`${CONFIG}/.git/worktrees/session-watch/gitdir`, { text: `${HOME}/.claude-wt/session-watch/.git\n`, mtimeMs: 1 })
  f.set(`${HOME}/.claude-wt/session-watch/.superpowers/sdd/z/progress.md`, { text: ledger(`${CONFIG}/plans/sub/2026-11-02-beta.md`, '1'), mtimeMs: NOW - 1_000 })
  f.set(`${DEV}/my-editor-app/.git/worktrees/odd/gitdir`, { text: `${HOME}/elsewhere/odd/.git\n`, mtimeMs: 1 })
  f.set(`${HOME}/elsewhere/odd/.superpowers/sdd/q/progress.md`, { text: ledger(`${CONFIG}/plans/2026-11-01-alpha.md`, '1', '2'), mtimeMs: NOW - 1_000 })
  const w = world(on, f)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  const t = await paneText($)
  expect(w.lists()).toContain(`${HOME}/.claude-wt/session-watch/.superpowers/sdd`)
  expect(t).toContain('1/2')
  expect(t).toContain('2/3')
  // repo labels (fix 4): the worktree shows its main repo; the config dir shows ~/.claude
  expect(t).toContain('~/.claude')
  expect(t).toContain('my-editor-app')
  expect(t).not.toContain('session-watch')
  expect(t).not.toContain('odd')
})

// Regression: a symlinked progress.md lists with mtimeMs 0 and must not be read as a ledger.
test('a progress.md that is a symlink is ignored', async ($, on) => {
  const f = files()
  f.set(`${DEV}/my-editor-app/.superpowers/sdd/x/progress.md`, { text: ledger(`${CONFIG}/plans/2026-11-01-alpha.md`, '1'), mtimeMs: NOW, isLink: true })
  const w = world(on, f)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  expect(await paneText($)).not.toContain('Alpha')
})

test('a read that rejects for one ledger leaves the other plan in the pane', async ($, on) => {
  const w = world(on, files(), new Set([`${DEV}/my-editor-app/.superpowers/sdd/x/progress.md`]))
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  const t = await paneText($)
  expect(t).not.toContain('Alpha')
  expect(t).toContain('Beta')
})

test('the age keeps moving on every shown poll', async ($, on) => {
  const w = world(on, files())
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  const before = w.lists().length
  await w.clock.advance(5_000)
  expect(w.lists().length).toBeGreaterThan(before)
})

test('/plans opens the tab and remembers it', async ($, on) => {
  const w = world(on, files())
  await startSession($)
  const answer = await $.command.run(commandRun('plans'))
  expect(w.opens).toContain('plans')
  expect(answer.text).toBe('Plans tab opened.')
  expect(w.stored.get('paneOpen')).toBe(true)
})

test('/panel opens the tab when it opens and closes it when it closes', async ($, on) => {
  const w = world(on, files())
  await startSession($)
  await $.command.run(commandRun('panel'))
  expect(w.opens).toContain('plans')
  w.panel.text = 'Panel closed.'
  await $.command.run(commandRun('panel'))
  expect(w.closes).toContain('plans')
  expect(w.stored.get('paneOpen')).toBe(false)
})

test('a pane the person left open comes back with the session', async ($, on) => {
  const w = world(on, files())
  w.stored.set('paneOpen', true)
  await startSession($)
  expect(w.opens).toContain('plans')
})

const planReads = (w: { reads: () => string[] }): string[] => w.reads().filter(p => p.startsWith(`${CONFIG}/plans/`))

test('an unchanged plan is not read again; a plan no ledger names is never read', async ($, on) => {
  const f = files()
  f.set(`${CONFIG}/plans/unnamed.md`, { text: PLAN_A, mtimeMs: 1 })
  const w = world(on, f)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  const first = planReads(w)
  expect(first).toHaveLength(2)
  expect(first.some(p => p.endsWith('unnamed.md'))).toBe(false)
  await w.clock.advance(5_000)
  expect(planReads(w)).toHaveLength(2)
})

test('a changed mtime re-reads that one plan', async ($, on) => {
  const f = files()
  const w = world(on, f)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  f.set(`${CONFIG}/plans/2026-11-01-alpha.md`, { text: PLAN_A, mtimeMs: 2 })
  await w.clock.advance(5_000)
  const reads = planReads(w).filter(p => p.endsWith('2026-11-01-alpha.md'))
  expect(reads).toHaveLength(2)
  expect(planReads(w).filter(p => p.endsWith('2026-11-02-beta.md'))).toHaveLength(1)
})

test('a poll started while one is in flight does nothing', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let isHeld = true
  const w = world(on, files(), new Set(), () => (isHeld ? gate : Promise.resolve()))
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  await w.clock.advance(5_000)
  expect(w.lists()).toHaveLength(1)
  isHeld = false
  release()
  await w.clock.advance(5_000)
  expect(w.lists().length).toBeGreaterThan(1)
})

test('a failing list of the plans dir keeps the last views', async ($, on) => {
  const failing = new Set<string>()
  const w = world(on, files(), failing)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  expect(await paneText($)).toContain('Alpha')
  failing.add(`${CONFIG}/plans`)
  await w.clock.advance(5_000)
  expect(await paneText($)).toContain('Alpha')
})

test('a failing list of the dev dir keeps the last views', async ($, on) => {
  const failing = new Set<string>()
  const w = world(on, files(), failing)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  failing.add(DEV)
  await w.clock.advance(5_000)
  expect(await paneText($)).toContain('Alpha')
})

const progressReads = (w: { reads: () => string[] }): string[] => w.reads().filter(p => p.endsWith('/progress.md'))

// Regression: 76aa678 — every 5 s poll re-read and re-parsed every ledger and re-listed ~/Dev.
test('an unchanged ledger is not read again; a changed mtime re-reads that one', async ($, on) => {
  const f = files()
  const w = world(on, f)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  await w.clock.advance(5_000)
  await w.clock.advance(5_000)
  expect(progressReads(w)).toHaveLength(2)
  f.set(`${DEV}/my-editor-app/.superpowers/sdd/x/progress.md`, { text: ledger(`${CONFIG}/plans/2026-11-01-alpha.md`, '1', '2'), mtimeMs: NOW - 1_000 })
  await w.clock.advance(5_000)
  expect(progressReads(w).filter(p => p.includes('/my-editor-app/.superpowers/'))).toHaveLength(2)
  expect(progressReads(w).filter(p => p.includes('/.worktrees/'))).toHaveLength(1)
  expect(await paneText($)).toContain('2/3')
})

test('the root list is not rebuilt within 60 s, and is after', async ($, on) => {
  const w = world(on, files())
  await startSession($)
  w.shown.value = true
  const devLists = (): number => w.lists().filter(p => p === DEV).length
  await w.clock.advance(5_000)
  expect(devLists()).toBe(1)
  await w.clock.advance(50_000)
  expect(devLists()).toBe(1)
  await w.clock.advance(15_000)
  expect(devLists()).toBe(2)
})

// Regression: 76aa678 — CLAUDE_CONFIG_DIR with a trailing slash built `//plans` paths the engine does not find.
test('a config dir with a trailing slash still finds the plans', async ($, on) => {
  const w = world(on, files(), new Set(), undefined, `${CONFIG}/`)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  const t = await paneText($)
  expect(t).toContain('Alpha')
  expect(t).toContain('Beta')
})

// Regression: 76aa678 — a worktree listed before its main repo kept the unlabelled add and showed its own folder name.
test('a worktree label does not depend on listing order', async ($, on) => {
  const f = new Map<string, FakeFile>([
    [`${CONFIG}/plans/2026-11-01-alpha.md`, { text: PLAN_A, mtimeMs: 1 }],
    [`${DEV}/app-next/.superpowers/sdd/x/progress.md`, { text: ledger(`${CONFIG}/plans/2026-11-01-alpha.md`, '1'), mtimeMs: NOW - 1_000 }],
    [`${DEV}/zeta/.git/worktrees/next/gitdir`, { text: `${DEV}/app-next/.git\n`, mtimeMs: 1 }],
  ])
  const w = world(on, f)
  await startSession($)
  w.shown.value = true
  await w.clock.advance(5_000)
  const t = await paneText($)
  expect(t).toContain('zeta')
  expect(t).not.toContain('app-next')
})
