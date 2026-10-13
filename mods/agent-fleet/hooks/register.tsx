import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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
import { paneLines } from './pane'
import type { Seg } from './pane'

const PANE = 'fleet'
const TICK_MS = 1000
// A silent workflow is told by 30 minutes of silence, so a minute is fine grain enough.
const IDLE_CHECK_MS = 60_000
const fleet = atom({ plugin: 'agent-fleet', key: 'fleet' } as const, emptyFleet(), { shape: FLEET_SHAPE })
// Bumped once a second while anything runs, so elapsed times on the band and
// in the pane keep moving between events.
const tick = atom({ plugin: 'agent-fleet', key: 'tick' } as const, 0)

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

// The 1 Hz tick: nothing live, nothing to do.
async function tickOnce($: EngineInterface): Promise<void> {
  const f = await read($, fleet)
  if (isAnyRunning(f)) await upkeep($, f)
}

// A workflow run that went silent with nothing running (or never had an agent)
// is not live, so the 1 Hz tick skips it; this coarse check ends it. It reads
// the state itself each time: one read a minute, and no cache to go stale.
async function watchIdle($: EngineInterface): Promise<void> {
  const f = await read($, fleet)
  await expireIfDue($, f, await $.clock.now())
}

const segProps =(seg: Seg) => ({
  color: seg.tone,
  dimColor: seg.dim === true,
  bold: seg.bold === true,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fleet',
      description: 'Toggle the fleet pane (subagents and workflow runs); "clear" drops finished runs',
    })
    $.clock.every(TICK_MS, () => {
      void tickOnce($).catch(swallow)
    })
    $.clock.every(IDLE_CHECK_MS, () => {
      void watchIdle($).catch(swallow)
    })
    // What a previous load of the mod left: one read catches up.
    const left = await read($, fleet).catch(swallow)
    if (left !== undefined) await upkeep($, left).catch(swallow)

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
    if (arg !== '') return { text: 'Usage: /fleet to toggle the pane, /fleet clear to drop finished runs.' }

    const shown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if (shown) {
      await $.ui.close({ id: PANE })

      return { text: 'Fleet pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Fleet' })

    return { text: opened.isPlaced ? 'Fleet pane opened.' : `Fleet pane waiting: ${opened.reason}` }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    const tzOffsetMin = -new Date().getTimezoneOffset()
    await update($, fleet, f => reduce(f, { kind: 'turn-start', tzOffsetMin })).catch(swallow)

    return started
  })

  // A spawn is recorded from its RESULT, never its input: a plugin beneath may
  // refuse it, and a refused spawn must not look like a running agent.
  on('agent.spawn', async ($, e, next) => {
    const costUsd = await $.session.usage().then(u => u.cost?.usd, swallow)
    const result = await next(e)
    try {
      const at = await $.clock.now()
      await record($, spawnEventOf(e, result, at, costUsd))
      if ('agentId' in result) {
        let isFirst = false
        await update($, fleet, f => {
          isFirst = !f.hasAutoOpened

          return reduce(f, { kind: 'auto-opened' })
        })
        // Unasked: the engine seats it from 144 columns and otherwise leaves it waiting.
        if (isFirst) await $.ui.open({ id: PANE, title: 'Fleet' })
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
    const isPaneUp = await $.ui.panes().then(panes => panes.some(pane => pane.id === PANE && pane.isPlaced), () => false)
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
    const now = await $.clock.now()
    const lines = paneLines(state, now, e.props.bodyColumns)

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
