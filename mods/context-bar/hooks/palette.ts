import type { ContextBarRow } from '../types'

// The pane's own colours, raw hex like gfx.ts HUE (mid saturation, readable on
// a dark and a light ground). /context's theme keys put several categories in
// look-alike tones; these are chosen apart, and the test pins how far.
//
// The engine's `kind` only separates used / free / buffer / deferred, so the
// used rows (system prompt, tools, messages...) are told apart by their name,
// which /context prints from a fixed set; a name outside it gets the fallback.
const USED_HUE: Record<string, string> = {
  messages: '#4a90c8',
  'system prompt': '#7d73d6',
  'system tools': '#2fb5b0',
  'mcp tools': '#d9a521',
  'custom agents': '#d4609a',
  'memory files': '#3fae7a',
  skills: '#b86fd0',
  'slash commands': '#a0b83a',
}
const OTHER_USED_HUE = '#9c7650'

export const FREE_HUE = '#8a8f98'
export const BUFFER_HUE = '#b09a7a'
// Where autocompaction triggers.
export const MARKER_HUE = '#e5322d'

export const KIND_GLYPH = { used: '■', free: '□', buffer: '▨' } as const

export const PALETTE: readonly string[] = [...Object.values(USED_HUE), OTHER_USED_HUE, FREE_HUE, BUFFER_HUE, MARKER_HUE]

export function hueOf(row: Pick<ContextBarRow, 'name' | 'kind'>): string {
  if (row.kind === 'free') return FREE_HUE
  if (row.kind === 'buffer') return BUFFER_HUE

  return USED_HUE[row.name.toLowerCase().replace(/\s*\(deferred\)$/, '')] ?? OTHER_USED_HUE
}
