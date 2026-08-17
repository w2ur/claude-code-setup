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

**Per-agent memory is project-scoped, and that is deliberate.** The agent frontmatter key `memory:` takes three values, which the harness resolves as: `user` → `~/.claude/agent-memory/<agent>/` · `project` → `<project root>/.claude/agent-memory/<agent>/` · `local` → `<project root>/.claude/agent-memory-local/<agent>/`. Three agents declare it — `implementer`, `portfolio-sync`, `troubleshooter` — and **all three declare `project`. None declares `user`.** So a store appears wherever a session's project root was: one per repo, plus one per nested working dir a session was launched from (`<repo>/client/`, say) and one per worktree (`<repo>/.worktrees/<branch>/`). 185 files across 16 repos (recounted 2026-08-08), against 17 in `~/.claude/agent-memory/` — and those 17 are residue from sessions whose project root *was* `~/.claude`, not a separate tier. Do not "consolidate" them upward; that fights the resolver.

**Per-agent memory must never be committed.** The harness default-ignores only `agent-memory-local/`, **not** `agent-memory/` — so a repo trusting that default will happily stage its memory files. Every repo with a store needs `.claude/` (or at minimum `.claude/agent-memory/`) in `.gitignore`. Repos that deliberately track other `.claude/` content — a committed project `CLAUDE.md`, shared commands — are the model here: ignore `.claude/agent-memory/` specifically rather than the whole directory.

Plans are not a memory system: they live in `~/.claude/plans/`, never in a repo.

**claude-mem was removed on 2026-07-25 (decision M13).** It was a third system holding session narrative and observation history. It went unretrieved through a five-hour, 27-repo review while costing ~1.4 GB on disk and a `$CMEM` injection at every session start. Do not reinstall it, and do not compensate by writing session narrative into the two systems above — that narrative already lives in the transcripts.

## Context management

- Rely on automatic context summarization; do not run `/compact` proactively. Use `/clear` when switching to an unrelated task. If a manual `/compact` ever runs, re-load any skills in use (CLAUDE.md is re-injected automatically).
- When dispatching to sub-agents, send focused prompts — not conversation dumps.

## Portfolio is a system

