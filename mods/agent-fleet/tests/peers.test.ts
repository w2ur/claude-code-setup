import { describe, expect, test } from 'claude-code/testing'

import type { Agent, Fleet, PeerSnapshot, Run } from '../types'
import { emptyFleet } from '../hooks/fleet'
import { isLivePeer, livePeers, parsePeer, sameContent, snapshotOf } from '../hooks/peers'

function agent(id: string, runId: string, status: Agent['status']): Agent {
  return {
    id,
    runId,
    description: id,
    model: 'm',
    status,
    startedAt: 1,
    tokensIn: 0,
    tokensOut: 0,
    lastInputTokens: 0,
  }
}

function fleet(): Fleet {
  const f = emptyFleet()
  const live: Run = { id: 'r1', kind: 'workflow', name: 'alpha', startedAt: 10, agentIds: ['a1', 'a2', 'a3'] }
  const over: Run = { id: 'r2', kind: 'subagents', startedAt: 5, endedAt: 9, agentIds: ['b1'] }
  f.runs = { r1: live, r2: over }
  f.order = ['r1', 'r2']
  f.agents = {
    a1: agent('a1', 'r1', 'done'),
    a2: agent('a2', 'r1', 'running'),
    a3: agent('a3', 'r1', 'running'),
    b1: agent('b1', 'r2', 'done'),
  }
  return f
}

const envelope = { sessionId: 'a', cwd: '/x', startedAt: 100, heartbeatAt: 200 }
const snap = (over: Partial<PeerSnapshot> = {}): PeerSnapshot => ({ v: 1, ...envelope, runs: [], ...over })

describe('snapshotOf', () => {
  test('keeps live runs only, with their counts', () => {
    const s = snapshotOf(fleet(), envelope)
    expect(s.runs).toEqual([{ title: 'alpha', kind: 'workflow', total: 3, done: 1, failed: 0, startedAt: 10 }])
  })
})

describe('parsePeer', () => {
  test('a truncated file is undefined', () => {
    expect(parsePeer('{"v":1,"sessionId":"a"')).toBeUndefined()
  })
  test('another version is undefined', () => {
    expect(parsePeer(JSON.stringify({ ...snap(), v: 2 }))).toBeUndefined()
  })
  test('a bad envelope or runs is undefined', () => {
    expect(parsePeer(JSON.stringify({ ...snap(), runs: 'x' }))).toBeUndefined()
    expect(parsePeer(JSON.stringify({ ...snap(), cwd: 3 }))).toBeUndefined()
    expect(parsePeer('null')).toBeUndefined()
  })
  test('round-trips a snapshot', () => {
    const s = snapshotOf(fleet(), envelope)
    expect(parsePeer(JSON.stringify(s))).toEqual(s)
  })
})

describe('isLivePeer', () => {
  const now = 1_000_000
  test('the window edge', () => {
    expect(isLivePeer(snap({ heartbeatAt: now - 60_000 }), now)).toBe(true)
    expect(isLivePeer(snap({ heartbeatAt: now - 60_001 }), now)).toBe(false)
  })
  test('an ended session is not live', () => {
    expect(isLivePeer(snap({ heartbeatAt: now, endedAt: now }), now)).toBe(false)
  })
})

describe('livePeers', () => {
  test('drops self and orders by startedAt', () => {
    const now = 1000
    const out = livePeers(
      [
        snap({ sessionId: 'late', startedAt: 50, heartbeatAt: now }),
        snap({ sessionId: 'me', startedAt: 1, heartbeatAt: now }),
        snap({ sessionId: 'early', startedAt: 10, heartbeatAt: now }),
      ],
      'me',
      now,
    )
    expect(out.map(p => p.sessionId)).toEqual(['early', 'late'])
  })
})

describe('sameContent', () => {
  const run = { title: 't', kind: 'workflow' as const, total: 2, done: 1, failed: 0, startedAt: 1 }
  test('ignores heartbeatAt', () => {
    expect(sameContent(snap({ runs: [run] }), snap({ heartbeatAt: 999, runs: [run] }))).toBe(true)
  })
  test('sees a changed run', () => {
    expect(sameContent(snap({ runs: [run] }), snap({ runs: [{ ...run, done: 2 }] }))).toBe(false)
  })
  test('nothing before is different', () => {
    expect(sameContent(undefined, snap())).toBe(false)
  })
})
