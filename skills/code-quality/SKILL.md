---
name: code-quality
description: Code quality checklist — preloaded into the implementer agent as background knowledge.
user-invocable: false
---

# Code Quality Checklist

This skill is preloaded into the implementer. Use it as a mental checklist before reporting "task complete."

## Before Writing Code

- [ ] Read 2-3 existing files in the same directory to match conventions
- [ ] Agent memory is auto-loaded — review it for known patterns on this project
- [ ] Identify the testing framework from package.json (vitest, jest, pytest)
- [ ] Identify the linter/formatter config (ESLint, Prettier, Ruff, Black)

## While Writing Code

- [ ] All code, comments, variable names, function names in English
- [ ] No `console.log` in production code
- [ ] No commented-out code
- [ ] No `any` type in TypeScript (unless task explicitly requires it)
- [ ] No new dependencies without clear justification
- [ ] Match existing import style, naming conventions, error handling patterns
- [ ] If adding env vars → update .env.example with placeholder

## After Writing Code

- [ ] Run build: `npm run build` (or equivalent) — must produce zero warnings
- [ ] Run tests: `npm test` (or equivalent) — all must pass
- [ ] Run linter if configured: `npm run lint` — zero errors
- [ ] If task involves logic → wrote test alongside implementation
- [ ] Test file lives next to source: `foo.ts` → `foo.test.ts`
- [ ] Tests verify behavior, not implementation details

## Before Reporting Done

- [ ] "Done when" criterion is verified — not just assumed
- [ ] README still accurately describes the project (check if task changed anything user-facing)
- [ ] CLAUDE.md still accurate (check if task changed stack, env vars, or deployment)
- [ ] If this fix revealed a pattern → agent auto-writes to its memory (no action needed)
- [ ] `git status` shows no untracked files that should be ignored

## Spec Compliance Check

After completing all subtasks from a plan:

1. Re-read the original SPEC or plan document
2. For each requirement in the spec: verify it exists in the code
3. For each described behavior: verify it works as described
4. List any deviations before presenting results
5. Fix deviations or flag them with justification

This check is mandatory after plan-driven work (Superpowers plans, /troubleshoot plans, multi-subtask implementations). Skip for direct fixes and single-file edits.

## Common Traps (from lessons)

- Service worker cache is the #1 false-positive for "my change isn't showing"
- Build warnings from upstream deps: document as exception, don't ignore silently
- Tailwind vs CSS modules: never mix in the same project
- localStorage has size limits — IndexedDB for anything beyond simple key-value
- Dark mode: test both themes, not just the one you're developing in
