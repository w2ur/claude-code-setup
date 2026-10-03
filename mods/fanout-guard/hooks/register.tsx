import type { EngineInterface, Register } from 'claude-code'

import { isFanOut, overThreshold } from './guard'
import type { Reading } from './guard'

const RUN = 'Run it'

// Per turn, reset on each prompt. A hot reload resets them too, which at
// worst asks once more.
let agentsThisTurn = 0
// One question per turn: parallel Agent calls share the pending answer.
let decision: Promise<boolean> | undefined

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

async function gate($: EngineInterface, tool: string): Promise<string | undefined> {
  if (tool === 'Agent') agentsThisTurn += 1
  if (!isFanOut(tool, agentsThisTurn)) return undefined

  // Fail open: a guard that cannot read usage must not block the work.
  let rateLimits: Reading[]
  try {
    rateLimits = (await $.session.usage()).rateLimits
  } catch {
    return undefined
  }
  const why = overThreshold(rateLimits, await $.clock.now())
  if (why === undefined) return undefined

  decision ??= ask($, why, tool === 'Workflow' ? 'workflow' : 'parallel agent dispatch')
  if (await decision) return undefined
  return `${$.plugin.name}: ${why}; the owner held this fan-out. Finish the work inline without spawning more agents, or stop and report where things stand.`
}

export const register: Register = on => {
  on('prompt.submit', ($, e, next) => {
    agentsThisTurn = 0
    decision = undefined

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
}
