# claude-scripts

Four deterministic, no-model shell scripts. None of them invokes `claude` or
any model — they're plain bash, so they're safe to run unattended (cron,
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

## Fixture-tree overrides

- `dev-scanner.sh` scans `$HOME/Dev` by default; pass a directory as a
  positional argument to point it at a single project (or a scratch fixture
  tree) instead.
- `disk-hygiene.sh` and `cleanup-cron.sh` honour `CLAUDE_DIR` (default
  `$HOME/.claude`).
- `tech-debt-triage.sh` honours `DEV_DIR` (default `$HOME/Dev`) and
  `HUB_REPO` (default `$DEV_DIR/<portfolio-site>`).

Every script can be exercised against a throwaway directory tree this way,
without touching the real `~/.claude` or `~/Dev`.

## The macOS cron caveat

Never schedule a model-invoking `claude -p` from crontab on macOS. A cron
job runs outside the GUI login session, so it has no access to the login
keychain that holds Claude Code's OAuth credentials — the CLI reports "Not
logged in" instead of falling back to anything readable. These scripts exist
partly so the unattended maintenance work (disk hygiene, tech-debt triage)
needs no model at all, and therefore no login session, and so can actually
run from cron.

If a model-invoking step is ever genuinely required unattended, use a
launchd `LaunchAgent` under `~/Library/LaunchAgents/` instead of cron — it
runs inside the GUI session and can reach the keychain.
