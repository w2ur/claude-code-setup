---
name: scheduled-jobs
description: Why each launchd LaunchAgent on this machine exists, scheduled at the hour it is, and which plausible "fixes" are wrong. Load before creating, editing, moving or diagnosing any scheduled job. Current state comes from jobs-inventory.sh, never from this file.
user-invocable: true
---

# Scheduled jobs — the reasons

**Current state is derived, never written here.** Run
`~/.claude/scripts/jobs-inventory.sh` (add `--json`) for the live list: label,
schedule, program, log, log age, last exit. This file holds only what cannot be
derived — the judgment behind each job. **Never add a count, a roster, or a file
list to this file.** Every count previously kept in prose here drifted.

Exit convention, portfolio-wide: **0 = healthy · 1 = a finding · 2 = could not run =
*unknown*, never "healthy" and never "nothing to do".** A mounted-but-empty volume,
an empty catalogue, an unauthenticated API returning zero rows — all are *unknown*.

## Cross-cutting rules

**Never schedule anything that reads the login keychain from crontab.** Four
instances, each found the hard way: `claude`'s OAuth credentials, `gh`'s OAuth token
(`~/.config/gh/hosts.yml` carries no `oauth_token:` line), an IMAP password, and the
Elenchus status secret. A crontab job runs outside the GUI login
session, so `login.keychain-db` is absent from its search list. The failures are
silent, not loud: `claude` reports `Not logged in`; `gh` returns `HTTP 401`; the
`security` lookup returns an **empty string with no error**, so the job reports
"nothing new" forever. Remedy is a LaunchAgent in `~/Library/LaunchAgents/`, which
runs inside the GUI session. Do **not** "fix" it by adding `USER=` — real cron
already sets it; that is a red herring that mimics the PATH bug below.

**Every plist carries its own `EnvironmentVariables.PATH`.** `launchctl getenv PATH`
returns nothing here, so a plist without it inherits launchd's built-in
`/usr/bin:/bin:/usr/sbin:/sbin`. Real dependencies: `node`/`npm` from fnm's
`~/.local/share/fnm/aliases/default/bin` — **always the `aliases/default` symlink,
never a `node-versions/<v>` path**, which one `fnm install` re-arms; `claude` from
`~/.local/bin`; `gh` and `uv` from `/opt/homebrew/bin`. `jq` and `curl` are Apple's
in `/usr/bin` and need nothing. **fnm's node is v24, Homebrew's is v26, and Vercel
caps at 24** — falling through to the Homebrew binary builds on a version the deploy
platform refuses. Check `which -a` before asserting a binary needs Homebrew.

**Nothing scheduled here calls a bare `python3`.** A standalone script carries a PEP
723 header and a `#!/usr/bin/env -S uv run --script` shebang, and the plist executes
the file **directly** so that shebang selects the interpreter. Passing the script as
an argument to an interpreter bypasses the one place its dependencies are declared.

**A binary guard does not cover a project's installed dependencies.** Guards check
`node`, not `node_modules`. A 2026-08 disk sweep deleted 16 repos' `node_modules`;
every guarded binary was still present, so `vigie-refresh` ran, regenerated
`snapshot.json`, then died in the build step that then existed. The visible result
was the worst shape available: **a fresh snapshot behind a frozen page**, answering
with numbers that looked current. The build is gone, but the lesson is not
vigie-specific. **Before deleting a dependency directory, list which
scheduled jobs build from that repo.**

**When a script's header states a cadence, check that something fires it before
believing the cadence.** Three jobs have been found describing themselves as
scheduled while nothing triggered them, `distribution-watch` among them. A script that
has never run leaves nothing behind to notice, and a status file records only runs
that happened.

**When you move a scheduled job, the trigger is the deliverable, not the prompt.** A
`status.json` records runs that happened, never runs that were never triggered — so a
missing trigger is indistinguishable from a quiet week. After any move, fire the job
once and read its log before calling the migration done.

## Wrong beliefs a future session will re-derive on its own

**An assumed quota-reset date is not a measured one.** The 2026-08-18 session
recorded 2026-09-17 as the reset; the real reset was 2026-09-01, found only by
watching a previously quota-blocked run turn green. Also: a **public** repo is
off the included-minutes meter entirely, so a repo flipping public silently
removes it from any burn projection.

