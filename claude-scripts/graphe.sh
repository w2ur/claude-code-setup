#!/usr/bin/env bash
# graphe.sh — weekly build of the writings graph (my-editor-app/tools/graphe/graphe.py).
#
# Run by the LaunchAgent com.example.graphe, never by cron: graphe.py calls
# `claude -p` (OAuth in the login keychain) and reads the Google Drive File
# Provider mount (GUI session only).
#
# MAX_EXTRACTIONS_PAR_PASSAGE: an unattended run must be cost-bounded, and this
# script owns the number. A backlog shows up as `differes` in the journal and
# drains over the following weeks.
#
# Exit codes follow the portfolio convention: 0 healthy, 1 a finding, 2 could
# not run (unknown). Only 1 and 2 notify; the notifier topic is PUBLIC, so the
# body is the last journal lines (counts only) and never a path or a citation.
# Every run ends with one timestamped summary line, so the log's age is a
# liveness signal.
#
# The first build is the owner's, never this agent's: it is run by hand, with its
# extraction count capped by the owner, repeated until the journal says
# `differes: 0` (a capped run that defers sources skips publication), and leaves
# $ETAT/publie.json behind once it has published. Until
# that file exists the script refuses to run (exit 2, one notification, nothing
# journalled, the tool never launched): the LaunchAgent is loaded before that
# first build, and an unattended first pass would extract and publish on its own.
#
# The notification body is the last journal line only when that line is this
# run's (its `.exit` equals the raw rc); otherwise it is « journal non écrit »,
# never a stale line from an earlier run.
#
# Test overrides: GRAPHE_DRIVE, GRAPHE_ETAT, GRAPHE_COFFRE, GRAPHE_TOOL, GRAPHE_NOTIFIER.
#
# Any code other than 0 or 1 (126/127 missing binary, 137/143 signal) is
# normalised to 2 = unknown, so it notifies; the raw code stays in the summary.
set -euo pipefail

MAX_EXTRACTIONS_PAR_PASSAGE=30

export PATH="/Users/{username}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"

DRIVE="${GRAPHE_DRIVE:-/Users/{username}/Library/CloudStorage/{email}/Drive/{private-workspace}}"
ETAT="${GRAPHE_ETAT:-/Users/{username}/.claude/state/graphe}"
COFFRE="${GRAPHE_COFFRE:-/Users/{username}/Library/Mobile Documents/iCloud~md~obsidian/Documents/écrits}"
TOOL="${GRAPHE_TOOL:-/Users/{username}/Dev/my-editor-app/tools/graphe/graphe.py}"
NOTIFIER="${GRAPHE_NOTIFIER:-/Users/{username}/.claude/scripts/notifier.sh}"
JOURNAL="$ETAT/journal.jsonl"

# notify <title> <body text>: the notifier reads its body from a file.
notify() {
  local f
  f="$(mktemp 2>/dev/null)" || { echo "mktemp failed, no notification" >&2; return 0; }
  printf '%s\n' "$2" > "$f" 2>/dev/null || true
  "$NOTIFIER" "$1" "$f" || echo "notifier failed: $?" >&2
  rm -f "$f"
}

if [ ! -f "$ETAT/publie.json" ]; then
  echo "première construction pas faite" >&2
  notify "graphe: exit 2" "première construction pas faite"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) graphe exit 2 (première construction pas faite)"
  exit 2
fi

rc=0
"$TOOL" --drive "$DRIVE" --etat "$ETAT" --coffre "$COFFRE" \
  --max-extractions "$MAX_EXTRACTIONS_PAR_PASSAGE" || rc=$?

raw=$rc
[ "$rc" -le 1 ] || rc=2

if [ "$rc" -ne 0 ]; then
  derniere=""
  [ -f "$JOURNAL" ] && derniere="$(tail -n 1 "$JOURNAL" 2>/dev/null)" || true
  if [ -z "$derniere" ]; then
    corps="journal non écrit"
  elif ! exit_journal="$(printf '%s' "$derniere" | /usr/bin/jq -er '.exit' 2>/dev/null)"; then
    corps="journal illisible"
  elif [ "$exit_journal" != "$raw" ]; then
    corps="journal non écrit"
  else
    # Counts only: the topic is public, so never a slug, title or path.
    corps="$(printf '%s' "$derniere" | /usr/bin/jq -c \
      '{date, sources, extraits_neufs, differes, noeuds, liens, isoles, exit, echecs: (.echecs // [] | length), introuvables: (.introuvables // 0), publication, fiction: (.fiction // 0), fiction_construites: (.fiction_construites // 0), publication_partielle: (.publication_partielle // false), raison: (.raison // null)}' \
      2>/dev/null)" || corps="journal illisible"
    [ -n "$corps" ] || corps="journal illisible"
  fi
  notify "graphe: exit $rc" "$corps"
fi

if [ "$raw" -ne "$rc" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) graphe exit $rc (rc brut $raw)"
else
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) graphe exit $rc"
fi
exit "$rc"
