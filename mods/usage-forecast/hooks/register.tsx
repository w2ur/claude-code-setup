import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { GuardDecision, GuardView, UsageWindowView } from '../types'
import {
  LOOKBACK,
  THRESHOLDS,
  addSample,
  armedBy,
  burnRate,
  clock,
  duration,
  isFanOut,
  label,
  lastRise,
  levelToAlert,
  projectFull,
  projectedAtReset,
} from './forecast'
import type { Armed, WindowSamples } from './forecast'
import { gauge } from './gauge'
import { RISE_MS, canRace, raceLines } from './race'
import type { Seg } from './race'
import { HUE, PANE_COLUMNS, cut, ease, heat, pulse, rule, spark } from './gfx'

const PANE = 'limits'
const TITLE = 'Limits'
const FRAME_MS = 125
const DECISIONS_KEPT = 6
const RUN = 'Run it'
// The panel mod's two answers to /panel (mods/panel/hooks/register.tsx).
const PANEL_OPENED = 'Panel opened.'
const PANEL_CLOSED = 'Panel closed.'

const windows = atom({ plugin: 'usage-forecast', key: 'windows' } as const, [], { shape: 'windows@2' })
// Countdowns: bumped once a minute.
const tick = atom({ plugin: 'usage-forecast', key: 'tick' } as const, 0)
// Animation: bumped at FRAME_MS only while something moves on screen.
const frame = atom({ plugin: 'usage-forecast', key: 'frame' } as const, 0)
const guard = atom({ plugin: 'usage-forecast', key: 'guard' } as const, { agentsThisTurn: 0, decisions: [] } as GuardView, {
  shape: 'guard@1',
})

// The percentage each gauge is drawn at, gliding to the reading. A reload
// starts it over from zero, which reads as the pane filling up again.
const drawn = new Map<string, number>()
let isGliding = false
// One question per turn: parallel Agent calls share the pending answer.
let decision: Promise<boolean> | undefined
let lastStatus: string | undefined
// Whether the last reading armed the guard: the frame timer reads this flag
// before anything that crosses to the engine, so an idle mod costs nothing.
let isArmedLast = false
// The latest reading that moved up: the runner stride runs while it is recent.
let lastRiseSeen: number | undefined

// $.store is shared by every session, so the burn rate counts what parallel
// sessions spend too: the limit is the account's, not this session's.
async function observe($: EngineInterface, limit: SessionRateLimit, now: number): Promise<UsageWindowView> {
  const look = LOOKBACK[limit.kind]
  const resetsAt = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt)
  let ratePerHour: number | undefined
  let history: number[] | undefined
  let lastRiseAt: number | undefined

  if (look !== undefined && limit.resetsAt !== undefined) {
    const key = `samples:${limit.kind}`
    const held = (await $.store.get(key)) as WindowSamples | undefined
    const next = addSample(held, limit.resetsAt, { t: now, pct: limit.percentUsed }, look.span)
    await $.store.set(key, next)
    ratePerHour = burnRate(next.samples, look.minSpan)
    history = next.samples.map(s => s.pct)
    lastRiseAt = lastRise(next.samples)

    const alertKey = `alerted:${limit.kind}`
    const heldAlerts = (await $.store.get(alertKey)) as { resetsAt: string; levels: number[] } | undefined
    const levels = heldAlerts !== undefined && heldAlerts.resetsAt === limit.resetsAt ? heldAlerts.levels : []
    const level = levelToAlert(limit.percentUsed, levels)
    if (level !== undefined) {
      const reset = resetsAt === undefined ? '' : `, resets ${clock(resetsAt)}`
      $.ui.toast(`${label(limit.kind)} window at ${limit.percentUsed}%${reset}`)
      await $.store.set(alertKey, { resetsAt: limit.resetsAt, levels: [...levels, level] })
    }
  }

  return {
    kind: limit.kind,
    percent: limit.percentUsed,
    resetsAt,
    ratePerHour,
    fullAt: projectFull(limit.percentUsed, ratePerHour, now, resetsAt),
    projected: projectedAtReset(limit.percentUsed, ratePerHour, now, resetsAt),
    history,
    lastRiseAt,
  }
}

