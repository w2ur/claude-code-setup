import type { ParsedPlan, PlanView } from '../types'
import type { Ledger } from './ledger'
import { siblingsOf } from './plans'

// Spec: 2026-11-02-session-watch-design.md, "Plans: the execution ledger is the
// signal" — a ledger changed within this window means the plan is running.
export const RUNNING_WINDOW_MS = 30 * 60_000

export type { PlanView }

// A `~/` path carries no home directory here, so it matches when the absolute
// plan path ends with the same tail (`~/.claude/plans/x.md` vs `/h/.claude/plans/x.md`).
export function pointsAt(planPath: string, absolute: string): boolean {
  if (planPath.startsWith('~/')) return absolute.endsWith(planPath.slice(1))
  return planPath === absolute
}

// The repo a ledger root belongs to: a `.worktrees/<wt>` or `.claude/worktrees/<wt>`
// root shows its repo, the config dir shows `~/.claude`.
function repoLabel(root: string, configDir: string): string {
  const path = root.replace(/\/+$/, '')
  if (path === configDir) return '~/.claude'
  const main = /^(.*?)\/(?:\.claude\/worktrees|\.worktrees)\/[^/]+$/.exec(path)?.[1] ?? path

  return main.split('/').pop() ?? main
}

// Join ledgers to plans: unfinished plans with a ledger, running first, then
// stalled, newest ledger first in each. Ledgers of unknown plans are dropped.
export function viewsOf(plans: ParsedPlan[], ledgers: Ledger[], allFiles: string[], configDir: string, now: number): PlanView[] {
  const base = configDir.replace(/\/$/, '')
  const out: { view: PlanView; mtimeMs: number }[] = []
  for (const plan of plans) {
    const absolute = `${base}/plans/${plan.file}`
    let best: Ledger | undefined
    for (const l of ledgers) {
      if (!pointsAt(l.planPath, absolute)) continue
      if (best === undefined || l.mtimeMs > best.mtimeMs) best = l
    }
    if (best === undefined) continue
    const done = new Set(best.completed)
    if (best.isFinal || plan.tasks.every((t) => done.has(t.id))) continue
    const tasks = plan.tasks.map((t) => ({ ...t, isDone: done.has(t.id) }))
    const touched = best.lastTouched !== undefined && !done.has(best.lastTouched) ? plan.tasks.find((t) => t.id === best.lastTouched) : undefined
    const current = touched ?? plan.tasks.find((t) => !done.has(t.id))
    const ageMs = Math.max(0, now - best.mtimeMs)
    const view: PlanView = {
      file: plan.file,
      title: plan.title,
      status: ageMs <= RUNNING_WINDOW_MS ? 'running' : 'stalled',
      done: tasks.filter((t) => t.isDone).length,
      total: tasks.length,
      repo: best.repo ?? repoLabel(best.root, base),
      ageMs,
      siblings: siblingsOf(plan, allFiles),
      tasks,
    }
    if (current !== undefined) view.current = current
    out.push({ view, mtimeMs: best.mtimeMs })
  }
  const rank = (v: PlanView): number => (v.status === 'running' ? 0 : 1)
  out.sort((a, b) => rank(a.view) - rank(b.view) || b.mtimeMs - a.mtimeMs)
  return out.map((o) => o.view)
}
