import type { ContextBarItem, ContextBarRow } from '../types'

// The lists /context prints beneath its grid, as far as the breakdown carries
// them. Every list is optional here: a breakdown that leaves one out gives its
// category no detail rather than failing the measurement.
export type ItemSources = {
  mcpTools?: readonly { serverName: string; tokens: number; isLoaded: boolean }[]
  agents?: readonly { agentType: string; tokens: number }[]
  memoryFiles?: readonly { path: string; type: string; tokens: number }[]
  skills?: { skillFrontmatter: readonly { name: string; tokens: number }[] }
}

const byTokens = (a: ContextBarItem, b: ContextBarItem): number => b.tokens - a.tokens || a.name.localeCompare(b.name)

function perServer(tools: NonNullable<ItemSources['mcpTools']>): ContextBarItem[] {
  const sums = new Map<string, number>()
  for (const t of tools) if (t.isLoaded) sums.set(t.serverName, (sums.get(t.serverName) ?? 0) + t.tokens)

  return [...sums].map(([name, tokens]) => ({ name, tokens }))
}

// The items behind one category row, biggest first; empty when it has none.
// The row is found by its name, which is /context's own label: `kind` cannot
// tell the used categories apart.
export function itemsOf(row: Pick<ContextBarRow, 'name' | 'kind'>, sources: ItemSources): ContextBarItem[] {
  if (row.kind !== 'used') return []
  const name = row.name.toLowerCase()
  let items: ContextBarItem[] = []
  if (name.startsWith('mcp tools')) items = perServer(sources.mcpTools ?? [])
  else if (name.startsWith('custom agents')) items = (sources.agents ?? []).map(a => ({ name: a.agentType, tokens: a.tokens }))
  else if (name.startsWith('memory files')) {
    items = (sources.memoryFiles ?? []).map(f => ({ name: `${f.path.split('/').pop() ?? f.path} (${f.type})`, tokens: f.tokens }))
  } else if (name.startsWith('skills')) items = (sources.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, tokens: s.tokens }))

  return items.filter(i => i.tokens > 0).sort(byTokens)
}