**Do not grant Full Disk Access to `uv`.** TCC's `kTCCServiceSystemPolicyAllFiles`
table contains **no row for `uv` at all** — the grant has never existed — and
`devlog-collect` runs to exit 0 in ~10 s writing onto the Drive. `rclone`
(the Drive mirror job) reads the same mount with no TCC row either. A hang on a Drive
path is the FileProvider not yet materialising, not a missing grant. Note `claude`
carries an **explicit FDA denial** (`auth_value 0`) and still reaches the Drive mount.

## Per-job judgment

**`tech-debt-triage`** — Phase 2 deep-review selections stay manual. Items flagged
2+ months without action escalate L1→L2→L3 to `troubleshooter`.

**`cleanup`** — runs `cleanup-cron.sh`, **not** `claude -p "/cleanup"`. `/cleanup`
commits at Step 1, can fire `/sync-setup` at Step 4, and its CONFIRM tier is
interactive by design — none of that is safe unattended. The wrapper covers **Step 0's
AUTO tier only** and logs the rest as `owner action:`.

**`usage-watch`** — guards on `curl` and a uv-managed Python with a **fatal exit
rather than a skip**, so a missing interpreter cannot be mistaken for a quiet week.
Its findings, payload growth included, **notify through `notifier.sh` itself**:
`intendant.sh` and vigie drop exit 1 on the assumption that the job already
reported it. A run that measured nothing (no route list, zero routes, the ratchet
crashing) is exit 2, never a finding.

**`model-watch`** — a model chain hides its own degradation, and a *delisted* entry
is worse than a degraded one: OpenRouter validates the whole `models` array up front,
so one stale entry 400s a request the primary could have served. Refuses to read an
empty catalogue as everything having been delisted.
**Two discovery sources, because one missed an outage**: `wrangler.toml` chains, and
`url:`/`model:` literal pairs in Netlify functions — my-bias-app's Groq model sat in a
`.ts` constant, was retired on 2026-08-16, and 502'd for two weeks unseen. Groq has
no public free catalogue, so its ids are checked against the public deprecations
page, reading **only the first `<code>` of each table row** — the third column is
the *replacement*, and a whole-page substring grep flagged the replacement as
retired on its first run. Its falsifying control is that the retired set still
contains `llama-3.3-70b-versatile`; otherwise exit 2. **Here-strings, not pipes,
for the membership tests**: under `pipefail`, `grep -q` closing the pipe on its
first match gives `printf` a SIGPIPE on a large string, and that "failed" pipeline
reads as *not found* — a false negative, the silent kind.

**`devlog-collect`** — the plist executes `collect.py` directly so its `uv run
--script` shebang selects the interpreter. See the FDA note above.

**`vigie-refresh`** — the only scheduled job whose script lives in a project repo,
so `/sync-setup` does not cover it. It collects the snapshot and then **pushes
what changed**: since 2026-09-13 vigie has no panel, so this agent is the whole
of it. Guards on **`node`/`npm`/`git` only, fatal exit 2**: without those no
snapshot exists at all.
**`gh` and `uv` are deliberately NOT fatal.** Each feeds exactly one collector, and
`runCollectors` isolates a collector that throws — a missing `gh` records
`{ok:false}`, the columns render `SIGNAL LOST`, and the band names the missing
source. That is the designed, visible, one-column failure. Making them fatal was
tried and is strictly worse: the script exits *before* the collect, so nothing
regenerates the snapshot and every push is computed from a stale one — every
source `ok:true` and nothing wrong, under a `generated_at` nobody reads.
**A guard written to prevent a plausible-looking answer nobody measured was
manufacturing one.** It `cd`s into the repo first, deliberately: the collectors
resolve `.env`, the snapshot and the previous snapshot against the cwd, and a
scheduled job runs with cwd `$HOME`.

**It calls `notify.mjs` and must read three exit states.** Under
`set -euo pipefail` a bare call would mark this agent failed in exactly the
months an alert fires, because **1 means a finding, not a failure**. 0 and 1 are
both success; only 2 — could not run — stops the script. `VIGIE_DIGEST_DOW`
gates the Monday audience digest on the same agent rather than a second plist.

