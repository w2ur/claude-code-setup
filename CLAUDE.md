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

- **haiku** — passive audits (portfolio-audit, docs-checker).
- **sonnet** — default implementation, single-file changes, clear scope.
- **opus** — 4+ files across layers, architecture analysis, retry after failed sonnet. Supports fast mode for latency-sensitive loops.

Escalation order is **Fable > Opus > Sonnet > Haiku** (aliases resolve to current releases). The session default is **Opus [1m]** — a deliberate cost choice, not the top of the lattice. Fable is manual escalation for the hardest work, invoked explicitly rather than assumed. L3/troubleshooter always inherits the session model (`model: inherit`), so it is never weaker than the caller regardless of which tier the session is running.

For multi-stage fan-outs (audit/migrate/review across many targets), use the Workflow tool; plain parallel Agent dispatch for independent one-shot tasks.

## Session handoff and memory

Three memory systems, each with a distinct role — don't duplicate across them:

- **Auto-memory** (`~/.claude/projects/-Users-{username}-Dev/memory/`, indexed by `MEMORY.md`): session handoffs and durable cross-session knowledge (user preferences, project state, feedback). Write a condensed version automatically at the end of significant work — no permission needed.
- **Per-agent memory** (`~/.claude/agent-memory/<agent>/`): operational knowledge scoped to one agent (patterns, past corrections for that agent's domain).
- **claude-mem**: session narrative and observation history. Don't duplicate its content into the other two.

Stop using the bare phrase "agent memory" for auto-memory — it collides with the per-agent system's name.

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
- Monthly `/tech-debt` Phase 1 triage runs via a local crontab entry (1st of month, 8:07am — `/tech-debt --triage-only`, output logged to `~/.claude/tech-debt-cron.log`), not a cloud `/schedule` routine: cloud routines run in an isolated sandbox with no access to the local `~/Dev` filesystem, so they can't read `.portfolio.yml`/git state. Phase 2 deep-review selections stay manual. Items flagged 2+ months without action escalate to `/troubleshoot`.

## Quality

- Zero build warnings. Exceptions → documented in the project CLAUDE.md with justification.
- Conventional Commits. One logical change per commit.
- Tests are systematic: unit for all logic, property tests for pure transforms (see `property-testing` skill), regression test alongside every bug fix.
- Implementer checklist (pre/during/post code): `code-quality` skill.
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
