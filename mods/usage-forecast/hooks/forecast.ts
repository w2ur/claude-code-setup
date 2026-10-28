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

// ---------------------------------------------------------------------------
// The fan-out guard (was the fanout-guard mod): asks before a Workflow or a
// second Agent in one turn while a window runs high.
// ---------------------------------------------------------------------------

export const THRESHOLDS: Record<string, number> = { five_hour: 85, seven_day: 90 }

// The windows a projection may arm, and the share below which it is noise:
// early on, a few whole-point moves over a short span read as a sprint. The
// 7-day window is left out: its pace comes from active hours and is
// extrapolated over nights and days off, so it would arm on any busy stretch.
export const PROJECTION_FLOOR: Record<string, number> = { five_hour: 60 }

export type Armed = { kind: string; why: string }

// The windows that arm the guard, each with its reason. A raw threshold arms
// as before; a 5-hour window projected to fill before it resets arms too, so
// the guard speaks while the limit can still be avoided, not once it nearly
// is. A window whose reset has passed arms nothing: its reading is stale.
// Time to reset as a duration, never a bare clock time: "resets 14:00" on a
// 7-day window reads as today and invites "Run it" four days early.
export function armedBy(
  views: readonly { kind: string; percent: number; resetsAt?: number; fullAt?: number }[],
  now: number,
): Armed[] {
  const out: Armed[] = []
  for (const v of views) {
    const threshold = THRESHOLDS[v.kind]
    if (threshold === undefined) continue
    if (v.resetsAt !== undefined && v.resetsAt <= now) continue
    const reset = v.resetsAt === undefined ? '' : ` (resets in ${duration(v.resetsAt - now)})`
    const floor = PROJECTION_FLOOR[v.kind]
    if (v.percent >= threshold) out.push({ kind: v.kind, why: `${label(v.kind)} at ${v.percent}%${reset}` })
    else if (v.fullAt !== undefined && floor !== undefined && v.percent >= floor) {
      out.push({ kind: v.kind, why: `${label(v.kind)} at ${v.percent}%, full in ${duration(v.fullAt - now)} at this pace${reset}` })
    }
  }
  return out
}

// A Workflow is always a fan-out; one Agent is a delegation, the second in a
// turn is a fan-out.
export function isFanOut(tool: string, agentsThisTurn: number): boolean {
  return tool === 'Workflow' || (tool === 'Agent' && agentsThisTurn >= 2)
}

// Where the window will stand at its reset at this pace, capped at 100: the
// ghost drawn ahead of the gauge.
export function projectedAtReset(
  pct: number,
  ratePerHour: number | undefined,
  now: number,
  resetsAt: number | undefined,
): number | undefined {
  if (ratePerHour === undefined || ratePerHour <= 0 || resetsAt === undefined) return undefined
  return Math.min(100, pct + ((resetsAt - now) / HOUR) * ratePerHour)
}

// When the percentage last moved up between two kept samples; the race scene
// keeps its runner moving for a few minutes after.
export function lastRise(samples: readonly Sample[]): number | undefined {
  for (let i = samples.length - 1; i > 0; i--) {
    if ((samples[i]?.pct ?? 0) > (samples[i - 1]?.pct ?? 0)) return samples[i]?.t
  }
  return undefined
}
