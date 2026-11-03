import { describe, expect, test } from 'claude-code/testing'

import type { Ledger } from '../hooks/ledger'
import { viewsOf } from '../hooks/views'
import type { ParsedPlan } from '../types'

const CFG = '/h/.claude'
const NOW = 10_000_000
const MIN = 60_000

const plan = (file: string, n = 5): ParsedPlan => ({
  file,
  title: file,
  tasks: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), title: `t${i + 1}` })),
})

const ledger = (file: string, over: Partial<Ledger> = {}): Ledger => ({
  planPath: `${CFG}/plans/${file}`,
  root: '/w/repo',
  mtimeMs: NOW - 10 * MIN,
  completed: ['1', '2'],
  isFinal: false,
  ...over,
})

describe('viewsOf', () => {
  // Regression: the label named the worktree leaf, not the repo.
  test('repo label: worktree roots show their repo, the config dir shows ~/.claude', () => {
    const label = (root: string, repo?: string) =>
      viewsOf([plan('p.md')], [ledger('p.md', repo === undefined ? { root } : { root, repo })], ['p.md'], CFG, NOW)[0]?.repo
    expect(label('/h/Dev/my-editor-app/.worktrees/feat')).toBe('my-editor-app')
    expect(label('/h/Dev/my-editor-app/.claude/worktrees/refonte')).toBe('my-editor-app')
    expect(label('/h/.claude-wt/session-watch', 'claude')).toBe('claude')
    expect(label(CFG)).toBe('~/.claude')
    expect(label('/h/Dev/la-table')).toBe('la-table')
  })

  test('running: 2/5, current is task 3', () => {
    const [v] = viewsOf([plan('p.md')], [ledger('p.md')], ['p.md'], CFG, NOW)
    expect(v?.status).toBe('running')
    expect([v?.done, v?.total]).toEqual([2, 5])
    expect(v?.current?.id).toBe('3')
    expect(v?.repo).toBe('repo')
    expect(v?.ageMs).toBe(10 * MIN)
    expect(v?.tasks.map((t) => t.isDone)).toEqual([true, true, false, false, false])
  })

  test('stalled after 31 minutes', () => {
    const [v] = viewsOf([plan('p.md')], [ledger('p.md', { mtimeMs: NOW - 31 * MIN })], ['p.md'], CFG, NOW)
    expect(v?.status).toBe('stalled')
  })

  test('current is lastTouched when not completed', () => {
    const [v] = viewsOf([plan('p.md')], [ledger('p.md', { lastTouched: '4' })], ['p.md'], CFG, NOW)
    expect(v?.current?.id).toBe('4')
  })

  test('all complete or final: no view', () => {
    const all = ledger('p.md', { completed: ['1', '2', '3', '4', '5'] })
    expect(viewsOf([plan('p.md')], [all], ['p.md'], CFG, NOW)).toEqual([])
    expect(viewsOf([plan('p.md')], [ledger('p.md', { isFinal: true })], ['p.md'], CFG, NOW)).toEqual([])
  })

  test('ledger naming a plan that is not listed (archived): no view', () => {
    expect(viewsOf([plan('p.md')], [ledger('archive/old.md')], ['p.md'], CFG, NOW)).toEqual([])
  })

  test('two ledgers on one plan: the newer wins', () => {
    const older = ledger('p.md', { root: '/w/old', mtimeMs: NOW - 20 * MIN })
    const newer = ledger('p.md', { root: '/w/new', mtimeMs: NOW - 2 * MIN })
    const vs = viewsOf([plan('p.md')], [older, newer], ['p.md'], CFG, NOW)
    expect(vs.length).toBe(1)
    expect(vs[0]?.repo).toBe('new')
  })

  test('~/ plan path is expanded', () => {
    const l = ledger('p.md', { planPath: '~/.claude/plans/p.md' })
    expect(viewsOf([plan('p.md')], [l], ['p.md'], CFG, NOW).length).toBe(1)
  })

  test('subfolder plan, siblings, and ordering running before stalled', () => {
    const plans = [plan('a.md'), plan('sub/b.md'), plan('c.md')]
    const ls = [
      ledger('a.md', { mtimeMs: NOW - 40 * MIN }),
      ledger('sub/b.md', { mtimeMs: NOW - 5 * MIN }),
      ledger('c.md', { mtimeMs: NOW - 1 * MIN }),
    ]
    const vs = viewsOf(plans, ls, ['a.md', 'sub/b.md', 'c.md', 'a-review.md'], CFG, NOW)
    expect(vs.map((v) => v.file)).toEqual(['c.md', 'sub/b.md', 'a.md'])
    expect(vs[2]?.siblings).toEqual(['a-review.md'])
  })

  test('plan with no tasks never yields a view', () => {
    expect(viewsOf([plan('p.md', 0)], [ledger('p.md', { completed: [] })], ['p.md'], CFG, NOW)).toEqual([])
  })
})
