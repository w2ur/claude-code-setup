import { expect, test } from 'claude-code/testing'

import type { Ledger } from '../hooks/ledger'
import { viewsOf } from '../hooks/views'
import type { ParsedPlan } from '../types'

// Hand-rolled property test (no library in the mod runtime): seeded PRNG, 200
// seeds; a failure names its seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CFG = '/h/.claude'
const NOW = 50_000_000

test('views: done <= total, files unique, foreign ids never count', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = mulberry32(seed)
    const int = (max: number): number => Math.floor(random() * (max + 1))
    const plans: ParsedPlan[] = []
    for (let p = 0; p < 1 + int(5); p += 1) {
      const n = int(8)
      plans.push({
        file: `${int(1) ? 'sub/' : ''}plan${p}.md`,
        title: `plan${p}`,
        tasks: Array.from({ length: n }, (_, i) => ({ id: i % 3 === 0 ? `B${i}` : String(i), title: 't' })),
      })
    }
    const pool = ['0', '1', '2', '3', '4', '10', '11', '99', 'B0', 'B3', 'B6', 'Z']
    const ledgers: Ledger[] = []
    for (let l = 0; l < int(10); l += 1) {
      const target = plans[int(plans.length - 1)]
      const completed = pool.filter(() => random() < 0.4)
      const ledger: Ledger = {
        planPath: int(5) === 0 ? `${CFG}/plans/gone.md` : `${CFG}/plans/${target?.file ?? ''}`,
        root: `/w/r${int(3)}`,
        mtimeMs: NOW - int(90) * 60_000,
        completed,
        isFinal: int(6) === 0,
      }
      const touched = pool[int(pool.length - 1)]
      if (touched !== undefined && int(1)) ledger.lastTouched = touched
      ledgers.push(ledger)
    }
    const views = viewsOf(plans, ledgers, plans.map((p) => p.file), CFG, NOW)
    const files = views.map((v) => v.file)
    expect(new Set(files).size, `seed ${seed}: unique files`).toBe(files.length)
    for (const v of views) {
      expect(v.done <= v.total, `seed ${seed}: done<=total`).toBe(true)
      const p = plans.find((x) => x.file === v.file)
      const ids = new Set(p?.tasks.map((t) => t.id))
      const best = ledgers
        .filter((l) => l.planPath === `${CFG}/plans/${v.file}`)
        .reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
      const inPlan = new Set(best.completed.filter((id) => ids.has(id)))
      expect(v.done, `seed ${seed}: foreign ids`).toBe(inPlan.size)
      expect(v.total, `seed ${seed}: total`).toBe(ids.size)
    }
  }
})
