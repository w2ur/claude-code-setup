# CLAUDE.md — Global Instructions

Project-level CLAUDE.md overrides anything here.

## Language

All code, comments, identifiers, commit messages → English. User-facing content follows the project's target language (defined in the project CLAUDE.md).

## Planning and execution

- Single-file / small fix: execute directly.
- Multi-file / architecture / feature work: propose a plan first and wait for approval. Plan subtasks must be atomic with explicit "done when…" criteria so any sub-agent can pick them up.
- **Plans never live in the repo.** They go in `~/.claude/plans/` only. If you find plan files inside a repo, `git rm -r --cached` them and add to `.gitignore`.

## Bug handling

1. **Triage first**: one concise question about the most likely environmental cause (stale cache, service worker, stale build, local state). Skip for obvious code bugs.
2. **Escalation cascade** — one-way, no retries at the same level:
   - L1: direct fix with a **stated root-cause hypothesis**.
   - L2: `superpowers:systematic-debugging` skill.
   - L3: `troubleshooter` agent.
3. No edit without a stated hypothesis. "Try a different approach" without a new hypothesis is banned.

## Sub-agents

Default to parallel dispatch for any 2+ independent tasks. Specify the model when dispatching:

- **haiku** — passive audits (portfolio-audit). `docs-checker` is sonnet: it edits files and verifies URLs, so it is not a passive audit.
- **sonnet** — default implementation, single-file changes, clear scope.
- **opus** — 4+ files across layers, architecture analysis, retry after failed sonnet. Supports fast mode for latency-sensitive loops.

Escalation order is **Fable > Opus > Sonnet > Haiku** (aliases resolve to current releases). The session default is **Opus [1m]** — a deliberate cost choice, not the top of the lattice. Fable is manual escalation for the hardest work, invoked explicitly rather than assumed. L3/troubleshooter always inherits the session model (`model: inherit`), so it is never weaker than the caller regardless of which tier the session is running.

For multi-stage fan-outs (audit/migrate/review across many targets), use the Workflow tool; plain parallel Agent dispatch for independent one-shot tasks.

## Session handoff and memory

Two memory systems, each with a distinct role — don't duplicate across them:

