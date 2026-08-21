#!/bin/bash
# Run one GitHub Actions scheduled job locally, while the Actions quota is out
# (2026-08-18 → 2026-09-17). Generalises ~/.claude/scripts/midas-ohlcv-bridge.sh,
# which stays as-is: it is desk-critical and proven, and it migrates onto this
# runner only once this runner has a track record.
#
#   gha-bridge.sh <name>        run the job declared in gha-bridge.d/<name>.conf
#   gha-bridge.sh --list        list configured bridges and their state
#   gha-bridge.sh --install     write + load a LaunchAgent per bridge
#   gha-bridge.sh --uninstall   remove every bridge LaunchAgent
#
# Exit codes:
#   0 = ran, nothing wrong
#   1 = the job itself reported a finding (its own non-zero, e.g. a watchdog
#       catching a missed session) — a REAL result, not a malfunction
#   2 = could not run. UNKNOWN, never "healthy".
#
# WHY NOT act. These jobs run repo Python against a venv and then push to main.
# Under act they gain a container boundary that puts the git credential helper
# and the venv out of reach, and act cannot schedule itself, so a LaunchAgent
# is needed either way. act is for the push/PR gates (see act-local.sh); this
# is for the scheduled half.
#
# LaunchAgents, never crontab. These push over the credential helper, and a
# cron job has no access to the GUI login keychain — the same trap that made
# `claude -p` and `gh` fail silently from cron. See the CLAUDE.md rule:
# never schedule anything that reads the login keychain from crontab.

set -uo pipefail

CONFDIR="${GHA_BRIDGE_DIR:-$HOME/.claude/gha-bridge.d}"
LABEL_PREFIX="com.example.gha-bridge"
AGENTS="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/.claude"
EXPIRES_DEFAULT="2026-09-17"

# --- self-expiry -------------------------------------------------------------
# A temporary writer to main that outlives its reason is worse than the outage
# it patched. Past the reset every bridge removes ITSELF AND ALL ITS SIBLINGS,
# so one firing is enough to clean the whole set up.
expire_all() {
  echo "EXPIRED on ${1}: the Actions quota has reset. Removing every bridge agent."
  for p in "$AGENTS/${LABEL_PREFIX}."*.plist; do
    [[ -e "$p" ]] || continue
    lbl="$(basename "$p" .plist)"
    launchctl bootout "gui/$(id -u)/${lbl}" 2>/dev/null || true
    rm -f "$p"
    echo "  removed $lbl"
  done
  echo "Confirm the hosted schedules are green again before trusting them."
}

usage() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; }

# --- plist schedule helper ---------------------------------------------------
# SCHEDULE_LOCAL is "HH:MM" plus optional weekday list, e.g. "15:00" or
# "11:00 1,2,3,4,5". LOCAL time, because that is what launchd's
# StartCalendarInterval takes. Every conversion in the shipped configs is
# UTC+2: this bridge window (Aug 18 - Sep 17) sits entirely inside CEST, and
# the DST change is 2026-10-26, well after expiry. Anything surviving past that
# date must be re-derived.
emit_intervals() {
  # Several firings a day are separated by ';' — {portfolio-site} runs two
  # (06:00 and 16:00 UTC), and dropping the second would have halved the hub's
  # refresh rate silently.
  local whole="$1" spec
  local IFS_SAVE="$IFS"
  IFS=';'
  for spec in $whole; do
    IFS="$IFS_SAVE"
    emit_one_interval "${spec# }"
    IFS=';'
  done
  IFS="$IFS_SAVE"
}

emit_one_interval() {
  local spec="$1" hhmm days h m
  hhmm="${spec%% *}"; h="${hhmm%%:*}"; m="${hhmm##*:}"
  h="$((10#$h))"; m="$((10#$m))"
  if [[ "$spec" == *" "* ]]; then days="${spec#* }"; else days=""; fi
  if [[ -z "$days" ]]; then
    printf '    <dict><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n' "$h" "$m"
  else
    local IFS=,
    for d in $days; do
      printf '    <dict><key>Weekday</key><integer>%d</integer><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n' "$d" "$h" "$m"
    done
  fi
}