**`gate-watch`** — here a cron failure would be worse than a visible error:
unauthenticated `gh search prs` returns zero rows, byte-identical to "no repo has any
PRs", so it would report full coverage forever. It checks `gh auth status` explicitly
rather than inferring from an empty result set. Monthly because a dormant repo
starting to take PRs is a slow signal.

**`elenchus-watch`** — **the hour is the design, not a free slot.** The proxy's
counters roll over at **00:00 UTC**, computed inside the Durable Object from its own
clock. 23:47 Paris is 21:47 UTC — ~91% of the UTC day elapsed in summer. A morning
run would sample a UTC day a few hours old and read near-zero *every single day*,
reporting "plenty left" on the very day the service refused everyone at 23:00. **Do
not move it to a breakfast slot to sit beside the others.** The route it reads is
deliberately **invisible rather than closed**: an unauthorized caller gets the same
`405 Method not allowed` as any other `GET`, byte-identical, because a 404 or 401
would announce it exists. Its secret is **not** the extension's `X-Elenchus-Key`,
which ships inside the `.crx`. **A 405 is exit 2, not exit 0.** Status reads claim no
quota — a test pins that six status reads around one analysis move the counter by
exactly one, so watching the service cannot consume what it watches.

**`distribution-watch`** — are the publish-once channels actually done: npm, PyPI,
awesome-list PRs, the Chrome Web Store listing. Reports state, never proposes
content, and checks for an already-open PR before naming "open a PR" as an action.
The 3rd and 17th rather than the 1st and 15th, which are taken at 08:07.

**`dev-snapshot`** (`~/Library/LaunchAgents/com.example.dev-snapshot.plist`,
03:17) — one-way mirror of `~/Dev` onto iCloud Drive, `rsync -a --delete`. A git
remote covers tracked files only; this covers gitignored personal files, repos
never pushed anywhere, and model weights that live in a project but never went
to GitHub. **Mirror, not archive**: a local deletion propagates within the next
run (worst case ~24 h), and the only undo is iCloud's own 30-day Recently
Deleted — this script has no undo of its own. 03:17 was picked clear of every
other agent, the 05:xx model jobs in particular; `jobs-inventory.sh` gives the
occupied slots before any move.
**Two guards stand between a partially-wiped `~/Dev` and a wiped mirror.** A
git-count floor refuses to run at all (exit 2) when `~/Dev` holds fewer
`*/.git` dirs than a measured floor — read as UNKNOWN, never as "nothing to
mirror". And because `--max-delete` only **caps** a real rsync's deletions
(openrsync deletes up to the limit, exits 25, and would do the same again
every subsequent night — a slow-motion wipe on the same ~30-day timescale as
the iCloud undo window), the script runs a read-only pre-flight first and
**refuses the entire run** (exit 1, nothing touched) when the pre-flight would
delete at or above that same threshold. `--max-delete` stays on the real
transfer too, as a redundant second fence. A third guard refuses (exit 2) if
the source and the iCloud destination are nested inside each other. See
`~/.claude/scripts/dev-snapshot.sh` for the filter list and every constant's
rationale — each script owns its own numbers, not this file.
**A clean run used to be silent, which broke the rule that log age is the only
stop signal** — a dead agent never exits with an error, it goes quiet, so only
the age of its log can say it has stopped. launchd does not touch a log file's mtime on a run that writes nothing, so a job
that ran fine every night for a month and one silently un-triggered for a
month (laptop asleep at 03:17, agent unloaded) looked identical — an old,
empty log and a cached `last_exit 0` from months back. Fixed: every run,
success included, now ends with one timestamped summary line
(`<ISO8601> dev-snapshot ok: <N> files, <D> deleted, <dur>s, exit 0`, or
`FAILED: exit <rc>` on stderr), so `jobs-inventory.sh`'s log-age column is a
real liveness signal for this job too, not an exception to the rule.
**Every non-zero exit also notifies once through `notifier.sh`** (job name,
exit code, counts — never a path). The liveness line cannot carry a failure
on its own: `intendant.sh` and vigie drop exit 1 on the assumption that the
job already reported its finding, and the `FAILED` line keeps the log fresh,
so a mirror refusing every night read as healthy everywhere.

