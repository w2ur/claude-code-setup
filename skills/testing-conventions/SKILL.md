---
name: testing-conventions
description: Test conventions across this portfolio — regression-test comment format, property-test setup for TS and Python, the financial-math arbitrary settings that were tuned by measurement, and why a failing check may be pinning a defect rather than reporting one. Load before writing tests, adding a regression test to a bug fix, setting up property tests, or when a test disagrees with what you expect.
user-invocable: true
---

# Testing conventions

The rules live in `~/.claude/CLAUDE.md`. This skill holds the formats and settings.

## Unit and regression

- Unit tests for **all** logic.
- **A regression test alongside every bug fix**, carrying the commit that fixed it:

  ```ts
  // Regression: <commit-hash> — <bug description>
  ```

  The hash makes the test self-documenting: a future reader can pull the fix and the
  reasoning without archaeology in the test file itself.

## Property tests for pure transforms

- TypeScript → `fast-check`
- Python → `hypothesis`
- File naming: `foo.property.test.ts` alongside the unit tests.

### Financial-math arbitraries — settings tuned by measurement

| setting | value | why |
|---|---|---|
| float arbitraries | `noNaN`, `noDefaultInfinity` | otherwise every property fails on degenerate inputs rather than on real ones |
| runs | **≥ 1000** | the default run count does not reach the interesting tail |
| tolerance | **1e-6** | **not 1e-10 — measured too tight at scale.** Accumulated float error over a long series exceeds 1e-10 legitimately, so the tighter tolerance reports false failures. |

The 1e-10 value looks more rigorous and is the obvious thing to reach for. It was
tried and it was wrong. Use 1e-6.

## A test can pin a defect — read its intent before "fixing" it

When a check disagrees with what you expect, read the test's **intent** before
assuming the code is wrong. Twice in a single day the test was the one asserting the
truth:

- `test_check_ignores_generic_data_drift` asserted *"data is synced but not
  guarded"* — the surprising behaviour was the deliberate one, named in the test.
- A Python and a TypeScript implementation each pinned the other's answer as
  correct, so "fixing" either one to match intuition would have broken the pair.

A test whose name states an intent is evidence about the design, not just about the
code path.

## What a green suite does not cover

Two measured blind spots in this portfolio:

- **UI components are not unit-tested by convention.** In `my-fitness-app`, 1,155 tests
  passed against a tree that would not build — a deleted module was still imported by
  two components. Only the build gate caught it.
- **A route-handler test never runs the middleware.** A gated API route can ship
  100% broken with a fully green suite. Test the middleware path separately.