# --- subcommands -------------------------------------------------------------
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --list)
    printf '%-24s %-9s %-10s %s\n' NAME MODE AGENT SCHEDULE
    for c in "$CONFDIR"/*.conf; do
      [[ -e "$c" ]] || { echo "(no configs in $CONFDIR)"; exit 0; }
      ( n="$(basename "$c" .conf)"; MODE=?; SCHEDULE_LOCAL=""
        # shellcheck disable=SC1090
        . "$c"
        a="no"; [[ -e "$AGENTS/${LABEL_PREFIX}.${n}.plist" ]] && a="loaded"
        printf '%-24s %-9s %-10s %s\n' "$n" "$MODE" "$a" "${SCHEDULE_LOCAL:-–}" )
    done
    exit 0 ;;
  --uninstall)
    expire_all "$(date -u +%F) (manual)"
    exit 0 ;;
  --install)
    mkdir -p "$AGENTS"
    for c in "$CONFDIR"/*.conf; do
      [[ -e "$c" ]] || { echo "FATAL: no configs in $CONFDIR"; exit 2; }
      n="$(basename "$c" .conf)"
      SCHEDULE_LOCAL=""
      # shellcheck disable=SC1090
      . "$c"
      [[ -n "$SCHEDULE_LOCAL" ]] || { echo "skip $n: no SCHEDULE_LOCAL"; continue; }
      lbl="${LABEL_PREFIX}.${n}"; plist="$AGENTS/${lbl}.plist"
      {
        echo '<?xml version="1.0" encoding="UTF-8"?>'
        echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        echo '<plist version="1.0"><dict>'
        echo "  <key>Label</key><string>${lbl}</string>"
        echo '  <key>ProgramArguments</key><array>'
        echo '    <string>/bin/bash</string>'
        echo "    <string>${HOME}/.claude/scripts/gha-bridge.sh</string>"
        echo "    <string>${n}</string>"
        echo '  </array>'
        # fnm owns node; gh and uv are Homebrew; claude is ~/.local/bin. A
        # LaunchAgent inherits almost no PATH, and a guard that degrades to a
        # skip because a binary was merely unresolvable is the failure this
        # whole design refuses.
        echo '  <key>EnvironmentVariables</key><dict><key>PATH</key>'
        echo "  <string>${HOME}/.local/share/fnm/aliases/default/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>"
        echo '  <key>StartCalendarInterval</key>'
        echo '  <array>'
        emit_intervals "$SCHEDULE_LOCAL"
        echo '  </array>'
        echo "  <key>StandardOutPath</key><string>${LOGDIR}/gha-bridge-${n}.log</string>"
        echo "  <key>StandardErrorPath</key><string>${LOGDIR}/gha-bridge-${n}.log</string>"
        echo '</dict></plist>'
      } > "$plist"
      launchctl bootout "gui/$(id -u)/${lbl}" 2>/dev/null || true
      if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
        echo "installed ${lbl}  (${SCHEDULE_LOCAL} local)"
      else
        echo "FATAL: launchctl bootstrap failed for ${lbl}"; exit 2
      fi
    done
    exit 0 ;;
  "") usage; exit 2 ;;
esac

# --- run one bridge ----------------------------------------------------------
NAME="$1"
CONF="$CONFDIR/${NAME}.conf"
[[ -f "$CONF" ]] || { echo "FATAL: no config at $CONF"; exit 2; }

MODE=""; REPO=""; CMD=""; PATHS=""; MSG=""; RC_COMMITTABLE="0"; EXPIRES="$EXPIRES_DEFAULT"; SCHEDULE_LOCAL=""
# shellcheck disable=SC1090
. "$CONF"

echo "=== gha-bridge ${NAME} $(date -u +%FT%TZ) ==="

TODAY="$(date -u +%F)"
if [[ "$TODAY" > "$EXPIRES" || "$TODAY" == "$EXPIRES" ]]; then
  expire_all "$TODAY"; exit 0
fi

# --- guards: FATAL, never a skip --------------------------------------------
for tool in git gh; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: $tool not on PATH"; exit 2; }
done
[[ -n "$REPO" && -d "$REPO" ]] || { echo "FATAL: REPO '$REPO' is not a directory"; exit 2; }
[[ -n "$CMD" ]] || { echo "FATAL: config declares no CMD"; exit 2; }
cd "$REPO" || { echo "FATAL: cannot cd to $REPO"; exit 2; }

# --- sync --------------------------------------------------------------------
git fetch origin --quiet || { echo "FATAL: git fetch failed"; exit 2; }
if ! git merge --ff-only origin/main --quiet; then
  echo "FATAL: local main will not fast-forward (dirty tree or divergence)."
  echo "       Resolve by hand — a bridge must never merge or rebase blindly."
  exit 2
fi

# --- run ---------------------------------------------------------------------
echo "--- ${MODE}: ${CMD}"
# SUBSHELL, deliberately. `eval` runs in the CURRENT shell, so a CMD that ends
# in `exit` would terminate this runner where it stands — skipping the
# committable check, the commit and the push, while still looking like a clean
# run in the log. Caught by a control: a MODE=commit job exiting 9 produced no
# FATAL line and no commit, just silence.
( eval "$CMD" )
rc=$?
echo "command exited ${rc}"

case "$MODE" in
  check)
    # Read-only. The job's own non-zero is a FINDING about the world, not a
    # malfunction — the same distinction gate-watch.sh draws.
    #
    # EXCEPT 2, which the helpers reserve for "I could not run at all"
    # (no hook file, no checkout, no credential). Collapsing that into 1 would
    # file a could-not-check as a checked-and-found-something, which is the
    # unknown-reported-as-a-result error this convention exists to prevent.
    [[ $rc -eq 0 ]] && exit 0
    if [[ $rc -eq 2 ]]; then
      echo "UNKNOWN: ${NAME} could not run (rc=2). This is NOT a clean result and"
      echo "         must not be read as healthy."
      exit 2
    fi
    echo "FINDING: ${NAME} reported a problem (rc=${rc}). This is the job doing"
    echo "         its work, not the bridge failing. Read the log above."
    exit 1 ;;
  selfpush)
    # The script owns its own commit and push.
    exit $rc ;;
  commit)
    committable=false
    IFS=, read -r -a ok_rcs <<<"$RC_COMMITTABLE"
    for c in "${ok_rcs[@]}"; do [[ "$rc" == "$c" ]] && committable=true; done
    if ! $committable; then
      echo "FATAL: rc=${rc} is not in RC_COMMITTABLE=${RC_COMMITTABLE};"
      echo "       refusing to commit state written by a crashed run."
      exit "$rc"
    fi ;;
  *) echo "FATAL: unknown MODE '${MODE}'"; exit 2 ;;
esac

# --- commit + push (MODE=commit only) ---------------------------------------
# Absent pathspecs are filtered FIRST: `git status` exits 0 for a path that
# does not exist while `git add` exits 128, which is how fetch-ohlcv threw away
# two nights of prices in 2026-08.
present=()
for p in $PATHS; do
  if [[ -e "$p" ]] || git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    present+=("$p")
  else
    echo "Skipping '$p' — matches nothing in the worktree or the index."
  fi
done

if [[ ${#present[@]} -eq 0 ]] || [[ -z "$(git status --porcelain -- "${present[@]}")" ]]; then
  echo "No changes to commit."
  exit "$rc"
fi

git add -- "${present[@]}" || { echo "FATAL: git add failed"; exit 2; }

# [skip ci] is NOT cosmetic. my-trading-app/session-integrity fires on every push to
# main, so without it each bridge commit queues a hosted job — which fails
# while the quota is out, and bills ~1.3 min once it returns. The bridge exists
# to stop spending Actions minutes; it must not spend them on its own commits.
git commit -q -m "$(eval echo "$MSG") [skip ci]" \
  || { echo "FATAL: git commit failed"; exit 2; }

for attempt in 1 2 3; do
  if git push origin HEAD:main; then
    echo "Pushed on attempt ${attempt}."
    exit "$rc"
  fi
  [[ "$attempt" -eq 3 ]] && break
  echo "Push rejected (${attempt}/3) — rebasing."
  git pull --rebase origin main || { git rebase --abort; echo "FATAL: rebase failed"; exit 2; }
done

echo "FATAL: push to main failed after 3 attempts. The commit is local only."
exit 2
