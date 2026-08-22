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
(`~/.config/gh/hosts.yml` carries no `oauth_token:` line), the veille's IMAP
password, and the My Socratic App status secret. A crontab job runs outside the GUI login
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
`snapshot.json`, then died in `astro build`. The visible result was the worst shape
available: **a fresh snapshot behind a frozen `dist/`**, the panel answering with
numbers that looked current. **Before deleting a dependency directory, list which
scheduled jobs build from that repo.**

**When a script's header states a cadence, check that something fires it before
believing the cadence.** Three jobs have been found describing themselves as
scheduled while nothing triggered them — the diffusion pipeline after its prompts
moved into a plugin, the job-search dossier, and `distribution-watch`. A script that
has never run leaves nothing behind to notice, and a status file records only runs
that happened.

## Two wrong beliefs a future session will re-derive on its own

**Do not grant Full Disk Access to `uv`.** TCC's `kTCCServiceSystemPolicyAllFiles`
table contains **no row for `uv` at all** — the grant has never existed — and
`devlog-collect` runs to exit 0 in ~10 s writing onto the Drive. `rclone`
(`diffusion-mirror`) reads the same mount with no TCC row either. A hang on a Drive
path is the FileProvider not yet materialising, not a missing grant. Note `claude`
carries an **explicit FDA denial** (`auth_value 0`) and still reaches the Drive mount.

**Do not wire Buffer's `LinkedInPostMetadataInput.firstComment`.** The field exists
in the schema — introspection confirms it — but **this account lacks the paid
option**, and sending it makes `createPost` fail, whereupon `/api/dispatch` does
`continue` and **the post is never published**. A branch that wired it up was
written, reviewed, and deleted unpushed. *A schema field says what the API accepts in
FORM, not what the plan ALLOWS.* Also written at the top of `diffusion-task.sh`.

## Per-job judgment

**`tech-debt-triage`** — Phase 2 deep-review selections stay manual. Items flagged
2+ months without action escalate L1→L2→L3 to `troubleshooter`.

**`cleanup`** — runs `cleanup-cron.sh`, **not** `claude -p "/cleanup"`. `/cleanup`
commits at Step 1, can fire `/sync-setup` at Step 4, and its CONFIRM tier is
interactive by design — none of that is safe unattended. The wrapper covers **Step 0's
AUTO tier only** and logs the rest as `owner action:`.

**`usage-watch`** — guards on `curl` and a uv-managed Python with a **fatal exit
rather than a skip**, so a missing interpreter cannot be mistaken for a quiet week.

**`model-watch`** — a model chain hides its own degradation, and a *delisted* entry
is worse than a degraded one: OpenRouter validates the whole `models` array up front,
so one stale entry 400s a request the primary could have served. Refuses to read an
empty catalogue as everything having been delisted.

**`devlog-collect`** — the plist executes `collect.py` directly so its `uv run
--script` shebang selects the interpreter. See the FDA note above.

**`vigie-refresh`** — the only scheduled job whose script lives in a project repo
(it builds that project), so `/sync-setup` does not cover it. Guards on
**`node`/`npm`/`git` only, fatal exit 2**: without those no snapshot exists at all.
**`gh` and `uv` are deliberately NOT fatal.** Each feeds exactly one collector, and
`runCollectors` isolates a collector that throws — a missing `gh` records
`{ok:false}`, the columns render `SIGNAL LOST`, and the band names the missing
source. That is the designed, visible, one-column failure. Making them fatal was
tried and is strictly worse: the script exits *before* `npm run build`, so the panel
keeps serving the last good snapshot with every source `ok:true` and the band reading
ALL CLEAR. **A guard written to prevent a plausible-looking answer nobody measured
was manufacturing one.** It `cd`s into the repo first, deliberately: Astro resolves
its content-collection base against the cwd of `astro build`, and a scheduled job
runs with cwd `$HOME`, which would silently collect zero documents rather than fail.

