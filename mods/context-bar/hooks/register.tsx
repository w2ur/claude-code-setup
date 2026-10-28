import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextBarReading, ContextBarRow, ContextBarSnapshot, ContextBarView } from '../types'
import { formatTokens, fractionsOf, glide, isSettled, segmentWidths } from './bar'
import { PANE_COLUMNS, heat } from './gfx'
import { historyLines } from './history'
import { itemsOf } from './items'
import { squareLines } from './squares'
import type { Line, Seg } from './squares'

const PANE = 'context'
const FRAME_MS = 125
const HISTORY_MAX = 120
// The panel mod's two answers to /panel (mods/panel/hooks/register.tsx).
const PANEL_OPENED = 'Panel opened.'
const PANEL_CLOSED = 'Panel closed.'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
const view = atom({ plugin: 'context-bar', key: 'view' } as const, null)
// Change the tag when the series' meaning changes: a reload declines what an
// earlier version stored.
const history = atom({ plugin: 'context-bar', key: 'history' } as const, [], { shape: 'reading-2' })
// The category whose items the legend lists; pressing its row again, or another, moves it.
const expanded = atom({ plugin: 'context-bar', key: 'expanded' } as const, null)
// Read by the pane's drawing only: bumping it is what asks for a frame.
const tick = atom({ plugin: 'context-bar', key: 'tick' } as const, 0)

const targetOf = (s: ContextBarSnapshot): ContextBarView => ({
  percent: s.percent,
  fractions: fractionsOf(s.rows, s.maxTokens),
})

async function isRemembered($: EngineInterface): Promise<boolean> {
  return (await $.store.get('paneOpen')) === true
}

async function isPaneListed($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
}

// `summary` estimates locally and already carries the per-item lists the pane
// expands (MCP tools, skills, memory files, agents); `full` would only count
// them with one token-count request per tool and memory file on every measurement.
async function refresh($: EngineInterface): Promise<void> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown
  if (breakdown === undefined) return

  const rows: ContextBarRow[] = breakdown.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => {
      const kind = c.kind === 'free' || c.kind === 'buffer' ? c.kind : 'used'
      const items = itemsOf({ name: c.name, kind }, breakdown)

      return { name: c.name, tokens: c.tokens, color: c.color, isFree: kind === 'free', kind, ...(items.length === 0 ? {} : { items }) }
    })
  const next: ContextBarSnapshot = {
    rows,
    usedTokens: breakdown.totalTokens,
    maxTokens: breakdown.rawMaxTokens,
    percent: breakdown.percentage,
    isAutoCompactEnabled: breakdown.isAutoCompactEnabled,
    ...(breakdown.autoCompactThreshold === undefined ? {} : { autoCompactAt: breakdown.autoCompactThreshold }),
  }
  const last = await read($, snapshot)
  const isSame = last !== null && last.percent === next.percent && last.usedTokens === next.usedTokens
  await update($, snapshot, () => next)
  // The first snapshot is drawn as it is; only a change glides.
  await update($, view, v => v ?? targetOf(next))
  // A re-measure that changes nothing (session start, /panel) adds no point.
  if (!isSame) {
    const reading: ContextBarReading = { percent: next.percent, at: await $.clock.now() }
    await update($, history, h => [...h, reading].slice(-HISTORY_MAX))
  }
}

