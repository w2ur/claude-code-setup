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

**Per-agent memory is project-scoped, and that is deliberate.** The agent frontmatter key `memory:` resolves as: `user` → `~/.claude/agent-memory/<agent>/` · `project` → `<project root>/.claude/agent-memory/<agent>/` · `local` → `<project root>/.claude/agent-memory-local/<agent>/`. Every agent that declares it declares `project`; none declares `user`. So a store appears wherever a session's project root was — one per repo, plus one per nested working dir a session was launched from (`<repo>/client/`) and one per worktree. Anything under `~/.claude/agent-memory/` is residue from sessions whose project root *was* `~/.claude`, not a separate tier. **Do not "consolidate" them upward; that fights the resolver.**

**Per-agent memory must never be committed.** The harness default-ignores only `agent-memory-local/`, **not** `agent-memory/` — so a repo trusting that default will happily stage its memory files. Every repo with a store needs `.claude/` (or at minimum `.claude/agent-memory/`) in `.gitignore`. Repos that deliberately track other `.claude/` content — a committed project `CLAUDE.md`, shared commands — are the model here: ignore `.claude/agent-memory/` specifically rather than the whole directory.

Plans are not a memory system: they live in `~/.claude/plans/`, never in a repo.

**claude-mem was removed on 2026-07-25 (decision M13).** It was a third system holding session narrative and observation history. It went unretrieved through a five-hour, 27-repo review while costing ~1.4 GB on disk and a `$CMEM` injection at every session start. Do not reinstall it, and do not compensate by writing session narrative into the two systems above — that narrative already lives in the transcripts.

## Context management

- Rely on automatic context summarization; do not run `/compact` proactively. Use `/clear` when switching to an unrelated task. If a manual `/compact` ever runs, re-load any skills in use (CLAUDE.md is re-injected automatically).
- When dispatching to sub-agents, send focused prompts — not conversation dumps.
- **A CLAUDE.md records rules, not history.** When a belief here turns out wrong, **delete the wrong sentence** — do not strike it through and explain. Git log holds what was believed and when. Keep a retraction only where a future session would independently re-derive the wrong belief from the same evidence; then state it as a rule ("do not grant FDA to `uv` — no TCC row has ever existed"), never as a story. **Never hand-type a count, an inventory, or a file list: derive it, or omit it.** Sort every paragraph into **guard** (prevents a wrong action — keep), **instruction** (expires — delete when done), **domain knowledge** (true but rarely needed — move to a skill), **archaeology** (delete). `~/.claude/scripts/claude-md-weight.sh` is the check and the source of truth for the size threshold; never restate that number here.

## Portfolio is a system

- Every project has `README.md` and `CLAUDE.md`. **Two repos are exempt, decided 2026-08-09: `{github-username}`** (the GitHub profile README — one file, no code) **and `midas-core`** (a mirror generated by `my-trading-app/scripts/sync_core.py`, whose own discipline is "never hand-edit midas-core", so guidance placed there would invite the mistake it forbids). `vigie` enforces this in `NO_CLAUDE_MD_EXPECTED` (`src/lib/portfolio-view.mjs`) and every entry must carry its reason. There is no per-repo manifest file (decision M12 retired `.portfolio.yml`). The portfolio now runs on three layers, spec'd in full in the `portfolio-conventions` skill: **Layer 1 — derived inventory**, `~/Dev/{portfolio-site}/scripts/build-inventory.mjs` observes GitHub (visibility, description, homepage, stars…), stack, deploy target, and live-URL health at build time, writing `src/data/inventory.json` — nothing hand-typed, so nothing can go stale. **Layer 2 — the pitch**, `name`/`tagline_fr`/`tagline_en`/`facts_fr`/`facts_en` as YAML frontmatter at the top of each repo's `README.md`. **Layer 3 — editorial**, `~/Dev/{portfolio-site}/src/data/editorial.ts` decides which projects get a hub tile and in what order; array order is the order.
- Folder name = GitHub repo name. Always **kebab-case**.
- Docs (README / CLAUDE.md, including README frontmatter) update in the **same commit** as the code change they describe. Never commit a feature with a stale README.
- New editorial entries default to the end of the `editorial.ts` array unless the owner specifies placement — there is no numeric sort field to default anymore.
- Strategic docs live in `~/Dev/{portfolio-site}/strategy/`: `inventaire.md`, `charte-coherence.md`, `pipeline.md`, `strategie-visibilite.md`. Read when relevant; flag in handoff when they need updating (owner commits separately).
- When changing commands/agents/skills/hooks in `~/.claude/`: update `~/Dev/workflow-guide.html` DATA section; if architectural, flag `strategy/charte-coherence.md`.
- When changing commands/agents/skills/hooks, also sweep **every kept command** for references to what you deleted — not just CLAUDE.md. A prune that only cleans the global file leaves dangling `/command` refs inside commands that still run.
- **Scheduled jobs and `~/.claude/scripts/`: load the `scheduled-jobs` skill** before creating, editing, moving or diagnosing any of them. It holds the reasons; `~/.claude/scripts/jobs-inventory.sh` derives the current state. Never write a roster, a count or a schedule table here. What follows is only what can be violated *without* thinking about scheduled jobs:
  - **Never schedule anything that reads the login keychain from crontab** — `claude`, `gh`, IMAP and API secrets all live there, and outside the GUI session the lookup fails *silently* (empty string, no error). Use a launchd LaunchAgent. Four instances so far.
  - **Every plist carries its own `EnvironmentVariables.PATH`**; `launchctl getenv PATH` is empty here. `node`/`npm` from fnm's `aliases/default` symlink (**v24** — Homebrew's is v26 and Vercel caps at 24), `claude` from `~/.local/bin`, `gh`/`uv` from `/opt/homebrew/bin`.
  - **Nothing here calls a bare `python3`.** A standalone script carries a PEP 723 header and a `uv run --script` shebang, and is executed *directly* so that shebang selects the interpreter.
  - **Exit convention, portfolio-wide: 0 healthy · 1 a finding · 2 could not run = *unknown*, never "healthy" and never "nothing to do".** An empty catalogue, a mounted-but-empty volume, and an unauthenticated API returning zero rows are all *unknown*.
  - **Each script is the source of truth for its own numbers** (retentions, weights, thresholds, tiers). Command prose describes them and must never restate them.
  - **Before deleting a dependency directory, list which scheduled jobs build from that repo** — binary guards cannot see it coming.
  - **When a script's header states a cadence, check that something actually fires it.** Three jobs have been found describing a schedule that nothing triggered.
