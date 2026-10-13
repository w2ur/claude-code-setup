export type Phase = { title: string; detail?: string }

// `lost`: recorded running, but the engine no longer lists it and no completion arrived.
export type AgentStatus = 'running' | 'done' | 'failed' | 'denied' | 'lost'

export type Agent = {
  id: string
  parentId?: string
  runId: string
  description: string
  subagentType?: string
  model: string
  effort?: string
  status: AgentStatus
  denyReason?: string
  isBackground?: boolean
  startedAt: number
  endedAt?: number
  endedTurn?: number
  tokensIn: number
  tokensOut: number
  lastInputTokens: number
  lastStepIndex?: number
  // The turn `lastStepIndex` belongs to: a step index restarts at 0 with each turn.
  lastTurnId?: string
  // When the step `lastStepIndex` belongs to was seen: a step seen earlier than this is a late one.
  lastStepAt?: number
  window?: number
  lastTool?: string
  // The latest sighting (a step or a tool call, before the spawn too): a loss must not predate it.
  lastSeenAt?: number
  answerPreview?: string
  // Where the outcome (done/failed) came from: the agent's own turn.complete
  // ('real'), or the engine's agent list ('list'), which a real one overrides.
  outcomeSource?: 'list' | 'real'
  isAnnounced?: boolean
}

export type RunSummary = {
  name: string
  total: number
  done: number
  failed: number
  denied: number
  lost?: number
  tokens: number
  startedAt: number
  endedAt?: number
  costUsd?: number
}

export type Run = {
  id: string
  kind: 'workflow' | 'subagents'
  name?: string
  phases?: Phase[]
  workflowRunId?: string
  startedAt: number
  endedAt?: number
  endedTurn?: number
  // The last event (spawn, step, tool, complete) that named this run: a workflow with none for too long is over.
  lastActivityAt?: number
  // Set while every agent so far is done but the grace period has not run out: the run may still spawn its next phase.
  settlingAt?: number
  agentIds: string[]
  costStartUsd?: number
  costEndUsd?: number
  summary?: RunSummary
  // The outcome last announced for the run's end: an end is toasted when its outcome differs from it.
  announced?: string
  // Opened by a spawn that named no Workflow call: the launch of the call may still fold it in.
  provisional?: boolean
}

// What was seen of an agent no spawn has named (yet): the engine may step an
// agent before its spawn hook has the result, and its own forks (compaction,
// memory) step under ids no spawn ever names. Never drawn; a spawn adopts it.
export type Pending = Pick<
  Agent,
  | 'model'
  | 'effort'
  | 'tokensIn'
  | 'tokensOut'
  | 'lastInputTokens'
  | 'lastStepIndex'
  | 'lastTurnId'
  | 'lastStepAt'
  | 'window'
  | 'lastTool'
> & {
  // The last sighting of the id (step, tool call or completion): the time to
  // live counts from it, and the adopting agent takes it as its `lastSeenAt`.
  seenAt: number
  end?: {
    at: number
    turn: number
    status: 'done' | 'failed'
    source: 'list' | 'real'
    answerPreview?: string
    costUsd?: number
  }
}

export type Fleet = {
  // Minutes east of UTC, refreshed each turn, so run titles can show a local clock time.
  tzOffsetMin?: number
  runs: Record<string, Run>
  agents: Record<string, Agent>
  pending: Record<string, Pending>
  // A workflow's own run id -> the run its next spawn without a Workflow call id joins
  // while it is open or ended less than REJOIN_WINDOW_MS ago (it reopens): the latest
  // call launched under it, or the provisional run such a spawn opened.
  workflowAlias: Record<string, string>
  order: string[]
  hasAutoOpened: boolean
  turn: number
  mainModel?: string
  mainWindow?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-fleet': { fleet: Shaped<Fleet>; tick: number }
  }
}
