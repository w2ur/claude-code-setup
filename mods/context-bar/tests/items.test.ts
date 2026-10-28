import { expect, test } from 'claude-code/testing'

import { itemsOf } from '../hooks/items'

const used = (name: string) => ({ name, kind: 'used' as const })

test('MCP tools are summed per server, loaded ones only, biggest server first', () => {
  const mcpTools = [
    { serverName: 'a', tokens: 100, isLoaded: true },
    { serverName: 'b', tokens: 500, isLoaded: true },
    { serverName: 'a', tokens: 100, isLoaded: true },
    { serverName: 'c', tokens: 900, isLoaded: false },
  ]
  expect(itemsOf(used('MCP tools'), { mcpTools })).toEqual([
    { name: 'b', tokens: 500 },
    { name: 'a', tokens: 200 },
  ])
})

test('skills, agents and memory files are listed by name, biggest first', () => {
  expect(itemsOf(used('Skills'), { skills: { skillFrontmatter: [{ name: 'x', tokens: 5 }, { name: 'y', tokens: 9 }] } })).toEqual([
    { name: 'y', tokens: 9 },
    { name: 'x', tokens: 5 },
  ])
  expect(itemsOf(used('Custom agents'), { agents: [{ agentType: 'reviewer', tokens: 40 }] })).toEqual([{ name: 'reviewer', tokens: 40 }])
  expect(itemsOf(used('Memory files'), { memoryFiles: [{ path: '/a/b/CLAUDE.md', type: 'Project', tokens: 7 }] })).toEqual([
    { name: 'CLAUDE.md (Project)', tokens: 7 },
  ])
})

test('a category with no list, a missing list, or another kind has no items', () => {
  expect(itemsOf(used('Messages'), { mcpTools: [{ serverName: 'a', tokens: 1, isLoaded: true }] })).toEqual([])
  expect(itemsOf(used('Skills'), {})).toEqual([])
  expect(itemsOf({ name: 'MCP tools', kind: 'free' }, { mcpTools: [{ serverName: 'a', tokens: 1, isLoaded: true }] })).toEqual([])
})
