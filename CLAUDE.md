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

Default to parallel dispatch for any 2+ independent tasks. **Every `Agent` call names a model**; an unnamed one falls to `CLAUDE_CODE_SUBAGENT_MODEL` (opus), which is the right tier for judgment work and the wrong one for lookups. Pick by task complexity, not by file count:

| tier | model | work |
|---|---|---|
| very complex | **fable** | whole-setup or whole-project reviews, audits that weigh many surfaces, the hardest planning. Manual: `/model fable` for the session, or `fork` (forks always inherit). Never the default. |
| complex | **opus** | architecture analysis, plans, applying reviewed diffs across files, retry after a failed sonnet, anything a subagent must judge rather than execute. Session default. Supports fast mode for latency-sensitive loops. |
| execution | **sonnet** | implementation against a spec with "done when" criteria (`implementer`), single-file changes, doc fixes that also verify URLs (`docs-checker`). |
| basic | **haiku** | passive audits (`portfolio-audit`), Explore-type searches, queue reading (`brief`), anything whose output is a list the caller re-checks. |

Escalation order is **Fable > Opus > Sonnet > Haiku** (aliases resolve to current releases). The session default is **Opus [1m]** — a deliberate cost choice, not the top of the lattice. Fable is manual escalation for the hardest work, invoked explicitly rather than assumed. L3/troubleshooter always inherits the session model (`model: inherit`), so it is never weaker than the caller regardless of which tier the session is running.

**Workflows are opted in by this line.** A multi-stage fan-out — audit, migrate or review across three or more targets, or any review-then-verify pipeline — uses the Workflow tool without asking first; plain parallel Agent dispatch for independent one-shot tasks. `ultracode` stays off: it is session-only and forces xhigh effort.

## Session handoff and memory

**Memory stores, per-agent memory layout, or a proposal for a third place to keep session knowledge: load the `memory-and-plans` skill** before creating, moving, consolidating or gitignoring any of it. It holds the resolver table and the reasons.

Two systems, each with a distinct role — don't duplicate across them:

- **Auto-memory** (`~/.claude/projects/-Users-{username}-Dev/memory/`, indexed by `MEMORY.md`): session handoffs and durable cross-session knowledge (user preferences, project state, feedback). Write a condensed version automatically at the end of significant work — no permission needed.
- **Per-agent memory** (`<project root>/.claude/agent-memory/<agent>/`): operational knowledge scoped to one agent. **It lives next to the code, not in `~/.claude`.**

Call the first system "auto-memory". The bare phrase "agent memory" names the per-agent system only.

- **Per-agent memory is project-scoped, and that is deliberate.** Stores are scattered by design — one per repo, plus one per nested working dir and per worktree a session was launched from. **Do not "consolidate" them upward; that fights the resolver.**
- **Per-agent memory must never be committed.** The harness default-ignores only `agent-memory-local/`, **not** `agent-memory/`. Every repo with a store needs `.claude/agent-memory/` in `.gitignore` — ignore that path specifically rather than the whole `.claude/` directory, which would silently untrack any project skill written there.
- **Do not reinstall claude-mem** (removed 2026-07-25, decision M13), and do not compensate by writing session narrative into the two systems above — that narrative already lives in the transcripts.

Plans are not a memory system: they live in `~/.claude/plans/`, never in a repo.

## Context management

- Rely on automatic context summarization; do not run `/compact` proactively. Use `/clear` when switching to an unrelated task. If a manual `/compact` ever runs, re-load any skills in use (CLAUDE.md is re-injected automatically).
- When dispatching to sub-agents, send focused prompts — not conversation dumps.
- **A CLAUDE.md records rules, not history**, and is billed in every session started under it. Sort every paragraph into **guard** (prevents a wrong action — keep), **instruction** (expires — delete when done), **domain knowledge** (true but rarely needed — move to a skill), **archaeology** (delete). When a belief here turns out wrong, **delete the wrong sentence** — do not strike it through and explain. **Never hand-type a count, an inventory or a file list: derive it, or omit it.**
- **Before editing, restructuring or pruning any CLAUDE.md — this one included — load the `claude-md-hygiene` skill.** It holds the method, the gitignore prerequisite, the parsed-by-a-script prerequisite and the line-coverage check. `~/.claude/scripts/claude-md-weight.sh` is the check and the source of truth for the size threshold; never restate that number here.

