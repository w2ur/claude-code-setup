import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ContextCategory, On } from 'claude-code'

const PANE = {
  plugin: 'context-bar',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'context',
  props: {
    title: 'Context',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'context-bar',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const CATEGORIES: ContextCategory[] = [
  { name: 'System prompt', kind: 'used', tokens: 6000, color: '#3366cc', isDeferred: false },
  { name: 'Messages', kind: 'used', tokens: 30_000, color: '#cc6633', isDeferred: false },
  { name: 'Free space', kind: 'free', tokens: 64_000, color: '#888888', isDeferred: false },
]

// The lists a breakdown carries beside its categories, as the engine words them.
const MCP_CATEGORIES: ContextCategory[] = [
  { name: 'System prompt', kind: 'used', tokens: 6000, color: '#3366cc', isDeferred: false },
  { name: 'MCP tools', kind: 'used', tokens: 7000, color: '#33cc66', isDeferred: false },
  { name: 'Memory files', kind: 'used', tokens: 3000, color: '#cc3366', isDeferred: false },
  { name: 'Messages', kind: 'used', tokens: 20_000, color: '#cc6633', isDeferred: false },
  { name: 'Free space', kind: 'free', tokens: 47_000, color: '#888888', isDeferred: false },
  { name: 'Autocompact buffer', kind: 'buffer', tokens: 17_000, color: '#777777', isDeferred: false },
]
const LISTS = {
  mcpTools: [
    { name: 'mcp__github__pr', serverName: 'github', tokens: 1500, isLoaded: true },
    { name: 'mcp__github__issue', serverName: 'github', tokens: 2500, isLoaded: true },
    { name: 'mcp__linear__create', serverName: 'linear', tokens: 3000, isLoaded: true },
    { name: 'mcp__unloaded__x', serverName: 'unloaded', tokens: 9000, isLoaded: false },
  ],
  memoryFiles: [{ path: '/home/{username}/CLAUDE.md', type: 'User', tokens: 3000 }],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 83_000,
}

type Shell = { isShown: boolean; isPlaced: boolean; opens: string[]; closes: string[]; clock: ReturnType<typeof mock.clock> }

// What sits beneath the plugin: a clock, a store, a surface that places panes,
// and a context measurement at 36%.
function world(on: On, options: { used?: () => number; categories?: ContextCategory[]; extra?: object } = {}): Shell {
  const used = options.used ?? (() => 36_000)
  const shell: Shell = { isShown: false, isPlaced: true, opens: [], closes: [], clock: mock.clock(on, { now: 1_000_000 }) }
  let isPanelOn = false
  on('command.run', { command: 'panel' }, () => {
    isPanelOn = !isPanelOn

    return { text: isPanelOn ? 'Panel opened.' : 'Panel closed.' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.store(on)
  on('ui.panes', () => ({
    value: shell.isShown ? [{ id: 'context', title: 'Context', isShown: true, isFocused: false, isPlaced: shell.isPlaced }] : [],
  }))
  on('ui.open', (_, e) => {
    shell.opens.push(e.id)
    shell.isShown = true

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    shell.closes.push(e.id)
    shell.isShown = false

    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 100_000,
        tokens: used(),
        percent: 36,
        breakdown: {
          categories: options.categories ?? CATEGORIES,
          totalTokens: used(),
          rawMaxTokens: 100_000,
          percentage: used() / 1000,
          ...options.extra,
        } as never,
      },
      rateLimits: [],
    },
  }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return Box({})
  })

  return shell
}

function commandRun() {
  return {
    command: 'panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  } as Parameters<Engine['command']['run']>[0]
}

async function texts($: Engine, mounted: typeof PANE | typeof BAND): Promise<string[] | null> {
  const ui = await $.ui.mount(mounted)
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  return found.length === 0 ? null : found.map(t => t.text)
}

test('the pane draws the percent, the tokens and one legend row per category', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())

  const drawn = (await texts($, PANE)) ?? []
  expect(drawn.join('|')).toContain('36%')
  expect(drawn.join('')).toContain('36k / 100k')
  expect(drawn.some(t => /System prompt/.test(t))).toBe(true)
  expect(drawn.some(t => /Messages/.test(t))).toBe(true)
  expect(drawn.some(t => /Free space/.test(t))).toBe(false)
  expect(drawn.some(t => /Context over this session/.test(t))).toBe(true)
})

test('the pane says so before the first measurement', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(await texts($, PANE)).toEqual(['Waiting for the first measurement.'])
})

