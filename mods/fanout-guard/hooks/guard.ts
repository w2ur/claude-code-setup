export type Reading = { kind: string; percentUsed: number; resetsAt?: string }

export const THRESHOLDS: Record<string, number> = { five_hour: 85, seven_day: 90 }

const MINUTE = 60_000

// Time to reset as a duration, never a bare clock time: "resets 14:00" on a
// 7-day window reads as today and invites "Run it" four days early.
export function untilReset(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

// The windows over their threshold, as one line for the question and the deny.
export function overThreshold(limits: Reading[], now: number): string | undefined {
  const hot = limits.filter(l => l.percentUsed >= (THRESHOLDS[l.kind] ?? Infinity))
  if (hot.length === 0) return undefined
  return hot
    .map(l => {
      const name = l.kind === 'five_hour' ? '5h' : '7d'
      if (l.resetsAt === undefined) return `${name} at ${l.percentUsed}%`
      return `${name} at ${l.percentUsed}% (resets in ${untilReset(Date.parse(l.resetsAt) - now)})`
    })
    .join(', ')
}

// A Workflow is always a fan-out; one Agent is a delegation, the second in a
// turn is a fan-out.
export function isFanOut(tool: string, agentsThisTurn: number): boolean {
  return tool === 'Workflow' || (tool === 'Agent' && agentsThisTurn >= 2)
}
