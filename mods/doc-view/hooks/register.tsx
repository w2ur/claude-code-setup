import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { EMPTY, MAX_BYTES, clip, find, isMarkdown, label, mdPaths, remember, remind, select, shortPath } from './docs'

const PANE = 'docs'
const TITLE = 'Docs'
const COLUMNS = 80
// The panel mod's two answers to /panel (mods/panel/hooks/register.tsx).
const PANEL_OPENED = 'Panel opened.'
const PANEL_CLOSED = 'Panel closed.'
// How many file buttons the list shows above the document.
const LIST_ROWS = 6
// A shell-written file counts when modified from this long before the call.
const SLACK_MS = 2_000

const docs = atom({ plugin: 'doc-view', key: 'docs' } as const, EMPTY, { shape: 'docs-2' })

// This mod only observes: a failure is dropped, never surfaced.
const swallow = (): undefined => undefined

let home: string | undefined

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })

// A file written: the main conversation's takes the screen and opens the tab
// (unless the person closed it); a subagent's only joins the list.
async function written($: EngineInterface, path: string, agentId: string | undefined): Promise<void> {
  if (agentId !== undefined) {
    await update($, docs, d => remind(d, path))
    return
  }
  const next = await update($, docs, d => remember(d, path))
  if (!next.isMuted) await open($)
}

const succeeded = (ran: { deny?: string; isError?: boolean }): boolean => ran.deny === undefined && ran.isError !== true

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'docs', description: 'Bring the Docs tab of /panel (markdown files written this session)' })
    home = await $.env.get('HOME').catch(swallow)

    return next(e)
  })

  on('command.run', { command: 'docs' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== '') {
      const found = find((await read($, docs)).files, arg, home)
      if (found === undefined) return { text: `No markdown file "${arg}" written this session.` }
      await update($, docs, d => select(d, found))
    }
    await update($, docs, d => ({ ...d, isMuted: false }))
    const opened = await open($)

    return { text: opened.isPlaced ? 'Docs tab opened.' : `Docs tab waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      if (answer.text === PANEL_OPENED) {
        await update($, docs, d => ({ ...d, isMuted: false }))
        await open($)
      } else if (answer.text === PANEL_CLOSED) {
        await update($, docs, d => ({ ...d, isMuted: true }))
        await $.ui.close({ id: PANE })
      }
    } catch {
      // The tab is this mod's affair; the panel's answer stands.
    }

    return answer
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') await update($, docs, d => ({ ...d, isMuted: true })).catch(swallow)

    return closed
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (isMarkdown(e.file_path) && succeeded(ran)) await written($, e.file_path, e.agentId).catch(swallow)

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (isMarkdown(e.file_path) && succeeded(ran)) await written($, e.file_path, e.agentId).catch(swallow)

    return ran
  })

  // A shell command: markdown files it names and modified during the call are
  // written files; the shown file, if the command changed it, redraws.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (!succeeded(ran)) return ran
    try {
      for (const path of mdPaths(e.command, home)) {
        const stat = await $.fs.stat(path).catch(swallow)
        if (stat?.kind === 'file' && stat.mtimeMs >= startedAt - SLACK_MS) await written($, path, e.agentId)
      }
      const shown = (await read($, docs)).selected
      if (shown !== undefined) {
        const mtime = (await $.fs.stat(shown).catch(swallow))?.mtimeMs
        await update($, docs, d => (d.selected !== shown || d.seenMtime === mtime ? d : { ...d, seenMtime: mtime, revision: d.revision + 1 }))
      }
    } catch {
      // Detection is best effort; the command's answer stands.
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const state = await read($, docs)
    const selected = state.selected
    if (selected === undefined) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No markdown file written yet this session.</Text>
          <Text dimColor>Each one Claude writes or edits opens here.</Text>
        </Box>
      )
    }
    const stat = await $.fs.stat(selected).catch(swallow)
    const text =
      stat === undefined ? '*This file no longer exists.*'
      : stat.size > MAX_BYTES ? `*Too large to show here (${Math.round(stat.size / 1024 / 1024)} MiB).*`
      : await $.fs.read(selected).then(clip, (err: unknown) => `*Cannot read this file: ${String(err)}*`)
    const shown = state.files.slice(0, LIST_ROWS)
    const hidden = state.files.length - shown.length

    return (
      <Box flexDirection="column">
        {state.files.length > 1 && (
          <Box flexDirection="column">
            {shown.map(file => (
              <Button key={`file:${file}`} plain dimColor={file !== selected} onPress={() => void update($, docs, d => select(d, file))}>
                {file === selected ? '▸ ' : '  '}
                {label(file, state.files)}
              </Button>
            ))}
            {hidden > 0 && <Text dimColor>  +{hidden} more: /docs &lt;name&gt;</Text>}
          </Box>
        )}
        <Text dimColor wrap="truncate-start">{shortPath(selected, home)}</Text>
        <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
        <Markdown key={`doc:${state.revision}`} text={text} />
      </Box>
    )
  })
}
