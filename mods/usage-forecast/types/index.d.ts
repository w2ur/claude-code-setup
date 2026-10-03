export type UsageWindowView = {
  kind: string
  percent: number
  /** Epoch ms; absent when the API gave no reset time. */
  resetsAt?: number
  /** Percentage points per hour over the lookback; absent without enough samples. */
  ratePerHour?: number
  /** Epoch ms the window fills at this pace; absent when it resets first. */
  fullAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-forecast': { windows: UsageWindowView[]; tick: number; isShown: boolean }
  }
}