## Portfolio is a system

- Every project has `README.md` and `CLAUDE.md`. **Exempt, decided 2026-08-09: `{github-username}`** (the GitHub profile README — one file, no code) **and `midas-core`** (a mirror generated by `my-trading-app/scripts/sync_core.py`, whose own discipline is "never hand-edit midas-core", so guidance placed there would invite the mistake it forbids). `vigie` enforces this in `NO_CLAUDE_MD_EXPECTED` (`src/lib/portfolio-view.mjs`) and every entry must carry its reason.
- **The portfolio runs on three layers, spec'd in full in the `portfolio-conventions` skill** — load it before changing how projects are described, listed or ordered. **Layer 1 — derived inventory** (`{portfolio-site}/scripts/build-inventory.mjs` observes GitHub, stack, deploy target and live-URL health at build time; nothing hand-typed, so nothing can go stale). **Layer 2 — the pitch** (`name`/`tagline_fr`/`tagline_en`/`facts_fr`/`facts_en` as YAML frontmatter atop each repo's `README.md`). **Layer 3 — editorial** (`{portfolio-site}/src/data/editorial.ts` decides which projects get a hub tile and in what order; array order is the order). There is no per-repo manifest file — decision M12 retired `.portfolio.yml`.
- Folder name = GitHub repo name. Always **kebab-case**.
- Docs (README / CLAUDE.md, including README frontmatter) update in the **same commit** as the code change they describe. Never commit a feature with a stale README.
- New editorial entries default to the end of the `editorial.ts` array unless the owner specifies placement — there is no numeric sort field to default anymore.
- Strategic docs live in `~/Dev/{portfolio-site}/strategy/`: `inventaire.md`, `charte-coherence.md`, `pipeline.md`, `strategie-visibilite.md`. Read when relevant; flag in handoff when they need updating (owner commits separately).
- When changing commands/agents/skills/hooks in `~/.claude/`: update `~/Dev/workflow-guide.html` DATA section; if architectural, flag `strategy/charte-coherence.md`. Also sweep **every kept command** for references to what you deleted — a prune that only cleans the global file leaves dangling `/command` refs inside commands that still run.
- **Scheduled jobs and `~/.claude/scripts/`: load the `scheduled-jobs` skill** before creating, editing, moving or diagnosing any of them. It holds the reasons; `~/.claude/scripts/jobs-inventory.sh` derives the current state. Never write a roster, a count or a schedule table here. What follows is only what can be violated *without* thinking about scheduled jobs:
  - **Never schedule anything that reads the login keychain from crontab** — `claude`, `gh`, IMAP and API secrets all live there, and outside the GUI session the lookup fails *silently* (empty string, no error). Use a launchd LaunchAgent.
  - **Every plist carries its own `EnvironmentVariables.PATH`**; `launchctl getenv PATH` is empty here. `node`/`npm` from fnm's `aliases/default` symlink (**v24** — Homebrew's is v26 and Vercel caps at 24), `claude` from `~/.local/bin`, `gh`/`uv` from `/opt/homebrew/bin`.
  - **Nothing here calls a bare `python3`.** A standalone script carries a PEP 723 header and a `uv run --script` shebang, and is executed *directly* so that shebang selects the interpreter.
  - **Exit convention, portfolio-wide: 0 healthy · 1 a finding · 2 could not run = *unknown*, never "healthy" and never "nothing to do".** An empty catalogue, a mounted-but-empty volume, and an unauthenticated API returning zero rows are all *unknown*.
  - **Each script is the source of truth for its own numbers** (retentions, weights, thresholds, tiers). Command prose describes them and must never restate them.
  - **Before deleting a dependency directory, list which scheduled jobs build from that repo** — binary guards cannot see it coming.
  - **When a script's header states a cadence, check that something actually fires it.** Jobs have been found describing a schedule that nothing triggered.
