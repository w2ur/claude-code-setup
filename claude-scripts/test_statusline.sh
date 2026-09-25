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

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
