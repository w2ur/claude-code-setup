import type { Fleet, PeerRun, PeerSnapshot } from '../types'
import { isLive, runStats, runTitle } from './fleet'

// Spec: ~/.claude/plans/2026-11-02-session-watch-design.md (Fleet section).
// A session rewrites its snapshot at least this often, even when idle.
export const HEARTBEAT_MS = 15_000
// A snapshot whose heartbeat is older than this belongs to a dead session.
export const LIVE_WINDOW_MS = 60_000
// Under the Claude config dir.
export const SESSION_WATCH_DIR = 'state/session-watch'

// Live runs only. A workflow between phases outside the settling grace is
// published as idle (accepted by the owner, 2026-11-02).
export function snapshotOf(f: Fleet, envelope: Omit<PeerSnapshot, 'v' | 'runs'>): PeerSnapshot {
  const runs: PeerRun[] = []
  for (const id of f.order) {
    const run = f.runs[id]
    if (run === undefined || !isLive(f, run)) continue
    const stats = runStats(f, run)
    runs.push({
      title: runTitle(run),
      kind: run.kind,
      total: stats.total,
      done: stats.done,
      failed: stats.failed,
      startedAt: run.startedAt,
    })
  }
  return { v: 1, ...envelope, runs }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function isPeerRun(x: unknown): x is PeerRun {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return (
    typeof r.title === 'string' &&
    (r.kind === 'workflow' || r.kind === 'subagents') &&
    isNum(r.total) &&
    isNum(r.done) &&
    isNum(r.failed) &&
    isNum(r.startedAt)
  )
}

// A truncated file (read mid-write) or a foreign version is undefined, never an error.
export function parsePeer(text: string): PeerSnapshot | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as Record<string, unknown>
  if (p.v !== 1) return undefined
  if (typeof p.sessionId !== 'string' || typeof p.cwd !== 'string') return undefined
  if (!isNum(p.startedAt) || !isNum(p.heartbeatAt)) return undefined
  if (p.endedAt !== undefined && !isNum(p.endedAt)) return undefined
  if (!Array.isArray(p.runs) || !p.runs.every(isPeerRun)) return undefined
  return p as unknown as PeerSnapshot
}

export function isLivePeer(p: PeerSnapshot, now: number): boolean {
  return p.endedAt === undefined && now - p.heartbeatAt <= LIVE_WINDOW_MS
}

export function livePeers(all: PeerSnapshot[], selfId: string, now: number): PeerSnapshot[] {
  return all.filter(p => p.sessionId !== selfId && isLivePeer(p, now)).sort((a, b) => a.startedAt - b.startedAt)
}

export function sameContent(a: PeerSnapshot | undefined, b: PeerSnapshot): boolean {
  if (a === undefined) return false
  return JSON.stringify({ ...a, heartbeatAt: 0 }) === JSON.stringify({ ...b, heartbeatAt: 0 })
}
