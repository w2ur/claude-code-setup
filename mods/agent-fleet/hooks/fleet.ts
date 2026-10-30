import type { Agent, Fleet, Pending, Phase, Run, RunSummary } from '../types'

// Known limits of run identity. A run is one attempt, but when the engine
// leaves a spawn's Workflow call id empty the attempt is only inferred (from
// the alias of the workflow's own run id), and the engine offers no attempt id
// to do better. All need empty call ids and a narrow timing:
// - a resume launched while the previous attempt is still open, or within
//   REJOIN_WINDOW_MS of its end, has its pre-launch spawns join the previous run;
// - a server-launched provisional run left open by silent killed agents can be
//   folded into the next launched attempt;
// - a phase gap longer than REJOIN_WINDOW_MS splits an attempt in two runs.

// Single source of the bounds. The state survives reloads and a session can be
// long, so nothing here grows without a ceiling.
export const RUNS_DETAILED = 5
export const RUNS_KEPT = 50
export const PREVIEW_CHARS = 120
export const LABEL_CHARS = 80
// A run that ended in the turn being drawn keeps the band up for this many
// further turns; 0 means the band goes one turn after the run ends.
export const BAND_LINGER_TURNS = 0
// How long a run stays "settling" after its last agent ends before it counts as
// over: a workflow leaves ~4 s between phases (observed), so 15 s clears a gap
// with margin; a longer gap is announced as an end and reopens (accepted limit;
// past REJOIN_WINDOW_MS with empty call ids it opens another run instead),
// and the real end is announced too when its outcome differs. A failure taken
// from the engine's list waits as long for the real completion to correct it.
export const RUN_END_GRACE_MS = 15_000
// How long after its end a run is still rejoined by a spawn with an empty
// Workflow call id: a phase gap lasts seconds, a resume comes later.
export const REJOIN_WINDOW_MS = 2 * 60_000

const PHASES_MAX = 50
const META_WINDOW = 20_000
const META_DEPTH = 6
const META_NODES = 500

// How long a workflow run may go without an event (spawn, step, tool call,
// completion) before it counts as over. The engine reports no status for a
// workflow's background task to a mod, so a run whose end never reached us (the
// mod reloaded while it ran, the workflow was killed) is told by its silence.
export const WORKFLOW_IDLE_MS = 30 * 60_000
// What was seen of an agent no spawn names is kept this long, and at most this
// many ids: the engine's own forks (compaction, memory) never get a spawn.
export const PENDING_TTL_MS = 60_000
export const PENDING_MAX = 50

// The tag the engine's atom keeps the persisted Fleet under. Bump it whenever
// the Fleet changes shape or meaning: a value kept under another tag reads as absent.
export const FLEET_SHAPE = 'fleet@4'

export function emptyFleet(): Fleet {
  return { runs: {}, agents: {}, pending: {}, workflowAlias: {}, order: [], hasAutoOpened: false, turn: 0 }
}

// ---------------------------------------------------------------------------
// Workflow meta: parsed as a data literal, never evaluated.
// ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

class NotALiteral extends Error {}

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[\w$]/
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

function parseLiteral(src: string): Json {
  let i = 0
  let nodes = 0

  const fail = (): never => {
    throw new NotALiteral()
  }

  const skipTrivia = (): void => {
    for (;;) {
      const c = src[i]
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
        i += 1
      } else if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i += 1
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        if (end < 0) fail()
        i = end + 2
      } else {
        return
      }
    }
  }

  const readString = (): string => {
    const quote = src[i]
    i += 1
    let out = ''
    for (;;) {
      const c = src[i]
      if (c === undefined) return fail()
      i += 1
      if (c === quote) return out
      if (c === '\n' && quote !== '`') return fail()
      if (quote === '`' && c === '$' && src[i] === '{') return fail()
      if (c !== '\\') {
        out += c
        continue
      }
      const e = src[i]
      i += 1
      if (e === 'u') {
        const hex = src.slice(i, i + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail()
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else if (e === undefined) {
        return fail()
      } else {
        out += ESCAPES[e] ?? e
      }
    }
  }

  const readKey = (): string => {
    const c = src[i]
    if (c === "'" || c === '"') return readString()
    if (c === undefined || !IDENT_START.test(c)) return fail()
    const start = i
    while (i < src.length && IDENT_PART.test(src[i] ?? '')) i += 1
    return src.slice(start, i)
  }

  const readValue = (depth: number): Json => {
    nodes += 1
    if (nodes > META_NODES || depth > META_DEPTH) return fail()
    skipTrivia()
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') return readString()
    if (c === '{') {
      i += 1
      const out: { [key: string]: Json } = {}
      for (;;) {
        skipTrivia()
        if (src[i] === '}') {
          i += 1
          return out
        }
        const key = readKey()
        if (key === '__proto__') return fail()
        skipTrivia()
        if (src[i] !== ':') return fail()
        i += 1
        out[key] = readValue(depth + 1)
        skipTrivia()
        if (src[i] === ',') i += 1
        else if (src[i] !== '}') return fail()
      }
    }
    if (c === '[') {
      i += 1
      const out: Json[] = []
      for (;;) {
        skipTrivia()
        if (src[i] === ']') {
          i += 1
          return out
        }
        out.push(readValue(depth + 1))
        skipTrivia()
        if (src[i] === ',') i += 1
        else if (src[i] !== ']') return fail()
      }
    }
    const rest = src.slice(i, i + 40)
    const num = NUMBER.exec(rest)
    if (num) {
      i += num[0].length
      return Number(num[0])
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (rest.startsWith(word) && !IDENT_PART.test(rest[word.length] ?? '')) {
        i += word.length
        return value
      }
    }
    return fail()
  }

  return readValue(0)
}

export type WorkflowMeta = { name?: string; phases?: Phase[] }

const META_START = /export\s+const\s+meta\s*=\s*/

// Anything that is not a plain data literal (a call, an identifier, a template
// with `${}`, an unterminated string) yields {} : no name, no phases, no error.
export function parseMeta(script: string | undefined): WorkflowMeta {
  if (script === undefined) return {}
  const start = META_START.exec(script)
  if (start === null) return {}
  let literal: Json
  try {
    literal = parseLiteral(script.slice(start.index + start[0].length, start.index + start[0].length + META_WINDOW))
  } catch (error) {
    if (error instanceof NotALiteral) return {}
    throw error
  }
  if (literal === null || typeof literal !== 'object' || Array.isArray(literal)) return {}

  const meta: WorkflowMeta = {}
  if (typeof literal.name === 'string' && literal.name.trim() !== '') meta.name = clip(literal.name, LABEL_CHARS)
  if (Array.isArray(literal.phases)) {
    const phases: Phase[] = []
    for (const item of literal.phases.slice(0, PHASES_MAX)) {
      if (typeof item === 'string') {
        phases.push({ title: clip(item, LABEL_CHARS) })
      } else if (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.title === 'string') {
        const phase: Phase = { title: clip(item.title, LABEL_CHARS) }
        if (typeof item.detail === 'string') phase.detail = clip(item.detail, LABEL_CHARS)
        phases.push(phase)
      }
    }
    if (phases.length > 0) meta.phases = phases
  }
  return meta
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const s = String(seconds % 60).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}:${s}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
}

