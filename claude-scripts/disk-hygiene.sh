#!/usr/bin/env bash
# disk-hygiene.sh
#
# Deterministic, idempotent, retention-driven disk-hygiene sweep for
# ~/.claude. No model involved. Read-only by default: `plan` mode only
# prints what would happen. `apply` mode performs the AUTO tier
# unconditionally and the CONFIRM tier only for the categories whose
# --yes-* flag is passed.
#
# Usage:
#   disk-hygiene.sh [plan|apply] [--yes-projects] [--yes-plugins]
#
# Output format (one action per line, tab-separated):
#   <VERB>\t<path>\t<reason>
# VERB is DELETE, ARCHIVE (reason carries the destination as "-> <dest>"),
# or REPORT. Lines are grouped under "# <category>" comment lines. The
# final line is always:
#   SUMMARY actions=<n> auto=<n> confirm=<n>
# A clean tree prints only that SUMMARY line, with actions=0.
#
# Safety: every path this script deletes/archives is built from $ROOT (the
# canonicalized root directory) and validated by assert_under_root before
# any filesystem mutation. The script refuses to run at all if
# $CLAUDE_DIR/settings.json is missing (guards against a mistyped root).
set -euo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

# ---------------------------------------------------------------------------
# Retention constants -- this table is authoritative (verified in a prior
# task). Do not restate these numbers elsewhere (e.g. in commands/cleanup.md)
# -- they will drift. Change them here only.
# ---------------------------------------------------------------------------
SESSION_ENV_DAYS=7      # session-env/ entries older than this are deleted
FILE_HISTORY_DAYS=30    # file-history/ entries older than this are deleted
PASTE_CACHE_DAYS=14     # paste-cache/ entries older than this are deleted
TASKS_DAYS=7            # tasks/ entries older than this are deleted.
                        # This is a TIME WINDOW, not a liveness check: no
                        # .lock is ever held by a running process, so a
                        # "keep entries with a live session" rule would
                        # delete everything.
BACKUPS_KEEP=2          # backups/ -- keep the newest N *.claude.json.backup.*
                        # files (see the two traps documented in do_backups).
SHELL_SNAPSHOTS_KEEP=1  # shell-snapshots/ -- keep the newest N, PLUS any
                        # snapshot protected by the liveness guard (see
                        # oldest_claude_cli_start_epoch).
PLANS_ARCHIVE_DAYS=21   # plans/*.md older than this are ARCHIVEd, never
                        # deleted. Owner decision: 21 days, matching the
                        # one-off catch-up that first flattened plans/.
                        # The HOLD list below is what keeps long-running
                        # working documents alive past the cutoff.

# Plans that are live working documents regardless of age -- never archived.
PLANS_HOLD_PATTERNS=(
  "*master-plan.md"
  "*fresh-eyes*"
  "*progress-A.md"
  "*progress-B.md"
)

MODE="plan"
YES_PROJECTS="false"
YES_PLUGINS="false"

usage() {
  echo "Usage: $(basename "$0") [plan|apply] [--yes-projects] [--yes-plugins]" >&2
}

for arg in "$@"; do
  case "$arg" in
    plan|apply) MODE="$arg" ;;
    --yes-projects) YES_PROJECTS="true" ;;
    --yes-plugins) YES_PLUGINS="true" ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ ! -f "$CLAUDE_DIR/settings.json" ]; then
  echo "Error: $CLAUDE_DIR/settings.json not found -- refusing to run (this guards against a mistyped CLAUDE_DIR root)" >&2
  exit 1
fi

# Canonical root. Every path this script constructs below is built from
# $ROOT (never from the raw, possibly-relative $CLAUDE_DIR), so a plain
# string-prefix check in assert_under_root is sufficient and does not
# depend on the target already existing on disk.
ROOT="$(cd "$CLAUDE_DIR" && pwd -P)"

ACTIONS=0
AUTO_COUNT=0
CONFIRM_COUNT=0
CURRENT_CATEGORY=""
CATEGORY_HEADER_PRINTED="false"

