#!/usr/bin/env bash
# intendant.sh — what needs a human today, and nothing else.
#
# vigie is a panel you OPEN: 17 sources, everything, always.
# intendant is an address you ASK: only the items requiring a decision.
# Same data, different consumer — so the data stays in vigie and this only reads it.
#
# THE ACCOUNTABILITY MECHANISM, and the reason this is worth a script at all:
# a source that cannot be read renders `SIGNAL LOST: <name>` and NEVER an empty
# section. An aggregator that silently drops a dead input manufactures "all clear",
# which is the failure this portfolio has already recorded three times: gate-watch
# on an unauthenticated `gh` (zero rows == "no repo has PRs"), vigie's fresh
# snapshot behind a frozen dist/, and a CI gate whose `jq all()` over an empty set
# returned true. The queue getting SHORTER when an input dies is the bug.
#
# Reports state. Never edits, never dispatches, never opens a PR.
#
# Exit: 0 nothing to do · 1 the queue is non-empty (a finding) · 2 at least one
# source could not be read = *unknown*, never "all clear". Partial-unknown counts
# as 2 even when the rest ran: part of the sweep is unknown, the rest ran.
#
# CLAUDE_DIR / DEV_DIR and each source's own *_STATE var redirect it at a fixture.

set -uo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
DEV_DIR="${DEV_DIR:-$HOME/Dev}"
SNAPSHOT="${VIGIE_SNAPSHOT:-$DEV_DIR/vigie/src/data/snapshot.json}"
JOBS="${JOBS_INVENTORY:-$CLAUDE_DIR/scripts/jobs-inventory.sh}"

JSON=0; NOTIFY=0
case "${1:-}" in
  --json)   JSON=1 ;;
  --notify) NOTIFY=1 ;;
esac
NOTIFIER="${NOTIFIER_BIN:-$CLAUDE_DIR/scripts/notifier.sh}"
TODAY=$(date -u +%Y-%m-%d)

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq not found — UNKNOWN, not clear" >&2; exit 2; }

ITEMS='[]'   # [{source,severity,text}]
SRC='{}'     # {name:{ok,reason}}

add_item() { # source severity text
  ITEMS=$(jq -c --arg s "$1" --arg v "$2" --arg t "$3" \
    '. + [{source:$s,severity:$v,text:$t}]' <<<"$ITEMS")
}
mark() { # name ok reason
  SRC=$(jq -c --arg n "$1" --argjson ok "$2" --arg r "${3:-}" \
    '.[$n] = {ok:$ok, reason:$r}' <<<"$SRC")
}

# ── vigie snapshot ──────────────────────────────────────────────────────────
if [ -r "$SNAPSHOT" ] && jq -e . "$SNAPSHOT" >/dev/null 2>&1; then
  mark vigie true
  n=$(jq -r '.data.gatewatch.missing // 0' "$SNAPSHOT")
  [ "$n" -gt 0 ] 2>/dev/null && add_item vigie act "$n repo(s) have PR traffic but no CI gate — /tech-debt"
  n=$(jq -r '[.data.envdrift[]?|(.undocumented//{})|keys[]?]|length' "$SNAPSHOT")
  [ "$n" -gt 0 ] 2>/dev/null && add_item vigie act "$n env var(s) documented nowhere — see vigie envdrift band"
  n=$(jq -r '[.data.plans.plans[]?|select((.held|not) and .days_until_archive<=0)]|length' "$SNAPSHOT")
  [ "$n" -gt 0 ] 2>/dev/null && add_item vigie act "$n plan(s) past the archive cutoff and not held — /cleanup"
  n=$(jq -r '[.sources|to_entries[]|select(.value.ok==false)]|length' "$SNAPSHOT")
  [ "$n" -gt 0 ] 2>/dev/null && add_item vigie warn "$n of vigie's own collectors are down — its panel is partial"
else
  mark vigie false "unreadable: $SNAPSHOT"
fi

