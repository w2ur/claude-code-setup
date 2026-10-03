export type Sample = { t: number; pct: number }

export type WindowSamples = { resetsAt: string; samples: Sample[] }

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// How far back the burn rate looks, and the shortest span it trusts. The
// window only reports whole-point moves, so a short span overstates the pace.
export const LOOKBACK: Record<string, { span: number; minSpan: number }> = {
  five_hour: { span: 45 * MINUTE, minSpan: 5 * MINUTE },
  seven_day: { span: 12 * HOUR, minSpan: HOUR },
}

export const ALERT_LEVELS = [80, 95]

// Appends a reading; a new `resetsAt` means a new window, so the old samples go.
export function addSample(
  held: WindowSamples | undefined,
  resetsAt: string,
  sample: Sample,
  span: number,
): WindowSamples {
  const kept = held !== undefined && held.resetsAt === resetsAt ? held.samples : []
  const samples = [...kept, sample].filter(s => s.t >= sample.t - span).sort((a, b) => a.t - b.t)
  return { resetsAt, samples }
}

// Percentage points per hour from the oldest kept sample to the newest.
export function burnRate(samples: Sample[], minSpan: number): number | undefined {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined || first === last) return undefined
  const span = last.t - first.t
  if (span < minSpan) return undefined
  const delta = last.pct - first.pct
  if (delta <= 0) return 0
  return (delta / span) * HOUR
}

// When the window reaches 100% at `ratePerHour`; undefined if it resets first.
export function projectFull(
  pct: number,
  ratePerHour: number | undefined,
  now: number,
  resetsAt: number | undefined,
): number | undefined {
  if (ratePerHour === undefined || ratePerHour <= 0) return undefined
  const at = now + ((100 - pct) / ratePerHour) * HOUR
  if (resetsAt !== undefined && at >= resetsAt) return undefined
  return at
}

// The highest alert level crossed that has not been alerted in this window.
export function levelToAlert(pct: number, alerted: number[]): number | undefined {
  const due = ALERT_LEVELS.filter(level => pct >= level && !alerted.includes(level))
  return due.length === 0 ? undefined : Math.max(...due)
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

export function label(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return kind
}