test('the band is one line, shows while no pane is open, and yields while the pane is listed', async ($, on) => {
  const shell = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ changed: ['context'] } as Parameters<Engine['session']['measure']>[0])

  const alone = (await texts($, BAND)) ?? []
  expect(alone.join('')).toContain('36%')

  await $.command.run(commandRun())
  expect(shell.isShown).toBe(true)
  expect(await texts($, BAND)).toBeNull()

  await $.command.run(commandRun())
  expect(shell.closes).toEqual(['context'])
  expect((await texts($, BAND))?.join('')).toContain('36%')
})

test('the panel answer opens, then closes, this tab', async ($, on) => {
  const shell = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  await $.command.run(commandRun())
  expect(shell.opens).toEqual(['context'])
  expect(shell.closes).toEqual(['context'])
})

test('a pane closed with the panel is not reopened next session', async ($, on) => {
  const shell = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  await $.command.run(commandRun())
  expect(shell.closes).toEqual(['context'])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(shell.opens).toEqual(['context'])
})

test('a remembered pane reopens at session start', async ($, on) => {
  const shell = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  shell.isShown = false

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(shell.opens).toEqual(['context', 'context'])
})

test('a new measurement glides frame by frame, then the clock stops asking for redraws', async ($, on) => {
  let used = 36_000
  const shell = world(on, { used: () => used })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())

  used = 80_000
  await $.session.measure({ changed: ['context'] } as Parameters<Engine['session']['measure']>[0])
  await shell.clock.advance(125)
  const mid = (await texts($, PANE))?.join('') ?? ''
  expect(mid).not.toContain('80%')
  expect(mid).not.toContain('36%')

  await shell.clock.advance(125 * 40)
  expect((await texts($, PANE))?.join('')).toContain('80%')
})

// Regression: review fix — an open pane the engine has not drawn (no room for it)
// must not hide the band.
test('the band stays while the pane is open but not placed', async ($, on) => {
  const shell = world(on)
  shell.isPlaced = false
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ changed: ['context'] } as Parameters<Engine['session']['measure']>[0])
  await $.command.run(commandRun())
  expect(shell.isShown).toBe(true)
  expect((await texts($, BAND))?.join('')).toContain('36%')
})

// Regression: review fix — a re-measure that changes nothing adds no history point.
test('re-measuring an unchanged context adds no point to the history', async ($, on) => {
  const shell = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  const footerOf = async () => ((await texts($, PANE)) ?? []).find(t => /^\d+ readings?/.test(t)) ?? ''
  expect(await footerOf()).toMatch(/^1 reading ·/)
  await $.session.measure({ changed: ['context'] } as Parameters<Engine['session']['measure']>[0])
  await $.session.measure({ changed: ['context'] } as Parameters<Engine['session']['measure']>[0])
  expect(await footerOf()).toMatch(/^1 reading ·/)
  expect(shell.opens).toEqual(['context'])
})

// Regression: review fix — with no pane on screen the view snaps to the snapshot,
// so the clock has nothing left to ask for.
test('with the pane not shown, the view snaps to the new measurement without gliding', async ($, on) => {
  let used = 36_000
  const shell = world(on, { used: () => used })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  shell.isShown = false
  used = 80_000
  await $.session.measure({ changed: ['context'] } as Parameters<Engine['session']['measure']>[0])
  await shell.clock.advance(125)
  expect((await texts($, PANE))?.join('')).toContain('80%')
})