**`vigie-serve`** — the only agent with `RunAtLoad` and `KeepAlive` both true. It
only serves the static `dist/` the refresh agent built: **the refresh agent owns the
data and this one only shows it**, because a server that also refreshed would make
the panel's age depend on when a browser was last opened. Port 7707 is pinned
**strictly** (`vite.preview.strictPort`) — Astro's default walks to the next free
port, which for a bookmark means quietly answering from whatever else holds it.
`astro dev` is left non-strict so `npm run dev` still works alongside it.
A `143` exit is launchd cycling it (SIGTERM) and is normal.

**`gate-watch`** — here a cron failure would be worse than a visible error:
unauthenticated `gh search prs` returns zero rows, byte-identical to "no repo has any
PRs", so it would report full coverage forever. It checks `gh auth status` explicitly
rather than inferring from an empty result set. Monthly because a dormant repo
starting to take PRs is a slow signal.

**`diffusion-quotidienne`** — **the job the whole pipeline hangs on.** Its step 1
calls `POST /api/dispatch`, which sends veto-expired entries to Buffer, reconciles
published posts, allocates slots and runs `sweepDiffusion`. **Nothing else calls that
route on a schedule** — no Vercel cron, no GitHub Action. With no trigger, nothing
leaves for Buffer, nothing is reconciled, nothing is swept, and no article is ever
adapted. 05:07 so the 40-minute watchdog ceiling (05:47) lands clear of the 05:57
weekend lines; the two cannot overlap by construction.

**`diffusion-releve`** — writes only into `metrics/`; measures, sends nothing. Picks
its regime (weekly reading vs month-close) **from the previous month's file state,
not from the date**, so a skipped week catches up rather than losing a close.

**`diffusion-my-trading-app` / `diffusion-devlog`** — the only scheduled jobs that invoke a
model, and the one place the keychain rule's escape hatch is deliberately taken (both
reasons apply: OAuth in the keychain, and a Google Drive File Provider mount that
exists only in the graphical session). **One script for all four lines**, since they
differ only by command name; all editorial logic stays in the `content-pipeline`
plugin prompt, where it can be revised without touching shell. **Do not grow logic
into `diffusion-task.sh`** — a new rule belongs in the command file.
A **`mkdir`-based lock** (atomic, hence a lock and not a race) stops two lines
running at once, since all four write `pipeline.json`; a lock older than two hours —
three times the worst case — is reclaimed, so a run killed by reboot cannot wedge the
pipeline. The **40-minute watchdog** exists because launchd has no timeout of its own;
a watchdog kill exits **2, not 1**, because the outcome is genuinely ambiguous — the
post may or may not have reached Buffer. **05:57 and not 06:00**: four hours of veto
window before the 10:00 publication, and off the round minute.
`StartCalendarInterval` catches up **only once, and that is wanted** — the prompts
verify the weekday themselves and refuse to schedule outside their own day, after a
late catch-up once treated a Sunday as a Saturday.
`--permission-mode acceptEdits` plus `diffusion/.claude/settings.json` is what makes
the headless run work: writes pass, Bash and Skill calls stay allow-listed, anything
unforeseen is **denied without a prompt, therefore silently**. The `Skill()` entries
are load-bearing — without them {author-first-name}'s voice and the adaptation rules never load
and the post goes out anyway.

**`publication-arm`** — arms one ntfy notification per scheduled post, delivered at
its exact publication time, carrying the first comment to paste by hand. **ntfy keeps
the schedule itself** (`X-At`), so a sleeping Mac loses nothing — which is why there
is no polling agent. Measured by making it fail: `X-At` at **+3 days is accepted, +4
is refused**. A 72 h ceiling against posts scheduled a fortnight out means **one pass
a day instead of ninety-six**; each pass arms whatever just entered the window.
State lives in `~/.claude/publication-arm.state`, **never in `pipeline.json`** —
that file's writer count is what justifies its read-merge-write rule and this script
refuses to become another. The key includes `scheduled_at`, so a rescheduled post
re-arms rather than counting as done. `diffusion-task.sh` calls it at the end of a run
so a Saturday My Trading App published the same day does not wait for the next morning; the
shared state file is what stops the two paths double-arming.
It carries a **partial mirror of My Editor App's `toPlainText`** — accepted debt: without
it a `utm\_source` pastes verbatim and breaks tracking, and running compiled
TypeScript from a LaunchAgent costs more than the risk.

