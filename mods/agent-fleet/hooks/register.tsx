import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Fleet } from '../types'

import {
  FLEET_SHAPE,
  announce,
  bandOf,
  emptyFleet,
  isAnyRunning,
  isDue,
  launchOf,
  reduce,
  spawnEventOf,
  unlistedRunning,
} from './fleet'
import type { FleetEvent } from './fleet'
import { PANE_COLUMNS } from './gfx'
import { paneLines } from './pane'
import type { Seg } from './pane'

const PANE = 'fleet'
// The panel mod's two answers to /panel (mods/panel/hooks/register.tsx).
const PANEL_OPENED = 'Panel opened.'
const PANEL_CLOSED = 'Panel closed.'
const TICK_MS = 1000
// A silent workflow is told by 30 minutes of silence, so a minute is fine grain enough.
const IDLE_CHECK_MS = 60_000
const fleet = atom({ plugin: 'agent-fleet', key: 'fleet' } as const, emptyFleet(), { shape: FLEET_SHAPE })
// Bumped once a second while anything runs, so elapsed times on the band and
// in the pane keep moving between events.
const tick = atom({ plugin: 'agent-fleet', key: 'tick' } as const, 0)
// The animation frame (spinners, the progress shimmer), apart from `tick` so
// that the upkeep keeps its 1 Hz: bumped eight times a second, and only while
// the pane is shown and something runs. An idle or hidden pane does not redraw.
const FRAME_MS = 125
const frame = atom({ plugin: 'agent-fleet', key: 'frame' } as const, 0)
// Remembered in the store when the person opens the pane with /fleet or /panel,
// so the next session opens it unasked; their own close forgets it.
const PANE_OPEN = 'paneOpen'

// Bookkeeping must never disturb the session: this mod only observes, so a
// failure while recording is dropped and the hook still answers what the chain
// beneath answered.
const swallow = (): undefined => undefined

// The engine's words for an agent that is over (AgentStatus).
const ENDED: ReadonlySet<string> = new Set(['completed', 'failed', 'killed'])

// Applies one event that can change a status or open or end a run, then says
// aloud the failures and run ends now due. The markers that keep a repeat from
// saying it again are part of the state.
async function record($: EngineInterface, event: Extract<FleetEvent, { at: number }>): Promise<void> {
  let messages: string[] = []
  await update($, fleet, f => {
    const announced = announce(reduce(f, event), event.at)
    messages = announced.messages

    return announced.fleet
  })
  for (const message of messages) $.ui.toast(message)
}

// Applies a step or a tool call: what it carries (usage, the current tool) is
// only drawn, so it announces nothing; a run end or a failure it leaves due is
// said by the next recorded event or the upkeep.
async function observe($: EngineInterface, event: Extract<FleetEvent, { kind: 'step' | 'tool' }>): Promise<void> {
  await update($, fleet, f => reduce(f, event))
}

// Agents the engine no longer carries as running, against the engine's own list.
// Finished ones it still lists give their real outcome; absent ones are lost
// (their completion never reached this mod, e.g. across a hot reload).
async function reconcile($: EngineInterface, f: Fleet, at: number): Promise<void> {
  const listed = await $.agent.list()
  const listedIds = new Set(listed.map(agent => agent.id))
  const ended = listed.filter(agent => {
    const held = f.agents[agent.id]
    return held !== undefined && held.status === 'running' && held.startedAt < at && ENDED.has(agent.status)
  })
  for (const agent of ended) {
    await record($, {
      kind: 'complete',
      at,
      agentId: agent.id,
      answer: '',
      isAborted: agent.status === 'killed',
      reason: agent.status === 'completed' ? 'answer' : agent.status,
      source: 'list',
    })
  }
  const ids = unlistedRunning(f, listedIds, at)
  if (ids.length > 0) await record($, { kind: 'lost', ids, at })
}

// Ends the runs whose grace ran out or that went silent, and announces a list
// failure whose wait is over: the timers are the only thing that does either.
async function expireIfDue($: EngineInterface, f: Fleet, at: number): Promise<void> {
  if (isDue(f, at)) await record($, { kind: 'expire', at })
}

