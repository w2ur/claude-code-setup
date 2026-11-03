import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PlanView } from './views'
import { viewsOf } from './views'
import { dirsOf, ledgerRoots, readLedgers, readPlans, resetPlanCache } from './discover'
import { paneLines } from './pane'
import type { Seg } from './pane'

const PANE = 'plans'
const TITLE = 'Plans'
const COLUMNS = 80
// The panel mod's two answers to /panel (mods/panel/hooks/register.tsx).
const PANEL_OPENED = 'Panel opened.'
const PANEL_CLOSED = 'Panel closed.'
const POLL_MS = 5_000
// Remembered in the store when the person opens the pane, so the next session
// opens it unasked; their own close forgets it.
const PANE_OPEN = 'paneOpen'

const views = atom({ plugin: 'plan-progress', key: 'views' } as const, [] as PlanView[])

// This mod only observes: a failure is dropped, never surfaced.
const swallow = (): undefined => undefined

// One poll at a time: the interval fires without waiting, so a slow poll must
// not be overlapped by the next.
let isPolling = false

// Polls only while the pane is shown. Written on every shown poll so ages keep
// moving; a failing read drops that one ledger. When a top-level list fails
// (plans dir, dev dir) the answer is unknown: the atom keeps its last value.
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (!isShown) return
    const dirs = await dirsOf($)
    if (dirs === undefined) return
    const now = await $.clock.now()
    const roots = await ledgerRoots($, dirs.devDir, dirs.configDir)
    if (roots === undefined) return
    const ledgers = await readLedgers($, roots)
    const found = await readPlans($, dirs.configDir, ledgers)
    if (found === undefined) return
    await update($, views, () => viewsOf(found.plans, ledgers, found.allFiles, dirs.configDir, now))
  } finally {
    isPolling = false
  }
}

const segProps = (seg: Seg) => ({
  color: seg.color ?? seg.tone,
  dimColor: seg.dim === true,
  bold: seg.bold === true,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    resetPlanCache()
    isPolling = false
    await $.command.register({ name: 'plans', description: 'Bring the Plans tab of /panel (plans being executed, from their ledgers)' })
    $.clock.every(POLL_MS, () => {
      void poll($).catch(swallow)
    })
    const wasOpen = (await $.store.get(PANE_OPEN).catch(swallow)) === true
    if (wasOpen) await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS }).catch(swallow)

    return next(e)
  })

  on('command.run', { command: 'plans' }, async ($, e) => {
    if (e.args.trim() !== '') return { text: 'Usage: /plans to open the Plans tab.' }
    // Never closes: the panel mod owns the switch, /panel.
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown === true) return { text: 'Plans tab already open; /panel toggles the panel.' }
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS, ...(pane !== undefined && { focus: true as const }) })
    await $.store.set(PANE_OPEN, true).catch(swallow)

    return { text: opened.isPlaced ? 'Plans tab opened.' : `Plans tab waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      if (answer.text === PANEL_OPENED) {
        await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })
        await $.store.set(PANE_OPEN, true).catch(swallow)
      } else if (answer.text === PANEL_CLOSED) {
        await $.ui.close({ id: PANE })
        await $.store.set(PANE_OPEN, false).catch(swallow)
      }
    } catch {
      // The tab is this mod's affair; the panel's answer stands.
    }

    return answer
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') await $.store.delete(PANE_OPEN).catch(swallow)

    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(await read($, views), e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        {lines.map((line, row) => (
          <Box key={`row:${row}`} flexDirection="row">
            {line.map((seg, col) => (
              <Text key={`seg:${col}`} {...segProps(seg)} wrap="truncate-end">
                {seg.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
