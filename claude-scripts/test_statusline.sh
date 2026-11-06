#!/usr/bin/env bash
# test_statusline.sh — fixture-driven tests for statusline-command.sh.
#
# settings-harness/F8 (opus55 v0.2, task B3): the statusline showed cache hit
# ratio but not why the cache missed, or the rate-limit windows. Both new
# fields are OPTIONAL in the real payload (prompt_cache.last_miss_cause and
# rate_limits appear only after the first API response, and rate_limits only
# for Pro/Max subscribers or behind a spend-limit gateway) — the fixtures
# below pin that an absent key prints nothing extra, never "null" and never
# an error.
#
# Run: bash ~/.claude/scripts/test_statusline.sh

set -u

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/statusline-command.sh"
PASS=0
FAIL=0

# Never let a fixture write into the real weekly-usage history.
USAGE_DIR=$(mktemp -d)
export STATUSLINE_USAGE_LOG="$USAGE_DIR/usage-log.tsv"
trap 'rm -rf "$USAGE_DIR"' EXIT

run() { # $1 = JSON payload
  printf '%s' "$1" | sh "$SCRIPT"
}

expect() {
  local name="$1" payload="$2" want="$3"
  local got
  got=$(run "$payload")
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        want: %s\n        got:  %s\n' "$name" "$want" "$got"
  fi
}

echo "statusline-command.sh"

# --- Baseline fields, unaffected by this task -------------------------------
BASE='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"effort":{"level":"high"},"context_window":{"used_percentage":42},"prompt_cache":{"warm":true,"hit_ratio":0.8}}'
expect "baseline (no misses, no rate_limits) is unchanged" \
  "$BASE" \
  "myproj  Opus/high  ctx:42%  cache:80%"

# --- Cache-miss cause --------------------------------------------------------
MISS='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"prompt_cache":{"warm":true,"hit_ratio":0.8,"misses":2,"last_miss_cause":{"causes":["tools_changed"]}}}'
expect "misses > 0 with a cause appends miss:<cause>" \
  "$MISS" \
  "myproj  Opus  cache:80%  miss:tools_changed"

ZERO_MISS='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"prompt_cache":{"warm":true,"hit_ratio":0.8,"misses":0,"last_miss_cause":{"causes":["tools_changed"]}}}'
expect "misses == 0 prints no miss segment even if a stale cause is present" \
  "$ZERO_MISS" \
  "myproj  Opus  cache:80%"

NO_MISS_FIELD='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"prompt_cache":{"warm":true,"hit_ratio":0.8}}'
expect "absent prompt_cache.misses prints no miss segment" \
  "$NO_MISS_FIELD" \
  "myproj  Opus  cache:80%"

MISS_NO_CAUSE='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"prompt_cache":{"warm":true,"hit_ratio":0.8,"misses":3}}'
expect "misses > 0 with no last_miss_cause prints no miss segment (never null)" \
  "$MISS_NO_CAUSE" \
  "myproj  Opus  cache:80%"

# --- Rate limits --------------------------------------------------------------
BOTH_LIMITS='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":23.5},"seven_day":{"used_percentage":41.2}}}'
expect "both rate-limit windows present prints 5h and 7d" \
  "$BOTH_LIMITS" \
  "myproj  Opus  5h:24% 7d:41%"

FIVE_ONLY='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":23.5}}}'
expect "only five_hour present prints just 5h" \
  "$FIVE_ONLY" \
  "myproj  Opus  5h:24%"

SEVEN_ONLY='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"rate_limits":{"seven_day":{"used_percentage":41.2}}}'
expect "only seven_day present prints just 7d" \
  "$SEVEN_ONLY" \
  "myproj  Opus  7d:41%"

NO_LIMITS='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"}}'
expect "absent rate_limits prints nothing extra" \
  "$NO_LIMITS" \
  "myproj  Opus"

# --- Both new fields together -------------------------------------------------
FULL='{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"prompt_cache":{"warm":true,"hit_ratio":0.8,"misses":2,"last_miss_cause":{"causes":["tools_changed"]}},"rate_limits":{"five_hour":{"used_percentage":23.5},"seven_day":{"used_percentage":41.2}}}'
expect "miss cause and rate limits both appear together, in order" \
  "$FULL" \
  "myproj  Opus  cache:80%  miss:tools_changed  5h:24% 7d:41%"

# --- Weekly-usage history -----------------------------------------------------
check() { # $1 = name, $2 = want, $3 = got
  if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$2" "$3"; fi
}
rm -f "$STATUSLINE_USAGE_LOG"
run "$NO_LIMITS" >/dev/null
check "no seven_day writes no history line" "0" "$(cat "$STATUSLINE_USAGE_LOG" 2>/dev/null | wc -l | tr -d ' ')"
run "$BOTH_LIMITS" >/dev/null
run "$BOTH_LIMITS" >/dev/null
run '{"rate_limits":{"seven_day":{"used_percentage":41.4}}}' >/dev/null
check "same whole 7d percent is logged once" "1" "$(wc -l < "$STATUSLINE_USAGE_LOG" | tr -d ' ')"
check "line carries rounded 5h and 7d" "24	41" "$(cut -f 2,3 "$STATUSLINE_USAGE_LOG")"
run "$SEVEN_ONLY" >/dev/null
run '{"rate_limits":{"seven_day":{"used_percentage":42.6}}}' >/dev/null
check "a changed 7d percent appends a line" "41,43" "$(cut -f 3 "$STATUSLINE_USAGE_LOG" | paste -sd, -)"
# Regression (review of 70121e3): an idle session holding a stale, lower figure
# alternated with the active one and the file grew 42/43/42/43 without bound.
run '{"rate_limits":{"seven_day":{"used_percentage":42}}}' >/dev/null
run '{"rate_limits":{"seven_day":{"used_percentage":43}}}' >/dev/null
run '{"rate_limits":{"seven_day":{"used_percentage":42}}}' >/dev/null
check "a stale lower figure from another session is not logged" "41,43" "$(cut -f 3 "$STATUSLINE_USAGE_LOG" | paste -sd, -)"
run '{"rate_limits":{"seven_day":{"used_percentage":3}}}' >/dev/null
check "a drop of 10+ points (weekly reset) is logged" "41,43,3" "$(cut -f 3 "$STATUSLINE_USAGE_LOG" | paste -sd, -)"