- Every project has `README.md` and `CLAUDE.md`. **Two repos are exempt, decided 2026-08-09: `{github-username}`** (the GitHub profile README — one file, no code) **and `midas-core`** (a mirror generated by `my-trading-app/scripts/sync_core.py`, whose own discipline is "never hand-edit midas-core", so guidance placed there would invite the mistake it forbids). `vigie` enforces this in `NO_CLAUDE_MD_EXPECTED` (`src/lib/portfolio-view.mjs`) and every entry must carry its reason. There is no per-repo manifest file (decision M12 retired `.portfolio.yml`). The portfolio now runs on three layers, spec'd in full in the `portfolio-conventions` skill: **Layer 1 — derived inventory**, `~/Dev/{portfolio-site}/scripts/build-inventory.mjs` observes GitHub (visibility, description, homepage, stars…), stack, deploy target, and live-URL health at build time, writing `src/data/inventory.json` — nothing hand-typed, so nothing can go stale. **Layer 2 — the pitch**, `name`/`tagline_fr`/`tagline_en`/`facts_fr`/`facts_en` as YAML frontmatter at the top of each repo's `README.md`. **Layer 3 — editorial**, `~/Dev/{portfolio-site}/src/data/editorial.ts` decides which projects get a hub tile and in what order; array order is the order.
- Folder name = GitHub repo name. Always **kebab-case**.
- Docs (README / CLAUDE.md, including README frontmatter) update in the **same commit** as the code change they describe. Never commit a feature with a stale README.
- New editorial entries default to the end of the `editorial.ts` array unless the owner specifies placement — there is no numeric sort field to default anymore.
- Strategic docs live in `~/Dev/{portfolio-site}/strategy/`: `inventaire.md`, `charte-coherence.md`, `pipeline.md`, `strategie-visibilite.md`. Read when relevant; flag in handoff when they need updating (owner commits separately).
- When changing commands/agents/skills/hooks in `~/.claude/`: update `~/Dev/workflow-guide.html` DATA section; if architectural, flag `strategy/charte-coherence.md`.
- When changing commands/agents/skills/hooks, also sweep **every kept command** for references to what you deleted — not just CLAUDE.md. A prune that only cleans the global file leaves dangling `/command` refs inside commands that still run.
- **Five local crontab entries plus three launchd LaunchAgents, deliberately offset.** All are local, not cloud `/schedule` routines: cloud routines run in an isolated sandbox with no access to the local `~/Dev` filesystem, so they can't read repo state.
  **This said "four" until 2026-08-17, and the fifth had simply never been written down** — `30 5 * * 0 /usr/bin/python3 "$HOME/Library/CloudStorage/GoogleDrive-…/Mon Drive/diffusion/tools/devlog-collect/collect.py" >> /tmp/devlog-collect.log`, the Sunday devlog collector. It is the **only scheduled job deliberately pinned to Apple's `/usr/bin/python3`**, and that pin is correct rather than an oversight: the script is stdlib-only, it lives on Google Drive rather than in a repo, and an absolute interpreter path is the one thing that cannot be broken by a PATH change or by uv's managed set moving. Do not "fix" it to use uv. Note its log currently opens with `zsh: command not found: 30`, residue from a mangled crontab edit — the entry itself parses and runs.
  - **1st, 8:07am** — `scripts/tech-debt-triage.sh` → `~/.claude/tech-debt-cron.log`. Phase 2 deep-review selections stay manual. Items flagged 2+ months without action escalate via the L1→L2→L3 cascade (see Bug handling) to the `troubleshooter` agent.
    **This entry ran `claude -p "/tech-debt --triage-only"` until 2026-08-01 and had never once worked.** A crontab job runs outside the GUI login session, so `~/Library/Keychains/login.keychain-db` is absent from its keychain search list; Claude Code's OAuth credentials live there, the lookup returns `errSecItemNotFound`, and the CLI reports `Not logged in` — it does **not** fall back to the readable `~/.claude/.credentials.json`. **Never schedule a model-invoking `claude -p` from crontab on macOS.** If one is ever genuinely required, use a launchd LaunchAgent in `~/Library/LaunchAgents/`, which runs inside the GUI session. Do **not** "fix" it by adding `USER=` to the entry: in a stripped shell `USER` looks decisive, which mimics the `PATH=` bug below, but real cron already sets it — that is a red herring.
  - **15th, 8:07am** — `scripts/cleanup-cron.sh` → `~/.claude/cleanup-cron.log`. Runs the **script, not `claude -p "/cleanup"`**: `/cleanup` makes git commits at Step 1 and can fire `/sync-setup` at Step 4, and its CONFIRM tier is interactive by design — none of that is safe unattended. The wrapper covers **Step 0's AUTO tier only** and logs everything else as an `owner action:` line.
  - **Mondays, 9:07am** — `scripts/usage-watch.sh` → `~/.claude/usage-watch-cron.log`. Weekly served-bytes trend. Guards on `curl` and on a **uv-managed** Python with a **fatal** exit rather than a skip, so a missing interpreter cannot be mistaken for a quiet week. It resolves the interpreter itself (`uv python find`, then uv's `~/.local/bin/python3.N` shim) and never runs a bare `python3` — see the uv rule below.
  - **Thursdays, 9:07am** — `scripts/model-watch.sh` → `~/.claude/model-watch-cron.log`. Are the OpenRouter models each repo configures still listed and still free. Exists because a model chain hides its own degradation, and because a *delisted* entry is worse than a degradation: OpenRouter validates the whole `models` array up front, so one stale entry 400s a request the primary could have served. Exit 1 is the alert; **exit 2 is "unknown", never "healthy"** — it refuses to read an empty catalogue as everything having been delisted.
  - **Daily, 7:07am — a launchd LaunchAgent, NOT a crontab entry.** `~/Library/LaunchAgents/com.example.vigie-refresh.plist` runs `~/Dev/vigie/scripts/vigie-refresh.sh` → `~/.claude/vigie-cron.log`, rebuilding the local control panel's snapshot and static site. **The only scheduled job whose script lives in a project repo rather than `~/.claude/scripts/`**, because it builds that project; it is therefore not covered by `/sync-setup`. Guards on **`node`/`npm`/`git` only** with a **fatal exit 2**, never a skip — without those no snapshot can be produced at all, and a collector that cannot reach its tools would record every source unavailable and render an empty portfolio, which is indistinguishable from a real empty portfolio. **`gh` and `uv` are deliberately NOT fatal; the rule here claimed they were until 2026-08-14, which was the opposite of the script's actual design.** (That second binary was `python3` until 2026-08-17. The env-drift collector spawned `python3` with the script as an argument, which bypasses the script's own shebang; it now executes `env-drift-check.py` directly and that shebang is `uv run --script`, so the dependency is `uv` and no interpreter at all.) Each feeds exactly one collector, and `runCollectors` already isolates a collector that throws: a missing `gh` records `{ok:false}`, the GitHub columns render `SIGNAL LOST`, and the band names the missing source — the designed, visible, one-column failure. Making them fatal replaced it with something strictly worse, and this was tried: the script exits *before* `npm run build`, so `snapshot.json` is never regenerated and the panel keeps serving the last good snapshot — every source `ok:true`, the band still reading ALL CLEAR, and nothing but the SWEEP timestamp to show the numbers were days old. A guard written to prevent a plausible-looking answer nobody measured was manufacturing one. It also **`cd`s into the repo first, deliberately**: Astro resolves its content-collection base against the cwd of `astro build`, and a scheduled job runs with cwd `$HOME`, so building from there would silently collect zero documents rather than failing.
  - **At login, kept alive — the third LaunchAgent, added 2026-08-16.** `~/Library/LaunchAgents/com.example.vigie-serve.plist` runs `~/Dev/vigie/scripts/vigie-serve.sh` → `~/.claude/vigie-serve.log`, serving the built panel at a pinned **<http://localhost:7707/>** so it is a bookmark rather than something started by hand. The **only agent with `RunAtLoad` true and `KeepAlive` true**; it costs ~40 ms and no network, because it only serves the static `dist/` the 07:07 agent built. **The refresh agent owns the data and this one only shows it** — a server that also refreshed would make the panel's age depend on when a browser was last opened. The port is pinned **strictly** (`vite.preview.strictPort`): Astro's default is to walk to the next free port, measured landing on 4323 when asked for 4321, which for a bookmark means quietly answering from whatever else holds the port. `astro dev` is deliberately left non-strict so `npm run dev` still works while the agent holds 7707. Details in `~/Dev/vigie/CLAUDE.md`.
    **It was a crontab entry until 2026-08-09, and moving it is the second instance of the keychain trap above — this time not involving `claude` at all.** `gh` keeps its OAuth token in the login keychain (`~/.config/gh/hosts.yml` carries **no `oauth_token:` line**), so a cron-run `gh` cannot authenticate. Measured with a throwaway crontab entry: `gh repo list {github-username} --limit 1 --json name` logged **`HTTP 401: Requires authentication`**. Left on cron, vigie's Portfolio pane would have recorded its `github` source `{ok:false}` in every single daily build. **Generalise the rule: it is not "never schedule `claude -p` from crontab", it is "never schedule anything that reads the login keychain from crontab".** The LaunchAgent fix was then verified the same way it was diagnosed — `launchctl kickstart` produced `snapshot written: 6 sources, 0 unavailable`. Prefer this over copying a token into a file: the keychain keeps the credential, and `gh`'s token here carries `delete_repo` and `workflow` scopes.
  - **Monthly, the 8th at 9:37am — the second launchd LaunchAgent.** `~/Library/LaunchAgents/com.example.gate-watch.plist` runs `~/.claude/scripts/gate-watch.sh` → `~/.claude/gate-watch-cron.log`. Which repos take enough pull requests to deserve the CI gate but do not carry it. **A LaunchAgent for the same keychain reason as vigie-refresh, and here the cron failure would be worse than a visible error**: `gh search prs` unauthenticated returns zero rows, which is byte-identical to "no repo has any PRs", so a cron-scheduled run would report full coverage forever. The script guards with an explicit `gh auth status` and exits 2, but this plist is what stops it reaching that branch. Monthly rather than weekly because a dormant repo starting to take PRs is a slow signal; the 8th collides with none of the jobs above. Verified on install with `launchctl kickstart`, which produced a real report rather than a 401.
  - Any cron entry invoking these scripts **needs an explicit `PATH=`**, and the right one per entry. Under cron's default PATH (`/usr/bin:/bin`) `claude` is unresolvable, and `disk-hygiene.sh` guards its marketplace check with `command -v claude` — so the check silently degrades to a skip, permanently, which is exactly the orphan-marketplace failure the sweep exists to catch. The same trap has a second address: **`node` and `npm` come from fnm**, at `~/.local/share/fnm/aliases/default/bin`, so without that directory on the PATH `tech-debt-triage.sh` would score every repo's vulnerability and outdated-dependency signals as unavailable. That script therefore **exits 2 and prints a `WARN`** rather than degrading quietly — prefer that shape for anything unattended. **But do not generalise the Homebrew claim to every tool.** Checked 2026-08-08 and re-checked 2026-08-16: `jq` is `/usr/bin/jq` (Apple ships it; Homebrew has one too) and `curl` is `/usr/bin/curl`, so `model-watch.sh` runs correctly under cron's bare `/usr/bin:/bin` — verified by running it that way, where it exited 0 rather than the 2 a missing `jq` would give. Its `/opt/homebrew/bin` is defensive, not required. The real cases are `node`/`npm` (fnm's alias dir), `claude` (`~/.local/bin/claude`), and `gh`/`uv` (`/opt/homebrew/bin`). Check `which -a` before asserting a binary needs Homebrew on the PATH — an invented dependency reads exactly like a verified one. **`python3` is no longer one of these, as of 2026-08-17**: no script here calls a bare `python3` any more (see the uv rule below), so a PATH carrying an interpreter buys nothing. What the scripts need on the PATH is either `uv` or `~/.local/bin`, and each resolves it itself.
    **This clause said `npm` lives in `/opt/homebrew/bin` until 2026-08-16, and that is how the trap actually sprang.** It was true when written and checked with `which`. **fnm took over `node` on 2026-08-15 12:15** (mtime on `~/.local/share/fnm/aliases`), both Homebrew binaries ceased to exist, and vigie's 07:07 LaunchAgent stopped the very next morning with `WARN missing required binaries: node npm`, after seven clean daily runs. The 1st-of-the-month `tech-debt-triage.sh` crontab entry carried the same dead PATH and would have degraded on 1 September; both are fixed. **Always point at fnm's `aliases/default` symlink, never a `node-versions/<v>` path** — fnm repoints the alias on upgrade, so a version path re-arms this within one `fnm install`. Note what the incident actually proves: the guards did their job, loudly and immediately. What rotted was the *documented reason*, which no guard can catch — the same failure mode as the retracted claims in vigie's own `CLAUDE.md`.
- **`~/.claude/scripts/` holds ten no-model scripts** — deterministic work gets a script, not an agent. `gate-watch.sh` (monthly: which repos have enough PR traffic to deserve the CI gate but do not carry it. **Repos are DISCOVERED from one `gh search prs --owner` call, not hand-listed** — the 2026-08-15 scope decision was taken from a hand-picked loop over 12 repos and missed `my-boardgame-app` and `my-bias-app`, both of which had PRs. **Reports state, never edits config and never opens a PR.** Distinguishes `pending` — a workflow change already open in a PR — from `MISSING`, because a watcher that nags about work in flight is one you learn to skip. Checks `gh auth status` explicitly rather than inferring from an empty result set: an unauthenticated `gh search prs` returns zero rows, which is byte-identical to "no repo has any PRs". Emits `--json`, but ****Vigie consumes it** as pane ④'s `gatewatch` source since 2026-08-16, through `runAllowing([1])` because exit 1 is a finding here; exit 2 stays fatal and reads as *unknown*. It is on Vigie's `SLOW_SOURCES` (measured 8.1 s). This line said "nothing consumes it yet" on the morning of the same day, which was true when written. Note `model-watch.sh` is still unconsumed — its "`--json` for Vigie" line has always described a capability rather than a wiring). The LaunchAgent log is the only reader today. Exit 1 = a repo over threshold has no gate, exit 2 = could not run and must be read as *unknown*, never as healthy), `sync-repo-about.sh` (pushes each repo's Layer 2 pitch to its GitHub About; prefers `about_en`, falls back to `tagline_en` — **the two are not interchangeable**, see the two-audiences note in its header; `--dry-run` by default, and `analytics`/`{github-username}` are deliberately excluded), `distribution-watch.sh` (fortnightly: are the publish-once channels actually done — package registries and awesome-list PRs. **Reports state, never proposes content**, and checks for an already-open PR before ever naming "open a PR" as an action), `dev-scanner.sh` (read-only `~/Dev` survey, `--json`), `disk-hygiene.sh` (the disk sweep; **the source of truth for every retention number** — never restate them in command prose, they drift), `cleanup-cron.sh` (the unattended wrapper), `tech-debt-triage.sh` (`/tech-debt` Phase 1; **the source of truth for the four signals and their weights** — the command file describes them but must never re-implement them), `usage-watch.sh` (weekly served-bytes trend; **hosts are DISCOVERED from the Vercel API, not hand-listed** — `~/.claude/usage-watch-routes.json` is an overlay for non-Vercel hosts, deep routes and acknowledged catch-alls only, so a new project is monitored automatically), `env-drift-check.py` (compares the env vars each repo's code actually **reads** against how they are **documented**; **the source of truth for the two documentation tiers** — tier 1 is `.env.example`/`.dev.vars.example`, tier 2 is `README.md`/`CLAUDE.md` prose, and **conflating them reports every prose-documented secret as a leak-grade finding**, which is exactly the false alarm it was built to stop. Exits 1 only on a var documented in *neither*), `model-watch.sh` (weekly: are the OpenRouter models each repo configures still listed and still free. **Models are DISCOVERED from each repo's `wrangler.toml`, not hand-listed**, so a new project is covered without editing the script. **Reports state, never edits config** — picking a replacement needs an eval set, which is `my-socratic-app/scripts/bake-off.mjs`. `--json` for Vigie; exit 1 = a model is gone, exit 2 = could not run and must be read as *unknown*, never as healthy). All but `distribution-watch.sh` honour `CLAUDE_DIR` or `DEV_DIR` so they can be tested against a fixture tree; that one reads no local tree at all — it queries public registries over the network, so there is nothing to redirect.
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
- **Branch protection does not exist on this account's private repos.** `gh api repos/{github-username}/<repo>/branches/main/protection` and `.../rulesets` both return `403 Upgrade to GitHub Pro or make this repository public` (measured 2026-08-15 on `vigie`, `my-trading-app`, `my-fitness-app`, `{portfolio-site}`). There is no free fallback, so every gate on a private repo is **advisory — a red X, not a blocked merge**. Do not write docs that claim enforcement, and do not "fix" it by upgrading to Pro; the zero-cost policy stands. The honest options are making the repo public, or having the repo's own merge automation read the gate's conclusion via the API.
- **When a subagent reports a surprising finding, verify the reason, not just the conclusion.** A right conclusion resting on a false reason is what becomes doc drift or a wrong design decision — the conclusion gets accepted, and the reason gets written down.
- **Budget multiple review rounds after any money-path fix.** The July 2026 My Trading App hardening took three, and the 2026-08-07 cluster took several more; the first pass on a pricing or ledger change reliably surfaces a second defect in the same neighbourhood. Treat one clean round as the start of the review, not the end of it.
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

**Eight plugins, audited 2026-08-08.** Two carry hooks, and both are deliberate:

- **`superpowers` is the standing exception to the lazy-load preference.** Its SessionStart hook injects ~3 KB (the `using-superpowers` skill) into every single session. That cost is **accepted, not overlooked** — owner's call, "an absolute necessity". Do not propose removing it, and do not re-raise the context cost as a finding.
- **`plan-reviewer` carries a Stop hook** (`check-new-plans.sh`) that flags any file in `~/.claude/plans/` touched in the last 120 minutes with no `-review.md` sibling. Note this **contradicts the "Stop hooks fully retired" line in the 2026-07-05 audit memory**: that is true of `settings.json` (which declares only `PreToolUse`/`PostToolUse`), but a plugin reintroduced one. Consequence worth knowing: *moving* an old file into `plans/` resets its mtime and trips the hook — restore the real mtime rather than letting it nag.
- **`frontend-design` was uninstalled 2026-08-08.** It overlapped `ui-ux-pro-max`, and the owner prefers the latter. Do not reinstall it or suggest it as the design skill; `ui-ux-pro-max` is the one.