function richWorld(on: On, used?: () => number): Shell {
  return world(on, { used, categories: MCP_CATEGORIES, extra: LISTS })
}

async function paneRows($: Engine): Promise<string[]> {
  return (await texts($, PANE)) ?? []
}

test('pressing a legend row with items lists them, grouped by server; pressing it again closes them', async ($, on) => {
  richWorld(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())

  const ui = await $.ui.mount(PANE)
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props.label ?? b.text)
  expect(buttons.length).toBe(2)
  expect(buttons.join('|')).toContain('MCP tools')
  expect(buttons.join('|')).toContain('Memory files')

  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).not.toMatch(/^ {2}linear/m)
  await ui.press({ key: 'cat:MCP tools' })
  const open = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const linear = open.findIndex(t => /^ {2}linear +3\.0k$/.test(t))
  const github = open.findIndex(t => /^ {2}github +4\.0k$/.test(t))
  expect(linear).toBeGreaterThan(-1)
  expect(github).toBeGreaterThan(-1)
  expect(github).toBeLessThan(linear)
  expect(open.some(t => /unloaded/.test(t))).toBe(false)

  await ui.press({ key: 'cat:MCP tools' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).some(t => /^ {2}linear/.test(t))).toBe(false)
  await ui.unmount()
})

test('pressing another row switches the open category: one at a time', async ($, on) => {
  richWorld(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())

  const ui = await $.ui.mount(PANE)
  const lines = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.press({ key: 'cat:MCP tools' })
  expect((await lines()).some(t => /^ {2}linear/.test(t))).toBe(true)
  await ui.press({ key: 'cat:Memory files' })
  const after = await lines()
  expect(after.some(t => /^ {2}linear/.test(t))).toBe(false)
  expect(after.some(t => /^ {2}CLAUDE\.md \(User\) +3\.0k$/.test(t))).toBe(true)
  await ui.unmount()
})

test('a category without item data is plain text', async ($, on) => {
  richWorld(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text).some(t => /Messages|System prompt/.test(t))).toBe(false)
  await ui.unmount()
})

test('the pane marks where autocompaction runs and says how far it is', async ($, on) => {
  richWorld(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  const drawn = await paneRows($)
  expect(drawn.join('\n')).toContain('Autocompact 83k (83%)')
  expect(drawn.join('\n')).toContain('47k to go')
  expect(drawn.filter(t => t.includes('◆')).length).toBeGreaterThan(1)
})

test('with autocompaction off the pane says so', async ($, on) => {
  world(on, { extra: { isAutoCompactEnabled: false } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  const drawn = await paneRows($)
  expect(drawn).toContain('Autocompact is off')
  expect(drawn.some(t => t.includes('◆'))).toBe(false)
})

test('the history is titled, labelled, and marks a fall of more than 20 points', async ($, on) => {
  let used = 40_000
  const shell = world(on, { used: () => used })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(commandRun())
  for (const next of [70_000, 20_000]) {
    used = next
    await shell.clock.advance(125 * 60 * 5)
    await $.session.measure({ changed: ['context'] } as Parameters<Engine['session']['measure']>[0])
  }
  await shell.clock.advance(60_000 * 3)

  const drawn = await paneRows($)
  expect(drawn.some(t => t.startsWith('── Context over this session'))).toBe(true)
  expect(drawn).toContain('100% ')
  expect(drawn).toContain('  0% ')
  expect(drawn.some(t => /^start +now$/.test(t))).toBe(true)
  expect(drawn.filter(t => t.trim() === '↓').length).toBeGreaterThan(0)
  expect(drawn.every(t => (t.match(/↓/g) ?? []).length <= 1)).toBe(true)
  expect(drawn.find(t => /readings/.test(t))).toMatch(/^3 readings · last compaction \d+m ago$/)
})