// Wall-clock HH:MM of an epoch-ms instant at a fixed offset (minutes east of UTC).
export function formatLocalTime(ms: number, offsetMin: number): string {
  const minutesOfDay = (((Math.floor(ms / 60_000) + offsetMin) % 1440) + 1440) % 1440
  const hh = String(Math.floor(minutesOfDay / 60)).padStart(2, '0')
  const mm = String(minutesOfDay % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// What a step cost in tokens as the API reported it. Totals count NEW tokens
// (input + cacheCreation + output); cache reads re-count the same context at
// every step, so they only enter the context size (input + cacheRead +
// cacheCreation) that `ctx %` is read from.
export type StepUsage = { input: number; output: number; cacheRead: number; cacheCreation: number }

export type SpawnEvent = {
  kind: 'spawn'
  at: number
  // Unique per spawn call, so two denied spawns of one workflow stay two rows.
  key: string
  toolUseId: string
  description: string
  subagentType: string
  parentAgentId?: string
  isBackground: boolean
  workflow?: { runId: string; agentIndex: number }
  // A resume of an agent the session already ran (a message or a notification
  // waking it), and when the spawn was asked for: an end recorded after that
  // instant belongs to the resumed run, so it stands.
  isResume?: boolean
  requestedAt?: number
  // From the spawn's RESULT: an agentId means it started, a deny means it did not.
  agentId?: string
  model?: string
  deny?: string
  costUsd?: number
}

export type FleetEvent =
  | { kind: 'turn-start'; tzOffsetMin?: number }
  | { kind: 'clear' }
  | { kind: 'expire'; at: number }
  | { kind: 'lost'; ids: string[]; at: number }
  | { kind: 'auto-opened' }
  | { kind: 'workflow-start'; at: number; toolUseId: string; script?: string; costUsd?: number }
  | { kind: 'workflow-launched'; at: number; toolUseId: string; runId?: string; name?: string }
  | { kind: 'workflow-end'; at: number; toolUseId: string; costUsd?: number }
  | SpawnEvent
  | {
      kind: 'step'
      at: number
      agentId?: string
      turnId?: string
      index: number
      model: string
      effort?: string | number
      usage: StepUsage | null
      window?: number
    }
  | { kind: 'tool'; at: number; agentId: string; tool: string }
  // An agent's loop starts a turn: its first, or one that wakes it after an end.
  | { kind: 'wake'; at: number; agentId: string }
  | {
      kind: 'complete'
      at: number
      agentId: string
      answer: string
      isAborted: boolean
      reason: string
      costUsd?: number
      // 'list' when read off the engine's agent list rather than the agent's
      // own turn.complete; a completion is real unless it says otherwise.
      source?: 'list' | 'real'
    }

type SpawnInput = {
  tool_use_id: string
  description: string
  subagentType: string
  parentAgentId?: string
  background: boolean
  workflow?: { runId: string; agentIndex: number }
  resume?: { agentId: string }
}

type SpawnResult = { model?: string; agentId?: string; deny?: string }

export function spawnEventOf(
  input: SpawnInput,
  result: SpawnResult,
  at: number,
  costUsd: number | undefined,
  requestedAt?: number,
): SpawnEvent {
  const key = input.workflow
    ? `${input.tool_use_id || input.workflow.runId}#${input.workflow.agentIndex}`
    : input.tool_use_id
  return {
    kind: 'spawn',
    at,
    key,
    toolUseId: input.tool_use_id,
    description: input.description,
    subagentType: input.subagentType,
    parentAgentId: input.parentAgentId,
    isBackground: input.background,
    workflow: input.workflow,
    agentId: result.agentId,
    model: result.model,
    deny: result.deny,
    costUsd,
    ...(input.resume === undefined ? {} : { isResume: true }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
  }
}

export type WorkflowLaunch = { isLaunched: boolean; runId?: string; name?: string }

// The Workflow tool starts the run in the background and answers at once
// (`status: "async_launched"`); a denial or an error answer means no run began.
export function launchOf(result: unknown): WorkflowLaunch {
  if (result === null || typeof result !== 'object') return { isLaunched: false }
  const answer = result as { deny?: unknown; isError?: unknown; result?: unknown }
  if (typeof answer.deny === 'string' || answer.isError === true) return { isLaunched: false }
  const body = answer.result
  if (body === null || typeof body !== 'object') return { isLaunched: false }
  const fields = body as { status?: unknown; runId?: unknown; workflowName?: unknown }
  const launch: WorkflowLaunch = { isLaunched: fields.status === 'async_launched' || fields.status === 'remote_launched' }
  if (typeof fields.runId === 'string') launch.runId = fields.runId
  if (typeof fields.workflowName === 'string') launch.name = fields.workflowName
  return launch
}

// ---------------------------------------------------------------------------
// Reducer. Pure: the input fleet is never mutated, the result is a new value.
// ---------------------------------------------------------------------------

function looseRunId(f: Fleet): string {
  return `subagents:${f.turn}`
}

function putRun(f: Fleet, run: Run): void {
  f.runs[run.id] = run
}

function putAgent(f: Fleet, agent: Agent): void {
  f.agents[agent.id] = agent
}

function ensureRun(f: Fleet, id: string, kind: Run['kind'], at: number): Run {
  const existing = f.runs[id]
  if (existing !== undefined) return existing
  const run: Run = { id, kind, startedAt: at, lastActivityAt: at, agentIds: [] }
  // Loose runs are told apart by the clock time they began at.
  if (kind === 'subagents') run.name = `Subagents · ${formatLocalTime(at, f.tzOffsetMin ?? 0)}`
  putRun(f, run)
  f.order.push(id)
  return run
}

function blankAgent(id: string, runId: string, at: number): Agent {
  return {
    id,
    runId,
    description: '',
    model: '',
    status: 'running',
    startedAt: at,
    tokensIn: 0,
    tokensOut: 0,
    lastInputTokens: 0,
  }
}

function touch(f: Fleet, runId: string, at: number): void {
  const run = f.runs[runId]
  if (run !== undefined && (run.lastActivityAt ?? 0) < at) putRun(f, { ...run, lastActivityAt: at })
}

// An event can name an agent no spawn has named (yet): the engine may step an
// agent while its spawn hook still waits on the result, and its own forks
// (compaction, memory) step under ids no spawn ever names. Nothing is drawn for
// such an id; what was seen waits here and a spawn adopts it.
// Every sighting renews the id's time to live: it counts from the last one.
function pendingOf(f: Fleet, id: string, at: number): Pending {
  const seen = f.pending[id] ?? { seenAt: at, model: '', tokensIn: 0, tokensOut: 0, lastInputTokens: 0 }

  return { ...seen, seenAt: Math.max(seen.seenAt, at) }
}

// What an agent takes over from its pending entry: everything but the entry's
// own bookkeeping, its last sighting becoming the agent's.
function seenFields({ seenAt, end: _end, ...fields }: Pending): Omit<Pending, 'seenAt' | 'end'> & Pick<Agent, 'lastSeenAt'> {
  return { ...fields, lastSeenAt: seenAt }
}

function revived(agent: Agent): Agent {
  return agent.status === 'lost' ? { ...agent, status: 'running', endedAt: undefined, endedTurn: undefined } : agent
}

// An agent recorded over (done, failed or lost) that is active again: a
// background agent ends its turn while its own background work runs, is woken
// by the task's notification or resumed by a message, and ends again later.
// Its outcome so far is void and the next completion sets its end; the failure
// marker goes too, so a second failure is said aloud.
const ENDED_STATUSES: ReadonlySet<Agent['status']> = new Set(['done', 'failed', 'lost'])

function reopened(agent: Agent): Agent {
  if (!ENDED_STATUSES.has(agent.status)) return agent
  return { ...agent, status: 'running', endedAt: undefined, endedTurn: undefined, outcomeSource: undefined, isAnnounced: undefined }
}

// Records `agent` (already carrying what the event says) as seen at `at`. A
// sighting proves an agent recorded over (lost, or done or failed and then
// woken) is active again, unless it is late (it predates a sighting already
// applied) or predates the end itself: that one says nothing about the agent
// after it, and reviving on it makes the agent flap.
// Every sighting stamps `lastSeenAt`, which a loss must not predate.
function sighted(f: Fleet, agent: Agent, at: number, isLate: boolean): void {
  const isRevived = ENDED_STATUSES.has(agent.status) && !isLate && at > (agent.endedAt ?? -Infinity)
  const seen: Agent = { ...agent, lastSeenAt: Math.max(agent.lastSeenAt ?? at, at) }
  putAgent(f, isRevived ? reopened(seen) : seen)
  touch(f, agent.runId, at)
  if (isRevived) settle(f, agent.runId)
}

function prunePending(f: Fleet, at: number): void {
  const kept = Object.entries(f.pending)
    .filter(([, entry]) => at - entry.seenAt < PENDING_TTL_MS)
    .sort(([, a], [, b]) => b.seenAt - a.seenAt)
    .slice(0, PENDING_MAX)
  f.pending = Object.fromEntries(kept)
}

function attach(f: Fleet, agent: Agent, runId: string): void {
  if (agent.runId !== runId) {
    const from = f.runs[agent.runId]
    if (from !== undefined) {
      const rest = from.agentIds.filter(id => id !== agent.id)
      if (rest.length === 0 && from.kind === 'subagents') {
        delete f.runs[from.id]
        f.order = f.order.filter(id => id !== from.id)
      } else {
        putRun(f, { ...from, agentIds: rest })
        settle(f, from.id)
      }
    }
  }
  const to = f.runs[runId]
  if (to !== undefined) {
    const ids = to.agentIds.includes(agent.id) ? to.agentIds : [...to.agentIds, agent.id]
    putRun(f, { ...to, agentIds: ids, summary: undefined })
  }
  putAgent(f, { ...agent, runId })
}

// A run with agents and none running is "settling", not over: a workflow's
// phases leave gaps in which every agent so far has finished, and a later spawn
// of the run cancels the settling. `expire` ends it once the grace has passed.
function settle(f: Fleet, runId: string): void {
  const run = f.runs[runId]
  if (run === undefined) return
  const members = membersOf(f, run)
  if (members.length === 0) return
  if (members.some(a => a.status === 'running')) {
    putRun(f, { ...run, endedAt: undefined, endedTurn: undefined, settlingAt: undefined })
    return
  }
  const lastEnd = Math.max(...members.map(a => a.endedAt ?? a.startedAt))
  if (run.endedAt !== undefined && lastEnd <= run.endedAt) return
  putRun(f, { ...run, endedAt: undefined, endedTurn: undefined, settlingAt: lastEnd })
}

function membersOf(f: Fleet, run: Run): Agent[] {
  return run.agentIds.map(id => f.agents[id]).filter((a): a is Agent => a !== undefined)
}

// A workflow run the engine can no longer be waited on for: no event for
// WORKFLOW_IDLE_MS while it still has a running agent or never had any.
function isIdleWorkflow(f: Fleet, run: Run, at: number): boolean {
  if (run.kind !== 'workflow' || run.endedAt !== undefined || run.summary !== undefined) return false
  if (at - (run.lastActivityAt ?? run.startedAt) < WORKFLOW_IDLE_MS) return false
  const members = membersOf(f, run)
  return members.length === 0 || members.some(a => a.status === 'running')
}

// Its running agents are lost; a run that never had one ends outright, one with
// agents settles and ends by the usual grace.
function endIdleWorkflows(f: Fleet, at: number): void {
  for (const id of f.order) {
    const run = f.runs[id]
    if (run === undefined || !isIdleWorkflow(f, run, at)) continue
    const running = membersOf(f, run).filter(a => a.status === 'running')
    if (running.length === 0) {
      putRun(f, { ...run, endedAt: at, endedTurn: f.turn })
      continue
    }
    for (const agent of running) putAgent(f, { ...agent, status: 'lost', endedAt: at, endedTurn: f.turn })
    settle(f, id)
  }
}

// Ends every run whose grace ran out by `at`: only here is a run's end recorded.
function expire(f: Fleet, at: number): void {
  endIdleWorkflows(f, at)
  for (const id of f.order) {
    const run = f.runs[id]
    if (run === undefined || run.settlingAt === undefined || at - run.settlingAt < RUN_END_GRACE_MS) continue
    const members = membersOf(f, run)
    if (members.some(a => a.status === 'running')) continue
    const endedTurn = Math.max(...members.map(a => a.endedTurn ?? f.turn))
    putRun(f, { ...run, endedAt: run.settlingAt, endedTurn, settlingAt: undefined })
  }
}

function raiseCostEnd(run: Run, costUsd: number | undefined): Run {
  if (costUsd === undefined) return run
  return { ...run, costEndUsd: Math.max(run.costEndUsd ?? costUsd, costUsd) }
}

function onWorkflowStart(f: Fleet, ev: Extract<FleetEvent, { kind: 'workflow-start' }>): void {
  const meta = parseMeta(ev.script)
  const run = ensureRun(f, ev.toolUseId, 'workflow', ev.at)
  putRun(f, {
    ...run,
    kind: 'workflow',
    name: run.name ?? meta.name,
    phases: run.phases ?? meta.phases,
    startedAt: Math.min(run.startedAt, ev.at),
    costStartUsd: run.costStartUsd ?? ev.costUsd,
  })
}

// A run that has not ended and was not reduced to a summary: a spawn may still join it.
function isOpen(run: Run | undefined): run is Run {
  return run !== undefined && run.endedAt === undefined && run.summary === undefined
}

// Folds `stray` into the run `targetId` and removes it: its agents move over,
// the start and first cost sample stay the earliest, the end cost the highest.
function mergeRun(f: Fleet, targetId: string, stray: Run): void {
  const target = f.runs[targetId]
  if (target === undefined) return
  for (const id of stray.agentIds) {
    const agent = f.agents[id]
    if (agent !== undefined) putAgent(f, { ...agent, runId: targetId })
  }
  const costStarts = [target.costStartUsd, stray.costStartUsd].filter((c): c is number => c !== undefined)
  const agentIds = [...target.agentIds, ...stray.agentIds.filter(id => !target.agentIds.includes(id))]
  agentIds.sort((a, b) => (f.agents[a]?.startedAt ?? 0) - (f.agents[b]?.startedAt ?? 0))
  putRun(
    f,
    raiseCostEnd(
      {
        ...target,
        name: target.name ?? stray.name,
        phases: target.phases ?? stray.phases,
        startedAt: Math.min(target.startedAt, stray.startedAt),
        costStartUsd: costStarts.length === 0 ? undefined : Math.min(...costStarts),
        agentIds,
      },
      stray.costEndUsd,
    ),
  )
  touch(f, targetId, stray.lastActivityAt ?? 0)
  delete f.runs[stray.id]
  f.order = f.order.filter(id => id !== stray.id)
}

function onWorkflowLaunched(f: Fleet, ev: Extract<FleetEvent, { kind: 'workflow-launched' }>): void {
  const run = f.runs[ev.toolUseId]
  if (run === undefined) return
  putRun(f, {
    ...run,
    name: run.name ?? (ev.name === undefined ? undefined : clip(ev.name, LABEL_CHARS)),
    workflowRunId: run.workflowRunId ?? ev.runId,
  })
  touch(f, run.id, ev.at)
  if (ev.runId === undefined) return
  // Agents the engine spawned before this answer, with an empty Workflow call
  // id, opened a provisional run when the alias named no run they could join
  // (none, or one ended REJOIN_WINDOW_MS ago or more): while it is open and
  // unannounced it is this run, split, and the only merge there is. Any other
  // run of the id (an earlier attempt of a resumed workflow, even one a
  // pre-launch spawn rejoined) is a run of its own and stays one.
  const prior = f.runs[f.workflowAlias[ev.runId] ?? '']
  if (prior !== undefined && prior.id !== run.id && prior.provisional === true && isOpen(prior) && prior.announced === undefined) {
    mergeRun(f, run.id, prior)
    settle(f, run.id)
  }
  f.workflowAlias[ev.runId] = run.id
}

function onWorkflowEnd(f: Fleet, ev: Extract<FleetEvent, { kind: 'workflow-end' }>): void {
  const run = f.runs[ev.toolUseId]
  if (run === undefined) return
  putRun(f, raiseCostEnd({ ...run, endedAt: ev.at, endedTurn: f.turn }, ev.costUsd))
  settle(f, run.id)
}

// The run a workflow agent belongs to. A run is one attempt: one Workflow call,
// keyed by its id. When the engine leaves that id empty (a resumed or
// server-launched run), the agent joins the run the workflow's own id is an
// alias of while it is open, or ended less than REJOIN_WINDOW_MS ago: that one
// is the same attempt after a phase gap longer than the grace, and reopens. An
// older end is taken for a resume. A summarized run is never joined. With no
// run to join, a provisional run opens and the alias points to it; the launch
// of the attempt folds it in.
function isRejoinable(run: Run | undefined, at: number): run is Run {
  if (run === undefined || run.summary !== undefined) return false
  return run.endedAt === undefined || at - run.endedAt < REJOIN_WINDOW_MS
}

function workflowRunOf(f: Fleet, ev: SpawnEvent, workflowRunId: string): string {
  if (ev.toolUseId !== '') return ev.toolUseId
  const aliased = f.workflowAlias[workflowRunId]
  const joined = aliased === undefined ? undefined : f.runs[aliased]
  if (isRejoinable(joined, ev.at)) return joined.id
  const id = `wf:${workflowRunId}:${ev.at}`
  putRun(f, { ...ensureRun(f, id, 'workflow', ev.at), provisional: true })
  f.workflowAlias[workflowRunId] = id

  return id
}

function onSpawn(f: Fleet, ev: SpawnEvent): void {
  const isWorkflow = ev.workflow !== undefined
  const parent = ev.parentAgentId === undefined ? undefined : f.agents[ev.parentAgentId]
  // A resumed agent goes on in its own run, wherever and whenever the spawn
  // that wakes it happens; one whose run was reduced starts afresh.
  const resumed = ev.isResume === true && !isWorkflow && ev.agentId !== undefined ? f.agents[ev.agentId] : undefined
  const resumedRunId = resumed !== undefined && f.runs[resumed.runId]?.summary === undefined ? resumed.runId : undefined
  const runId = ev.workflow
    ? workflowRunOf(f, ev, ev.workflow.runId)
    : (resumedRunId ?? parent?.runId ?? looseRunId(f))
  const base = ensureRun(f, runId, isWorkflow ? 'workflow' : 'subagents', ev.at)
  const run: Run = {
    ...base,
    workflowRunId: base.workflowRunId ?? ev.workflow?.runId,
    costStartUsd: base.costStartUsd ?? ev.costUsd,
    summary: undefined,
  }
  putRun(f, run)
  touch(f, runId, ev.at)

  if (ev.deny !== undefined) {
    // The key alone repeats across attempts of one workflow when the call id is
    // empty, and a resume inside the rejoin window shares the run too: the
    // spawn's instant tells the attempts apart.
    const id = `denied:${runId}:${ev.key}@${ev.at}`
    const agent: Agent = {
      ...blankAgent(id, runId, ev.at),
      description: clip(ev.description, LABEL_CHARS),
      subagentType: ev.subagentType,
      parentId: ev.parentAgentId,
      model: '',
      status: 'denied',
      denyReason: clip(ev.deny, LABEL_CHARS),
      endedAt: ev.at,
      endedTurn: f.turn,
    }
    putAgent(f, agent)
    const held = f.runs[runId] ?? run
    putRun(f, held.agentIds.includes(id) ? held : { ...held, agentIds: [...held.agentIds, id] })
    settle(f, runId)
    return
  }
  if (ev.agentId === undefined) return

  // What the spawn says wins: an agent it names is running, even one recorded
  // lost earlier, or done or failed before a resume asked for it; only a
  // completion seen before the spawn can say otherwise.
  const known = f.agents[ev.agentId]
  const seen = f.pending[ev.agentId]
  delete f.pending[ev.agentId]
  const carried: Agent =
    known ?? {
      ...blankAgent(ev.agentId, runId, ev.at),
      ...(seen === undefined ? {} : seenFields(seen)),
      ...(seen?.end === undefined
        ? {}
        : {
            status: seen.end.status,
            endedAt: seen.end.at,
            endedTurn: seen.end.turn,
            answerPreview: seen.end.answerPreview,
            outcomeSource: seen.end.source,
          }),
    }
  const isWoken = resumed !== undefined && (resumed.endedAt ?? -Infinity) < (ev.requestedAt ?? ev.at)
  const alive = isWoken ? reopened(carried) : revived(carried)
  const description = resumed !== undefined && resumed.description !== '' ? resumed.description : clip(ev.description, LABEL_CHARS)
  const merged: Agent = {
    ...alive,
    parentId: ev.parentAgentId,
    description,
    subagentType: ev.subagentType,
    model: ev.model ?? alive.model,
    isBackground: ev.isBackground,
    startedAt: Math.min(alive.startedAt, ev.at),
  }
  putAgent(f, merged)
  attach(f, merged, runId)
  const adopting = f.runs[runId]
  if (adopting !== undefined) putRun(f, raiseCostEnd(adopting, seen?.end?.costUsd))
  settle(f, runId)
}

// A step is the latest unless it was seen before the latest so far (a late step
// of an earlier turn). A step index restarts at 0 with each turn, so within the
// turn the agent last stepped in the index decides too; a step of a new turn is
// otherwise the latest.
function isLateStep(entry: Omit<Pending, 'seenAt' | 'end'>, ev: Extract<FleetEvent, { kind: 'step' }>): boolean {
  return entry.lastStepAt !== undefined && ev.at < entry.lastStepAt
}

function stepped<T extends Omit<Pending, 'seenAt' | 'end'>>(entry: T, f: Fleet, ev: Extract<FleetEvent, { kind: 'step' }>): T {
  const usage = ev.usage
  const context = usage === null ? undefined : usage.input + usage.cacheRead + usage.cacheCreation
  const isSameTurn = entry.lastTurnId === undefined || ev.turnId === undefined || entry.lastTurnId === ev.turnId
  const isLatest = !isLateStep(entry, ev) && (entry.lastStepIndex === undefined || !isSameTurn || ev.index >= entry.lastStepIndex)
  return {
    ...entry,
    model: entry.model === '' ? ev.model : entry.model,
    effort: ev.effort === undefined ? entry.effort : String(ev.effort),
    tokensIn: entry.tokensIn + (usage === null ? 0 : usage.input + usage.cacheCreation),
    tokensOut: entry.tokensOut + (usage?.output ?? 0),
    lastInputTokens: isLatest && context !== undefined ? context : entry.lastInputTokens,
    lastStepIndex: isLatest ? ev.index : entry.lastStepIndex,
    lastTurnId: isLatest ? (ev.turnId ?? entry.lastTurnId) : entry.lastTurnId,
    lastStepAt: isLatest ? ev.at : entry.lastStepAt,
    window: ev.model === f.mainModel ? f.mainWindow : entry.window,
  }
}

function onStep(f: Fleet, ev: Extract<FleetEvent, { kind: 'step' }>): void {
  if (ev.agentId === undefined) {
    f.mainModel = ev.model
    if (ev.window !== undefined) f.mainWindow = ev.window
    return
  }
  const agent = f.agents[ev.agentId]
  if (agent === undefined) {
    f.pending[ev.agentId] = stepped(pendingOf(f, ev.agentId, ev.at), f, ev)
    return
  }
  sighted(f, stepped(agent, f, ev), ev.at, isLateStep(agent, ev))
}

// The start of a turn of an agent's loop: a sighting like any other, which
// sets an agent recorded over running again, as its next step would.
function onWake(f: Fleet, ev: Extract<FleetEvent, { kind: 'wake' }>): void {
  const agent = f.agents[ev.agentId]
  if (agent === undefined) {
    f.pending[ev.agentId] = pendingOf(f, ev.agentId, ev.at)
    return
  }
  sighted(f, agent, ev.at, false)
}

function onTool(f: Fleet, ev: Extract<FleetEvent, { kind: 'tool' }>): void {
  const lastTool = clip(ev.tool, LABEL_CHARS)
  const agent = f.agents[ev.agentId]
  if (agent === undefined) {
    f.pending[ev.agentId] = { ...pendingOf(f, ev.agentId, ev.at), lastTool }
    return
  }
  sighted(f, { ...agent, lastTool }, ev.at, false)
}

// Whether an outcome from `source` replaces what the agent holds: a running or
// lost agent takes any outcome; a real one replaces one taken from the list;
// nothing replaces a real one, and a list outcome never replaces anything.
function isOverriding(held: Pick<Agent, 'status' | 'outcomeSource'>, source: 'list' | 'real'): boolean {
  if (held.status === 'running' || held.status === 'lost') return true
  return source === 'real' && held.outcomeSource === 'list'
}

// A completion confirming the status already held (a real one after the
// list's) brings the answer and the source, but keeps the earlier end and the
// cost sample taken with it: the end never moves later and an ended run is not
// reopened. Used for a pending entry's end and for a known agent's alike.
function isEndKept(held: { status: Agent['status']; at: number | undefined }, status: 'done' | 'failed', at: number): boolean {
  return held.status === status && held.at !== undefined && held.at <= at
}

function onComplete(f: Fleet, ev: Extract<FleetEvent, { kind: 'complete' }>): void {
  const failed = ev.isAborted || ev.reason !== 'answer'
  const preview = clip(ev.answer, PREVIEW_CHARS)
  const status: 'done' | 'failed' = failed ? 'failed' : 'done'
  const answerPreview = preview === '' ? undefined : preview
  const source = ev.source ?? 'real'
  const agent = f.agents[ev.agentId]
  if (agent === undefined) {
    const seen = pendingOf(f, ev.agentId, ev.at)
    const held = seen.end
    const isNewer = held === undefined || isOverriding({ status: held.status, outcomeSource: held.source }, source)
    if (!isNewer) {
      f.pending[ev.agentId] = seen
      return
    }
    const end =
      held !== undefined && isEndKept(held, status, ev.at)
        ? { ...held, source, answerPreview }
        : { at: ev.at, turn: f.turn, status, source, answerPreview, costUsd: ev.costUsd }
    f.pending[ev.agentId] = { ...seen, end }
    return
  }
  // Whether this completion sets the agent's end: only then is its cost sample the run's latest.
  let isEndMoved = false
  if (isOverriding(agent, source)) {
    const isKept = isEndKept({ status: agent.status, at: agent.endedAt }, status, ev.at)
    isEndMoved = !isKept
    putAgent(f, {
      ...agent,
      status,
      endedAt: isKept ? agent.endedAt : ev.at,
      endedTurn: isKept ? agent.endedTurn : f.turn,
      answerPreview,
      outcomeSource: source,
    })
  }
  const run = f.runs[agent.runId]
  if (run !== undefined && isEndMoved) putRun(f, raiseCostEnd(run, ev.costUsd))
  touch(f, agent.runId, ev.at)
  settle(f, agent.runId)
}

// The engine stopped listing agents we still hold as running: their completion
// was lost (a reload of the mod while they ran), so they are over, outcome unknown.
// An agent sighted after the loss's instant (a step or a tool call later than
// the list it was taken from) is alive: the mirror of `sighted()`'s rule.
function onLost(f: Fleet, ev: Extract<FleetEvent, { kind: 'lost' }>): void {
  const touched = new Set<string>()
  for (const id of ev.ids) {
    const agent = f.agents[id]
    if (agent === undefined || agent.status !== 'running') continue
    if ((agent.lastSeenAt ?? -Infinity) > ev.at) continue
    putAgent(f, { ...agent, status: 'lost', endedAt: ev.at, endedTurn: f.turn })
    touched.add(agent.runId)
  }
  for (const runId of touched) settle(f, runId)
}

// The running agents of loose runs that the engine's agent list does not
// carry and that began before `before` (one spawned since the list was taken
// is not missing, just newer). A workflow's agents are never listed by the
// engine, so they cannot be told apart from lost ones and are left alone.
export function unlistedRunning(f: Fleet, listedIds: ReadonlySet<string>, before: number): string[] {
  const ids: string[] = []
  for (const agent of Object.values(f.agents)) {
    if (agent.status !== 'running' || listedIds.has(agent.id) || agent.startedAt >= before) continue
    if (f.runs[agent.runId]?.kind !== 'subagents') continue
    ids.push(agent.id)
  }
  return ids
}

// True when some settling run's grace is out, or some workflow run has been
// silent too long, at `at`: an `expire` has work. A silent workflow with nothing
// running is not live, so this is asked on a coarse timer of its own as well as
// on the 1 Hz tick.
export function hasExpirable(f: Fleet, at: number): boolean {
  return f.order.some(id => {
    const run = f.runs[id]
    if (run === undefined) return false
    if (isIdleWorkflow(f, run, at)) return true
    return run.settlingAt !== undefined && at - run.settlingAt >= RUN_END_GRACE_MS && !hasRunning(f, run)
  })
}

// A failure is announced once it is real, or once one taken from the engine's
// list has stood for the grace without a real completion correcting it.
function isFailureDue(agent: Agent, at: number): boolean {
  if (agent.status !== 'failed' || agent.isAnnounced === true) return false
  return agent.outcomeSource !== 'list' || at - (agent.endedAt ?? at) >= RUN_END_GRACE_MS
}

// True when the upkeep has something to record at `at`: a run to end, or a
// failure from the list whose wait is over (recording any event announces it).
export function isDue(f: Fleet, at: number): boolean {
  if (hasExpirable(f, at)) return true
  return f.order.some(id => {
    const run = f.runs[id]
    return run !== undefined && run.summary === undefined && membersOf(f, run).some(a => isFailureDue(a, at))
  })
}

function summaryOf(f: Fleet, run: Run): RunSummary {
  const stats = runStats(f, run)
  const summary: RunSummary = {
    name: runTitle(run),
    total: stats.total,
    done: stats.done,
    failed: stats.failed,
    denied: stats.denied,
    tokens: stats.tokens,
    startedAt: run.startedAt,
  }
  if (stats.lost > 0) summary.lost = stats.lost
  if (run.endedAt !== undefined) summary.endedAt = run.endedAt
  if (stats.costUsd !== undefined) summary.costUsd = stats.costUsd
  return summary
}

export function hasRunning(f: Fleet, run: Run): boolean {
  return run.agentIds.some(id => f.agents[id]?.status === 'running')
}

// Running, or settling between phases: the run is not over yet.
export function isLive(f: Fleet, run: Run): boolean {
  return run.settlingAt !== undefined || hasRunning(f, run)
}

// A run whose end and failures have all been said aloud: its end carries the
// outcome last announced and no failed agent waits for its toast. Only such a
// run may be reduced or dropped, or `announce()` would never see what is due.
function isFullyAnnounced(f: Fleet, run: Run): boolean {
  if (run.endedAt === undefined || run.announced === undefined) return false
  if (run.announced !== outcomeOf(runStats(f, run))) return false
  return !membersOf(f, run).some(a => a.status === 'failed' && a.isAnnounced !== true)
}

// A loose run that holds no agent can never end: nothing waits to join it (a
// spawn that recorded nothing left it behind, and the turn's next spawn opens
// it afresh). A workflow run with none still waits on its spawns, and silence
// ends it.
function isHollow(f: Fleet, run: Run): boolean {
  return run.kind === 'subagents' && run.summary === undefined && membersOf(f, run).length === 0
}

function dropRun(f: Fleet, id: string): void {
  const run = f.runs[id]
  if (run !== undefined) for (const agentId of run.agentIds) delete f.agents[agentId]
  delete f.runs[id]
  f.order = f.order.filter(kept => kept !== id)
}

// The most recent RUNS_DETAILED runs keep their agents; older settled runs are
// reduced to a summary; past RUNS_KEPT the oldest settled runs go entirely. A
// run with an agent still running is never reduced, nor one with anything left
// to announce: the next reduce after the announcement does it. A hollow run
// goes at once, so nothing that cannot end holds the bound.
function bound(f: Fleet): void {
  for (const id of [...f.order]) {
    const run = f.runs[id]
    if (run !== undefined && isHollow(f, run)) dropRun(f, id)
  }
  const olderCount = Math.max(0, f.order.length - RUNS_DETAILED)
  for (const id of f.order.slice(0, olderCount)) {
    const run = f.runs[id]
    if (run === undefined || run.summary !== undefined || isLive(f, run) || !isFullyAnnounced(f, run)) continue
    const summary = summaryOf(f, run)
    for (const agentId of run.agentIds) delete f.agents[agentId]
    putRun(f, { ...run, agentIds: [], summary })
  }
  while (f.order.length > RUNS_KEPT) {
    const oldest = f.order[0]
    const run = oldest === undefined ? undefined : f.runs[oldest]
    if (oldest === undefined || run === undefined || isLive(f, run)) break
    if (run.summary === undefined && !isFullyAnnounced(f, run)) break
    dropRun(f, oldest)
  }
}

// `/fleet clear`: every run that is over (summaries included) leaves the view
// with its agents. A run still waiting on its first agent stays.
function clearFinished(f: Fleet): void {
  const kept: string[] = []
  for (const id of f.order) {
    const run = f.runs[id]
    if (run === undefined) continue
    const isOver = !hasRunning(f, run) && (run.summary !== undefined || run.endedAt !== undefined)
    if (!isOver) {
      kept.push(id)
      continue
    }
    for (const agentId of run.agentIds) delete f.agents[agentId]
    delete f.runs[id]
  }
  f.order = kept
}

// An alias outlives nothing: once its run is gone (dropped by the bounds or by
// `/fleet clear`), the next spawn without a call id opens a run of its own.
function pruneAliases(f: Fleet): void {
  f.workflowAlias = Object.fromEntries(Object.entries(f.workflowAlias).filter(([, runId]) => f.runs[runId] !== undefined))
}

export function reduce(previous: Fleet, event: FleetEvent): Fleet {
  const f: Fleet = {
    ...previous,
    runs: { ...previous.runs },
    agents: { ...previous.agents },
    pending: { ...previous.pending },
    workflowAlias: { ...previous.workflowAlias },
    order: [...previous.order],
  }
  switch (event.kind) {
    case 'turn-start':
      f.turn += 1
      if (event.tzOffsetMin !== undefined) f.tzOffsetMin = event.tzOffsetMin
      return f
    case 'expire':
      expire(f, event.at)
      break
    case 'lost':
      onLost(f, event)
      break
    case 'auto-opened':
      f.hasAutoOpened = true
      return f
    case 'clear':
      clearFinished(f)
      pruneAliases(f)
      return f
    case 'workflow-start':
      onWorkflowStart(f, event)
      break
    case 'workflow-launched':
      onWorkflowLaunched(f, event)
      break
    case 'workflow-end':
      onWorkflowEnd(f, event)
      break
    case 'spawn':
      onSpawn(f, event)
      break
    case 'step':
      onStep(f, event)
      break
    case 'tool':
      onTool(f, event)
      break
    case 'wake':
      onWake(f, event)
      break
    case 'complete':
      onComplete(f, event)
      break
  }
  if ('at' in event) prunePending(f, event.at)
  bound(f)
  pruneAliases(f)
  return f
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export type RunStats = {
  total: number
  running: number
  done: number
  failed: number
  denied: number
  lost: number
  tokens: number
  startedAt: number
  endedAt?: number
  costUsd?: number
}

export function runTitle(run: Run): string {
  return run.summary?.name ?? run.name ?? (run.kind === 'workflow' ? 'Workflow' : 'Subagents')
}

// Run cost is the session-cost delta between the run's first sample and its
// last agent's completion: it includes main-loop spend in that window.
function costOf(run: Run): number | undefined {
  if (run.costStartUsd === undefined || run.costEndUsd === undefined) return undefined
  return Math.max(0, run.costEndUsd - run.costStartUsd)
}

export function runStats(f: Fleet, run: Run): RunStats {
  if (run.summary !== undefined) {
    const s = run.summary
    return {
      total: s.total,
      running: 0,
      done: s.done,
      failed: s.failed,
      denied: s.denied,
      lost: s.lost ?? 0,
      tokens: s.tokens,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      costUsd: s.costUsd,
    }
  }
  const stats: RunStats = {
    total: 0,
    running: 0,
    done: 0,
    failed: 0,
    denied: 0,
    lost: 0,
    tokens: 0,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    costUsd: costOf(run),
  }
  for (const id of run.agentIds) {
    const agent = f.agents[id]
    if (agent === undefined) continue
    stats.tokens += agent.tokensIn + agent.tokensOut
    if (agent.status === 'denied') {
      stats.denied += 1
      continue
    }
    stats.total += 1
    if (agent.status === 'running') stats.running += 1
    else if (agent.status === 'done') stats.done += 1
    else if (agent.status === 'lost') stats.lost += 1
    else stats.failed += 1
  }
  return stats
}

export function isBandVisible(f: Fleet): boolean {
  return f.order.some(id => {
    const run = f.runs[id]
    if (run === undefined) return false
    if (isLive(f, run)) return true
    return run.endedTurn !== undefined && f.turn - run.endedTurn <= BAND_LINGER_TURNS
  })
}

function bandRun(f: Fleet): Run | undefined {
  const runs = f.order.map(id => f.runs[id]).filter((r): r is Run => r !== undefined)
  const live = runs.filter(r => isLive(f, r))
  const pool = live.length > 0 ? live : runs
  return pool[pool.length - 1]
}

export type Band = {
  tone: 'running' | 'done' | 'failed'
  glyph: string
  title: string
  parts: string[]
}

// The single line above the prompt, or null when nothing runs and nothing
// finished in the last turn.
export function bandOf(f: Fleet, now: number): Band | null {
  if (!isBandVisible(f)) return null
  const run = bandRun(f)
  if (run === undefined) return null
  const stats = runStats(f, run)

  const parts: string[] = []
  if (stats.total > 0) parts.push(`tasks ${stats.done}/${stats.total}`)
  if (stats.running > 0) parts.push(`${stats.running} running`)
  if (stats.failed > 0) parts.push(`${stats.failed} failed`)
  if (stats.denied > 0) parts.push(`${stats.denied} denied`)
  if (stats.lost > 0) parts.push(`${stats.lost} lost`)
  parts.push(formatElapsed((stats.endedAt ?? now) - stats.startedAt))
  parts.push(`${formatTokens(stats.tokens)} tok`)

  // Nothing started: a launch that failed, or every spawn refused.
  const isIdle = stats.total === 0
  if (isIdle && stats.denied === 0) parts.unshift('not started')
  const tone = stats.running > 0 || run.settlingAt !== undefined ? 'running' : stats.failed > 0 || isIdle ? 'failed' : 'done'
  const glyph = tone === 'running' ? '◉' : tone === 'failed' ? '✗' : '✓'
  return { tone, glyph, title: runTitle(run), parts }
}

// ---------------------------------------------------------------------------
// Toasts. The markers live in the state itself, so a replayed or repeated call
// finds nothing new to say. A failure is announced once (`isAnnounced`). A run's
// end is announced by its outcome (`announced`): an end whose outcome differs
// from the one last announced is due, so a premature end that reopens and ends
// otherwise is announced again, and an unchanged outcome never twice.
// ---------------------------------------------------------------------------

export type Announced = { fleet: Fleet; messages: string[] }

function outcomeOf(stats: RunStats): string {
  return `${stats.done}/${stats.total}/${stats.failed}/${stats.denied}/${stats.lost}`
}

// What is due at `at`: a list-derived failure waits out the grace first.
export function announce(fleet: Fleet, at: number): Announced {
  const f: Fleet = { ...fleet, runs: { ...fleet.runs }, agents: { ...fleet.agents } }
  const failures: string[] = []
  const ends: string[] = []

  for (const id of f.order) {
    const run = f.runs[id]
    if (run === undefined || run.summary !== undefined) continue

    for (const agentId of run.agentIds) {
      const agent = f.agents[agentId]
      if (agent === undefined || !isFailureDue(agent, at)) continue
      f.agents[agentId] = { ...agent, isAnnounced: true }
      failures.push(`${agent.description === '' ? 'An agent' : clip(agent.description, 50)} failed`)
    }

    if (run.endedAt === undefined || hasRunning(f, run)) continue
    const stats = runStats(f, run)
    const outcome = outcomeOf(stats)
    if (run.announced === outcome) continue
    f.runs[id] = { ...run, announced: outcome }
    const title = runTitle(run)
    if (stats.total === 0) {
      ends.push(`${title} did not start`)
      continue
    }
    const parts = [`${stats.done}/${stats.total} done`]
    if (stats.failed > 0) parts.push(`${stats.failed} failed`)
    if (stats.denied > 0) parts.push(`${stats.denied} denied`)
    if (stats.lost > 0) parts.push(`${stats.lost} lost`)
    parts.push(formatClock((run.endedAt ?? run.startedAt) - run.startedAt))
    parts.push(`${formatTokens(stats.tokens)} tok`)
    ends.push(`${title} finished · ${parts.join(' · ')}`)
  }
  return { fleet: f, messages: [...failures, ...ends] }
}

export function isAnyRunning(f: Fleet): boolean {
  return f.order.some(id => {
    const run = f.runs[id]
    return run !== undefined && isLive(f, run)
  })
}