async function observeAll($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<UsageWindowView[]> {
  const now = await $.clock.now()
  const views: UsageWindowView[] = []
  for (const limit of limits) views.push(await observe($, limit, now))
  lastRiseSeen = views.reduce<number | undefined>((m, v) => (v.lastRiseAt === undefined ? m : Math.max(m ?? 0, v.lastRiseAt)), undefined)
  await update($, windows, () => views)
  await say($, armedBy(views, now))

  return views
}

// The status line under the prompt carries the armed guard: it is the one
// place on screen whatever the pane or band is doing.
async function say($: EngineInterface, armed: Armed[]): Promise<void> {
  isArmedLast = armed.length > 0
  const text = armed.length === 0 ? undefined : `⚠ fan-out guard armed: ${armed.map(a => a.why).join(', ')}`
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function seed($: EngineInterface): Promise<void> {
  if ((await read($, windows)).length > 0) return
  const { rateLimits } = await $.session.usage()
  if (rateLimits.length > 0) await observeAll($, rateLimits)
}

const isPaneOpen = ($: EngineInterface): Promise<boolean> =>
  $.ui.panes().then(
    panes => panes.some(pane => pane.id === PANE && pane.isPlaced),
    () => false,
  )

const isPaneShown = ($: EngineInterface): Promise<boolean> =>
  $.ui.panes().then(
    panes => panes.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced),
    () => false,
  )

async function isArmedNow($: EngineInterface): Promise<boolean> {
  return armedBy(await read($, windows), await $.clock.now()).length > 0
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

async function ask($: EngineInterface, why: string, what: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(`${why}. Run this ${what} anyway?`, {
      options: [RUN, 'Hold'],
      header: 'Usage',
    })
    return answer === RUN
  } catch {
    // Dismissed, or a -p run with nobody to ask: hold.
    return false
  }
}

// A fresh reading at the moment of the fan-out, projected at the pace the
// last measurement held. Read-only: parallel Agent calls gate at once, and a
// read-then-write of the samples here would lose some and toast twice.
async function readingNow($: EngineInterface): Promise<UsageWindowView[]> {
  const { rateLimits } = await $.session.usage()
  const held = await read($, windows).catch((): UsageWindowView[] => [])
  const now = await $.clock.now()

  return rateLimits.map(l => {
    const resetsAt = l.resetsAt === undefined ? undefined : Date.parse(l.resetsAt)
    const rate = held.find(v => v.kind === l.kind)?.ratePerHour

    return { kind: l.kind, percent: l.percentUsed, resetsAt, fullAt: projectFull(l.percentUsed, rate, now, resetsAt) }
  })
}

async function gate($: EngineInterface, tool: string): Promise<string | undefined> {
  const counted = await update($, guard, g => (tool === 'Agent' ? { ...g, agentsThisTurn: g.agentsThisTurn + 1 } : g))
  if (!isFanOut(tool, counted.agentsThisTurn)) return undefined

  // Fail open: a guard that cannot read usage must not block the work.
  let views: UsageWindowView[]
  try {
    views = await readingNow($)
  } catch {
    return undefined
  }
  const now = await $.clock.now()
  const armed = armedBy(views, now)
  if (armed.length === 0) return undefined
  const why = armed.map(a => a.why).join(', ')
  const what = tool === 'Workflow' ? 'workflow' : 'parallel agent dispatch'

  const isFirst = decision === undefined
  decision ??= ask($, why, what)
  const ran = await decision
  if (isFirst) {
    const entry: GuardDecision = { at: now, what, ran, why }
    await update($, guard, g => ({ ...g, decisions: [...g.decisions, entry].slice(-DECISIONS_KEPT) }))
  }
  if (ran) return undefined
  return `${$.plugin.name}: ${why}; the owner held this fan-out. Finish the work inline without spawning more agents, or stop and report where things stand.`
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function glide(views: readonly UsageWindowView[]): Map<string, number> {
  const out = new Map<string, number>()
  let moving = false
  for (const v of views) {
    const at = ease(drawn.get(v.kind) ?? 0, v.percent)
    drawn.set(v.kind, at)
    out.set(v.kind, at)
    if (at !== v.percent) moving = true
  }
  isGliding = moving
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await seed($).catch(() => undefined)
    // Countdowns age between measurements; one redraw a minute keeps them true.
    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
    })
    // Frames while the pane is seen and a gauge glides, the guard is armed or
    // usage rose in the last RISE_MS (the runner strides);
    // the band's armed beacon beats at a quarter of that while the pane is not.
    let beat = 0
    $.clock.every(FRAME_MS, () => {
      beat += 1
      if (!isGliding && !isArmedLast && lastRiseSeen === undefined) return
      void (async () => {
        const isArmed = await isArmedNow($)
        // A window that reset since the last reading disarms here, not at
        // the next response: the band, beacon and status line go with it.
        if (!isArmed) await say($, [])
        const isSeen = await isPaneShown($)
        const now = await $.clock.now()
        const isRising = lastRiseSeen !== undefined && now - lastRiseSeen <= RISE_MS
        // The last frame after the stride ends draws the runner standing.
        const isStopping = lastRiseSeen !== undefined && !isRising
        if (isStopping) lastRiseSeen = undefined
        if ((isSeen && (isGliding || isArmed || isRising || isStopping)) || (isArmed && beat % 4 === 0)) await update($, frame, n => n + 1)
      })().catch(() => undefined)
    })
    if ((await $.store.get('paneOpen')) === true) void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS }).catch(() => undefined)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) await observeAll($, e.rateLimits)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    decision = undefined
    await update($, guard, g => ({ ...g, agentsThisTurn: 0 }))

    return next(e)
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const deny = await gate($, e.tool)
    return deny === undefined ? next(e) : { deny }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const deny = await gate($, e.tool)
    return deny === undefined ? next(e) : { deny }
  })

  // The panel mod's /panel: its answer, at the bottom of the chain, says
  // whether the panel opens or closes, and this tab follows it.
  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    // The tab first: remembering it is secondary, and a store failure must not
    // keep the tab from following. The panel's answer stands either way.
    try {
      if (answer.text === PANEL_OPENED) {
        drawn.clear()
        await seed($).catch(() => undefined)
        await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
        await $.store.set('paneOpen', true)
      } else if (answer.text === PANEL_CLOSED) {
        await $.ui.close({ id: PANE })
        await $.store.set('paneOpen', false)
      }
    } catch {
      // The tab is this mod's affair.
    }

    return answer
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('paneOpen', false)

    return next(e)
  })

  // Composes with any other band: this row on top, the chain's tree beneath.
  // While the panel holds this tab the band stays away, save the armed guard,
  // which shows whatever the panel is doing.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const views = await read($, windows)
    if (e.props.hasSurvey || views.length === 0) return next(e)
    await read($, tick)
    const beat = await read($, frame)
    const now = await $.clock.now()
    const armed = armedBy(views, now)
    const isBand = armed.length > 0 || !(await isPaneOpen($))
    if (!isBand) return next(e)

    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    if (armed.length > 0) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color={HUE.hot} weight="semibold">
              {pulse(beat, '⚠')} FAN-OUT GUARD ARMED{' '}
            </Text>
            <Text wrap="truncate-end">
              {armed.map(a => a.why).join(' · ')}
              <Text dimColor> · workflows and a 2nd agent ask first</Text>
            </Text>
          </Box>
          {below}
        </Box>
      )
    }

    const width = Math.max(6, Math.min(16, Math.floor(e.props.bodyColumns / 10)))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {views.map(v => (
            <Text key={v.kind}>
              <Text weight="semibold">{label(v.kind)} </Text>
              {gauge(v.percent, v.projected, THRESHOLDS[v.kind], width).map((seg, i) => (
                <Text key={`g:${i}`} color={seg.color} dimColor={seg.dim === true}>
                  {seg.text}
                </Text>
              ))}
              <Text> {v.percent}%</Text>
              <Text dimColor>{v.resetsAt === undefined ? '' : ` ↺${duration(v.resetsAt - now)}`}</Text>
              {v.fullAt !== undefined && <Text color="warning"> full ~{clock(v.fullAt)}</Text>}
              {'   '}
            </Text>
          ))}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const views = await read($, windows)
    const g = await read($, guard)
    await read($, tick)
    const beat = await read($, frame)
    const now = await $.clock.now()
    const cols = Math.max(24, e.props.bodyColumns)
    const armed = armedBy(views, now)
    const at = glide(views)

    const segs = (line: Seg[], key: string) => (
      <Box key={key} flexDirection="row">
        {line.map((seg, i) => (
          <Text key={`${key}:${i}`} color={seg.color ?? seg.tone} dimColor={seg.dim === true} weight={seg.bold === true ? "semibold" : "regular"} wrap="truncate-end">
            {seg.text}
          </Text>
        ))}
      </Box>
    )

    const rows: Seg[][] = []
    if (views.length === 0) rows.push([{ text: 'No reading yet: the first response reports one.', dim: true }])
    for (const v of views) {
      const shown = at.get(v.kind) ?? v.percent
      const threshold = THRESHOLDS[v.kind]
      if (v.resetsAt !== undefined && canRace(v.kind, cols)) {
        if (rows.length > 0) rows.push([])
        rows.push(
          ...raceLines({
            kind: v.kind,
            pct: v.percent,
            shown,
            resetsAt: v.resetsAt,
            now,
            ratePerHour: v.ratePerHour,
            threshold,
            lastRiseAt: v.lastRiseAt,
            tick: beat,
            width: cols,
          }),
        )
        rows.push([{ text: cut(v.ratePerHour === undefined ? 'pace: measuring' : `pace: ${v.ratePerHour.toFixed(1)} pts/h`, cols), dim: true }])
        if (v.history !== undefined && v.history.length > 1) {
          rows.push([{ text: spark(v.history, cols - 8, 100), color: HUE.cold }, { text: ' recent', dim: true }])
        }
        continue
      }
      const pct = `${Math.round(shown)}%`
      rows.push([{ text: rule(`${label(v.kind)} window`, cols), dim: true }])
      rows.push([...gauge(shown, v.projected, threshold, cols - pct.length - 1), { text: ` ${pct}`, bold: true, color: heat(v.percent / 100, 0.7, (threshold ?? 90) / 100) }])
      const facts = [
        v.resetsAt === undefined ? undefined : `↺ resets in ${duration(v.resetsAt - now)}`,
        v.ratePerHour === undefined ? 'pace: measuring' : `${v.ratePerHour.toFixed(1)} pts/h`,
      ].filter((f): f is string => f !== undefined)
      const line: Seg[] = [{ text: cut(facts.join(' · '), cols), dim: true }]
      if (v.fullAt !== undefined) line.push({ text: ` · full ~${clock(v.fullAt)}`, color: HUE.hot, bold: true })
      else if (v.projected !== undefined) line.push({ text: ` · ≈${Math.round(v.projected)}% at reset`, color: HUE.calm })
      rows.push(line)
      if (v.history !== undefined && v.history.length > 1) {
        rows.push([{ text: spark(v.history, cols - 8, 100), color: HUE.cold }, { text: ' recent', dim: true }])
      }
    }

    rows.push([{ text: rule('Fan-out guard', cols), dim: true }])
    if (armed.length > 0) {
      rows.push([
        { text: `${pulse(beat, '●')} `, color: HUE.hot, bold: true },
        { text: 'ARMED', color: HUE.hot, bold: true },
        { text: ' — workflows and a 2nd agent per turn ask first', dim: true },
      ])
      for (const a of armed) rows.push([{ text: `  ${cut(a.why, cols - 2)}`, color: HUE.hot }])
    } else {
      const arms = Object.entries(THRESHOLDS).map(([kind, t]) => `${label(kind)} ≥${t}%`)
      rows.push([
        { text: '○ ', color: HUE.calm, bold: true },
        { text: 'standby', color: HUE.calm, bold: true },
        { text: cut(` — arms at ${arms.join(' · ')} or when a window is projected full before reset`, cols - 9), dim: true },
      ])
    }
    rows.push([{ text: `  agents this turn: ${g.agentsThisTurn}`, dim: true }])
    for (const d of [...g.decisions].reverse()) {
      rows.push([
        { text: `  ${clock(d.at)} ` },
        d.ran ? { text: '✓ ran', color: HUE.warm } : { text: '✗ held', color: HUE.calm },
        { text: ` ${d.what} — ${d.why}`, dim: true },
      ])
    }

    return <Box flexDirection="column">{rows.map((line, i) => segs(line, `row:${i}`))}</Box>
  })
}