# Regression: after a weekly reset an idle session still holding the pre-reset figure
# alternated with the active one (43 -> reset 3 -> stale 43 -> 4 ...). The payload
# carries seven_day.resets_at (checked in a live payload, 2026-11-06), so the window
# is identified by it: a figure from an older window is never logged.
rm -f "$STATUSLINE_USAGE_LOG"
W1=1794556800; W2=1795161600
win() { printf '{"rate_limits":{"seven_day":{"used_percentage":%s,"resets_at":%s}}}' "$1" "$2"; }
run "$(win 43 $W1)" >/dev/null
run "$(win 3 $W2)" >/dev/null
run "$(win 43 $W1)" >/dev/null
run "$(win 4 $W2)" >/dev/null
run "$(win 43 $W1)" >/dev/null
check "a stale pre-reset figure after a weekly reset is not logged" "43,3,4" "$(cut -f 3 "$STATUSLINE_USAGE_LOG" | paste -sd, -)"
check "a line carries its window reset epoch" "$W2" "$(tail -n 1 "$STATUSLINE_USAGE_LOG" | cut -f 4)"
run "$(win 5 $((W2 + 20)))" >/dev/null
check "resets_at jitter inside one window is not a new window" "43,3,4,5" "$(cut -f 3 "$STATUSLINE_USAGE_LOG" | paste -sd, -)"

# Regression: resets_at and the last line's column 4 went into arithmetic and
# `[ -gt ]` unchecked. A float or an ISO string in the payload was written to the
# log as-is (and stayed there to poison every later run); a corrupt column 4 made
# the shell's arithmetic fail. Non-integers fall back to the figure-only rule and
# are never written to column 4; the statusline still prints.
run_err() { printf '%s' "$1" | sh "$SCRIPT" 2>"$USAGE_DIR/err"; }
win_raw() { printf '{"rate_limits":{"seven_day":{"used_percentage":%s,"resets_at":%s}}}' "$1" "$2"; }
for bad in '1795161600.5' '"2026-11-18T11:06:40Z"'; do
  rm -f "$STATUSLINE_USAGE_LOG"
  out=$(run_err "$(win_raw 41 "$bad")")
  check "resets_at $bad: the statusline still prints" "  7d:41%" "$out"
  check "resets_at $bad: stderr stays empty" "" "$(cat "$USAGE_DIR/err")"
  check "resets_at $bad: the line is logged with an empty column 4" "41|" "$(cut -f 3,4 "$STATUSLINE_USAGE_LOG" | tr '\t' '|')"
  run_err "$(win_raw 41 "$bad")" >/dev/null
  run_err "$(win_raw 44 "$bad")" >/dev/null
  check "resets_at $bad: the figure-only rule applies (rise logged, repeat not)" "41,44" "$(cut -f 3 "$STATUSLINE_USAGE_LOG" | paste -sd, -)"
done
for corrupt in 'abc' '1.5e9' '2026-11-18T11:06:40Z'; do
  rm -f "$STATUSLINE_USAGE_LOG"
  printf '1\t10\t40\t%s\n' "$corrupt" > "$STATUSLINE_USAGE_LOG"
  out=$(run_err "$(win 45 $W2)")
  check "corrupt column 4 '$corrupt': the statusline still prints" "  7d:45%" "$out"
  check "corrupt column 4 '$corrupt': stderr stays empty" "" "$(cat "$USAGE_DIR/err")"
  check "corrupt column 4 '$corrupt': the figure-only rule logs the rise, with the valid resets_at" "$W2" "$(tail -n 1 "$STATUSLINE_USAGE_LOG" | cut -f 4)"
  run_err "$(win 45 $W2)" >/dev/null
  check "corrupt column 4 '$corrupt': an unchanged figure is not logged" "2" "$(wc -l < "$STATUSLINE_USAGE_LOG" | tr -d ' ')"
done

# Regression (review round 4): a non-integer column 3 aborted /bin/sh on the
# arithmetic and blanked the status line for good.
printf '1\t5\t12.5\t\n' > "$STATUSLINE_USAGE_LOG"
got=$(run '{"cwd":"/tmp/myproj","model":{"display_name":"Opus"},"rate_limits":{"seven_day":{"used_percentage":20}}}' 2>/dev/null)
check "corrupt column 3 still prints the status line" "myproj  Opus  7d:20%" "$got"
check "corrupt column 3 is superseded by a fresh line" "20" "$(tail -n 1 "$STATUSLINE_USAGE_LOG" | cut -f 3)"

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
