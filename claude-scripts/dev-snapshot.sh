#!/usr/bin/env bash
# dev-snapshot.sh — nightly one-way mirror of ~/Dev onto iCloud Drive.
#
# Why this exists: a git remote covers tracked files only. It never covers
# gitignored personal files (secrets aside — those are deliberately dropped,
# see filters below), local-only repos that were never pushed, or model
# weights checked into a project but not to GitHub. A git push is not a
# backup of the working tree; this mirror is the plan for the rest of it.
#
# Direction and semantics: one way, ~/Dev -> iCloud, via `rsync -a --delete`.
# A file deleted locally is propagated to the iCloud copy within the next
# nightly run (worst case ~24h), so this is a MIRROR, not an archive: it does
# not by itself protect against "I deleted the wrong thing". The undo path is
# iCloud's own "Recently Deleted", which keeps deleted files for 30 days —
# that window is the actual safety net, not this script.
#
# Measured size (2026-09-24, filters below applied): ~7.2 decimal GB (GB,
# not GiB — the measured figure is 7,140,610,904 B = 7.14 GB = 6.65 GiB),
# ~30k files transferred out of ~35k seen. See task-I2-report.md for the
# full --stats output that gated the first real run (O10).
#
# --delete only removes files that no longer exist on the SOURCE side of
# what rsync actually compares — it never removes something the filters
# excluded. So a secret that reached the mirror before its exclude rule
# existed (or one dropped in on the iCloud side by hand) stays there
# permanently; this script will never clean it up. The only fix is a
# one-time manual delete on the iCloud side after tightening a filter.
#
# Filters, in order (first match wins, same as rsync's own rule order):
#   1. --include the two *.example patterns FIRST, because the broad
#      `.env.*` exclude below would otherwise also catch `.env.example` and
#      `.dev.vars.example` — those two are safe-to-share templates, not
#      secrets, and they're the ones a restore actually needs.
#   2. --exclude dependency/build/cache directories that are fully
#      reproducible from source (node_modules, .next, dist, build, out,
#      .vercel, .wrangler, .venv, venv, __pycache__, .turbo, coverage,
#      .svelte-kit, .astro, .pytest_cache, .ruff_cache, .playwright-mcp,
#      .claude/worktrees, .worktrees).
#   3. --exclude secret-shaped files (.env, .env.*, .dev.vars, .envrc,
#      *.pem, .claude/settings.local.json, .npmrc, *.key, *.p12, id_rsa*,
#      service-account*.json).
# Confirmed empirically against openrsync (macOS ships openrsync, protocol
# 29, not upstream rsync): include-before-exclude ordering wins per-path,
# and a slash-bearing pattern with no leading slash (.claude/worktrees/,
# .claude/settings.local.json) still anchors correctly when the matched
# path is nested two levels deep under the transfer root (tested with a
# fixture under repo1/) — see scripts/tests/dev-snapshot/test.sh fixture A.
#
# Numbers this script owns:
#   GIT_FLOOR (10)  — ~/Dev held 26 `*/.git` dirs at maxdepth 2 when this was
#                     written. The floor is kept well under that so a tree
#                     that's merely missing a couple of clones doesn't false
#                     -positive, while a wiped or never-populated ~/Dev still
#                     trips it (Tree B in the tests: an empty ~/Dev is 0, always
#                     under any positive floor).
#   MAX_DELETE (1000) — ~3% of the ~30k files this mirror transfers. Large
#                     enough that a legitimate bulk operation (a big refactor,
#                     a lockfile regeneration) doesn't trip the guard; far
#                     below "the iCloud copy is about to be wiped to match an
#                     accidentally-emptied source", which is exactly the
#                     failure this guard exists to catch. Used twice: as the
#                     REFUSAL threshold (see pre-flight below) and, redundantly,
#                     as rsync's own --max-delete on the real run.
#
# --max-delete alone only CAPS a run's deletions — openrsync deletes the
# first MAX_DELETE files, then exits 25, and does the same again the next
# night, so a partially-wiped ~/Dev (still above GIT_FLOOR) would silently
# lose the mirror over ~30 nights, on the same timescale as iCloud's own
# undo window. So before any run that could delete for real, a dry-run
# pre-flight (same filters) counts what WOULD be deleted and REFUSES the
# entire run — nothing touched — when that count is >= MAX_DELETE.
# --max-delete stays on the real run too, as a second, redundant fence.
#
# Deletions under a `.git/` directory are NOT counted against MAX_DELETE.
# `git gc` / auto-repack folds thousands of loose objects into a pack in one
# go: on 2026-10-04 a my-trading-app repack made the pre-flight see ~6,800 deletions,
# all `my-trading-app/.git/objects/*`, and the mirror refused every night for a week.
# That churn is git rewriting its own store, not a wipe — the pack holding
# the same objects is transferred in the same run. A wipe of working trees
# still counts in full, and a ~/Dev emptied of repos still trips GIT_FLOOR.
# The real run's --max-delete is therefore the pre-flight's TOTAL (git
# included) plus MAX_DELETE: still a fence against the tree changing
# between the two passes, no longer a cap a repack can hit on its own.
#
# Exit: 0 ok (mirror ran clean, or a clean --dry-run) ·
#       1 a finding (the pre-flight would delete >= MAX_DELETE files, rsync's
#         own --max-delete was hit, or rsync itself errored — in either
#         --dry-run or a real run) ·
#       2 could not run (~/Dev missing, too few *.git dirs under it — read
#         as UNKNOWN, never as "nothing to mirror" — or the iCloud
#         destination is missing).
#
# Evicted mirror copies (2026-10-16 → 10-26, every night FAILED): with the
# disk near full, iCloud's "Optimise Mac Storage" evicts mirror files, leaving
# DATALESS placeholders (SF_DATALESS in st_flags). When the source copy of
# such a file changes, rsync opens the old mirror copy as its delta BASIS and
# mmaps it. A LaunchAgent may not fault an evicted file back in, so the mmap
# fails with EDEADLK ("mmap: Resource deadlock avoided"), rsync aborts the
# whole transfer, and every later file is left stale. --whole-file does not
# help: openrsync still maps the basis (measured on a forced-dataless file).
# Remedy: before the real transfer, every file the pre-flight will UPDATE
# whose mirror copy is dataless is unlinked from the mirror, so rsync writes
# it fresh. That copy was about to be replaced anyway and its content lives
# in iCloud's own history; unlinking never downloads it. This is not a skip:
# any other read error still fails the run, as does a basis evicted between
# the pre-flight and the transfer (the next night handles it).
#
# Notification cooldown: a failure that repeats every night used to push every
# night — 10+ identical pushes in October. Each push records its CAUSE (a
# category, plus the rsync error class with the path stripped for a transfer
# error) in NOTIFY_STATE. The SAME cause pushes again only after COOLDOWN_DAYS;
# a DIFFERENT cause pushes at once; the first clean run after any recorded
# failure pushes one "recovered" line and clears the state. The log still
# carries a FAILED line every night, so the log stays a full record.
# --dry-run stays outside the cooldown: it never updates the mirror, so its
# clean exit pushes no "recovered" and keeps the state, and its failure
# pushes without reading or writing the state.
#   COOLDOWN_DAYS (7) — a persistent failure still reminds once a week, so it
#                      cannot fall silent for good, without training the
#                      owner to swipe the nightly push away.
#
# Usage: dev-snapshot.sh [--dry-run]
#   --dry-run runs only the pre-flight (with --stats added, for the O10
#   numbers) and never the real, deleting rsync. Its exit code reflects the
#   pre-flight the same way the real run does — an rsync error under -n is
#   never silently reported as success.
#
# Env overrides (fixture testing only — production uses every default):
#   DEV_DIR                default $HOME/Dev
#   ICLOUD_DIR              default $HOME/Library/Mobile Documents/com~apple~CloudDocs/dev-mirror
#   DEV_SNAPSHOT_GIT_FLOOR  default 10  (see GIT_FLOOR above)
#   DEV_SNAPSHOT_MAX_DELETE default 1000 (see MAX_DELETE above)
#   DEV_SNAPSHOT_NOTIFY_STATE   default $HOME/.claude/dev-snapshot.notify-state
#   DEV_SNAPSHOT_COOLDOWN_DAYS  default 7 (see COOLDOWN_DAYS above)
#
# Liveness line: every exit — success included — ends with one timestamped
# summary line (`<ISO8601> dev-snapshot ok|FAILED: ...`). This is not
# decoration: launchd does not touch a log file's mtime on a run that writes
# nothing, so a script whose success path is silent would leave
# jobs-inventory.sh's "log age" column frozen forever — a job that ran
# clean every night for a month and a job silently un-triggered for a month
# (laptop asleep at 03:17, agent unloaded) would look byte-for-byte
# identical. This one line is what makes log age a real liveness signal for
# this job, same as it is for every other com.example.* job.
#
# Notification: every non-zero exit — 1 and 2 alike, --dry-run included —
# pushes ONE message through notifier.sh, from the EXIT trap so no exit path
# can skip it. The liveness line alone is not enough: vigie drops
# exit 1 on the assumption that the job already reported the
# finding itself, and the FAILED line keeps the log's mtime fresh, so a
# mirror refusing every night used to look healthy on every dashboard. The
# ntfy topic is PUBLIC: the message carries the job name, the exit code and
# counts only — never a path. NOTIFIER_BIN overrides the notifier (tests).