- **Vercel exposes usage ONLY through billing data, and billing data requires being billed.** A charges query spanning a whole Hobby period returns `costs_not_found`, and **Spend Management is Pro-only**. So on the free plan there is no usage API and no spend alert — `usage-watch.sh` (served bytes) and the `push-build-gate` payload gate are the entire defence. Do not "improve" the monitor by pointing it back at a usage endpoint; that was tried and recorded in `~/.claude/plans/2026-08-03-vercel-usage-api-findings.md`.
- `/cleanup` opens with **Step 0 — Disk Hygiene**, which calls `disk-hygiene.sh`. Two tiers: **AUTO** applies unasked (ephemeral state to stated retentions, plus plan *archiving* — it never deletes a plan); **CONFIRM** (stale `projects/` transcript dirs, plugin temp dirs) only under `--yes-projects` / `--yes-plugins`. Orphan marketplaces are **reported, never auto-removed** — deleting the directory alone lets `plugins/known_marketplaces.json` re-clone it on the next session, daemons included. Deregister first with `claude plugin marketplace remove <name>`, then delete, then re-check in a fresh session.
- Plans archive after **21 days**, not 90; long-running working documents stay alive via the script's HOLD list, not by widening the cutoff.

## Python: uv is the sole manager

Decided 2026-08-17. No pyenv (already gone — `~/.pyenv` does not exist), no
development Python from Homebrew, no `pip install` into a system interpreter.
`~/.config/uv/uv.toml` sets `python-preference = "only-managed"`, which is what
actually enforces it: uv then refuses a system interpreter outright.

**It lives in `uv.toml` and not in `~/.zshrc`, and that distinction is the whole
point.** A shell export reaches interactive shells only — **a LaunchAgent and a
cron entry never source `.zshrc`** — so setting it there leaves it unset in
exactly the place a wrong interpreter would be invisible. uv's default without
it is "prefer managed, but fall back to a system Python if no managed one is
installed", so the gap is real rather than theoretical: `env-drift-check.py`'s
`uv run --script` shebang runs under the vigie LaunchAgent and picks correctly
today only because managed 3.11/3.12/3.13 happen to be installed. uv discovers
`~/.config/uv/uv.toml` on every invocation regardless of shell — verified with a
control, a probe file set to `only-system` flipped `uv python find` to
Homebrew's 3.14 with no env var set, and the same run without the file did not.
(Note `UV_PYTHON_PREFERENCE` is absent from uv 0.12.5's `--help`, which
documents `UV_MANAGED_PYTHON` instead; the old var is still parsed, but the
config key is the stable form.)

