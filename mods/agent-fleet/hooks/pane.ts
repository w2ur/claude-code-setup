import type { Agent, Fleet, Run } from '../types'
import { clip, formatClock, formatTokens, isLive, runStats, runTitle } from './fleet'
import { HUE, bar } from './gfx'

// The pane as data: lines of styled segments, already cut to the pane's width.
// register.tsx only maps them to Text elements, so the layout is testable
// without a renderer. A status is a theme semantic token (`tone`); a drawing
// (persona faces, the progress squares) takes a raw hex (`color`).

export type Tone = 'success' | 'error'
export type Seg = { text: string; tone?: Tone; color?: string; dim?: boolean; bold?: boolean }
export type Line = Seg[]

const MIN_COLUMNS = 20

// `body` is the pair the persona's face sits between: its shape says the tier.
type Tier = { name: string; glyph: string; body: readonly [string, string] }

// Decided by the resolved model id's family, not by what was asked for.
const TIERS: readonly Tier[] = [
  { name: 'fable', glyph: '★', body: ['♔', '♔'] },
  { name: 'opus', glyph: '▲', body: ['{', '}'] },
  { name: 'sonnet', glyph: '◆', body: ['[', ']'] },
  { name: 'haiku', glyph: '●', body: ['(', ')'] },
]

// One hue per tier, apart from gfx's status hues so a tier never reads as an
// outcome. An unknown model keeps the theme's own text colour.
const TIER_HUES: Readonly<Record<string, string>> = {
  fable: '#e3b341',
  opus: '#5b9bd5',
  sonnet: '#3fb8af',
  haiku: '#a3acb9',
}

export const tierHue = (tier: Tier): string | undefined => TIER_HUES[tier.name]

export function tierOf(model: string): Tier {
  const id = model.toLowerCase()
  const tier = TIERS.find(t => id.includes(t.name))
  if (tier !== undefined) return tier
  return { name: model === '' ? 'unknown' : clip(model, 16), glyph: '·', body: ['(', ')'] }
}

// The persona: a face whose body says the tier and whose hand holds the agent
// type's prop. Five cells of face and one of prop, so every name lines up.

// No sighting for this long and a running agent dozes.
const DOZE_MS = 30_000
// A sighting this recent and the face talks.
const TALK_MS = 1_500

const PROPS: Readonly<Record<string, string>> = {
  Explore: '⌕',
  Plan: '≡',
  implementer: '⊤',
  'docs-checker': '✎',
  troubleshooter: '✚',
  'portfolio-audit': '☰',
  'dummy-visitor': '?',
}

export const propOf = (subagentType: string | undefined): string => PROPS[subagentType ?? ''] ?? '∗'

export type Mood = 'working' | 'blinking' | 'talking' | 'dozing' | 'done' | 'failed'

const FACES: Readonly<Record<Mood, string>> = {
  working: '•ᴗ•',
  blinking: '-ᴗ-',
  talking: '•o•',
  dozing: '-.-',
  done: '^ᴗ^',
  failed: '×_×',
}

// `place` is the agent's rank in its run, so the faces do not blink in step.
export function moodOf(agent: Agent, now: number, tick: number, place: number): Mood {
  if (agent.status === 'done') return 'done'
  if (agent.status === 'failed') return 'failed'
  const quiet = now - Math.max(agent.startedAt, agent.lastSeenAt ?? agent.startedAt)
  if (quiet >= DOZE_MS) return 'dozing'
  if (quiet < TALK_MS && tick % 4 < 2) return 'talking'
  const beat = (((tick + place * 11) % 32) + 32) % 32
  return beat >= 30 ? 'blinking' : 'working'
}

function persona(agent: Agent, tier: Tier, mood: Mood, tick: number): Seg[] {
  const face = tinted(`${tier.body[0]}${FACES[mood]}${tier.body[1]}`, tierHue(tier))
  if (mood === 'done') return [face, text('✓', { tone: 'success' })]
  if (mood === 'failed') return [face, text('✗', { tone: 'error' })]
  if (mood === 'dozing') return [face, dim(Math.floor(tick / 8) % 2 === 0 ? 'z' : 'Z')]
  return [face, text(propOf(agent.subagentType))]
}

const PERSONA_CELLS = 1 + 5 + 1

const text = (value: string, style: Omit<Seg, 'text'> = {}): Seg => ({ text: value, ...style })
const dim = (value: string): Seg => text(value, { dim: true })
const tinted = (value: string, color: string | undefined): Seg => (color === undefined ? text(value) : text(value, { color }))

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

// Two lines: the persona with what it is and how long it has run, then which
// model, what it is doing and what it costs.
function agentLines(agent: Agent, now: number, cols: number, tick: number, place: number): Line[] {
  const tier = tierOf(agent.model)
  const elapsed = elapsedOf(agent, now)
  const name = clip(agent.description === '' ? 'agent' : agent.description, Math.max(1, cols - PERSONA_CELLS - 2 - elapsed.length))
  const gap = Math.max(1, cols - PERSONA_CELLS - 1 - name.length - elapsed.length)
  return [
    [text(' '), ...persona(agent, tier, moodOf(agent, now, tick, place), tick), text(` ${name}`), text(' '.repeat(gap)), dim(elapsed)],
    [dim(`        ${joined([tier.name, agent.effort, agent.lastTool, contextPercent(agent), tokensOf(agent)])}`)],
  ]
}

function doneLine(agent: Agent, now: number): Line {
  const line: Line = [
    text(' '),
    ...persona(agent, tierOf(agent.model), 'done', 0),
    text(` ${agent.description === '' ? 'agent' : agent.description} · ${elapsedOf(agent, now)} · ${tokensOf(agent)}`),
  ]
  if (agent.answerPreview !== undefined) line.push(dim(` — ${agent.answerPreview}`))
  return line
}