**`config-backup`** (`~/Library/LaunchAgents/com.example.config-backup.plist`,
03:47) — commits and pushes the two private config repos, `~/.claude` and
`~/.claude/plugins/local`; what `~/.claude` tracks is decided by its own
`.gitignore` allow-list, never here. LaunchAgent because `git push`
authenticates through the login keychain. **A secret in the index is exit 2
with nothing committed** — `gitleaks git --staged` runs before the commit and
the index is reset, so every following night stops at the same place until a
human looks; the repos' pre-commit hook is a second scan, not the gate. It
also sweeps in whatever was left uncommitted in `~/.claude` that day, by
design: it is a backup, not a history. 03:47 is after `dev-snapshot` and well
before the 05:xx model jobs. Ends every run with one summary line, for
the same log-age reason as `dev-snapshot`.

**`midas-ohlcv-bridge`** (retired 2026-09-04) — the last of the quota-outage
bridges, and the only scheduled job that ever wrote to a remote. It outlived the
reset on purpose: while my-trading-app main carried a required status check, hosted
`fetch-ohlcv` could not push and this bridge, under the owner's credentials, was
the only OHLCV writer. It was retired only after the check was removed and a
hosted run had pushed once. **Do not rebuild it** — my-trading-app is public and
unmetered, so a hosted job is strictly better than one that needs this Mac awake.

## Third-party agents

Five plists are not `com.example.*`. Four only watch or update themselves (espanso,
GoogleUpdater, Google keystone, alt-tab). **Pearcleaner's `homebrew-autoupdate` is the
only scheduled job on this machine that changes installed software unattended** —
`brew update && brew upgrade --greedy && …`, and `--greedy` upgrades even casks that
manage their own updates. Kept as-is by decision, recorded because an agent that
writes and is not written down is how a version change becomes an unexplained
breakage a week later — which is exactly how the fnm/node switch surfaced.

## `~/.claude/scripts/` — the conventions

Deterministic work gets a script, not an agent. The live roster comes from
`ls ~/.claude/scripts/`; never write it down.

**Each script is the source of truth for its own numbers.** `disk-hygiene.sh` owns
every retention number, `tech-debt-triage.sh` owns the four signals and their
weights, `env-drift-check.py` owns the two documentation tiers,
`claude-md-weight.sh` owns the instruction-file size threshold. **The command files
describe them and must never re-implement or restate them** — restated numbers drift.

**Targets are DISCOVERED, never hand-listed.** `gate-watch.sh` from one
`gh search prs --owner` call, `usage-watch.sh` from the Vercel API,
`model-watch.sh` from each repo's `wrangler.toml`, `claude-md-weight.sh` by walking
`~/Dev`. This is not decorative: a hand-picked loop over 12 repos missed `my-boardgame-app`
and `my-bias-app`, both of which had PRs.

**Watchers report state; they never edit config, raise a ceiling, or open a PR.**
Choosing a replacement model needs an eval set (`elenchus/scripts/bake-off.mjs`);
raising an Elenchus ceiling needs the provider's published RPD re-derived in the same
change. `gate-watch.sh` distinguishes `pending` (a fix already open in a PR) from
`MISSING`, because a watcher that nags about work in flight is one you learn to skip.

**`notifier.sh` is the single push channel, and its topic is PUBLIC.** It redacts
against `secrets.json` literals first and generic token patterns second, because a
failing run can quote its own `curl` command. **That redaction covers secrets, not
personal data** — never route personal content through it. Counts only.

**`env-drift-check.py`**: tier 1 is `.env.example`/`.dev.vars.example`, tier 2 is
`README.md`/`CLAUDE.md` prose. **Conflating them reports every prose-documented
secret as a leak-grade finding** — the exact false alarm it was built to stop. It
exits 1 only on a var documented in *neither*.

**`distribution-watch.sh`'s Chrome Web Store check asserts the resolved slug, never
the status code** — the Store answers 200 for any 32-character ID, including one that
never existed, so `res.ok` is unfalsifiable there. It re-proves that control at
runtime rather than trusting the measurement in its own comment.

**All but `distribution-watch.sh` honour `CLAUDE_DIR` / `DEV_DIR` / `LAUNCH_AGENTS_DIR`**
so they can be tested against a fixture tree. That one reads no local tree — it
queries public registries, so there is nothing to redirect.
