import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextBarRow, ContextBarSnapshot } from '../types'
import { formatTokens, segmentWidths } from './bar'

const isShown = atom({ plugin: 'context-bar', key: 'isShown' } as const, false)
const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)

// `summary` estimates locally; `full` would send one token-count request per
// tool and memory file on every measurement.
async function refresh($: EngineInterface): Promise<void> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown
  if (breakdown === undefined) return

  const rows: ContextBarRow[] = breakdown.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, isFree: c.kind === 'free' }))
  const next: ContextBarSnapshot = {
    rows,
    usedTokens: breakdown.totalTokens,
    maxTokens: breakdown.rawMaxTokens,
    percent: breakdown.percentage,
  }
  await update($, snapshot, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-bar',
      description: 'Toggle the context window bar above the prompt',
    })
    const wasShown = (await $.store.get('isShown')) === true
    await update($, isShown, () => wasShown)
    if (wasShown) await refresh($)

    return next(e)
  })

  on('command.run', { command: 'context-bar' }, async $ => {
    const shown = !(await read($, isShown))
    await update($, isShown, () => shown)
    await $.store.set('isShown', shown)
    if (shown) await refresh($)

    return { text: shown ? 'Context bar on.' : 'Context bar off.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && (await read($, isShown))) await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, snapshot)
    if (e.props.hasSurvey || data === null || !(await read($, isShown))) return next(e)

    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns - 2)
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
        </Box>
        <Box flexDirection="row" flexWrap="wrap">
          <Text bold>
            {data.percent}% · {formatTokens(data.usedTokens)}/{formatTokens(data.maxTokens)}
            {'  '}
          </Text>
          {data.rows
            .filter(row => !row.isFree)
            .map(row => (
              <Text key={row.name}>
                <Text color={row.color}>■</Text> {row.name} {formatTokens(row.tokens)}
                {'  '}
              </Text>
            ))}
        </Box>
        {below}
      </Box>
    )
  })
}
