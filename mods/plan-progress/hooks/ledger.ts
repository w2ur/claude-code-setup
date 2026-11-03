import { ID, taskIdOf } from './plans'

export type Ledger = {
  planPath: string
  root: string
  // Main repo label when the root is a worktree found through its repo.
  repo?: string
  mtimeMs: number
  completed: string[]
  lastTouched?: string
  isFinal: boolean
}

const ID_ONLY = new RegExp(`^(?:${ID})$`)
const RANGE = /^([0-9]+)-([0-9]+)$/
// A completion, at line start or after a sentence end: `Task 1: complete`,
// `Tasks 5-6: complete`, `Task 3, 4: complete`, `Task A3+A4: complete`,
// `Task A2 (steps 1,2): complete`, `Task 1 : complete`.
const COMPLETION = /(?:^|\. )Tasks? ([^:()]+?)(?: \([^)]*\))?[ \t]*: complete\b/g
// The same without the `Task` prefix, at line start only: `C1: complete (commit …)`.
const BARE_COMPLETION = new RegExp(`^(${ID})[ \\t]*: complete\\b`)
// Code spans quote ledger text (rulings, findings) and complete nothing.
const CODE_SPAN = /`[^`]*`/g
const FINAL = /^final[ -]/i

// The ids a completion's list names: plain ids and integer ranges; anything
// else (`15-step1`) is a partial id and completes nothing.
function idsOfList(list: string): string[] {
  const out: string[] = []
  for (const raw of list.split(/[,+]/)) {
    const token = raw.trim()
    const range = RANGE.exec(token)
    if (range?.[1] !== undefined && range[2] !== undefined) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (to >= from && to - from < 1000) for (let n = from; n <= to; n++) out.push(String(n))
    } else if (ID_ONLY.test(token)) out.push(token)
  }

  return out
}

const FIRST_LINE = /^# SDD ledger — plan:[ \t]*(.+?)[ \t]*$/

// Parse an execution ledger (progress.md). The plan path comes from the first
// line, else from the workspace's plan-path marker (a repo-relative marker is
// resolved against `root`); with neither, the ledger is unusable.
export function parseLedger(text: string, root: string, mtimeMs: number, planPathMarker?: string): Ledger | undefined {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  let planPath = FIRST_LINE.exec(lines[0] ?? '')?.[1]
  if (planPath === undefined) {
    const marker = (planPathMarker ?? '').split('\n')[0]?.trim() ?? ''
    if (marker === '') return undefined
    planPath = marker.startsWith('/') || marker.startsWith('~/') ? marker : `${root.replace(/\/$/, '')}/${marker}`
  }
  const completed: string[] = []
  let lastTouched: string | undefined
  let isFinal = false
  for (const raw of lines) {
    const line = raw.replace(CODE_SPAN, '')
    if (FINAL.test(line)) isFinal = true
    const found = [...line.matchAll(COMPLETION)].map(m => m[1] ?? '')
    const bare = BARE_COMPLETION.exec(line)?.[1]
    if (bare !== undefined) found.push(bare)
    for (const list of found) {
      for (const id of idsOfList(list)) if (!completed.includes(id)) completed.push(id)
    }
    const id = taskIdOf(line)
    if (id === undefined) continue
    const rest = line.slice(`Task ${id}`.length)
    if (rest.startsWith(':') || rest.startsWith('/')) lastTouched = id
  }
  const ledger: Ledger = { planPath, root, mtimeMs, completed, isFinal }
  if (lastTouched !== undefined) ledger.lastTouched = lastTouched
  return ledger
}