// Upkeep on one read of the fleet: while anything is live, reconcile with the
// engine and move the clock; in any case expire what is due. What reconcile
// records only starts a grace, so the read taken first still tells whether an
// expiry is due.
async function upkeep($: EngineInterface, f: Fleet): Promise<void> {
  const at = await $.clock.now()
  const isLive = isAnyRunning(f)
  if (isLive) await reconcile($, f, at).catch(swallow)
  await expireIfDue($, f, at)
  if (isLive) await update($, tick, n => n + 1)
}

// Starts or stops the 8 Hz animation: one interval at most, running only while
// the pane is shown and something runs. Its own timer rather than a standing
// one, so an idle session schedules nothing eight times a second; the 1 Hz
// tick decides, so it starts or stops within a second of either changing.
type Animation = (isRunning: boolean) => Promise<void>

function animation($: EngineInterface): Animation {
  let timer: Timer | undefined
  return async isRunning => {
    const isShown = isRunning && (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (isShown && timer === undefined) {
      timer = $.clock.every(FRAME_MS, () => {
        void update($, frame, n => n + 1).catch(swallow)
      })
    } else if (!isShown && timer !== undefined) {
      timer.cancel()
      timer = undefined
    }
  }
}

// The 1 Hz tick: nothing live, nothing to do (and no animation).
async function tickOnce($: EngineInterface, animate: Animation): Promise<void> {
  const f = await read($, fleet)
  const isRunning = isAnyRunning(f)
  await animate(isRunning).catch(swallow)
  if (isRunning) await upkeep($, f)
}

// A workflow run that went silent with nothing running (or never had an agent)
// is not live, so the 1 Hz tick skips it; this coarse check ends it. It reads
// the state itself each time: one read a minute, and no cache to go stale.
async function watchIdle($: EngineInterface): Promise<void> {
  const f = await read($, fleet)
  await expireIfDue($, f, await $.clock.now())
}

const segProps = (seg: Seg) => ({
  color: seg.color ?? seg.tone,
  dimColor: seg.dim === true,
  bold: seg.bold === true,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fleet',
      description: 'Bring the Fleet tab of /panel (subagents and workflow runs); "clear" drops finished runs',
    })
    const animate = animation($)
    $.clock.every(TICK_MS, () => {
      void tickOnce($, animate).catch(swallow)
    })
    $.clock.every(IDLE_CHECK_MS, () => {
      void watchIdle($).catch(swallow)
    })
    // What a previous load of the mod left: one read catches up.
    const left = await read($, fleet).catch(swallow)
    if (left !== undefined) await upkeep($, left).catch(swallow)
    // The pane the person kept open last time comes back with the session.
    const wasOpen = (await $.store.get(PANE_OPEN).catch(swallow)) === true
    if (wasOpen) await $.ui.open({ id: PANE, title: 'Fleet', columns: PANE_COLUMNS }).catch(swallow)

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      const before = await read($, fleet)
      const after = await update($, fleet, f => reduce(f, { kind: 'clear' }))
      const dropped = before.order.length - after.order.length

      return { text: dropped === 0 ? 'No finished runs to clear.' : `Cleared ${dropped} finished run${dropped === 1 ? '' : 's'}.` }
    }
    if (arg !== '') return { text: 'Usage: /fleet to open the Fleet tab, /fleet clear to drop finished runs.' }

    // Never closes: the panel mod owns the switch, /panel.
    const shown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (shown) return { text: 'Fleet tab already open; /panel toggles the panel.' }
    const opened = await $.ui.open({ id: PANE, title: 'Fleet', columns: PANE_COLUMNS })
    await $.store.set(PANE_OPEN, true).catch(swallow)

    return { text: opened.isPlaced ? 'Fleet tab opened.' : `Fleet tab waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      if (answer.text === PANEL_OPENED) {
        await $.ui.open({ id: PANE, title: 'Fleet', columns: PANE_COLUMNS })
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

  // The person closing the pane (its mark or close key) means they no longer
  // want it back; a plugin's close or an unload says nothing of the kind.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') await $.store.delete(PANE_OPEN).catch(swallow)

    return closed
  })

  // A turn of the main loop counts a turn: the loose runs and the band's
  // linger go by it. A turn of an agent's loop does not (counting it split two
  // agents launched in one assistant turn into two runs); it is a sighting,
  // taken before the turn runs so that it never postdates the turn's own end.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      try {
        const at = await $.clock.now()
        await record($, { kind: 'wake', at, agentId })
      } catch {
        // observe only, see `swallow`
      }

      return next(e)
    }
    const started = await next(e)
    const tzOffsetMin = -new Date().getTimezoneOffset()
    await update($, fleet, f => reduce(f, { kind: 'turn-start', tzOffsetMin })).catch(swallow)

    return started
  })

  // A spawn is recorded from its RESULT, never its input: a plugin beneath may
  // refuse it, and a refused spawn must not look like a running agent.
  on('agent.spawn', async ($, e, next) => {
    const costUsd = await $.session.usage().then(u => u.cost?.usd, swallow)
    const requestedAt = await $.clock.now().catch(swallow)
    const result = await next(e)
    try {
      const at = await $.clock.now()
      await record($, spawnEventOf(e, result, at, costUsd, requestedAt))
      if ('agentId' in result) {
        let isFirst = false
        await update($, fleet, f => {
          isFirst = !f.hasAutoOpened

          return reduce(f, { kind: 'auto-opened' })
        })
        // Unasked: the engine seats it from 144 columns and otherwise leaves it waiting.
        if (isFirst) await $.ui.open({ id: PANE, title: 'Fleet', columns: PANE_COLUMNS })
      }
    } catch {
      // observe only, see `swallow`
    }

    return result
  }).catch((_$, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      try {
        const at = await $.clock.now()
        await observe($, { kind: 'tool', at, agentId, tool: e.tool })
      } catch {
        // observe only, see `swallow`
      }

      return next(e)
    }
    if (e.tool !== 'Workflow') return next(e)

    // The Workflow tool starts the run in the background and answers at once,
    // so the run's end is not this call resolving: it is read off its agents.
    const toolUseId = e.tool_use_id
    const script = e.script
    try {
      const at = await $.clock.now()
      const costUsd = await $.session.usage().then(u => u.cost?.usd, swallow)
      await record($, { kind: 'workflow-start', at, toolUseId, script, costUsd })
    } catch {
      // observe only, see `swallow`
    }
    const result = await next(e)
    try {
      const launch = launchOf(result)
      if (launch.isLaunched) {
        const at = await $.clock.now()
        await record($, { kind: 'workflow-launched', at, toolUseId, runId: launch.runId, name: launch.name })
      } else {
        const at = await $.clock.now()
        await record($, { kind: 'workflow-end', at, toolUseId })
      }
    } catch {
      // observe only, see `swallow`
    }

    return result
  }).catch((_$, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      const at = await $.clock.now()
      const window =
        e.agentId === undefined ? await $.session.usage().then(u => u.context.window, swallow) : undefined
      const u = result.usage
      const usage =
        u === null
          ? null
          : {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheCreation: u.cache_creation_input_tokens ?? 0,
            }
      await observe($, {
        kind: 'step',
        at,
        agentId: e.agentId,
        turnId: e.turnId,
        index: e.index,
        model: e.model,
        effort: e.effort,
        usage,
        window,
      })
    } catch {
      // observe only, see `swallow`
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) return completed
    const agentId = e.agentId
    try {
      const at = await $.clock.now()
      const costUsd = await $.session.usage().then(u => u.cost?.usd, swallow)
      await record($, {
        kind: 'complete',
        at,
        agentId,
        answer: e.answer,
        isAborted: e.isAborted,
        reason: e.reason,
        costUsd,
        source: 'real',
      })
    } catch {
      // observe only, see `swallow`
    }

    return completed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // The pane shows the same runs in full; the band would only repeat them.
    const isPaneUp = await $.ui.panes().then(panes => panes.some(pane => pane.id === PANE && pane.isShown), () => false)
    if (isPaneUp) return next(e)
    const state = await read($, fleet)
    await read($, tick)
    const now = await $.clock.now()
    const band = bandOf(state, now)
    if (band === null) return next(e)

    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const color = band.tone === 'failed' ? 'error' : band.tone === 'done' ? 'success' : undefined

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={color} bold>
            {band.glyph}{' '}
          </Text>
          <Text bold wrap="truncate-end">
            {band.title}
          </Text>
          <Text dimColor wrap="truncate-end">
            {' · '}
            {band.parts.join(' · ')}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, fleet)
    await read($, tick)
    const at = await read($, frame)
    const now = await $.clock.now()
    const lines = paneLines(state, now, e.props.bodyColumns, at)

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