set -uo pipefail

SUMMARY_START="$(date +%s)"
SUMMARY_FILES="?"
SUMMARY_DELETED="?"
# Why the run stopped, for the notification. Counts only, never a path.
FAIL_REASON="unexpected exit"
# Stable key for the cooldown: what failed, never a count or a path.
FAIL_CAUSE="unexpected"
EVICTED_REPLACED=0
NOTIFIER="${NOTIFIER_BIN:-${HOME:-}/.claude/scripts/notifier.sh}"
NOTIFY_STATE="${DEV_SNAPSHOT_NOTIFY_STATE:-${HOME:-}/.claude/dev-snapshot.notify-state}"
COOLDOWN_DAYS="${DEV_SNAPSHOT_COOLDOWN_DAYS:-7}"
# Set before the trap can fire; the argument parser below may raise it.
DRY_RUN=0

# push <title> <body text> [priority]
# shellcheck disable=SC2329  # reached only from the EXIT trap
push() {
  local body
  [ -x "$NOTIFIER" ] || return 0
  body="$(mktemp)" || return 0
  printf '%s\n' "$2" > "$body"
  "$NOTIFIER" "$1" "$body" --priorite "${3:-high}" >/dev/null 2>&1 || true
  rm -f "$body"
}

# The state file holds one line: <cause><TAB><epoch of the last push>.
# shellcheck disable=SC2329  # reached only from the EXIT trap
notify_failure() {
  local rc="$1" key="exit $1: $FAIL_CAUSE" prev_key="" prev_at=0 now
  now="$(date +%s)"
  # A dry run is a manual check: it reports its failure, but it is not the
  # nightly job, so it neither consults nor rewrites the nightly cooldown.
  if [ "$DRY_RUN" -eq 1 ]; then
    push "dev-snapshot --dry-run FAILED (exit $rc)" \
      "$(printf 'dev-snapshot --dry-run exited %s: %s.\nNothing was changed. See the output.' "$rc" "$FAIL_REASON")"
    return 0
  fi
  if [ -f "$NOTIFY_STATE" ]; then
    IFS=$'\t' read -r prev_key prev_at < "$NOTIFY_STATE" || true
  fi
  case "$prev_at" in ''|*[!0-9]*) prev_at=0 ;; esac
  if [ "$prev_key" = "$key" ] && [ $(( now - prev_at )) -lt $(( COOLDOWN_DAYS * 86400 )) ]; then
    echo "notification skipped: same cause as $(date -r "$prev_at" '+%Y-%m-%d'), cooldown ${COOLDOWN_DAYS}d" >&2
    return 0
  fi
  push "dev-snapshot FAILED (exit $rc)" \
    "$(printf 'dev-snapshot exited %s: %s.\nThe iCloud mirror of the Dev folder was not updated. See the job log.\nThe same cause will not push again for %s days.' \
      "$rc" "$FAIL_REASON" "$COOLDOWN_DAYS")"
  printf '%s\t%s\n' "$key" "$now" > "$NOTIFY_STATE" 2>/dev/null || true
}