function failedLines(agent: Agent, now: number, cols: number): Line[] {
  const lines = agentLines(agent, now, cols, 0, 0)
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

const PROGRESS_LABEL = 'Progress  '

// One square per agent in spawn order (done in calm, failed in hot, running
// hollow, lost dim), then the count in words. A run with more agents than the
// width holds, or whose agents are no longer kept, draws a bar instead.
function progressLine(f: Fleet, run: Run, members: readonly Agent[], cols: number): Line {
  const stats = runStats(f, run)
  if (stats.total === 0) return []
  const said = ` ${joined(
    [
      `${stats.done} of ${stats.total} done`,
      stats.running > 0 ? `${stats.running} running` : undefined,
      stats.failed > 0 ? `${stats.failed} failed` : undefined,
      stats.lost > 0 ? `${stats.lost} lost` : undefined,
    ],
    ', ',
  )}`
  const counted = members.filter(a => a.status !== 'denied')
  const room = cols - PROGRESS_LABEL.length - said.length
  const line: Line = [dim(PROGRESS_LABEL)]
  if (counted.length === stats.total && counted.length <= room) {
    for (const agent of counted) {
      if (agent.status === 'done') line.push(text('■', { color: HUE.calm }))
      else if (agent.status === 'failed') line.push(text('■', { color: HUE.hot }))
      else if (agent.status === 'lost') line.push(dim('■'))
      else line.push(text('□'))
    }
  } else {
    const width = Math.max(1, room)
    const [calm, rest] = bar(stats.done / stats.total, width)
    const [ended, empty] = stats.failed > 0 ? bar((stats.done + stats.failed) / stats.total, width) : [calm, rest]
    const hot = ended.slice(calm.length)
    if (calm !== '') line.push(text(calm, { color: HUE.calm }))
    if (hot !== '') line.push(text(hot, { color: HUE.hot }))
    if (empty !== '') line.push(dim(empty))
  }
  line.push(text(said))
  return line
}

// The agent that used the most tokens, and its share of the run's: who the
// run's cost went to. Only worth a line once two agents can be compared.
function heaviestLine(members: readonly Agent[]): Line {
  const counted = members.filter(a => a.status !== 'denied')
  const total = counted.reduce((sum, a) => sum + a.tokensIn + a.tokensOut, 0)
  if (counted.length < 2 || total <= 0) return []
  const top = counted.reduce((a, b) => (b.tokensIn + b.tokensOut > a.tokensIn + a.tokensOut ? b : a))
  const share = Math.round(((top.tokensIn + top.tokensOut) / total) * 100)
  return [
    dim('Most tokens '),
    text(top.description === '' ? 'agent' : top.description),
    dim(` · ${tokensOf(top)} of ${formatTokens(total)} (${share}%)`),
  ]
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

function expandedRun(f: Fleet, run: Run, now: number, cols: number, tick: number): Line[] {
  const members = run.agentIds.map(id => f.agents[id]).filter((a): a is Agent => a !== undefined)
  const lines: Line[] = [[text(runTitle(run), { bold: true })], tilesLine(f, run, now)]
  const progress = progressLine(f, run, members, cols)
  if (progress.length > 0) lines.push(progress)
  const heaviest = heaviestLine(members)
  if (heaviest.length > 0) lines.push(heaviest)
  const by = (status: Agent['status']): Agent[] => members.filter(a => a.status === status)
  const running = by('running')
  const done = by('done')
  const failed = by('failed')
  const denied = by('denied')
  const lost = by('lost')

  if (running.length > 0) {
    lines.push(section('Running', running.length))
    for (const agent of running) lines.push(...agentLines(agent, now, cols, tick, members.indexOf(agent)))
  }
  lines.push(...phaseLines(run, cols))
  if (done.length > 0) {
    lines.push(section('Done', done.length, { bold: true, tone: 'success' }))
    for (const agent of done) lines.push(doneLine(agent, now))
  }
  if (failed.length > 0) {
    lines.push(section('Failed', failed.length, { bold: true, tone: 'error' }))
    for (const agent of failed) lines.push(...failedLines(agent, now, cols))
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

function isUnfinished(f: Fleet, run: Run): boolean {
  if (run.summary !== undefined) return false
  return isLive(f, run) || (run.kind === 'workflow' && run.endedAt === undefined)
}

// `tick` is the animation frame (spinners, shimmer); 0 draws the first frame.
export function paneLines(f: Fleet, now: number, columns: number, tick = 0): Line[] {
  const cols = Math.max(MIN_COLUMNS, columns)
  const runs = f.order.map(id => f.runs[id]).filter((r): r is Run => r !== undefined)
  const newest = runs[runs.length - 1]
  if (newest === undefined) {
    return [fit([dim('No agents yet. Subagents and workflow runs of this session appear here.')], cols)]
  }

  // The newest run, and every run not over yet (an agent still running, a
  // workflow that has not ended), are drawn in full, the most recent first; the
  // rest fold into one line each.
  const isExpanded = (run: Run): boolean => run === newest || isUnfinished(f, run)
  const lines: Line[] = []
  for (const run of [...runs].reverse().filter(isExpanded)) {
    if (lines.length > 0) lines.push([text(' ')])
    lines.push(...expandedRun(f, run, now, cols, tick))
  }
  const earlier = runs.filter(run => !isExpanded(run)).reverse()
  if (earlier.length > 0) {
    lines.push([dim('── earlier runs ──')])
    for (const run of earlier) lines.push(collapsedLine(f, run, now))
  }
  return lines.map(line => fit(line, cols))
}
