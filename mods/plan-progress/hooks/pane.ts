import type { PlanView } from './views'

// The pane as data: lines of styled segments, already cut to the pane's width.
// register.tsx only maps them to Text elements, so the layout is testable
// without a renderer. Same shape as agent-fleet's pane.
export type Tone = 'success' | 'error'
export type Seg = { text: string; tone?: Tone; color?: string; dim?: boolean; bold?: boolean }
export type Line = Seg[]

// Cuts a line to `cols` cells; the last kept segment ends in an ellipsis.
export function fit(line: Line, cols: number): Line {
  const out: Line = []
  let used = 0
  for (const seg of line) {
    const room = cols - used
    if (room <= 0) break
    if (seg.text.length <= room) {
      out.push(seg)
      used += seg.text.length
      continue
    }
    out.push({ ...seg, text: room > 1 ? `${seg.text.slice(0, room - 1)}…` : '…' })
    break
  }
  return out
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const head = (v: PlanView, age?: string): Line => {
  const line: Line = [{ text: v.title, bold: true }, { text: ` ${v.done}/${v.total}` }, { text: ` ${v.repo}`, dim: true }]
  if (age !== undefined) line.push({ text: ` ${age}`, dim: true })
  return line
}

export function paneLines(views: PlanView[], columns: number): Line[] {
  if (views.length === 0) return [fit([{ text: 'No plan in progress.', dim: true }], columns)]
  const out: Line[] = []
  const running = views.filter(v => v.status === 'running')
  const stalled = views.filter(v => v.status === 'stalled')
  if (running.length > 0) {
    out.push(fit([{ text: 'Running', bold: true }], columns))
    for (const v of running) {
      out.push(fit(head(v), columns))
      for (const t of v.tasks) {
        const isCurrent = v.current?.id === t.id && !t.isDone
        const mark = t.isDone ? '✓' : isCurrent ? '▸' : '·'
        const seg: Seg = t.isDone ? { text: `  ${mark} ${t.id} ${t.title}`, tone: 'success' } : isCurrent ? { text: `  ${mark} ${t.id} ${t.title}`, bold: true } : { text: `  ${mark} ${t.id} ${t.title}`, dim: true }
        out.push(fit([seg], columns))
      }
      if (v.siblings.length > 0) out.push(fit([{ text: `  ${v.siblings.join(' ')}`, dim: true }], columns))
    }
  }
  if (stalled.length > 0) {
    if (out.length > 0) out.push([])
    out.push(fit([{ text: 'Stalled', bold: true }], columns))
    for (const v of stalled) out.push(fit(head(v, formatAge(v.ageMs)), columns))
  }
  return out
}