# shellcheck disable=SC2329  # reached only from the EXIT trap
notify_recovery() {
  [ -f "$NOTIFY_STATE" ] || return 0
  local prev_key=""
  IFS=$'\t' read -r prev_key _ < "$NOTIFY_STATE" || true
  push "dev-snapshot recovered" \
    "dev-snapshot ran clean: $SUMMARY_FILES files, $SUMMARY_DELETED deleted. Previous failure: ${prev_key:-unknown}." default
  rm -f "$NOTIFY_STATE"
}

# Runs on every exit path, including early guard failures — `local rc=$?`
# must be the very first statement, before anything else in this function
# can overwrite $?. --help disables this trap before exiting (see below):
# it's a documentation path, not a job run, and has nothing to report.
# shellcheck disable=SC2329  # reached only from the EXIT trap
finish() {
  local rc=$?
  local ts dur
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dur=$(( $(date +%s) - SUMMARY_START ))
  if [ "$rc" -eq 0 ]; then
    echo "$ts dev-snapshot ok: $SUMMARY_FILES files, $SUMMARY_DELETED deleted, $EVICTED_REPLACED evicted replaced, ${dur}s, exit 0"
    # A dry run never updates the mirror, so it cannot have healed it.
    [ "$DRY_RUN" -eq 1 ] || notify_recovery
  else
    echo "$ts dev-snapshot FAILED: exit $rc, ${dur}s" >&2
    notify_failure "$rc"
  fi
}
trap finish EXIT

