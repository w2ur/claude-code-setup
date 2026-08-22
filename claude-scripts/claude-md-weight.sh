#!/usr/bin/env bash
# Measures the per-session cost of every CLAUDE.md on this machine.
#
# A CLAUDE.md is loaded in full into every session started under it, so its size
# is a recurring tax, not a one-off. On 2026-08-22 the portfolio held 785,204
# chars across 25 files: a session in ~/Dev preloaded ~18,850 tokens, one in
# {portfolio-site} ~62,967. Nobody had measured it, because nothing did.
#
# Three strata accumulate in these files and each has its own tell:
#   1. hand-typed state (counts, rosters, file lists) — drifts silently
#   2. retraction archaeology — correct to write once, then billed forever
#   3. dated narrative — git log already holds it
# This reports all three. It cannot judge which paragraph is a guard worth
# keeping; that is the owner's call. See "A CLAUDE.md records rules, not
# history" in the global CLAUDE.md for the taxonomy.
#
# THIS SCRIPT IS THE SOURCE OF TRUTH FOR THE SIZE THRESHOLD. Never restate the
# number in CLAUDE.md prose — restated numbers are exactly what this measures.
#
# Reports state; never edits a CLAUDE.md.
# DEV_DIR / CLAUDE_DIR redirect the tree so this can run against a fixture.
#
# Exit 0 = every file under threshold. Exit 1 = a finding. Exit 2 = could not
# run, read as UNKNOWN, never as "all files are lean" — an empty walk is
# indistinguishable from a wiped tree.

set -uo pipefail

DEV_DIR="${DEV_DIR:-$HOME/Dev}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
THRESHOLD="${CLAUDE_MD_THRESHOLD:-25000}"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

[ -d "$DEV_DIR" ] || { echo "FATAL: DEV_DIR $DEV_DIR is not a directory — UNKNOWN, not lean" >&2; exit 2; }

# Files are DISCOVERED, never hand-listed: a repo added tomorrow is covered.
files=$(find "$DEV_DIR" -name 'CLAUDE.md' \
          -not -path '*/node_modules/*' -not -path '*/.worktrees/*' \
          -not -path '*/.venv/*' -not -path '*/dist/*' 2>/dev/null | sort)
[ -f "$CLAUDE_DIR/CLAUDE.md" ] && files="$CLAUDE_DIR/CLAUDE.md"$'\n'"$files"
files=$(printf '%s' "$files" | sed '/^$/d')

[ -n "$files" ] || { echo "FATAL: no CLAUDE.md found under $DEV_DIR or $CLAUDE_DIR — UNKNOWN" >&2; exit 2; }

rows=""; findings=0; total=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  chars=$(wc -c < "$f" | tr -d ' ')
  total=$((total+chars))
  tok=$((chars/4))
  retract=$(grep -ciE 'RETRACT|was wrong|corrected 2026|no longer true|this said|until 2026|had never' "$f")
  dates=$(grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2}' "$f" | wc -l | tr -d ' ')
  # Hand-typed count assertions: a quantity followed by a countable noun. This
  # exact construction has drifted three times ("eighteen scripts" / nineteen,
  # "Eight plugins" / ten, a plist count written from memory).
  counts=$(grep -coiE '\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]{1,3})[[:space:]]+(plists?|scripts?|agents?|plugins?|repos|repositories|commands?|skills?|hooks?|files?|sources?|entries)\b' "$f")
  over=0; [ "$chars" -gt "$THRESHOLD" ] && { over=1; findings=$((findings+1)); }
  name=${f#"$HOME"/}
  rows+=$(jq -nc --arg f "$name" --argjson c "$chars" --argjson t "$tok" \
            --argjson r "$retract" --argjson d "$dates" --argjson n "$counts" --argjson o "$over" \
            '{file:$f,chars:$c,est_tokens:$t,retractions:$r,dated_refs:$d,count_assertions:$n,over_threshold:($o==1)}')$'\n'
done <<< "$files"

if [ "$JSON" -eq 1 ]; then
  printf '%s' "$rows" | jq -s "{threshold:$THRESHOLD,total_chars:$total,findings:$findings,files:(.|sort_by(-.chars))}"
else
  printf '%-46s %8s %8s %6s %6s %6s\n' FILE CHARS TOKENS RETR DATES COUNTS
  printf '%s' "$rows" | jq -sr 'sort_by(-.chars)[] | [.file,.chars,.est_tokens,.retractions,.dated_refs,.count_assertions,(if .over_threshold then "OVER" else "" end)] | @tsv' \
    | awk -F'\t' '{printf "%-46s %8s %8s %6s %6s %6s %s\n",$1,$2,$3,$4,$5,$6,$7}'
  printf '\n%d files, %d chars (~%d tokens). Threshold %d: %d over.\n' \
    "$(printf '%s' "$rows" | grep -c .)" "$total" "$((total/4))" "$THRESHOLD" "$findings"
fi

[ "$findings" -gt 0 ] && exit 1
exit 0