# ── scheduled jobs ──────────────────────────────────────────────────────────
# jobs-inventory.sh exits 1 when it HAS a finding and still prints valid JSON.
# Treating non-zero as unreadable is wrong here — 0 and 1 both mean it ran.
# Only 2 (could not run) is genuinely unknown. Same shape as vigie's
# runAllowing([1]) for the gatewatch collector.
J=""; JRC=9
if [ -x "$JOBS" ]; then J=$("$JOBS" --json 2>/dev/null); JRC=$?; fi
if { [ "$JRC" = 0 ] || [ "$JRC" = 1 ]; } && jq -e . <<<"$J" >/dev/null 2>&1; then
  mark jobs true
  # Which exits are worth a human. NOT every non-zero:
  #   0   healthy
  #   1   a finding — the watcher already reported it through its own channel;
  #       re-surfacing here is the nagging that teaches you to skip the queue
  #   143 launchd cycling a KeepAlive job with SIGTERM (vigie-serve) — normal
  #   "(never exited)" — jobs-inventory's own wording for an agent that has not
  #       run since load. Normal for a monthly/weekly schedule, not a failure.
  #   2   could not run = *unknown*. Nobody else reports this one. It is the
  #       whole point: a job killed by its watchdog exits 2 rather than 1
  #       precisely because the outcome is ambiguous.
  # Anything outside {0,1,143} is unexpected and also surfaces.
  while IFS=$'\t' read -r label ex; do
    [ -z "$label" ] && continue
    if [ "$ex" = "2" ]; then
      add_item jobs act "scheduled job '$label' exited 2 = could not run, outcome unknown"
    else
      add_item jobs warn "scheduled job '$label' exited $ex (unexpected)"
    fi
  done < <(jq -r '.[]|(.last_exit|tostring) as $e|select(($e|test("never")|not) and ($e|test("^(0|1|143|null)$")|not))|[.label,$e]|@tsv' <<<"$J" 2>/dev/null)
else
  mark jobs false "jobs-inventory.sh exit $JRC — could not run"
fi
# ── emit ────────────────────────────────────────────────────────────────────
DOWN=$(jq -r '[to_entries[]|select(.value.ok==false)]|length' <<<"$SRC")
NITEM=$(jq -r 'length' <<<"$ITEMS")

if [ "$JSON" = 1 ]; then
  jq -n --argjson s "$SRC" --argjson i "$ITEMS" --arg g "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{generated_at:$g, sources:$s, items:$i}'
else
  echo "── intendant — $(date '+%a %d %b %H:%M') ──"
  # SIGNAL LOST first: a dead source must never look like a short queue.
  jq -r 'to_entries[]|select(.value.ok==false)|"  SIGNAL LOST: \(.key) — \(.value.reason)"' <<<"$SRC"
  if [ "$NITEM" = 0 ]; then
    [ "$DOWN" = 0 ] && echo "  nothing needs you." \
      || echo "  no items from the sources that answered — NOT an all-clear."
  else
    jq -r '.[]|"  [\(.source)] \(.text)"' <<<"$ITEMS"
  fi
fi

# --notify: push the queue through the single channel. Counts only, which the
# items already are — notifier.sh's ntfy topic is PUBLIC and redacts secrets,
# not personal data, so nothing here may carry a name or a status.
# Silence when there is nothing to say AND every source answered: a daily
# notification that always fires is one you stop reading. A SIGNAL LOST still
# notifies, because "the sweep did not run" is exactly what you need told.
if [ "$NOTIFY" = 1 ] && [ -x "$NOTIFIER" ] && { [ "$NITEM" -gt 0 ] || [ "$DOWN" -gt 0 ]; }; then
  BODY=$(mktemp); { 
    jq -r 'to_entries[]|select(.value.ok==false)|"SIGNAL LOST: \(.key)"' <<<"$SRC"
    jq -r '.[]|"[\(.source)] \(.text)"' <<<"$ITEMS"
  } > "$BODY"
  TITLE="Intendant — $NITEM item(s)"
  [ "$DOWN" -gt 0 ] && TITLE="$TITLE, $DOWN source(s) LOST"
  PRIO=default; [ "$DOWN" -gt 0 ] && PRIO=high
  "$NOTIFIER" "$TITLE" "$BODY" --priorite "$PRIO" >/dev/null 2>&1 \
    || echo "intendant: notification not delivered" >&2
  rm -f "$BODY"
fi

[ "$DOWN" -gt 0 ] && exit 2
[ "$NITEM" -gt 0 ] && exit 1
exit 0
