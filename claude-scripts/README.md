# claude-scripts

Fourteen deterministic, no-model scripts (thirteen bash, one Python). None of them
invokes `claude` or any model, so they're safe to run unattended (cron,
launchd) without a login session. `~/.claude/CLAUDE.md`'s rule: deterministic
work gets a script, not an agent.

## The scripts

- **`dev-scanner.sh`** — read-only survey of `~/Dev` (or a single project
  passed as a positional argument): git status, branch, last commit, doc
  files present, and detected stack. Prints human-readable text by default,
  structured JSON with `--json`.
- **`disk-hygiene.sh`** — the `/cleanup` command's Step 0 disk-hygiene sweep.
  Two tiers: AUTO (ephemeral state, applied without asking) and CONFIRM
  (stale transcript/plugin directories, applied only behind an explicit
  `--yes-projects` / `--yes-plugins` flag). This script is the source of
  truth for every retention number and category it sweeps — read the script
  itself for those, not this file; they drift the moment they're restated
  elsewhere.
- **`cleanup-cron.sh`** — the unattended monthly wrapper around
  `disk-hygiene.sh`'s AUTO tier only. It never touches the CONFIRM tier and
  never runs a git command.
- **`tech-debt-triage.sh`** — Phase 1 (triage) of the monthly tech-debt
  review: a fixed set of deterministic signals (commit velocity, portfolio
  prominence, time since last deep review, dependency/lint issues), scored
  and sorted into a table. This script is the source of truth for the
  signals and their weights — read the script itself for those. Phase 2
  (deep review) is deliberately not automated.
- **`sync-repo-about.sh`** — pushes each repo's one-line pitch (from its
  `README.md` frontmatter) to its GitHub About field. Prefers `about_en` and
  falls back to `tagline_en` — the two are written for different readers and
  are not interchangeable; see the script's header. `--dry-run` by default.
- **`distribution-watch.sh`** — asks whether each committed publish-once
  distribution channel (package registries, awesome-list PRs) is actually
  done. It reports state and never proposes content, and it checks for an
  already-open PR before ever naming "open a PR" as an action. Read-only: it
  never posts, publishes or opens anything.
- **`usage-watch.sh`** — weekly served-bytes trend per deployed host. Hosts
  are discovered from the hosting provider's API rather than hand-listed, so
  a newly deployed project is monitored without editing anything; the routes
  file is only an overlay for non-provider hosts, deep routes, and
  acknowledged catch-alls.
- **`gate-watch.sh`** — monthly check for repos that take enough pull
  requests to deserve the CI gate but do not carry it. Repos are discovered
  from a single pull-request search rather than hand-listed: the original
  rollout was scoped from a hand-picked loop over twelve repos and missed two
  that had PRs, which is precisely the failure a discovery-based check
  prevents. It reports state and never edits config or opens a PR, and it
  distinguishes *pending* — a workflow change already open in a PR — from
  *missing*, because a watcher that nags about work in flight is one you learn
  to skip. It checks authentication explicitly rather than inferring health
  from an empty result set: an unauthenticated search returns zero rows, which
  is byte-identical to "no repo has any PRs".
- **`model-watch.sh`** — weekly check that the LLM models each repo configures
  are still listed and still free. Exists because a model fallback chain hides
  its own degradation, and because a *delisted* model is worse than a degraded
  one: the provider validates the whole `models` array up front, so a single
  stale entry fails a request the primary could have served. A chain protects
  against runtime failures, not against delisting. Exit 1 is the alert; **exit
  2 means "unknown", never "healthy"** — it refuses to read an empty catalogue
  as everything having been delisted, and any consumer must preserve that
  distinction rather than collapsing it into a pass. Reports state only;
  choosing a replacement is a human decision backed by an eval set.
- **`env-drift-check.py`** — compares the environment variables each repo's
  code actually *reads* against how they are *documented*. It is the source
  of truth for the two documentation tiers it distinguishes (an example
  dotfile vs. README/CLAUDE.md prose); conflating them would report every
  prose-documented secret as a leak, which is the false alarm it exists to
  prevent. Exits non-zero only for a variable documented in neither tier.

- **`diffusion-mirror.sh`** — daily one-way mirror of the content-pipeline
  folder from Google Drive (authoritative) to iCloud Drive. There is
  deliberately no return path: the web app reads the Drive API and cannot read
  iCloud, so a two-way sync would let the backup overwrite the source.

- **`act-local.sh`**, **`gha-bridge.sh`**, **`midas-ohlcv-bridge.sh`** — a
  **temporary** family, and the dates in their headers are load-bearing. The
  GitHub Actions included-usage meter was exhausted on 2026-08-18, which blocks
  every GitHub-hosted run until it resets on 2026-09-17, so these run the same
  work locally in the interval: the CI gates under `act`, one scheduled
  workflow from a `.conf` declaration, and the desk-critical market-data fetch
  respectively. The last one is deliberately NOT folded into the general
  runner — it is proven and load-bearing, and it migrates only once the general
  runner has a track record. All three expire with the quota; check the date
  before treating them as permanent infrastructure.

## Fixture-tree overrides

- `dev-scanner.sh` honours `DEV_DIR` (default `$HOME/Dev`) for the tree it
  surveys; pass a directory as a positional argument instead to point it at a
  single project.
- `disk-hygiene.sh` and `cleanup-cron.sh` honour `CLAUDE_DIR` (default
  `$HOME/.claude`).
- `tech-debt-triage.sh` honours `DEV_DIR` (default `$HOME/Dev`) and
  `HUB_REPO` (default `$DEV_DIR/<portfolio-site>`).
- `sync-repo-about.sh` and `env-drift-check.py` honour `DEV_DIR` (default
  `$HOME/Dev`).
- `usage-watch.sh` honours `CLAUDE_DIR` (default `$HOME/.claude`) — its
  routes file, baselines and log all live there.
- `model-watch.sh` honours `DEV_DIR` (default `$HOME/Dev`) for the repos whose
  model configuration it reads.

Every script that reads a tree can be exercised against a throwaway directory
this way, without touching the real `~/.claude` or `~/Dev`. The exception is
`distribution-watch.sh`, which queries public registries over the network and
has no local tree to point elsewhere.

## The macOS cron caveat

Never schedule a model-invoking `claude -p` from crontab on macOS. A cron
job runs outside the GUI login session, so it has no access to the login
keychain that holds Claude Code's OAuth credentials — the CLI reports "Not
logged in" instead of falling back to anything readable. These scripts exist
partly so the unattended maintenance work (disk hygiene, tech-debt triage)
needs no model at all, and therefore no login session, and so can actually
run from cron.

**On the machine this repo is synced from, that fallback became the rule:** as
of 2026-08-19 there are no crontab entries left at all — every scheduled job
runs as a launchd `LaunchAgent`. The trigger generalises beyond `claude`, and it
is the sentence worth keeping: never schedule anything that reads the login
keychain from cron. `gh` stores its OAuth token there too, so a cron-run `gh`
returns `HTTP 401` — and for a watcher whose "no results" and "not
authenticated" look identical, that failure is invisible.

If a model-invoking step is ever genuinely required unattended, use a
launchd `LaunchAgent` under `~/Library/LaunchAgents/` instead of cron — it
runs inside the GUI session and can reach the keychain.
