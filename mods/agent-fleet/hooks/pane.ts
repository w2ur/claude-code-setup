import type { Agent, Fleet, Run } from '../types'
import { clip, formatClock, formatTokens, isLive, runStats, runTitle } from './fleet'

// The pane as data: lines of styled segments, already cut to the pane's width.
// register.tsx only maps them to Text elements, so the layout is testable
// without a renderer. Colours are theme semantic tokens, never a palette.

export type Tone = 'success' | 'error'
export type Seg = { text: string; tone?: Tone; dim?: boolean; bold?: boolean }
export type Line = Seg[]

const MIN_COLUMNS = 20

type Tier = { name: string; glyph: string }

// Decided by the resolved model id's family, not by what was asked for.
const TIERS: readonly Tier[] = [
  { name: 'fable', glyph: '★' },
  { name: 'opus', glyph: '▲' },
  { name: 'sonnet', glyph: '◆' },
  { name: 'haiku', glyph: '●' },
]

export function tierOf(model: string): Tier {
  const id = model.toLowerCase()
  const tier = TIERS.find(t => id.includes(t.name))
  if (tier !== undefined) return tier
  return { name: model === '' ? 'unknown' : clip(model, 16), glyph: '·' }
}

const text = (value: string, style: Omit<Seg, 'text'> = {}): Seg => ({ text: value, ...style })
const dim = (value: string): Seg => text(value, { dim: true })

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

function joined(parts: (string | undefined)[], separator = ' · '): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(separator)
}

function contextPercent(agent: Agent): string | undefined {
  if (agent.window === undefined || agent.window <= 0 || agent.lastInputTokens <= 0) return undefined
  const percent = Math.round((agent.lastInputTokens / agent.window) * 100)
  return percent === 0 ? 'ctx <1%' : `ctx ${percent}%`
}

function elapsedOf(agent: Agent, now: number): string {
  return formatClock((agent.endedAt ?? now) - agent.startedAt)
}

function tokensOf(agent: Agent): string {
  return formatTokens(agent.tokensIn + agent.tokensOut)
}

// Three lines: what it is, which model, what it is doing and what it costs.
function agentLines(agent: Agent, now: number, mark: Seg): Line[] {
  const tier = tierOf(agent.model)
  return [
    [text(' '), mark, text(` ${tier.glyph} ${agent.description === '' ? 'agent' : agent.description}`)],
    [dim(`     ${joined([tier.name, agent.effort])}`)],
    [dim(`     ${joined([agent.lastTool, contextPercent(agent), tokensOf(agent), elapsedOf(agent, now)])}`)],
  ]
}

function doneLine(agent: Agent, now: number): Line {
  const line: Line = [
    text(' '),
    text('✓', { tone: 'success' }),
    text(` ${agent.description === '' ? 'agent' : agent.description} · ${elapsedOf(agent, now)} · ${tokensOf(agent)}`),
  ]
  if (agent.answerPreview !== undefined) line.push(dim(` — ${agent.answerPreview}`))
  return line
}

function failedLines(agent: Agent, now: number): Line[] {
  const lines = agentLines(agent, now, text('✗', { tone: 'error' }))
  if (agent.answerPreview !== undefined) lines.push([dim(`     ↳ ${agent.answerPreview}`)])
  return lines
}

function lostLine(agent: Agent): Line {
  return [dim(` ? ${agent.description === '' ? 'agent' : agent.description} · lost`)]
}

function deniedLine(agent: Agent): Line {
  const reason = agent.denyReason === undefined ? '' : ` — ${agent.denyReason}`
  return [dim(` ⊘ ${agent.description === '' ? 'agent' : agent.description}${reason}`)]
}

// The planned phases: titles only (no per-phase status exists), as many as the
// width allows and the rest counted.
function phaseLines(run: Run, cols: number): Line[] {
  const phases = run.phases
  if (phases === undefined || phases.length === 0) return []
  const separator = ' › '
  const indent = 3
  let shown = ''
  let count = 0
  for (const phase of phases) {
    const candidate = count === 0 ? phase.title : `${shown}${separator}${phase.title}`
    const hidden = phases.length - count - 1
    const tail = hidden > 0 ? ` +${hidden} more` : ''
    if (count > 0 && indent + candidate.length + tail.length > cols) break
    shown = candidate
    count += 1
  }
  const hidden = phases.length - count
  return [
    [text(`Phases · ${phases.length}`, { bold: true })],
    [dim(`   ${shown}${hidden > 0 ? ` +${hidden} more` : ''}`)],
  ]
}