**Homebrew's `python@3.14` stays installed, and that is not a loophole.** It is
`installed_on_request=false` — a dependency of `gcloud-cli`, `mpv`, `yt-dlp`,
`vapoursynth` and `peon-ping`. `brew uninstall python@3.14` takes those five
with it. So the rule is *"Homebrew Python is a library dependency of Homebrew
formulae, never a development interpreter"*, not *"no Homebrew Python exists"*.
Do not try to remove it.

Consequences worth knowing before writing anything Python here:

- **There is no bare `python` and no bare `pip` on PATH at all.** Any doc or
  script saying `python -m venv` / `pip install -e .` is already broken, not
  merely unfashionable. Several were, and were fixed in this same change.
- **A bare `python3` resolves to `/opt/homebrew/bin/python3`** — the dependency
  interpreter above — with Apple's `/usr/bin/python3` (3.9.6) behind it. 3.9
  runs a stdlib-only snippet fine (measured), so an interpreter swap under a
  scheduled job would be **invisible** until something used 3.10+ syntax. This
  is why nothing in `~/.claude/scripts/` **or `~/.claude/hooks/`** calls a bare
  `python3` any more.
- **In a hook, the answer is usually `jq`, not uv.** All four hooks were reading
  JSON fields with `python3`; `secret-scan` alone spawned an interpreter three
  times per invocation, on every Write and Edit. A field lookup needs no
  interpreter at all, and `/usr/bin/jq` ships with macOS so it resolves under
  any PATH a hook can inherit. Routing a per-keystroke hook through `uv run`
  would have been strictly worse than the problem.
  Keep Python only where a real language is required — `push-build-gate`'s
  env-prefix parser and `payload_gate.py` — and there resolve the interpreter
  **once**, after the hook's cheap pre-filter, with the same resolver the
  scripts use. Never launch `payload_gate.py` via `uv run`: hook.sh reads exit
  2 as *block the push* and 3 as *warn*, and a launcher that can emit its own
  failure codes into that channel can manufacture a verdict.
- **A hook that cannot resolve its interpreter fails OPEN, loudly** (exit 1,
  the only non-blocking code whose stderr the owner sees) — fail closed on the
  guard's verdict, open on the guard's own malfunction.
- **Per-project: `uv sync`.** It creates `.venv`, installs from `uv.lock` and
  installs the project. Commit the lockfile.
- **One-off tooling with a requirements file: `uv run --with-requirements`.**
  No venv, no install step, cached after first use.
- **A standalone script gets a PEP 723 header and a
  `#!/usr/bin/env -S uv run --script` shebang**, then is executed *directly*.
  Never invoke such a script as `python3 script.py` — that bypasses the shebang,
  which is the single place its interpreter and dependencies are declared. That
  exact bug was live in vigie's env-drift collector until 2026-08-17.
- **`uv sync` installs the project editable by default**, which is the
  configuration behind the `MultiplexedPath` / `NotADirectoryError` break in
  `midas-core` — see [[feedback_editable_install_breaks_namespace_package_resources]].
  Re-run the single-directory assertion after any move to `uv sync`; the
  editable finder's tables are frozen at install time.
- **A public repo keeps its `pip` path.** `claude-code-setup` documents both:
  uv for the owner, `requirements.txt` for anyone cloning it. Do not force uv on
  readers of a published repo.

## Quality

