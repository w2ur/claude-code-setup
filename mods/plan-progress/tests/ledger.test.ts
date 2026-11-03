import { describe, expect, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'

// Fixture: legacy flat ledger of {portfolio-site} (no plan-path line); its
// Task/FINAL REVIEW lines are copied under a synthetic first line.
const WRP = [
  '# SDD ledger — plan: /x/plans/p.md',
  'Task 1: complete (commit 70841a7, review clean; minors: non-CDATA entity decoding latent)',
  'Task 2: complete (commit e3312cc, review clean)',
  'Task 3: complete (commits 2b8fd55+0ba3319, review clean)',
  'Task 4: complete (commit a6bb4ec, review clean; 26 pages 0 warnings)',
  'Task 5: complete (commits f3e0496+f008abf, review clean)',
  'Task 6: complete (commit ac0e829; final review: Ready to merge)',
  'FINAL REVIEW: Ready to merge (10 commits, 26 pages 0 warnings, 4/4 tests)',
].join('\n')

const LA_TABLE = [
  '# SDD ledger — plan: /Users/{username}/.claude/plans/la-table/2026-10-26-remove-planned-lines.md',
  'Spec: ~/.claude/plans/la-table/2026-10-10-la-table-design.md',
  'Task 1: complete (commits 9863328..07f0e75, review clean)',
  'Task 1: minor (deferred): status.test « sacs » assertion broad',
  'Task 2: complete (commits 07f0e75..1b1f424, review clean)',
  'Task 3: complete (commits 1b1f424..850c1ea, review clean)',
  'Task 4: complete (commits 850c1ea..ab49d69, review clean)',
  'Task 5: complete (commits ab49d69..32c65bf, review clean)',
  'Ruling: an unchecked checkout row defaults to « Acheté sans ticket »',
  'Final review round 1 (/code-review high, claude-opus-5-5): 9 findings',
].join('\n')

describe('parseLedger', () => {
  test('legacy ledger: 6 completed and final', () => {
    const l = parseLedger(WRP, '/r/{portfolio-site}', 5)
    expect(l?.completed).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(l?.isFinal).toBe(true)
    expect(l?.planPath).toBe('/x/plans/p.md')
  })

  test('la-table ledger: path from first line, ids 1..5, final (Final review round)', () => {
    const l = parseLedger(LA_TABLE, '/r/la-table', 5)
    expect(l?.planPath).toBe('/Users/{username}/.claude/plans/la-table/2026-10-26-remove-planned-lines.md')
    expect(l?.completed).toEqual(['1', '2', '3', '4', '5'])
    expect(l?.isFinal).toBe(true)
    expect(l?.lastTouched).toBe('5')
  })

  test('Task 10 never counts as Task 1', () => {
    const l = parseLedger('# SDD ledger — plan: /p.md\nTask 1: complete\nTask 10: fix round 2', '/r', 1)
    expect(l?.completed).toEqual(['1'])
    expect(l?.lastTouched).toBe('10')
  })

  test('prose starting with a capital is not a completion', () => {
    const l = parseLedger('# SDD ledger — plan: /p.md\nTask I fixed the thing\nTask A: complete', '/r', 1)
    expect(l?.completed).toEqual(['A'])
    expect(l?.lastTouched).toBe('A')
  })

  test('lastTouched accepts the Task <id>/ form', () => {
    const l = parseLedger('# SDD ledger — plan: /p.md\nTask 2/spec: ok', '/r', 1)
    expect(l?.lastTouched).toBe('2')
  })

  test('plan-path marker used when the first line is missing; repo-relative resolved against root', () => {
    expect(parseLedger('Task 1: complete', '/r', 1, '/abs/plans/p.md\n')?.planPath).toBe('/abs/plans/p.md')
    expect(parseLedger('Task 1: complete', '/r/repo', 1, 'plans/p.md')?.planPath).toBe('/r/repo/plans/p.md')
    expect(parseLedger('Task 1: complete', '/r', 1, '~/.claude/plans/p.md')?.planPath).toBe('~/.claude/plans/p.md')
  })

  test('neither source gives undefined', () => {
    expect(parseLedger('Task 1: complete', '/r', 1)).toBeUndefined()
    expect(parseLedger('Task 1: complete', '/r', 1, '  ')).toBeUndefined()
  })

  // Regression: completion grammar — real ledger lines from memoire-transverse, my-editor-app
  // refonte-phase-3 and my-budget-app used forms the parser ignored.
  describe('completion grammar', () => {
    const head = '# SDD ledger — plan: /p.md\n'
    const done = (body: string) => parseLedger(head + body, '/r', 1)?.completed

    test('integer range (my-budget-app)', () => {
      expect(done('Tasks 5-6: complete (commits 5d7cc98, f57dc51; review approved).')).toEqual(['5', '6'])
    })
    test('comma list mid-line after ". " (my-editor-app)', () => {
      expect(done('Batch B fix round 1: 77fab1f (I1 actor precedence). Accepted. Task 3, 4, 5: complete')).toEqual(['3', '4', '5'])
    })
    test('plus form', () => {
      expect(done('Task A3+A4: complete for code (commits b03fd76..758eb0b)')).toEqual(['A3', 'A4'])
    })
    test('qualifier in brackets', () => {
      expect(done('Task A2 (steps 1,2,4b,6): complete (commits 9a8441a..ed1adf4, review clean)')).toEqual(['A2'])
    })
    test('several completions on one line', () => {
      expect(done('Batch A fix round 1: 4b7e489. Verified by controller (diff read). Task 1: complete. Task 2: complete.')).toEqual(['1', '2'])
    })
    test('space before the colon', () => {
      expect(done('Task 1 : complete')).toEqual(['1'])
    })
    test('a partial id completes the others only', () => {
      expect(done('Task 13, 14, 15-step1: complete')).toEqual(['13', '14'])
    })
    test('"fix round" before a completion on the same line', () => {
      expect(done('Task 7: fix round 2/5 (3 addressed; commit 14c047b). Task 7: complete (commits 6827d7b).')).toEqual(['7'])
    })
    test('a mid-file FINAL line, any FINAL form', () => {
      for (const f of ['FINAL REVIEW: ok', 'FINAL WHOLE-BRANCH REVIEW: ok', 'FINAL-FIX WAVE: done']) {
        expect(parseLedger(`${head}${f}\nTask 9: complete\n`, '/r', 1)?.isFinal).toBe(true)
      }
      expect(parseLedger(`${head}Finally something\n`, '/r', 1)?.isFinal).toBe(false)
    })
    // Regression: 76aa678 — `Final review round 14` (la-table) was not read as final: FINAL matched upper case only.
    test('FINAL in any case, followed by a space or a dash', () => {
      for (const f of ['Final review round 14 (/code-review high, claude-opus-5-5): 9 findings, none invariant → fix wave 15 (7', 'final-fix wave', 'Final fix wave 1: commits 32c65bf..4264257, 21 items applied']) {
        expect(parseLedger(`${head}${f}\n`, '/r', 1)?.isFinal).toBe(true)
      }
      expect(parseLedger(`${head}Final: parked\nFinally\n`, '/r', 1)?.isFinal).toBe(false)
    })
    // Regression: 76aa678 — a ruling quoting `Task 6 done. Task 7: complete` in backticks marked task 7 done (session-watch progress.md).
    test('a completion quoted in backticks counts for nothing', () => {
      const l = parseLedger(`${head}Final: parked — completion after colon-less prose on the same line missed (\`Task 6 done. Task 7: complete\`) — Ruling: accept\nTask 2: complete\n`, '/r', 1)
      expect(l?.completed).toEqual(['2'])
      expect(l?.lastTouched).toBe('2')
      expect(parseLedger(`${head}Task 3: complete\nnote \`Task 9: fix\`\n`, '/r', 1)?.lastTouched).toBe('3')
    })
    // Regression: 76aa678 — elenchus-proxy ledger writes `C1: complete (commit ad6f50d…)` without the Task prefix.
    test('a line-start completion without the Task prefix', () => {
      expect(done('W1: dispatched (opus), BASE b3e7174. C1: dispatched (sonnet), new repo, no BASE.\nC1: complete (commit ad6f50d, 1 Important carried to C2 by Ruling 10, 1 minor deferred)\nW1: complete (commit 0c503dd, review clean, 1 minor deferred).')).toEqual(['C1', 'W1'])
      expect(done('See also W2: complete (commit abc)')).toEqual([])
    })
    test('CRLF line endings', () => {
      const l = parseLedger('# SDD ledger — plan: /p.md\r\nTasks 1-2: complete\r\nFINAL REVIEW: ok\r\n', '/r', 1)
      expect(l?.planPath).toBe('/p.md')
      expect(l?.completed).toEqual(['1', '2'])
      expect(l?.isFinal).toBe(true)
    })
  })
})