**`veille-emploi`** — the only scheduled job serving the job-search dossier, which
had *no trigger at all* until it existed; the cost was measured on the day it was
fixed, at **seven follow-ups due or overdue with nothing saying so**. LaunchAgent for
two cumulative reasons, either sufficient: the IMAP password is in the login
keychain, and the dossier is on an iCloud File Provider mount. **No model,
deliberately** — it chains deterministic plugin scripts; editorial presentation stays
in `digest-matin`, in a session, with the owner. It marks `$VeilleTraitee` **after**
the state is written; marking first loses the alerts if the write fails.
**A quiet e-mail channel does not abort the run**: `lire_alertes.py` exits 2 on an
empty window because it cannot distinguish a quiet period from a broken server
filter. The wrapper cuts the mail channel, says so in the notification, runs the ATS
collection and follow-up check anyway, and exits 2 — part of the sweep is unknown,
the rest ran. Two bugs worth knowing: **`rc=$?` inside `if ! cmd` captures the status
of the negation, not the command**, so the guard was always false; and treating a
fully-marked mailbox as fatal threw away two unrelated channels.

**`my-socratic-app-watch`** — **the hour is the design, not a free slot.** The proxy's
counters roll over at **00:00 UTC**, computed inside the Durable Object from its own
clock. 23:47 Paris is 21:47 UTC — ~91% of the UTC day elapsed in summer. A morning
run would sample a UTC day a few hours old and read near-zero *every single day*,
reporting "plenty left" on the very day the service refused everyone at 23:00. **Do
not move it to a breakfast slot to sit beside the others.** The route it reads is
deliberately **invisible rather than closed**: an unauthorized caller gets the same
`405 Method not allowed` as any other `GET`, byte-identical, because a 404 or 401
would announce it exists. Its secret is **not** the extension's `X-My Socratic App-Key`,
which ships inside the `.crx`. **A 405 is exit 2, not exit 0.** Status reads claim no
quota — a test pins that six status reads around one analysis move the counter by
exactly one, so watching the service cannot consume what it watches.

**`distribution-watch`** — are the publish-once channels actually done: npm, PyPI,
awesome-list PRs, the Chrome Web Store listing. Reports state, never proposes
content, and checks for an already-open PR before naming "open a PR" as an action.
The 3rd and 17th rather than the 1st and 15th, which are taken at 08:07.

**`diffusion-mirror`** — mirrors the diffusion folder **one way, Google Drive →
iCloud**, because My Editor App on Vercel and `/api/dispatch` read the Drive API and
cannot read iCloud. Drive stays authoritative; there is deliberately no return path.

**`gha-bridge.*` / `act-local` / `midas-ohlcv-bridge`** — the local bridge family
built while the GitHub Actions included-usage meter is exhausted. **The first two
expire when the quota resets; check the date before treating them as permanent.**
`midas-ohlcv-bridge` fetches OHLCV rows, commits and **pushes to `{github-username}/my-trading-app`** — the
only scheduled job that writes to a remote, so **never `launchctl kickstart` it to
"test" anything**. It is also the only one invoked through a login shell, which is
why `~/.profile`'s dead first line prints in its log every run.

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
Choosing a replacement model needs an eval set (`my-socratic-app/scripts/bake-off.mjs`);
raising an My Socratic App ceiling needs the provider's published RPD re-derived in the same
change. `gate-watch.sh` distinguishes `pending` (a fix already open in a PR) from
`MISSING`, because a watcher that nags about work in flight is one you learn to skip.

**`notifier.sh` is the single push channel, and its topic is PUBLIC.** It redacts
against `secrets.json` literals first and generic token patterns second, because a
failing run can quote its own `curl` command. **That redaction covers secrets, not
personal data** — never route company names, candidature status, or dossier content
through it. Counts only.

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

**`diffusion-task.sh` is the one model-invoking script, and it proves the rule rather
than bending it**: it is a launcher, not a task. It resolves the `claude` binary,
guards the working folder, sets a watchdog and reports an exit code. Every judgment
it carries out lives in the `content-pipeline` plugin prompt. **Do not grow logic
into it.**