function tilesLine(f: Fleet, run: Run, now: number): Line {
  const stats = runStats(f, run)
  const tile = (label: string, value: string): Seg[] => [dim(`[ ${label} `), text(value, { bold: true }), dim(' ]')]
  const tiles: Seg[][] = []
  if (stats.costUsd !== undefined && stats.costUsd > 0) tiles.push(tile('Cost', `≈$${stats.costUsd.toFixed(2)}`))
  tiles.push(tile('Tokens', formatTokens(stats.tokens)))
  tiles.push(tile('Time', formatClock((stats.endedAt ?? now) - stats.startedAt)))
  return tiles.flatMap((segs, i) => (i === 0 ? segs : [text('  '), ...segs]))
}

function collapsedLine(f: Fleet, run: Run, now: number): Line {
  const stats = runStats(f, run)
  const running = isLive(f, run)
  const parts = [
    stats.total > 0 ? `${stats.done}/${stats.total}` : undefined,
    stats.running > 0 ? `${stats.running} running` : undefined,
    stats.failed > 0 ? `${stats.failed} failed` : undefined,
    stats.denied > 0 ? `${stats.denied} denied` : undefined,
    stats.lost > 0 ? `${stats.lost} lost` : undefined,
    formatClock((stats.endedAt ?? now) - stats.startedAt),
    `${formatTokens(stats.tokens)} tok`,
  ]
  return [dim(` ${running ? '◉' : '▸'} ${runTitle(run)} · ${joined(parts)}`)]
}

function section(title: string, count: number, style: Omit<Seg, 'text'> = { bold: true }): Line {
  return [text(`${title} · ${count}`, style)]
}

function expandedRun(f: Fleet, run: Run, now: number, cols: number): Line[] {
  const lines: Line[] = [[text(runTitle(run), { bold: true })], tilesLine(f, run, now)]
  const members = run.agentIds.map(id => f.agents[id]).filter((a): a is Agent => a !== undefined)
  const by = (status: Agent['status']): Agent[] => members.filter(a => a.status === status)
  const running = by('running')
  const done = by('done')
  const failed = by('failed')
  const denied = by('denied')
  const lost = by('lost')

  if (running.length > 0) {
    lines.push(section('Running', running.length))
    for (const agent of running) lines.push(...agentLines(agent, now, text('◉')))
  }
  lines.push(...phaseLines(run, cols))
  if (done.length > 0) {
    lines.push(section('Done', done.length, { bold: true, tone: 'success' }))
    for (const agent of done) lines.push(doneLine(agent, now))
  }
  if (failed.length > 0) {
    lines.push(section('Failed', failed.length, { bold: true, tone: 'error' }))
    for (const agent of failed) lines.push(...failedLines(agent, now))
  }
  if (lost.length > 0) {
    lines.push(section('Lost', lost.length, { bold: true, dim: true }))
    for (const agent of lost) lines.push(lostLine(agent))
  }
  if (denied.length > 0) {
    lines.push(section('Denied', denied.length, { bold: true, dim: true }))
    for (const agent of denied) lines.push(deniedLine(agent))
  }
  if (members.length === 0) {
    const stats = runStats(f, run)
    lines.push([dim(run.endedAt !== undefined && stats.total === 0 ? ' not started' : ' waiting for the first agent…')])
  }
  return lines
}

export function paneLines(f: Fleet, now: number, columns: number): Line[] {
  const cols = Math.max(MIN_COLUMNS, columns)
  const runs = f.order.map(id => f.runs[id]).filter((r): r is Run => r !== undefined)
  const newest = runs[runs.length - 1]
  if (newest === undefined) {
    return [fit([dim('No agents yet. Subagents and workflow runs of this session appear here.')], cols)]
  }

  const lines = expandedRun(f, newest, now, cols)
  const earlier = runs.slice(0, -1).reverse()
  if (earlier.length > 0) {
    lines.push([dim('── earlier runs ──')])
    for (const run of earlier) lines.push(collapsedLine(f, run, now))
  }
  return lines.map(line => fit(line, cols))
}