assert_under_root() {
  local target="$1"
  case "$target" in
    "$ROOT"/*) ;;
    *)
      echo "Error: refusing to act outside root: $target" >&2
      exit 1
      ;;
  esac
}

category_start() {
  CURRENT_CATEGORY="$1"
  CATEGORY_HEADER_PRINTED="false"
}

# Prints a non-action comment line inside the current category, emitting
# the category header first if this is the category's first output.
print_comment() {
  if [ "$CATEGORY_HEADER_PRINTED" = "false" ]; then
    echo "# $CURRENT_CATEGORY"
    CATEGORY_HEADER_PRINTED="true"
  fi
  echo "# $1"
}

# emit VERB PATH REASON TIER  (TIER is "auto" or "confirm")
emit() {
  local verb="$1" path="$2" reason="$3" tier="$4"
  if [ "$CATEGORY_HEADER_PRINTED" = "false" ]; then
    echo "# $CURRENT_CATEGORY"
    CATEGORY_HEADER_PRINTED="true"
  fi
  printf '%s\t%s\t%s\n' "$verb" "$path" "$reason"
  ACTIONS=$((ACTIONS + 1))
  if [ "$tier" = "auto" ]; then
    AUTO_COUNT=$((AUTO_COUNT + 1))
  else
    CONFIRM_COUNT=$((CONFIRM_COUNT + 1))
  fi
}

# ---------------------------------------------------------------------------
# AUTO tier -- ephemeral state, applied without confirmation
# ---------------------------------------------------------------------------

do_telemetry() {
  category_start "telemetry"
  local dir="$ROOT/telemetry"
  [ -d "$dir" ] || return 0
  # "delete ALL files" is read literally: recursive, files only (a stray
  # empty subdirectory left behind is not this category's concern).
  local f
  while IFS= read -r -d '' f; do
    emit "DELETE" "$f" "telemetry spool entry (no retention stated -- delete all)" "auto"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$f"
      rm -f -- "$f"
    fi
  done < <(find "$dir" -type f -print0 | sort -z)
}

do_debug() {
  category_start "debug"
  local dir="$ROOT/debug"
  [ -d "$dir" ] || return 0

  local latest_target=""
  if [ -L "$dir/latest" ]; then
    local raw_target
    raw_target="$(readlink "$dir/latest")"
    case "$raw_target" in
      /*) latest_target="$raw_target" ;;
      *) latest_target="$dir/$raw_target" ;;
    esac
  fi

  local f base
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    [ "$base" = "latest" ] && continue
    if [ -n "$latest_target" ] && [ "$f" = "$latest_target" ]; then
      continue
    fi
    emit "DELETE" "$f" "stale debug log (keeping latest and its symlink target)" "auto"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$f"
      rm -f -- "$f"
    fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -name '*.txt' -print0 | sort -z)
}

# Converts a ps `etime` value ([[DD-]HH:]MM:SS) to whole seconds.
etime_to_seconds() {
  local raw="$1" days=0 rest
  if [[ "$raw" == *-* ]]; then
    days="${raw%%-*}"
    rest="${raw#*-}"
  else
    rest="$raw"
  fi
  local IFS=':'
  local -a parts
  read -ra parts <<< "$rest"
  local h=0 m=0 s=0
  case "${#parts[@]}" in
    3) h="${parts[0]}"; m="${parts[1]}"; s="${parts[2]}" ;;
    2) m="${parts[0]}"; s="${parts[1]}" ;;
    1) s="${parts[0]}" ;;
  esac
  printf '%s' $(( 10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s ))
}

# Prints the epoch start time of the OLDEST currently-running CLI `claude`
# process (matching commands that ARE "claude" or BEGIN WITH "claude "),
# or nothing if none is running.
#
# NOTE ON SPEC DEVIATION: the plan called for deriving this from
# `ps -Ao etimes=,args=` (elapsed seconds). macOS's BSD ps has no `etimes`
# keyword at all -- only `etime` (the [[DD-]HH:]MM:SS format) is supported
# on this machine (verified: `ps -Ao etimes=,args=` errors with
# "ps: etimes: keyword not found"). This parses `etime` and derives seconds
# itself instead. The GUI app helpers under /Applications/Claude.app are
# excluded implicitly: their command lines start with an absolute path, so
# they never match "claude" or "claude "-prefixed commands.
oldest_claude_cli_start_epoch() {
  local now oldest="" line etime cmd elapsed start
  now="$(date +%s)"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    etime="${line%% *}"
    cmd="${line#* }"
    case "$cmd" in
      claude|"claude "*) : ;;
      *) continue ;;
    esac
    elapsed="$(etime_to_seconds "$etime")"
    start=$((now - elapsed))
    if [ -z "$oldest" ] || [ "$start" -lt "$oldest" ]; then
      oldest="$start"
    fi
  done < <(ps -Ao etime=,args= 2>/dev/null | sed -E 's/^[[:space:]]+//')
  printf '%s' "$oldest"
}

do_shell_snapshots() {
  category_start "shell-snapshots"
  local dir="$ROOT/shell-snapshots"
  [ -d "$dir" ] || return 0

  local guard_epoch
  guard_epoch="$(oldest_claude_cli_start_epoch)"

  # TRAP (macOS): `/bin/ls -t` does NOT list dotfiles. This category's
  # files aren't dotfiles, but the same "glob explicitly, sort by mtime
  # ourselves" discipline is applied here (see do_backups for the category
  # where this trap actually bites).
  local listing f
  listing="$(
    while IFS= read -r -d '' f; do
      printf '%s\t%s\n' "$(stat -f %m "$f")" "$f"
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -print0)
  )"
  [ -z "$listing" ] && return 0

  local sorted idx=0 mtime
  sorted="$(printf '%s\n' "$listing" | sort -t "$(printf '\t')" -k1,1nr)"
  while IFS=$'\t' read -r mtime f; do
    idx=$((idx + 1))
    if [ "$idx" -le "$SHELL_SNAPSHOTS_KEEP" ]; then
      continue
    fi
    # Liveness guard: every running CLI session sources its own snapshot on
    # every shell call, so deleting a live one breaks that session. Protect
    # any snapshot at or after the oldest running CLI process's start time.
    # Inert (guard_epoch empty) if no CLI process is running.
    if [ -n "$guard_epoch" ] && [ "$mtime" -ge "$guard_epoch" ]; then
      continue
    fi
    emit "DELETE" "$f" "stale shell snapshot (keeping newest $SHELL_SNAPSHOTS_KEEP + any live session's)" "auto"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$f"
      rm -f -- "$f"
    fi
  done <<< "$sorted"
}

# Generic "entries (files or dirs) older than N days" sweep, used for
# session-env/, file-history/, paste-cache/, and tasks/.
do_older_than() {
  local category="$1" dir="$2" days="$3"
  category_start "$category"
  [ -d "$dir" ] || return 0
  local entry
  while IFS= read -r -d '' entry; do
    emit "DELETE" "$entry" "older than ${days}d" "auto"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$entry"
      rm -rf -- "$entry"
    fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 \( -type f -o -type d \) -mtime "+$days" -print0 | sort -z)
}

do_backups() {
  category_start "backups"
  local dir="$ROOT/backups"
  [ -d "$dir" ] || return 0

  # TRAP (a): backups/ is a LIVE ROLLING BUFFER. The app writes new backup
  # files and rotates old ones away *during* a sweep. "Newest N" is a
  # sweep-time invariant, never a steady state -- so this glob is
  # re-evaluated fresh right here, at the moment this function runs
  # (never from a list captured during an earlier `plan` invocation). A
  # plan/apply diff on this category is expected, not a bug.
  #
  # TRAP (b): `/bin/ls -t` does NOT list dotfiles, and these files are
  # named `.claude.json.backup.*` -- so the obvious `ls -t | tail -n +3`
  # is a silent no-op. Glob `.claude.json.backup.*` explicitly and sort by
  # mtime ourselves.
  local listing f
  listing="$(
    while IFS= read -r -d '' f; do
      printf '%s\t%s\n' "$(stat -f %m "$f")" "$f"
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -name '.claude.json.backup.*' -print0)
  )"
  [ -z "$listing" ] && return 0

  local sorted idx=0 mtime
  sorted="$(printf '%s\n' "$listing" | sort -t "$(printf '\t')" -k1,1nr)"
  while IFS=$'\t' read -r mtime f; do
    idx=$((idx + 1))
    [ "$idx" -le "$BACKUPS_KEEP" ] && continue
    emit "DELETE" "$f" "old backup (keeping newest $BACKUPS_KEEP)" "auto"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$f"
      rm -f -- "$f"
    fi
  done <<< "$sorted"
}

do_changelog() {
  category_start "changelog"
  local f="$ROOT/cache/changelog.md"
  [ -f "$f" ] || return 0
  emit "DELETE" "$f" "regenerable cache file" "auto"
  if [ "$MODE" = "apply" ]; then
    assert_under_root "$f"
    rm -f -- "$f"
  fi
}

is_plans_hold() {
  local name="$1" pattern
  for pattern in "${PLANS_HOLD_PATTERNS[@]}"; do
    case "$name" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

do_plans_archive() {
  category_start "plans"
  local dir="$ROOT/plans"
  [ -d "$dir" ] || return 0
  # AUTO tier, but never deletes. Never touches anything already under
  # plans/archive/ (find is -maxdepth 1 here, so it never recurses into
  # the archive/ subdirectory).
  local f base year dest
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    is_plans_hold "$base" && continue
    if [[ "$base" =~ ^([0-9]{4})-[0-9]{2}-[0-9]{2}- ]]; then
      year="${BASH_REMATCH[1]}"
    else
      year="$(date -r "$(stat -f %m "$f")" +%Y)"
    fi
    dest="$dir/archive/$year"
    emit "ARCHIVE" "$f" "older than ${PLANS_ARCHIVE_DAYS}d -> $dest/$base" "auto"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$f"
      assert_under_root "$dest"
      mkdir -p -- "$dest"
      mv -- "$f" "$dest/$base"
    fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -name '*.md' -mtime "+$PLANS_ARCHIVE_DAYS" -print0 | sort -z)
}

# ---------------------------------------------------------------------------
# CONFIRM tier -- reported in `plan`, applied only behind a flag
# ---------------------------------------------------------------------------

# Replaces every non-alphanumeric character with "-", one for one (no run
# collapsing). Used both to forward-encode a live path AND to normalize an
# existing projects/ directory name before comparing -- this is required
# because the encoding scheme changed between CLI versions: some dirs
# encode "." as "-", others keep the literal ".". Applying this same
# character-wise transform to both sides makes them comparable regardless
# of which scheme produced the on-disk name.
normalize_encode() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'
}

# Candidate live paths, encoded forward from reality (never by decoding a
# projects/ dir name, which is lossy): ~/.claude, ~/Dev, every immediate
# subdirectory of ~/Dev, and every worktree path reported by
# `git worktree list --porcelain` run inside each git repo under ~/Dev.
collect_live_project_paths() {
  printf '%s\n' "$HOME/.claude"
  printf '%s\n' "$HOME/Dev"
  local sub
  while IFS= read -r -d '' sub; do
    printf '%s\n' "$sub"
    if git -C "$sub" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git -C "$sub" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}'
    fi
  done < <(find "$HOME/Dev" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
}

do_projects() {
  # Only compute/report this category in plan mode, or in apply mode when
  # its flag was passed -- an unset flag means this category is not
  # performed at all, so it prints nothing.
  if [ "$MODE" = "apply" ] && [ "$YES_PROJECTS" != "true" ]; then
    return 0
  fi
  category_start "projects"
  local dir="$ROOT/projects"
  [ -d "$dir" ] || return 0

  local live_encoded
  live_encoded="$(collect_live_project_paths | while IFS= read -r p; do printf '%s\n' "$(normalize_encode "$p")"; done | sort -u)"

  local entry base norm
  while IFS= read -r -d '' entry; do
    base="$(basename "$entry")"
    norm="$(normalize_encode "$base")"
    if printf '%s\n' "$live_encoded" | grep -Fxq -- "$norm"; then
      continue
    fi
    emit "DELETE" "$entry" "stale transcript dir (no matching live path)" "confirm"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$entry"
      rm -rf -- "$entry"
    fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
}

do_plugins() {
  if [ "$MODE" = "apply" ] && [ "$YES_PLUGINS" != "true" ]; then
    return 0
  fi
  category_start "plugins"
  local plugins_dir="$ROOT/plugins"
  [ -d "$plugins_dir" ] || return 0

  # plugins/cache/temp_git_* -- safe to delete.
  local entry
  while IFS= read -r -d '' entry; do
    emit "DELETE" "$entry" "stale plugin cache temp dir" "confirm"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$entry"
      rm -rf -- "$entry"
    fi
  done < <(find "$plugins_dir/cache" -mindepth 1 -maxdepth 1 -type d -name 'temp_git_*' -print0 2>/dev/null | sort -z)

  # Directory names containing whitespace anywhere under plugins/.
  while IFS= read -r -d '' entry; do
    emit "DELETE" "$entry" "plugin directory name contains whitespace" "confirm"
    if [ "$MODE" = "apply" ]; then
      assert_under_root "$entry"
      rm -rf -- "$entry"
    fi
  done < <(find "$plugins_dir" -type d -name '* *' -print0 2>/dev/null | sort -z)

  # Marketplaces with no enabled plugin -- REPORT only, NEVER delete.
  # Deleting the marketplace directory alone does not work:
  # plugins/known_marketplaces.json re-clones it on the next session; it
  # must be deregistered through the CLI first. Never report
  # claude-plugins-official: it is a hardcoded built-in.
  local marketplaces_dir="$plugins_dir/marketplaces"
  if [ -d "$marketplaces_dir" ]; then
    local real_claude_dir=""
    real_claude_dir="$(cd "$HOME/.claude" 2>/dev/null && pwd -P)" || real_claude_dir=""
    if ! command -v claude >/dev/null 2>&1 || [ "$ROOT" != "$real_claude_dir" ]; then
      print_comment "skipped marketplace enabled-plugin check: requires the claude CLI and the real ~/.claude"
    else
      local enabled_marketplaces
      enabled_marketplaces="$(
        claude plugin list 2>/dev/null | awk '
          /❯/ { line=$0; sub(/^.*❯[[:space:]]*/,"",line); current=line }
          /Status:/ && /enabled/ { print current }
        ' | sed -E 's/.*@//'
      )"
      local mdir mname
      while IFS= read -r -d '' mdir; do
        mname="$(basename "$mdir")"
        [ "$mname" = "claude-plugins-official" ] && continue
        if printf '%s\n' "$enabled_marketplaces" | grep -Fxq -- "$mname"; then
          continue
        fi
        emit "REPORT" "$mdir" "no enabled plugin -> run: claude plugin marketplace remove $mname (then delete)" "confirm"
      done < <(find "$marketplaces_dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
    fi
  fi
}

main() {
  do_telemetry
  do_debug
  do_shell_snapshots
  do_older_than "session-env" "$ROOT/session-env" "$SESSION_ENV_DAYS"
  do_backups
  do_older_than "file-history" "$ROOT/file-history" "$FILE_HISTORY_DAYS"
  do_older_than "paste-cache" "$ROOT/paste-cache" "$PASTE_CACHE_DAYS"
  do_older_than "tasks" "$ROOT/tasks" "$TASKS_DAYS"
  do_changelog
  do_plans_archive
  do_projects
  do_plugins

  echo "SUMMARY actions=$ACTIONS auto=$AUTO_COUNT confirm=$CONFIRM_COUNT"
}

main
