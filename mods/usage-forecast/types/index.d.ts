export type UsageWindowView = {
  kind: string
  percent: number
  /** Epoch ms; absent when the API gave no reset time. */
  resetsAt?: number
  /** Percentage points per hour over the lookback; absent without enough samples. */
  ratePerHour?: number
  /** Epoch ms the window fills at this pace; absent when it resets first. */
  fullAt?: number
  /** Where the window stands at its reset at this pace, capped at 100. */
  projected?: number
  /** The kept samples' percentages, oldest first, for the sparkline. */
  history?: number[]
  /** Epoch ms of the last reading that moved up, within the kept samples. */
  lastRiseAt?: number
}

/** One fan-out the guard ruled on. */
export type GuardDecision = { at: number; what: string; ran: boolean; why: string }

export type GuardView = { agentsThisTurn: number; decisions: GuardDecision[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-forecast': {
      windows: Shaped<UsageWindowView[]>
      tick: number
      frame: number
      guard: Shaped<GuardView>
    }
  }
}
