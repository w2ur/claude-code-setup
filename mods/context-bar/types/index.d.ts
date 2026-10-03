export type ContextBarRow = {
  name: string
  tokens: number
  color: string
  isFree: boolean
}

export type ContextBarSnapshot = {
  rows: ContextBarRow[]
  usedTokens: number
  maxTokens: number
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { isShown: boolean; snapshot: ContextBarSnapshot | null }
  }
}