// One frame of the glide, only while the pane is on screen and still moving:
// an idle pane asks for no redraw.
async function frame($: EngineInterface): Promise<void> {
  const [snap, drawn] = await Promise.all([read($, snapshot), read($, view)])
  if (snap === null || drawn === null) return
  const target = targetOf(snap)
  if (isSettled(drawn, target)) return
  if (!(await isPaneShown($))) {
    // Nothing is on screen to glide: snap, so the timer has nothing left to do.
    await update($, view, () => target)
    return
  }

  await update($, view, v => (v === null ? v : glide(v, target)))
  await update($, tick, t => t + 1)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(FRAME_MS, () => {
      void frame($).catch(() => undefined)
    })
    // Reopened unasked: the engine seats it only where the terminal is wide enough.
    if (await isRemembered($)) {
      await $.ui.open({ id: PANE, title: 'Context', columns: PANE_COLUMNS })
      await refresh($)
    }

    return next(e)
  })

  on('command.run', { command: 'panel' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      if (answer.text === PANEL_OPENED) {
        await $.ui.open({ id: PANE, title: 'Context', columns: PANE_COLUMNS })
        await $.store.set('paneOpen', true)
        await refresh($)
      } else if (answer.text === PANEL_CLOSED) {
        await $.ui.close({ id: PANE })
        await $.store.set('paneOpen', false)
      }
    } catch {
      // The tab is this mod's affair; the panel's answer stands.
    }

    return answer
  })

  // Only the person's close is a decision to forget; the mod's own close and
  // the engine's unload leave the pane to come back.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('paneOpen', false)

    return closed
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tick)
    const [data, drawn, series, open, now] = await Promise.all([
      read($, snapshot),
      read($, view),
      read($, history),
      read($, expanded),
      $.clock.now(),
    ])
    if (data === null || drawn === null) return <Text dimColor>Waiting for the first measurement.</Text>

    const width = Math.max(10, e.props.bodyColumns)
    const color = heat(drawn.percent / 100)
    const lines = squareLines({ ...data, percent: drawn.percent, accent: color, columns: width, expanded: open })
    const chart = historyLines({ readings: series, width, now, accent: color })
    const toggle = (name: string): void => {
      void update($, expanded, current => (current === name ? null : name))
        .then(() => update($, tick, t => t + 1))
        .catch(() => undefined)
    }

    // Consecutive segments sharing a `press` are one Button; the rest are Text.
    const drawSegs = (line: Line, i: number) => {
      const groups: Seg[][] = []
      for (const s of line) {
        const last = groups.at(-1)
        if (last !== undefined && last[0]?.press === s.press) last.push(s)
        else groups.push([s])
      }
      const texts = (segs: Seg[], j: number) =>
        segs.map((s, k) => (
          <Text key={`${i}:${j}:${k}`} bold={s.bold} color={s.color} dimColor={s.dim}>
            {s.text}
          </Text>
        ))

      return groups.map((g, j) => {
        const name = g[0]?.press
        return name === undefined ? texts(g, j) : (
          <Button key={`cat:${name}`} plain onPress={() => toggle(name)}>
            {texts(g, j)}
          </Button>
        )
      })
    }

    return (
      <Box flexDirection="column">
        {lines.map((line, i) =>
          line.some(s => s.press !== undefined) ? (
            <Box key={`square:${i}`} flexDirection="row">
              {drawSegs(line, i)}
            </Box>
          ) : (
            <Text key={`square:${i}`}>{drawSegs(line, i)}</Text>
          ),
        )}
        <Text> </Text>
        {chart.map((line, i) => (
          <Text key={`history:${i}`}>{drawSegs(line, 1000 + i)}</Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, snapshot)
    if (e.props.hasSurvey || data === null) return next(e)
    // The pane says all of this, shown or behind another tab; the band would only repeat it.
    if (await isPaneListed($)) return next(e)

    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, Math.min(40, e.props.bodyColumns - 20))
    const cells = segmentWidths(data.rows.map(r => r.tokens), width)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {data.rows.map((row, i) =>
            (cells[i] ?? 0) > 0 ? (
              <Text key={row.name} color={row.isFree ? undefined : row.color} dimColor={row.isFree}>
                {(row.isFree ? '░' : '█').repeat(cells[i] ?? 0)}
              </Text>
            ) : null,
          )}
          <Text bold color={heat(data.percent / 100)}>
            {' '}
            {data.percent}%
          </Text>
          <Text dimColor> {formatTokens(data.usedTokens)}/{formatTokens(data.maxTokens)}</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
