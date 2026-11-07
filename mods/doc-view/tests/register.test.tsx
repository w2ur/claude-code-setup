import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'doc-view',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'docs',
  props: { title: 'Docs', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const NOW = 1_000_000_000

const cmd = (command: string, args: string) =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as Parameters<Engine['command']['run']>[0]

type File = { text: string; mtimeMs: number; size?: number }

function world(on: On) {
  const files = new Map<string, File>([
    ['/home/{username}/a.md', { text: '# Alpha', mtimeMs: NOW }],
    ['/home/{username}/b.md', { text: '# Beta', mtimeMs: NOW }],
  ])
  const shell = { opens: [] as string[], closes: [] as string[], panel: { text: 'Panel opened.' }, files }
  mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'docs' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/w' : undefined }))
  on('fs.read', (_, e) => {
    const f = files.get(e.path)
    if (f === undefined) throw new Error('ENOENT')
    return { value: f.text }
  })
  on('fs.stat', (_, e) => {
    const f = files.get(e.path)
    if (f === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: f.size ?? f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('ui.open', (_, e) => {
    shell.opens.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    shell.closes.push(e.id)
    return { value: undefined }
  })
  on('command.run', { command: 'panel' }, () => ({ text: shell.panel.text }))
  on('tool.call', (_, e) => (e.tool === 'Edit' && e.file_path.endsWith('bad.md') ? { result: 'no match', isError: true } : { result: {} }))

  return shell
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('writing a markdown file opens the tab on it, rendered', async ($, on) => {
  const shell = world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/a.md', content: '# Alpha' })

  expect(shell.opens).toEqual(['docs'])
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# Alpha')
  expect((await ui.find({ type: 'Text', text: /~\/a\.md/ }))?.text).toBe('~/a.md')
  await ui.unmount()
})

test('non-markdown and failed writes are ignored', async ($, on) => {
  const shell = world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/x.ts', content: '' })
  await $.tool.call({ tool: 'Edit', file_path: '/home/{username}/bad.md', old_string: 'a', new_string: 'b' })

  expect(shell.opens).toEqual([])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /No markdown/ })).toBeDefined()
  await ui.unmount()
})

test('the list switches the document shown', async ($, on) => {
  world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/a.md', content: '' })
  await $.tool.call({ tool: 'Edit', file_path: '/home/{username}/b.md', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# Beta')
  await ui.press({ key: 'file:/home/{username}/a.md' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# Alpha')
  await ui.unmount()
})

// Regression: a control character made the engine refuse the whole pane.
test('a file holding control characters still draws', async ($, on) => {
  const shell = world(on)
  shell.files.set('/home/{username}/log.md', { text: 'red \u001b[31mtext\u0000', mtimeMs: NOW })
  await $.session.start(start)
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/log.md', content: '' })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('red [31mtext')
  await ui.unmount()
})

test('a file too large to read says so', async ($, on) => {
  const shell = world(on)
  shell.files.set('/home/{username}/big.md', { text: '', size: 5 * 1024 * 1024, mtimeMs: NOW })
  await $.session.start(start)
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/big.md', content: '' })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('Too large')
  await ui.unmount()
})

// Regression: a write reopened the tab after /panel closed it.
test('after /panel closes, writes no longer reopen the tab until /panel opens', async ($, on) => {
  const shell = world(on)
  await $.session.start(start)
  shell.panel.text = 'Panel closed.'
  await $.command.run(cmd('panel', ''))
  expect(shell.closes).toEqual(['docs'])
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/a.md', content: '' })
  expect(shell.opens).toEqual([])

  shell.panel.text = 'Panel opened.'
  await $.command.run(cmd('panel', ''))
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/b.md', content: '' })
  expect(shell.opens).toEqual(['docs', 'docs'])
})

test("a subagent's write joins the list without taking the screen", async ($, on) => {
  const shell = world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/a.md', content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/b.md', content: '', agentId: 'sub-1' })

  expect(shell.opens).toEqual(['docs'])
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# Alpha')
  expect(await ui.find({ key: 'file:/home/{username}/b.md' })).toBeDefined()
  await ui.unmount()
})

test('a shell command that writes a markdown file shows it; one that only names it does not', async ($, on) => {
  const shell = world(on)
  shell.files.set('/home/{username}/new.md', { text: '# New', mtimeMs: NOW })
  shell.files.set('/home/{username}/old.md', { text: '# Old', mtimeMs: NOW - 60_000 })
  await $.session.start(start)
  await $.tool.call({ tool: 'Bash', command: 'cat old.md > /dev/null; cat > ~/new.md <<EOF' })

  expect(shell.opens).toEqual(['docs'])
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# New')
  expect(await ui.find({ key: 'file:/home/{username}/old.md' })).toBeUndefined()
  await ui.unmount()
})

test('/docs recalls a file by its ~ path', async ($, on) => {
  world(on)
  await $.session.start(start)
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/a.md', content: '' })
  await $.tool.call({ tool: 'Write', file_path: '/home/{username}/b.md', content: '' })
  expect((await $.command.run(cmd('docs', '~/a.md')))?.text).toBe('Docs tab opened.')

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# Alpha')
  await ui.unmount()
})

test('a value an earlier version stored is declined', async ($, on) => {
  world(on)
  on('state.get', () => ({ value: { value: { files: ['/home/{username}/a.md'], revision: 1 }, version: 1 } }))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /No markdown/ })).toBeDefined()
  await ui.unmount()
})