- **Vercel exposes usage ONLY through billing data, and billing data requires being billed.** A charges query spanning a whole Hobby period returns `costs_not_found`, and **Spend Management is Pro-only**. So on the free plan there is no usage API and no spend alert — `usage-watch.sh` (served bytes) and the `push-build-gate` payload gate are the entire defence. Do not "improve" the monitor by pointing it back at a usage endpoint; that was tried and recorded in `~/.claude/plans/2026-08-03-vercel-usage-api-findings.md`.
- `/cleanup` opens with **Step 0 — Disk Hygiene** (`disk-hygiene.sh`); the command file owns the tier rules and the script owns every number. Two guards worth knowing outside it: plan *archiving* never deletes a plan, and **long-running working documents stay alive via the script's HOLD list, not by widening the cutoff**. **Orphan marketplaces are reported, never auto-removed** — deleting the directory alone lets `plugins/known_marketplaces.json` re-clone it on the next session, daemons included. Deregister first with `claude plugin marketplace remove <name>`, then delete, then re-check in a fresh session.

## Python: uv is the sole manager

Decided 2026-08-17. **Before writing any Python here, touching a hook or scheduled job that runs Python, or diagnosing a wrong-interpreter symptom, load the `python-uv` skill** — it holds the measurements, the falsifying control and the traps.

- `~/.config/uv/uv.toml` sets `python-preference = "only-managed"`, and that is what enforces it. **It must stay in `uv.toml`, never in `~/.zshrc`** — a LaunchAgent and a cron entry never source `.zshrc`, so a shell export leaves it unset exactly where a wrong interpreter would be invisible.
- **There is no bare `python` and no bare `pip` on PATH at all.** Any doc or script saying `python -m venv` / `pip install -e .` is already broken.
- **Never call a bare `python3`** — it resolves to Homebrew's dependency interpreter, with Apple's 3.9.6 behind it, and a stdlib-only snippet runs fine on both, so an interpreter swap under a scheduled job is **silent** until something uses 3.10+ syntax.
- **Homebrew's `python@3.14` stays installed.** It is a dependency of other installed formulae (`brew uses --installed python@3.14`), not a development interpreter. Do not try to remove it and do not file it as a finding.
- **In a hook, the answer is usually `jq`, not uv.** A JSON field lookup needs no interpreter, and `/usr/bin/jq` ships with macOS. **Never launch `payload_gate.py` via `uv run`**: `hook.sh` reads exit 2 as *block the push* and 3 as *warn*, and a launcher that can emit its own failure codes into that channel can manufacture a verdict.
- **A hook that cannot resolve its interpreter fails OPEN, loudly** (exit 1) — fail closed on the guard's verdict, open on the guard's own malfunction.
- **Per-project: `uv sync`**, and commit the lockfile. **One-off tooling: `uv run --with-requirements`.** **A standalone script gets a PEP 723 header and a `#!/usr/bin/env -S uv run --script` shebang**, then is executed *directly* — never as `python3 script.py`, which bypasses the single place its interpreter and dependencies are declared.
- **`uv sync` installs the project editable by default**, which is the configuration behind the `MultiplexedPath` / `NotADirectoryError` break in `midas-core` — see [[feedback_editable_install_breaks_namespace_package_resources]]. Re-run the single-directory assertion after any move to `uv sync`; the editable finder's tables are frozen at install time.
- **A public repo keeps its `pip` path.** `claude-code-setup` documents both: uv for the owner, `requirements.txt` for anyone cloning it. Do not force uv on readers of a published repo.

## Quality

