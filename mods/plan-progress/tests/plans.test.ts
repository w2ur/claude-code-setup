import { describe, expect, test } from 'claude-code/testing'

import { parsePlan, siblingsOf, taskIdOf } from '../hooks/plans'

const ids = (text: string) => parsePlan('p.md', text)?.tasks.map((t) => t.id)

describe('parsePlan', () => {
  // Regression: la-table plans keep tasks as `1. **Title**` under `## Tasks`; only that section counts.
  test('la-table: numbered bold list under ## Tasks, not in other sections', () => {
    const text = [
      '# Remove planned lines Implementation Plan',
      '## Review Focus',
      '1. **A review point** — not a task',
      '## Tasks',
      '',
      '1. **Trip without a receipt** — migration 0009, `Trip.noReceipt`, `src/worker/schema.ts`, `recordTrip` and',
      '   `setTripTotal` (`src/domain/ops/shopping.ts`), `calibration.ts`.',
      '2. **`shopping.remove` takes a reason** — `removeAjout` → `removeLine`, `HANDLERS`, `enterReste` extracted from `buy',
      '6. **Docs alongside each task**: spec §10.2 (Courses removal sheet, checkout), README (Courses paragraph, checkout a',
      '',
      'Order: 1, 2, 3, then 4 and 5, docs within each.',
      '## Out of scope',
      '1. **Not a task** — after the section',
    ].join('\n')
    const plan = parsePlan('p.md', text)
    expect(plan?.tasks.map((t) => t.id)).toEqual(['1', '2', '6'])
    expect(plan?.tasks[0]?.title).toBe('Trip without a receipt')
    expect(plan?.tasks[2]?.title).toBe('Docs alongside each task')
  })

  test('graphe-v0-1: ### Task B1 : style, 8 tasks', () => {
    const text = [
      '# Graphe v0.1 — Implementation Plan',
      '### Task B1 : inventaire des sources',
      '### Task B2 : extraction incrémentale',
      '### Task B3 : canonicalisation incrémentale',
      '### Task B4 : construction du coffre et du graphe',
      '### Task B5 : la route `POST /api/graphe`',
      '### Task B6 : orchestrateur, première construction, migration des extraits',
      '### Task B7 : LaunchAgent hebdomadaire et notification',
      '### Task B8 : le mod `graphe`, un graphe dessiné en ASCII (demande du 2026-10-27)',
    ].join('\n')
    expect(ids(text)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'])
    expect(parsePlan('p.md', text)?.tasks[0]?.title).toBe('inventaire des sources')
  })

  test('my-editor-app-small-fixes: ## Task A — style, 4 tasks', () => {
    const text = [
      '## Task A — Left navigation rail (replaces the top bar)',
      '## Task B — Light/dark toggle (lands with/after A: its control lives in the rail)',
      '## Task C — Écrire header compact',
      '## Task D — Corpus search and filters',
    ].join('\n')
    expect(ids(text)).toEqual(['A', 'B', 'C', 'D'])
  })

  test('my-art-tool-vision-scene: 23 tasks, suffixed ids, not the Task index heading', () => {
    const heads = [
      '1', '2', '3', '4', '5', '6', '7a', '7b', '8', '9', '10a', '10b', '10c', '11', '11b', '12', '13', '14', '14b', '15', '16', '17', '18',
    ]
    const text = ['## Task index', ...heads.map((h) => `### Task ${h}: something`)].join('\n')
    const got = ids(text)
    expect(got).toEqual(heads)
    expect(got?.length).toBe(23)
    expect(got).toContain('7a')
    expect(got).toContain('10c')
    expect(got).toContain('11b')
    expect(got).toContain('14b')
  })

  test('Task 0 is present', () => {
    expect(ids('### Task 0: Branch\n### Task 1: x')).toEqual(['0', '1'])
  })

  test('a heading inside a fenced code block is not a task', () => {
    const text = ['### Task 1: real', '```md', '### Task 3: x', '```', '### Task 2: also real'].join('\n')
    expect(ids(text)).toEqual(['1', '2'])
  })

  test('a review file has no tasks', () => {
    expect(parsePlan('r-review.md', '# Review\n## MUST\n- a\n## SHOULD\n- b')).toBeUndefined()
  })

  test('title drops " — Implementation Plan" without a stray dash', () => {
    expect(parsePlan('x.md', '# Writing margin — Implementation Plan\n### Task 1: a')?.title).toBe('Writing margin')
    expect(parsePlan('x.md', '# Writing margin - Implementation Plan\n### Task 1: a')?.title).toBe('Writing margin')
    expect(parsePlan('x.md', '# Writing margin Implementation Plan\n### Task 1: a')?.title).toBe('Writing margin')
  })

  test('title falls back to the file stem', () => {
    expect(parsePlan('sub/2026-11-01-x.md', '### Task 1: a')?.title).toBe('2026-11-01-x')
  })

  test('spec comes from the **Spec:** line', () => {
    const text = '# T\n**Spec:** `~/.claude/plans/2026-11-01-my-editor-app-corpus-links-design.md`\n### Task 1: a'
    expect(parsePlan('p.md', text)?.spec).toBe('~/.claude/plans/2026-11-01-my-editor-app-corpus-links-design.md')
    expect(parsePlan('p.md', '### Task 1: a')?.spec).toBeUndefined()
  })
})

describe('taskIdOf', () => {
  test('whole id, never a prefix', () => {
    expect(taskIdOf('Task 12: x')).toBe('12')
    expect(taskIdOf('Task 1: complete')).toBe('1')
    expect(taskIdOf('Task B1/Wave 2: y')).toBe('B1')
    expect(taskIdOf('Task 7a')).toBe('7a')
    expect(taskIdOf('Task 3 done')).toBe('3')
  })
  test('not a task reference', () => {
    expect(taskIdOf('Tasks done')).toBeUndefined()
    expect(taskIdOf('Taskforce 1')).toBeUndefined()
    expect(taskIdOf('nothing')).toBeUndefined()
  })
})

describe('siblingsOf', () => {
  const all = [
    '2026-11-01-my-editor-app-corpus-index-foundation.md',
    '2026-11-01-my-editor-app-corpus-index-foundation-review.md',
    '2026-11-01-my-editor-app-corpus-links-design.md',
    '2026-11-01-my-editor-app-writing-margin.md',
    '2026-11-01-my-editor-app-writing-margin-design.md',
    '2026-11-01-my-editor-app-writing-margin-review.md',
    '2026-11-01-my-editor-app-writing-margin-review-2.md',
    '2026-11-01-my-editor-app-other-review.md',
  ]
  test('plan with a Spec line: the spec and its review', () => {
    const plan = {
      file: '2026-11-01-my-editor-app-corpus-index-foundation.md',
      title: 't',
      spec: '~/.claude/plans/2026-11-01-my-editor-app-corpus-links-design.md',
      tasks: [],
    }
    expect(siblingsOf(plan, all).sort()).toEqual([
      '2026-11-01-my-editor-app-corpus-index-foundation-review.md',
      '2026-11-01-my-editor-app-corpus-links-design.md',
    ])
  })
  test('plan without a Spec line: design, review and review-k', () => {
    const plan = { file: '2026-11-01-my-editor-app-writing-margin.md', title: 't', tasks: [] }
    expect(siblingsOf(plan, all).sort()).toEqual([
      '2026-11-01-my-editor-app-writing-margin-design.md',
      '2026-11-01-my-editor-app-writing-margin-review-2.md',
      '2026-11-01-my-editor-app-writing-margin-review.md',
    ])
  })
  test('design of a prefix of the stem counts only without a spec line', () => {
    const files = ['2026-11-01-my-editor-app-design.md', '2026-11-01-ecri-design.md']
    const plan = { file: '2026-11-01-my-editor-app-writing-margin.md', title: 't', tasks: [] }
    expect(siblingsOf(plan, files)).toEqual(['2026-11-01-my-editor-app-design.md'])
    expect(siblingsOf({ ...plan, spec: '~/x/none.md' }, files)).toEqual([])
  })
})
