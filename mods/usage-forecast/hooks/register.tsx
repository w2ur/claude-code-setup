import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { UsageWindowView } from '../types'
import {
  LOOKBACK,
  addSample,
  burnRate,
  clock,
  duration,
  label,
  levelToAlert,
  projectFull,
} from './forecast'
import type { WindowSamples } from './forecast'

const windows = atom({ plugin: 'usage-forecast', key: 'windows' } as const, [])
const tick = atom({ plugin: 'usage-forecast', key: 'tick' } as const, 0)
const isShown = atom({ plugin: 'usage-forecast', key: 'isShown' } as const, false)

// $.store is shared by every session, so the burn rate counts what parallel
// sessions spend too: the limit is the account's, not this session's.
async function observe($: EngineInterface, limit: SessionRateLimit, now: number): Promise<UsageWindowView> {
  const look = LOOKBACK[limit.kind]
  const resetsAt = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt)
  let ratePerHour: number | undefined

  if (look !== undefined && limit.resetsAt !== undefined) {
    const key = `samples:${limit.kind}`
    const held = (await $.store.get(key)) as WindowSamples | undefined
    const next = addSample(held, limit.resetsAt, { t: now, pct: limit.percentUsed }, look.span)
    await $.store.set(key, next)
    ratePerHour = burnRate(next.samples, look.minSpan)

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
  }
}

async function seed($: EngineInterface): Promise<void> {
  if ((await read($, windows)).length > 0) return
  const { rateLimits } = await $.session.usage()
  if (rateLimits.length === 0) return
  const now = await $.clock.now()
  const views: UsageWindowView[] = []
  for (const limit of rateLimits) views.push(await observe($, limit, now))
  await update($, windows, () => views)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-bar',
      description: 'Toggle the rate-limit band above the prompt: usage, reset countdown, burn rate, projected full time',
    })
    const wasShown = (await $.store.get('isShown')) === true
    await update($, isShown, () => wasShown)
    if (wasShown) await seed($)
    // Countdowns age between measurements; one redraw a minute keeps them true.
    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const now = await $.clock.now()
      const views: UsageWindowView[] = []
      for (const limit of e.rateLimits) views.push(await observe($, limit, now))
      await update($, windows, () => views)
    }

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    const shown = !(await read($, isShown))
    await update($, isShown, () => shown)
    await $.store.set('isShown', shown)
    if (!shown) return { text: 'Usage bar off.' }
    await seed($)
    const hasReading = (await read($, windows)).length > 0

    return { text: hasReading ? 'Usage bar on.' : 'Usage bar on; it shows after the first response reports a reading.' }
  })

  // Composes with any other band (context-bar): this row on top, the rest of
  // the chain's tree beneath it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const views = await read($, windows)
    if (e.props.hasSurvey || views.length === 0 || !(await read($, isShown))) return next(e)

    await read($, tick)
    const now = await $.clock.now()
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const gauge = Math.max(6, Math.min(16, Math.floor(e.props.bodyColumns / 10)))

    const row = (
      <Box flexDirection="row" flexWrap="wrap">
        {views.map(v => {
          const filled = Math.min(gauge, Math.round((v.percent / 100) * gauge))
          const hot = v.percent >= 95 ? 'error' : v.percent >= 80 ? 'warning' : 'success'
          const reset = v.resetsAt === undefined ? '' : ` ↺${duration(v.resetsAt - now)}`
          const pace = v.ratePerHour === undefined ? '' : ` ${v.ratePerHour.toFixed(1)}/h`
          return (
            <Text key={v.kind}>
              <Text bold>{label(v.kind)} </Text>
              <Text color={hot}>{'█'.repeat(filled)}</Text>
              <Text dimColor>{'░'.repeat(gauge - filled)}</Text>
              <Text> {v.percent}%</Text>
              <Text dimColor>
                {reset}
                {pace}
              </Text>
              {v.fullAt !== undefined && <Text color="warning"> full ~{clock(v.fullAt)}</Text>}
              {'   '}
            </Text>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