if [ -z "${HOME:-}" ]; then
  echo "FATAL: HOME is not set — could not resolve defaults" >&2
  FAIL_REASON="HOME is not set"; FAIL_CAUSE="home-unset"
  exit 2
fi

DEV_DIR="${DEV_DIR:-$HOME/Dev}"
ICLOUD_DIR="${ICLOUD_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/dev-mirror}"
MIRROR_DEST="$ICLOUD_DIR/Dev"

GIT_FLOOR="${DEV_SNAPSHOT_GIT_FLOOR:-10}"
MAX_DELETE="${DEV_SNAPSHOT_MAX_DELETE:-1000}"

case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  --help|-h)
    trap - EXIT
    awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; FAIL_REASON="unknown argument"; FAIL_CAUSE="bad-argument"; exit 2 ;;
esac

command -v rsync >/dev/null 2>&1 || { echo "FATAL: rsync not found" >&2; FAIL_REASON="rsync not found"; FAIL_CAUSE="rsync-missing"; exit 2; }

if [ ! -d "$DEV_DIR" ]; then
  echo "FATAL: $DEV_DIR is not a directory — nothing to mirror is UNKNOWN, not empty" >&2
  FAIL_REASON="source folder missing"; FAIL_CAUSE="source-missing"
  exit 2
fi

GIT_COUNT="$(find "$DEV_DIR" -maxdepth 2 -name .git -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$GIT_COUNT" -lt "$GIT_FLOOR" ]; then
  echo "FATAL: $DEV_DIR holds $GIT_COUNT */.git dirs, below the floor of $GIT_FLOOR — refusing, this looks empty or partially wiped" >&2
  FAIL_REASON="$GIT_COUNT git repos found, below the floor of $GIT_FLOOR"; FAIL_CAUSE="git-floor"
  exit 2
fi

