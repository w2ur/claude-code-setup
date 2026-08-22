#!/usr/bin/env bash
# Derives the scheduled-job inventory from the plists themselves.
#
# This file exists because the inventory used to be hand-typed prose in
# ~/.claude/CLAUDE.md — 37 KB of it, loaded into every single session, and it
# drifted three separate times ("eighteen scripts" when there were nineteen,
# "Eight plugins" when ten were enabled, a plist count written from memory).
# A number written from memory reads exactly like a number that was counted.
#
# Same principle as build-inventory.mjs observing the portfolio, gate-watch.sh
# discovering repos from `gh search prs`, and model-watch.sh discovering models
# from wrangler.toml: nothing hand-typed, so nothing can go stale. The REASONS
# each job exists — why 05:57 and not 06:00, why vigie-serve must not refresh,
# why midas-ohlcv-bridge must never be kickstarted — are judgment and cannot be
# derived; they live in the `scheduled-jobs` skill, loaded only when relevant.
#
# Reports state. Never loads, unloads, kickstarts or edits a plist: this runs
# unattended-adjacent, and midas-ohlcv-bridge pushes to a remote.
#
# LAUNCH_AGENTS_DIR redirects the tree so this can be tested against a fixture.
#
# Exit 0 = every agent healthy. Exit 1 = a finding (an agent's last run exited
# non-zero, or its log is older than its schedule implies). Exit 2 = could not
# run, which must be read as UNKNOWN and never as "no agents are scheduled" —
# an empty glob is indistinguishable from a wiped LaunchAgents directory.

set -uo pipefail

LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PREFIX="${JOBS_PREFIX:-com.example.}"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

command -v plutil >/dev/null 2>&1 || { echo "FATAL: plutil not found" >&2; exit 2; }
command -v jq     >/dev/null 2>&1 || { echo "FATAL: jq not found" >&2; exit 2; }

[ -d "$LAUNCH_AGENTS_DIR" ] || {
  echo "FATAL: $LAUNCH_AGENTS_DIR is not a directory — inventory UNKNOWN, not empty" >&2
  exit 2
}

shopt -s nullglob
plists=("$LAUNCH_AGENTS_DIR/$PREFIX"*.plist)
shopt -u nullglob

[ "${#plists[@]}" -gt 0 ] || {
  echo "FATAL: no $PREFIX*.plist under $LAUNCH_AGENTS_DIR — UNKNOWN, not healthy" >&2
  exit 2
}

# Human-readable schedule from StartCalendarInterval / RunAtLoad+KeepAlive.
schedule_of() {
  jq -r '
    def dow: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][.];
    def one: "\(if .Weekday   != null then (.Weekday|dow)  + " "  else "" end)"
           + "\(if .Day       != null then "day \(.Day) "         else "" end)"
           + "\(if .Hour      != null then "\(.Hour)"             else "*" end)"
           + ":\(if .Minute   != null then (.Minute|tostring|if length==1 then "0"+. else . end) else "**" end)";
    if (.RunAtLoad == true and .KeepAlive == true) then "at login, kept alive"
    elif (.StartCalendarInterval|type) == "array"  then [.StartCalendarInterval[]|one]|join(", ")
    elif (.StartCalendarInterval|type) == "object" then (.StartCalendarInterval|one)
    elif (.StartInterval != null)                  then "every \(.StartInterval)s"
    else "no trigger" end' <<<"$1"
}

findings=0
rows=""

for p in "${plists[@]}"; do
  j=$(plutil -convert json -o - "$p" 2>/dev/null) || { echo "WARN: unreadable $p" >&2; continue; }

  label=$(jq -r '.Label // "?"'                       <<<"$j")
  prog=$(jq -r '(.ProgramArguments // [.Program])|join(" ")' <<<"$j")
  log=$(jq -r '.StandardOutPath // ""'                <<<"$j")
  sched=$(schedule_of "$j")

  # Log age. A never-written log is not a healthy log.
  if [ -n "$log" ] && [ -f "$log" ]; then
    age=$(( ( $(date +%s) - $(stat -f %m "$log") ) / 86400 ))
    logstate="${age}d"
  elif [ -n "$log" ]; then
    logstate="NEVER WRITTEN"; findings=$((findings+1))
  else
    logstate="no log configured"
  fi

  # Last exit status, when launchd still remembers it.
  last=$(launchctl print "gui/$UID/$label" 2>/dev/null \
         | awk -F'= *' '/last exit code/{print $2; exit}' | sed 's/^ *//;s/ *$//')
  last="${last:--}"
  keep=$(jq -r '.KeepAlive == true' <<<"$j")
  # A KeepAlive daemon cycled by launchd exits 143 (SIGTERM). Normal, not a finding.
  case "$last" in
    0|-|"(never exited)") ;;
    143) [ "$keep" = "true" ] || findings=$((findings+1)) ;;
    *) findings=$((findings+1)) ;;
  esac

  rows+=$(jq -nc --arg l "$label" --arg s "$sched" --arg p "$prog" \
                 --arg g "$log" --arg a "$logstate" --arg e "$last" \
            '{label:$l,schedule:$s,program:$p,log:$g,log_age:$a,last_exit:$e}')$'\n'
done

if [ "$JSON" -eq 1 ]; then
  printf '%s' "$rows" | jq -s '.'
else
  printf '%-34s %-22s %-16s %s\n' LABEL SCHEDULE LOG EXIT
  printf '%s' "$rows" | jq -r '"\(.label)\t\(.schedule)\t\(.log_age)\t\(.last_exit)"' \
    | awk -F'\t' '{printf "%-34s %-22s %-16s %s\n",$1,$2,$3,$4}'
  printf '\n%d agents, %d findings\n' "${#plists[@]}" "$findings"
fi

[ "$findings" -gt 0 ] && exit 1
exit 0
