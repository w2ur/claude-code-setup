import type { ParsedPlan, PlanTask } from '../types'

export const ID = '[0-9]+[a-z]?|[A-Z][0-9]*'
const HEADING = new RegExp(`^#{2,3}[ \\t]+Task[ \\t]+(${ID})[ \\t]*(?::|—|-)[ \\t]*(.+)$`)
const NUMBERED = /^(\d+)\. \*\*(.+?)\*\*/
const TASK_REF = new RegExp(`^Task (${ID})(?=[ :/]|$)`)

const stemOf = (file: string): string => (file.split('/').pop() ?? file).replace(/\.md$/, '')
const dirOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '')

// Parse a plan file: its tasks (headings outside fenced code), title and spec path.
// Returns undefined when the file holds no task heading (a review, a design).
export function parsePlan(file: string, text: string): ParsedPlan | undefined {
  const tasks: PlanTask[] = []
  let heading: string | undefined
  let spec: string | undefined
  let fence: string | undefined
  let inTasks = false
  for (const line of text.split('\n')) {
    const mark = /^[ \t]*(```|~~~)/.exec(line)
    if (mark) {
      const kind = mark[1] ?? '```'
      if (!fence) fence = kind
      else if (fence === kind) fence = undefined
      continue
    }
    if (fence) continue
    if (heading === undefined && /^# /.test(line)) heading = line.slice(2).trim()
    if (spec === undefined) {
      const s = /^\*\*Spec:\*\*[ \t]*`?([^`\s]+)`?/.exec(line)
      if (s) spec = s[1]
    }
    if (/^## /.test(line)) inTasks = /^##[ \t]+Tasks[ \t]*$/.test(line)
    if (inTasks) {
      const n = NUMBERED.exec(line)
      if (n?.[1] !== undefined && n[2] !== undefined) {
        tasks.push({ id: n[1], title: n[2].trim() })
        continue
      }
    }
    const m = HEADING.exec(line.trimEnd())
    if (m?.[1] !== undefined && m[2] !== undefined) tasks.push({ id: m[1], title: m[2].trim() })
  }
  if (tasks.length === 0) return undefined
  const title = heading
    ? heading.replace(/ Implementation Plan$/, '').replace(/ [—-]$/, '').trim() || stemOf(file)
    : stemOf(file)
  const plan: ParsedPlan = { file, title, tasks }
  if (spec !== undefined) plan.spec = spec
  return plan
}

// The id after a leading "Task ", read whole: 'Task 12: x' is '12', never '1'.
export function taskIdOf(text: string): string | undefined {
  return TASK_REF.exec(text)?.[1]
}

// Files that belong with a plan: its spec, its reviews, and (no Spec line only) its design.
export function siblingsOf(plan: ParsedPlan, allFiles: string[]): string[] {
  const dir = dirOf(plan.file)
  const stem = stemOf(plan.file)
  const out: string[] = []
  for (const f of allFiles) {
    if (f === plan.file) continue
    if (dirOf(f) !== dir) continue
    const base = f.slice(dir.length)
    if (plan.spec !== undefined && base === (plan.spec.split('/').pop() ?? '')) {
      out.push(f)
      continue
    }
    if (base === `${stem}-review.md` || new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-review-[0-9]+\\.md$`).test(base)) {
      out.push(f)
      continue
    }
    if (plan.spec === undefined && base.endsWith('-design.md')) {
      const prefix = base.slice(0, -'-design.md'.length)
      if (prefix === stem || stem.startsWith(`${prefix}-`)) out.push(f)
    }
  }
  return out
}