if [ ! -d "$ICLOUD_DIR" ]; then
  echo "FATAL: $ICLOUD_DIR is not a directory — iCloud destination missing" >&2
  FAIL_REASON="iCloud destination missing"; FAIL_CAUSE="destination-missing"
  exit 2
fi

# Neither side may be inside the other. MIRROR_DEST itself may not exist yet
# (a fresh iCloud target on the very first run), so its canonical path is
# built from ICLOUD_DIR's realpath (which the check above guarantees
# exists) rather than realpath'd directly — macOS realpath refuses a
# nonexistent path outright.
DEV_REAL="$(realpath "$DEV_DIR")"
MIRROR_DEST_REAL="$(realpath "$ICLOUD_DIR")/Dev"
case "$MIRROR_DEST_REAL/" in
  "$DEV_REAL/"*)
    echo "FATAL: iCloud destination $MIRROR_DEST_REAL is inside $DEV_REAL — refusing, would mirror into itself" >&2
    FAIL_REASON="source and destination overlap"; FAIL_CAUSE="overlap"
    exit 2
    ;;
esac
case "$DEV_REAL/" in
  "$MIRROR_DEST_REAL/"*)
    echo "FATAL: $DEV_REAL is inside iCloud destination $MIRROR_DEST_REAL — refusing, would mirror into itself" >&2
    FAIL_REASON="source and destination overlap"; FAIL_CAUSE="overlap"
    exit 2
    ;;
esac

# error_class <rsync output>: the first rsync error with its pid and path
# stripped ("mmap: Resource deadlock avoided"), so the cooldown key stays the
# same when the same fault hits a different file. Never contains a path.
error_class() {
  local line
  line="$(printf '%s\n' "$1" | grep -m1 -E '^rsync(\([0-9]+\))?: error: ' | sed -E 's/^rsync(\([0-9]+\))?: error: //')"
  # "<path>: <class>" -> "<class>"; a line with a single colon-free class stays.
  case "$line" in *": "*) line="${line#*: }" ;; esac
  printf '%s' "${line:-unclassified}" | tr '\t/' '  ' | cut -c1-80
}

# is_dataless <path>: SF_DATALESS (0x40000000) set, i.e. evicted by iCloud.
is_dataless() {
  local f
  f="$(stat -f %f "$1" 2>/dev/null)" || return 1
  [ $(( f & 0x40000000 )) -ne 0 ]
}

# Filter order matters: includes for the *.example templates must precede
# the secret excludes below, or the broader .env.* exclude would also catch
# .env.example / .dev.vars.example.
RSYNC_FILTERS=(
  --include='.env.example' --include='*.example'
  --exclude='node_modules/' --exclude='.next/' --exclude='dist/' --exclude='build/' --exclude='out/'
  --exclude='.vercel/' --exclude='.wrangler/' --exclude='.venv/' --exclude='venv/' --exclude='__pycache__/'
  --exclude='.turbo/' --exclude='coverage/' --exclude='.svelte-kit/' --exclude='.astro/' --exclude='.pytest_cache/'
  --exclude='.ruff_cache/' --exclude='.playwright-mcp/' --exclude='.claude/worktrees/' --exclude='.worktrees/'
  --exclude='.env' --exclude='.env.*' --exclude='.dev.vars' --exclude='.envrc' --exclude='*.pem'
  --exclude='.claude/settings.local.json'
  --exclude='.npmrc' --exclude='*.key' --exclude='*.p12' --exclude='id_rsa*' --exclude='service-account*.json'
)