- **Auto-memory** (`~/.claude/projects/-Users-{username}-Dev/memory/`, indexed by `MEMORY.md`): session handoffs and durable cross-session knowledge (user preferences, project state, feedback). Write a condensed version automatically at the end of significant work — no permission needed.
- **Per-agent memory** (`<project root>/.claude/agent-memory/<agent>/`): operational knowledge scoped to one agent (patterns, past corrections for that agent's domain). **It lives next to the code, not in `~/.claude`.**

Stop using the bare phrase "agent memory" for auto-memory — it collides with the per-agent system's name.

**Per-agent memory is project-scoped, and that is deliberate.** The agent frontmatter key `memory:` takes three values, which the harness resolves as: `user` → `~/.claude/agent-memory/<agent>/` · `project` → `<project root>/.claude/agent-memory/<agent>/` · `local` → `<project root>/.claude/agent-memory-local/<agent>/`. Three agents declare it — `implementer`, `portfolio-sync`, `troubleshooter` — and **all three declare `project`. None declares `user`.** So a store appears wherever a session's project root was: one per repo, plus one per nested working dir (`untilt/client/`) and per worktree a session was launched from (`midas/.worktrees/backtester-plan-1/`, `pogofish/.worktrees/webapp/`). ~130 files across 15 repos, against ~14 in `~/.claude/agent-memory/` — and those 14 are residue from sessions whose project root *was* `~/.claude`, not a separate tier. Do not "consolidate" them upward; that fights the resolver.

**Per-agent memory must never be committed.** The harness default-ignores only `agent-memory-local/`, **not** `agent-memory/` — so a repo trusting that default will happily stage its memory files. Every repo with a store needs `.claude/` (or at minimum `.claude/agent-memory/`) in `.gitignore`. `midas` is the model for repos that deliberately track other `.claude/` content: ignore `.claude/agent-memory/` specifically rather than the whole directory.

Plans are not a memory system: they live in `~/.claude/plans/`, never in a repo.

**claude-mem was removed on 2026-07-25 (decision M13).** It was a third system holding session narrative and observation history. It went unretrieved through a five-hour, 27-repo review while costing ~1.4 GB on disk and a `$CMEM` injection at every session start. Do not reinstall it, and do not compensate by writing session narrative into the two systems above — that narrative already lives in the transcripts.

## Context management

- Rely on automatic context summarization; do not run `/compact` proactively. Use `/clear` when switching to an unrelated task. If a manual `/compact` ever runs, re-load any skills in use (CLAUDE.md is re-injected automatically).
- When dispatching to sub-agents, send focused prompts — not conversation dumps.

## Portfolio is a system

- Every project has `README.md`, `CLAUDE.md`, and `.portfolio.yml`. Full manifest spec lives in the `portfolio-conventions` skill.
- Folder name = GitHub repo name = `.portfolio.yml` slug. Always **kebab-case**.
- Docs (README / CLAUDE.md / .portfolio.yml) update in the **same commit** as the code change they describe. Never commit a feature with a stale README.
- New projects default `sort_order: 99`.
- Strategic docs live in `~/Dev/{portfolio-site}/strategy/`: `inventaire.md`, `charte-coherence.md`, `pipeline.md`, `strategie-visibilite.md`. Read when relevant; flag in handoff when they need updating (owner commits separately).
- When changing commands/agents/skills/hooks in `~/.claude/`: update `~/Dev/workflow-guide.html` DATA section; if architectural, flag `strategy/charte-coherence.md`.
- When changing commands/agents/skills/hooks, also sweep **every kept command** for references to what you deleted — not just CLAUDE.md. A prune that only cleans the global file leaves dangling `/command` refs inside commands that still run.
- **Two local crontab entries, deliberately offset.** Both are local, not cloud `/schedule` routines: cloud routines run in an isolated sandbox with no access to the local `~/Dev` filesystem, so they can't read `.portfolio.yml`/git state.
  - **1st, 8:07am** — `/tech-debt --triage-only` → `~/.claude/tech-debt-cron.log`. Phase 2 deep-review selections stay manual. Items flagged 2+ months without action escalate via the L1→L2→L3 cascade (see Bug handling) to the `troubleshooter` agent.
  - **15th, 8:07am** — `scripts/cleanup-cron.sh` → `~/.claude/cleanup-cron.log`. Runs the **script, not `claude -p "/cleanup"`**: `/cleanup` makes git commits at Step 1 and can fire `/sync-setup` at Step 4, and its CONFIRM tier is interactive by design — none of that is safe unattended. The wrapper covers **Step 0's AUTO tier only** and logs everything else as an `owner action:` line.
  - Any cron entry invoking these scripts **needs an explicit `PATH=`**. Under cron's default PATH `claude` is unresolvable, and `disk-hygiene.sh` guards its marketplace check with `command -v claude` — so the check silently degrades to a skip, permanently, which is exactly the orphan-marketplace failure the sweep exists to catch.
- **`~/.claude/scripts/` holds three no-model scripts** — deterministic work gets a script, not an agent. `dev-scanner.sh` (read-only `~/Dev` survey, `--json`), `disk-hygiene.sh` (the disk sweep; **the source of truth for every retention number** — never restate them in command prose, they drift), `cleanup-cron.sh` (the unattended wrapper). All honour `CLAUDE_DIR` so they can be tested against a dirtied copy.
- `/cleanup` opens with **Step 0 — Disk Hygiene**, which calls `disk-hygiene.sh`. Two tiers: **AUTO** applies unasked (ephemeral state to stated retentions, plus plan *archiving* — it never deletes a plan); **CONFIRM** (stale `projects/` transcript dirs, plugin temp dirs) only under `--yes-projects` / `--yes-plugins`. Orphan marketplaces are **reported, never auto-removed** — deleting the directory alone lets `plugins/known_marketplaces.json` re-clone it on the next session, daemons included. Deregister first with `claude plugin marketplace remove <name>`, then delete, then re-check in a fresh session.
- Plans archive after **21 days**, not 90; long-running working documents stay alive via the script's HOLD list, not by widening the cutoff.

## Quality

- Zero build warnings. Exceptions → documented in the project CLAUDE.md with justification.
- Conventional Commits. One logical change per commit.
- Tests are systematic: unit for all logic, regression test alongside every bug fix (comment format: `// Regression: <commit-hash> — <bug description>`); property tests for pure transforms via `fast-check` (TS) / `hypothesis` (Python), file `foo.property.test.ts`. Financial-math arbitraries: `noNaN`/`noDefaultInfinity`, ≥1000 runs, 1e-6 tolerance (not 1e-10 — too tight at scale).
- After plan-driven sub-agent work, re-check every plan requirement against the code before reporting done (skip for direct single-file fixes). Service worker cache is the #1 false positive for "my change isn't showing" — rule it out before deeper debugging.
- Before merging any nontrivial diff: run `/code-review` (high effort; ultra for multi-file or cross-layer changes). Sub-agent-produced diffs are always reviewed before merge; pair with `/verify` when the change has a runtime surface.

## Generalization check

Before implementing a specific request, consider whether it's a special case of a pattern already in the portfolio. If the general solution is roughly the same effort, implement the general version with the specific case as the default. Skip when the general version materially increases complexity or when there's only one known use case. This is a judgment call, not a mandatory abstraction.

## Design defaults

- **Never default to purple / violet / indigo** as a primary color (model bias from Tailwind/shadcn defaults). For new projects without a specified palette, propose 2-3 directions based on subject, mood, and audience. Wait for approval.
- Dark + light mode default, via `prefers-color-scheme`. Opt-out requires justification in the project CLAUDE.md.
- Author signature default: footer **"Made with care by {author-first-name}"** → `https://{portfolio-site-url}`. Opt-out requires justification.

## Security and privacy

- No secrets in repos (also enforced by the `secret-scan` hook). Update `.env.example` with placeholders when adding env vars.
- No private/personal user data in repos. Test fixtures must be synthetic.
- `.gitignore` coverage verified whenever new file types enter the project (build artifacts, `.env*`, OS files, data exports, `docs/plans/`).
- Network posture is deliberately open (blanket WebFetch/WebSearch/curl) — this is a solo-owner machine, not a scoping oversight.

## Infrastructure

Zero-cost policy: free tiers only (Netlify, Vercel, Cloudflare, Neon, D1). Automatic deploys on push to main.

## Plugins

Before installing a plugin: evaluate overlap with existing custom agents/commands — custom setup wins on conflict. Audit periodically with `/cleanup plugins-only`. Plugins with SessionStart hooks cost context every session; prefer plugins that lazy-load.
