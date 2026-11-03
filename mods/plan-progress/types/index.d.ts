export type PlanTask = { id: string; title: string }

// `file` is the plan identity: its path relative to <config>/plans/.
export type ParsedPlan = { file: string; title: string; spec?: string; tasks: PlanTask[] }

// One plan as the Plans tab draws it (hooks/views.ts holds the derivation).
export type PlanView = {
  file: string
  title: string
  status: 'running' | 'stalled'
  done: number
  total: number
  current?: PlanTask
  repo: string
  ageMs: number
  siblings: string[]
  tasks: (PlanTask & { isDone: boolean })[]
}

declare module 'claude-code' {
  interface PluginState {
    'plan-progress': { views: PlanView[] }
  }
}