# Pre-flight: --max-delete only CAPS a run's deletions, it does not REFUSE
# one — openrsync deletes the first MAX_DELETE files, exits 25, and a
# partially-wiped ~/Dev (still above GIT_FLOOR) would lose up to MAX_DELETE
# more every subsequent night until the mirror is gone, on the same
# timescale as iCloud's 30-day undo window. So before anything can be
# deleted for real, count what a delete run WOULD do with a plain dry run
# (same filters, `-n`, so nothing is touched) and refuse outright, before
# invoking the real rsync at all, when that count is >= MAX_DELETE.
# --dry-run runs only this pre-flight (plus --stats for the O10 numbers);
# a real run still keeps --max-delete below as a second, redundant fence
# in case the tree changes between the pre-flight and the real transfer.
PREFLIGHT_ARGS=(-a -n --delete --itemize-changes)
[ "$DRY_RUN" -eq 1 ] && PREFLIGHT_ARGS+=(--stats)

PREFLIGHT_OUT="$(rsync "${PREFLIGHT_ARGS[@]}" "${RSYNC_FILTERS[@]}" "$DEV_DIR/" "$MIRROR_DEST/" 2>&1)"
PREFLIGHT_RC=$?

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$PREFLIGHT_OUT"
fi

if [ "$PREFLIGHT_RC" -ne 0 ]; then
  echo "FATAL: rsync pre-flight exited $PREFLIGHT_RC — refusing, nothing deleted" >&2
  FAIL_REASON="rsync pre-flight exited $PREFLIGHT_RC, nothing deleted"; FAIL_CAUSE="preflight: $(error_class "$PREFLIGHT_OUT")"
  exit 1
fi

DELETE_TOTAL="$(printf '%s\n' "$PREFLIGHT_OUT" | grep -c '^\*deleting')"
# Git's own store churn (see the header) is excluded from the refusal count.
DELETE_COUNT="$(printf '%s\n' "$PREFLIGHT_OUT" | grep '^\*deleting' | grep -vc '/\.git/')"
if [ "$DELETE_COUNT" -ge "$MAX_DELETE" ]; then
  echo "FATAL: pre-flight would delete $DELETE_COUNT files (>= MAX_DELETE=$MAX_DELETE) — refusing the whole run, nothing deleted" >&2
  FAIL_REASON="pre-flight would delete $DELETE_COUNT files (limit $MAX_DELETE), nothing deleted"; FAIL_CAUSE="delete-guard"
  exit 1
fi

SUMMARY_DELETED="$DELETE_TOTAL"

if [ "$DRY_RUN" -eq 1 ]; then
  SUMMARY_FILES="$(printf '%s\n' "$PREFLIGHT_OUT" | awk -F': ' '/^Number of files transferred:/{print $2}')"
  exit 0
fi

# --stats is added here (never printed on success — only the one summary
# line above is) purely so the liveness line can report a file count
# without a second rsync invocation.
# Evicted basis files (see the header): unlink every mirror copy the transfer
# is about to UPDATE (`>f` without `+`, so the copy exists) when it is
# dataless, so rsync writes it fresh instead of mmapping a placeholder.
while IFS= read -r line; do
  case "$line" in
    '>f+'*) continue ;;
    '>f'*) rel="${line#* }" ;;
    *) continue ;;
  esac
  dest="$MIRROR_DEST/$rel"
  if [ -f "$dest" ] && is_dataless "$dest"; then
    rm -f "$dest" && EVICTED_REPLACED=$((EVICTED_REPLACED + 1))
  fi
done <<< "$PREFLIGHT_OUT"

REAL_MAX_DELETE=$((DELETE_TOTAL + MAX_DELETE))
REAL_OUT="$(rsync -a --delete --max-delete="$REAL_MAX_DELETE" --stats "${RSYNC_FILTERS[@]}" "$DEV_DIR/" "$MIRROR_DEST/" 2>&1)"
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "FATAL: rsync exited $RC (--max-delete=$REAL_MAX_DELETE hit, or a transfer error)" >&2
  printf '%s\n' "$REAL_OUT" >&2
  FAIL_REASON="rsync exited $RC (delete limit hit, or a transfer error)"; FAIL_CAUSE="transfer: $(error_class "$REAL_OUT")"
  exit 1
fi

SUMMARY_FILES="$(printf '%s\n' "$REAL_OUT" | awk -F': ' '/^Number of files transferred:/{print $2}')"
exit 0
