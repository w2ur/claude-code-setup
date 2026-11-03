import type { EngineInterface } from 'claude-code'

import type { ParsedPlan } from '../types'
import { parseLedger } from './ledger'
import type { Ledger } from './ledger'
import { parsePlan } from './plans'
import { pointsAt } from './views'

const none = (): undefined => undefined

// The Claude config dir (no API returns it): the env var, else the home
// default. Undefined unless absolute, since `$.fs` resolves a relative path
// against the session cwd.
export async function dirsOf($: EngineInterface): Promise<{ configDir: string; devDir: string } | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const homeDir = home?.replace(/\/+$/, '')
  const configDir = configured?.replace(/\/+$/, '') || (homeDir ? `${homeDir}/.claude` : '')
  if (!configDir.startsWith('/') || !homeDir?.startsWith('/')) return undefined

  return { configDir, devDir: `${homeDir}/Dev` }
}

async function namesOf($: EngineInterface, dir: string, kind: 'file' | 'dir'): Promise<{ name: string; mtimeMs: number }[]> {
  return ((await $.fs.list(dir).catch(none)) ?? []).filter(e => e.kind === kind).map(e => ({ name: e.name, mtimeMs: e.mtimeMs }))
}

export type Root = { path: string; repo?: string }

// The worktrees git knows for a repo: `<root>/.git/worktrees/*/gitdir` holds the
// worktree's `.git` path, wherever the worktree lives.
async function gitWorktrees($: EngineInterface, root: string): Promise<string[]> {
  const out: string[] = []
  for (const wt of await namesOf($, `${root}/.git/worktrees`, 'dir')) {
    const text = await $.fs.read(`${root}/.git/worktrees/${wt.name}/gitdir`).catch(none)
    const path = text?.split('\n')[0]?.trim().replace(/\/\.git$/, '')
    if (path?.startsWith('/')) out.push(path)
  }

  return out
}

// Roots found by the last full discovery, reused for ROOTS_TTL_MS: listing the
// dev dir and every repo's worktree folders on each 5 s poll is the dominant cost.
const ROOTS_TTL_MS = 60_000
let rootsCache: { key: string; at: number; roots: Root[] } | undefined

// Where ledgers can live: the config dir, each repo under the dev dir, and each
// of their worktrees (those git knows, plus `.worktrees/*` and
// `.claude/worktrees/*` directories). A worktree carries its main repo's label,
// whatever order the repos are listed in. Undefined when the dev dir itself
// cannot be listed: unknown, not "no ledger".
export async function ledgerRoots($: EngineInterface, devDir: string, configDir: string): Promise<Root[] | undefined> {
  const now = await $.clock.now()
  const key = `${devDir}\n${configDir}`
  if (rootsCache !== undefined && rootsCache.key === key && now - rootsCache.at >= 0 && now - rootsCache.at < ROOTS_TTL_MS) return rootsCache.roots
  const repos = await $.fs.list(devDir).catch(none)
  if (repos === undefined) return undefined
  const roots = new Map<string, Root>()
  // A label added later wins over an earlier unlabelled add of the same path.
  const add = (path: string, repo?: string): void => {
    const held = roots.get(path)
    if (held === undefined || (held.repo === undefined && repo !== undefined)) roots.set(path, repo === undefined ? { path } : { path, repo })
  }
  const mains: { path: string; label: string }[] = [{ path: configDir, label: '~/.claude' }]
  for (const repo of repos.filter(e => e.kind === 'dir')) mains.push({ path: `${devDir}/${repo.name}`, label: repo.name })
  const found = await Promise.all(
    mains.map(async ({ path }) => {
      const subs = await Promise.all(['.worktrees', '.claude/worktrees'].map(async sub => (await namesOf($, `${path}/${sub}`, 'dir')).map(wt => `${path}/${sub}/${wt.name}`)))

      return { git: await gitWorktrees($, path), dirs: subs.flat() }
    }),
  )
  mains.forEach(({ path }) => add(path))
  mains.forEach(({ label }, i) => {
    for (const wt of [...(found[i]?.git ?? []), ...(found[i]?.dirs ?? [])]) add(wt, label)
  })
  const list = [...roots.values()]
  rootsCache = { key, at: now, roots: list }

  return list
}