- Zero build warnings. Exceptions → documented in the project CLAUDE.md with justification.
- Conventional Commits. One logical change per commit.
- Tests are systematic: unit for all logic, regression test alongside every bug fix (comment format: `// Regression: <commit-hash> — <bug description>`); property tests for pure transforms via `fast-check` (TS) / `hypothesis` (Python), file `foo.property.test.ts`. Financial-math arbitraries: `noNaN`/`noDefaultInfinity`, ≥1000 runs, 1e-6 tolerance (not 1e-10 — too tight at scale).
- After plan-driven sub-agent work, re-check every plan requirement against the code before reporting done (skip for direct single-file fixes). Service worker cache is the #1 false positive for "my change isn't showing" — rule it out before deeper debugging.
- **A check that has never produced the opposite answer is not evidence.** Before trusting silence, a zero count, a "no match" or a green suite — and especially before writing it down as a finding — make the probe fail once. Grep for something you know is in that same artifact; fire the hook's real trigger and watch it warn; confirm a liveness marker is present in the local build *and* absent from the old one; check a known-good sibling URL resolves. This generalises the 404 control already run before any status-code check: if you cannot make the check fail, it cannot pass.
- **In CI, a check that did not run must never look like a check that passed.** The same rule as above, one layer out, and GitHub Actions does not give it to you: a job excluded by `if:` reports `skipped`, a job dropped from a `needs:` list reports nothing, and `jq 'all(.[]; .result=="success")'` over an empty set returns `true` — so the obvious aggregating job reports success on **zero coverage** (measured, not assumed). An aggregate gate must therefore assert a **named list of expected checks computed up front** and refuse an empty list, never "did anything fail?". That gate is the only check a branch protection rule should require; requiring the individual jobs reintroduces the hole, since a rule can only require a name it already knows. The shared implementation is `{github-username}/.github`'s reusable `pr-gate.yml` (stack detected from the tree, same signals as `dev-scanner.sh`); `my-trading-app` keeps its own `tests.yml` and carries the same gate inline. **Callers are chosen on measured PR traffic, not coverage for its own sake** — three repos have PRs, nineteen had zero in 90 days, and a gate on a repo that never sees a PR is decoration.
- **Branch protection needs a public repo on this account.** `gh api .../branches/main/protection` and `.../rulesets` both return `403 Upgrade to GitHub Pro or make this repository public` on a private repo, so **every gate on a private repo is advisory — a red X, not a blocked merge.** Never write docs claiming enforcement, and do not fix it by upgrading to Pro; the zero-cost policy stands. `my-trading-app` is public and **is** protected: required check `gate` alone (bound to app_id 15368 so another app's same-named status cannot satisfy it), `strict: false`, `enforce_admins: false`, no required reviews, force-push and deletion off. Three traps on a solo account: **never require PR reviews** — the author cannot approve their own PR and the merge deadlocks permanently; **keep `enforce_admins` false**, or required checks also block the direct pushes to `main` this repo deliberately makes; **require only the aggregate `gate` job**, never the individual jobs. When checking whether a repo is protected, run a known-unprotected control alongside — `[]` from a rulesets query is equally the answer from a protectable-but-unprotected repo. Setting protection goes through the repo-settings API, which auto mode's classifier refuses: the owner runs the `gh api -X PUT`.
- **When a subagent reports a surprising finding, verify the reason, not just the conclusion.** A right conclusion resting on a false reason is what becomes doc drift or a wrong design decision — the conclusion gets accepted, and the reason gets written down.
- **Budget multiple review rounds after any money-path fix.** The first pass on a pricing or ledger change reliably surfaces a second defect in the same neighbourhood — measured repeatedly, never once fewer than three rounds. Treat one clean round as the start of the review, not the end of it.
- **Never trust an empty review without checking the finders ran.** A `/code-review` returned "0 findings" because all four finder agents had died. Zero findings and zero coverage are the same output — confirm the agents produced work before reading silence as a result. Same family as the falsifiable-control rule above.
- **A test can pin a defect.** Twice in one day: `test_check_ignores_generic_data_drift` asserted "data is synced but not guarded", and a Python/TypeScript pair each pinned the other's answer as correct. When a check disagrees with what you expect, read the test's *intent* before assuming the code is wrong — or right.
- Before merging any nontrivial diff: run `/code-review` at **high** effort. Sub-agent-produced diffs are always reviewed before merge; pair with `/verify` when the change has a runtime surface.
- **`ultra` is not the default, and "multi-file" is not the trigger.** The earlier rule said "ultra for multi-file or cross-layer changes", which describes nearly every real diff in this portfolio — so it was proposed constantly and waived every time. A prompt that is always declined is worse than no prompt: it trains both of us to skip the question, so the one time it matters gets waived on reflex too. Reserve `ultra` for a diff that touches a **money path** (pricing, ledger, fills, billing), **auth or secrets**, a **data migration**, or a **public API contract** — or when a normal review has already found a real defect and you want the surrounding neighbourhood swept (see the multiple-rounds rule above). Otherwise `high` is the ceiling. Offer `ultra` when one of those applies; do not offer it merely because a change spans files.

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

**Ten plugins, audited 2026-08-22** (`recherche-emploi` and `content-pipeline` joined since; `ls ~/.claude/plugins/` and `enabledPlugins` in `settings.json` are the roster). Two carry hooks, and both are deliberate:

- **`superpowers` is the standing exception to the lazy-load preference.** Its SessionStart hook injects ~3 KB (the `using-superpowers` skill) into every single session. That cost is **accepted, not overlooked** — owner's call, "an absolute necessity". Do not propose removing it, and do not re-raise the context cost as a finding.
- **`plan-reviewer` carries a Stop hook** (`check-new-plans.sh`) that flags any file in `~/.claude/plans/` touched in the last 120 minutes with no `-review.md` sibling. Consequence worth knowing: *moving* an old file into `plans/` resets its mtime and trips the hook — restore the real mtime rather than letting it nag.
- **`frontend-design` is uninstalled and stays that way.** It overlapped `ui-ux-pro-max`, which is the design skill here. Do not reinstall it or suggest it.