- Zero build warnings. Exceptions → documented in the project CLAUDE.md with justification.
- Conventional Commits. One logical change per commit.
- **Tests are systematic**: unit for all logic, a regression test alongside every bug fix, property tests for pure transforms. **Load the `testing-conventions` skill** before writing tests, adding a regression test, or setting up property tests — it holds the comment format, the library choices and the financial-math arbitrary settings that were tuned by measurement.
- After plan-driven sub-agent work, re-check every plan requirement against the code before reporting done (skip for direct single-file fixes). Service worker cache is the #1 false positive for "my change isn't showing" — rule it out before deeper debugging.
- **A check that has never produced the opposite answer is not evidence.** Before trusting silence, a zero count, a "no match" or a green suite — and especially before writing it down as a finding — make the probe fail once. Grep for something you know is in that same artifact; fire the hook's real trigger and watch it warn; confirm a liveness marker is present in the local build *and* absent from the old one; check a known-good sibling URL resolves. **If you cannot make the check fail, it cannot pass.**
- **Before writing or changing a CI gate, adding a pr-gate caller, or setting or checking branch protection, load the `ci-and-branch-protection` skill.** Two rules that must not be violated without reading it: **in CI, a check that did not run must never look like a check that passed** — an aggregate gate must assert a **named list of expected checks computed up front** and refuse an empty list, because `jq 'all(.[]; …)'` over an empty set returns `true`; and **branch protection needs a public repo on this account**, so every gate on a private repo is advisory — never write docs claiming enforcement, and do not fix it by upgrading to Pro.
- **When a subagent reports a surprising finding, verify the reason, not just the conclusion.** A right conclusion resting on a false reason is what becomes doc drift or a wrong design decision — the conclusion gets accepted, and the reason gets written down.
- **Budget multiple review rounds after any money-path fix.** The first pass on a pricing or ledger change reliably surfaces a second defect in the same neighbourhood — measured repeatedly, never once fewer than three rounds. Treat one clean round as the start of the review, not the end of it.
- **Never trust an empty review without checking the finders ran.** Zero findings and zero coverage are the same output — confirm the agents produced work before reading silence as a result. Same family as the falsifiable-control rule above.
- **A test can pin a defect.** When a check disagrees with what you expect, read the test's *intent* before assuming the code is wrong — or right.
- Before merging any nontrivial diff: run `/code-review` at **high** effort. Sub-agent-produced diffs are always reviewed before merge; pair with `/verify` when the change has a runtime surface.
- **`ultra` is not the default, and "multi-file" is not the trigger.** A prompt that is always declined is worse than no prompt: it trains both of us to skip the question, so the one time it matters gets waived on reflex too. Reserve `ultra` for a diff that touches a **money path** (pricing, ledger, fills, billing), **auth or secrets**, a **data migration**, or a **public API contract** — or when a normal review has already found a real defect and you want the surrounding neighbourhood swept. Otherwise `high` is the ceiling. Do not offer `ultra` merely because a change spans files.

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

Before installing a plugin: evaluate overlap with existing custom agents/commands — custom setup wins on conflict. Audit periodically with `/cleanup plugins-only`. Plugins with SessionStart hooks cost context every session; prefer plugins that lazy-load. `ls ~/.claude/plugins/` and `enabledPlugins` in `settings.json` are the roster — never write one here.

Three exceptions to the lazy-load preference, all deliberate:

- **`superpowers` is the standing exception.** Its SessionStart hook injects the `using-superpowers` skill into every single session. That cost is **accepted, not overlooked** — owner's call, "an absolute necessity". Do not propose removing it, and do not re-raise the context cost as a finding.
- **`plan-reviewer` carries a Stop hook** (`check-new-plans.sh`) that flags any recently-touched file in `~/.claude/plans/` with no `-review.md` sibling. Consequence worth knowing: *moving* an old file into `plans/` resets its mtime and trips the hook — restore the real mtime rather than letting it nag.
- **`frontend-design` is uninstalled and stays that way.** It overlapped `ui-ux-pro-max`, which is the design skill here. Do not reinstall it or suggest it.
