// One entry behind a category: an MCP server, a skill, a memory file, an agent.
export type ContextBarItem = {
  name: string
  tokens: number
}

export type ContextBarRow = {
  name: string
  tokens: number
  // /context's theme colour: the band draws with it, the pane has its own hues.
  color: string
  isFree: boolean
  kind: 'used' | 'free' | 'buffer'
  // Biggest first; absent or empty when the category has no per-item data.
  items?: ContextBarItem[]
}

export type ContextBarSnapshot = {
  rows: ContextBarRow[]
  usedTokens: number
  maxTokens: number
  percent: number
  // The token count at which auto-compaction runs; absent when it is off.
  autoCompactAt?: number
  isAutoCompactEnabled: boolean
}

// What the pane draws right now: it glides toward the snapshot frame by frame.
export type ContextBarView = {
  percent: number
  fractions: Record<string, number>
}

// One measurement of the session, stamped with the clock's time.
export type ContextBarReading = {
  percent: number
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: ContextBarSnapshot | null
      view: ContextBarView | null
      history: Shaped<ContextBarReading[]>
      // The name of the category whose items the pane lists; one at a time.
      expanded: string | null
      tick: number
    }
  }
}