// Parsed plans by absolute path, re-read only when the listing's mtime moved.
// Module state: reset by session.start.
let planCache = new Map<string, { mtimeMs: number; plan: ParsedPlan | undefined }>()

export function resetPlanCache(): void {
  planCache = new Map()
  ledgerCache = new Map()
  rootsCache = undefined
}

// Plans at the top level of <config>/plans and one subfolder deep, never under
// archive/. `allFiles` holds every .md name (reviews and specs too), for
// siblings, from the listing alone. Only a plan some ledger names is read (a
// plan without a ledger is never drawn). Undefined when the plans dir cannot be
// listed: unknown, not "no plan".
export async function readPlans($: EngineInterface, configDir: string, ledgers: Ledger[]): Promise<{ plans: ParsedPlan[]; allFiles: string[] } | undefined> {
  const base = `${configDir}/plans`
  const top = await $.fs.list(base).catch(none)
  if (top === undefined) return undefined
  const found: { file: string; mtimeMs: number }[] = top.filter(e => e.kind === 'file').map(e => ({ file: e.name, mtimeMs: e.mtimeMs }))
  for (const d of top.filter(e => e.kind === 'dir' && e.name !== 'archive')) {
    for (const f of await namesOf($, `${base}/${d.name}`, 'file')) found.push({ file: `${d.name}/${f.name}`, mtimeMs: f.mtimeMs })
  }
  const listed = found.filter(f => f.file.endsWith('.md'))
  const plans: ParsedPlan[] = []
  for (const { file, mtimeMs } of listed) {
    const absolute = `${base}/${file}`
    if (!ledgers.some(l => pointsAt(l.planPath, absolute))) continue
    let held = planCache.get(absolute)
    if (held === undefined || held.mtimeMs !== mtimeMs) {
      const text = await $.fs.read(absolute).catch(none)
      if (text === undefined) continue
      held = { mtimeMs, plan: parsePlan(file, text) }
      planCache.set(absolute, held)
    }
    if (held.plan !== undefined) plans.push(held.plan)
  }

  return { plans, allFiles: listed.map(f => f.file) }
}

// Parsed ledgers by progress.md path, re-read only when the listing's mtime moved
// (the plan-path marker is read with the ledger and shares its lifetime).
let ledgerCache = new Map<string, { mtimeMs: number; ledger: Ledger | undefined }>()

// Every readable ledger under `<root>/.superpowers/sdd/*/progress.md`. A failed
// read drops that one ledger for this poll. Roots and ledger folders are listed
// concurrently; the result keeps root order.
export async function readLedgers($: EngineInterface, roots: Root[]): Promise<Ledger[]> {
  const perRoot = await Promise.all(
    roots.map(async ({ path: root, repo }) => {
      const sdd = `${root}/.superpowers/sdd`
      const perDir = await Promise.all(
        (await namesOf($, sdd, 'dir')).map(async (d): Promise<Ledger | undefined> => {
          const dir = `${sdd}/${d.name}`
          // A symlink lists with mtimeMs 0: only a regular file is a ledger.
          const progress = (await $.fs.list(dir).catch(none))?.find(e => e.name === 'progress.md' && e.kind === 'file' && !e.isLink)
          if (progress === undefined) return undefined
          const path = `${dir}/progress.md`
          let held = ledgerCache.get(path)
          if (held === undefined || held.mtimeMs !== progress.mtimeMs) {
            const text = await $.fs.read(path).catch(none)
            if (text === undefined) return undefined
            const marker = await $.fs.read(`${dir}/plan-path`).catch(none)
            held = { mtimeMs: progress.mtimeMs, ledger: parseLedger(text, root, progress.mtimeMs, marker) }
            ledgerCache.set(path, held)
          }
          if (held.ledger === undefined) return undefined

          return repo === undefined ? held.ledger : { ...held.ledger, repo }
        }),
      )

      return perDir.filter((l): l is Ledger => l !== undefined)
    }),
  )

  return perRoot.flat()
}
