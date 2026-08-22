#!/usr/bin/env bash
# Reports how much of the My Socratic App free tier's daily allowance is left, and
# which of the two service-wide ceilings is closer to binding.
#
# This exists because the free tier's success case and its failure case look
# identical from outside. When the service-wide ceiling is reached the proxy
# refuses everyone for the rest of the UTC day, and nothing anywhere says so:
# the extension shows a per-user "daily limit" message, which is what a heavy
# individual user sees too. The first report would come from a stranger who
# has no way to reach us.
#
# It reads GET /status on the Worker, which calls the rate limiter's peek() —
# a read that claims no quota. Watching the service therefore never consumes
# what it is watching, and that invariant is pinned by a test in
# my-socratic-app-proxy/test/status.test.js rather than trusted.
#
# TIMING IS PART OF THE DESIGN. The counters roll over at 00:00 UTC, computed
# inside the Durable Object from its own clock (currentDay() is toISOString()).
# A run scheduled for the morning in Paris would sample a UTC day only a few
# hours old and read near-zero every single time — a watcher that always says
# "plenty left", including on the day the service refused everyone at 23:00.
# The LaunchAgent fires at 23:47 Paris, which is 21:47 UTC: ~91% of the UTC day
# elapsed in summer, ~95% in winter.
#
# The status secret is NOT the extension's X-My Socratic App-Key. That key ships
# inside the .crx and is not an authentication boundary — anyone who unpacks a
# published build holds it — so it must never open an operational surface.
#
# Reports state; never changes a ceiling. Raising one is a provider decision
# that needs the published RPD re-derived in the same change, which is what
# my-socratic-app-proxy/test/token-budget.test.js guards.
#
# Exit: 0 headroom above the threshold; 1 a ceiling has bound today or headroom
# is below it; 2 the check could not run — which must be read as UNKNOWN, never
# as healthy. A 405 is exit 2, not exit 0: it means the route is not deployed
# or the secret is wrong, and a watcher that cannot see the counters knows
# nothing about them.
set -euo pipefail

STATUS_URL="${ELENCHUS_STATUS_URL:-https://my-socratic-app-proxy.william-445.workers.dev/status}"
KEYCHAIN_SERVICE="${ELENCHUS_KEYCHAIN_SERVICE:-my-socratic-app-status}"
HEADROOM_MIN="${ELENCHUS_HEADROOM_MIN:-0.20}"
NOTIFIER="${NOTIFIER_BIN:-$HOME/.claude/scripts/notifier.sh}"

JSON_OUTPUT=false
[ "${1:-}" = "--json" ] && JSON_OUTPUT=true

warn() { echo "WARN: $*" >&2; }

command -v curl >/dev/null 2>&1 || { warn "curl not found — cannot run."; exit 2; }
command -v jq   >/dev/null 2>&1 || { warn "jq not found — cannot run."; exit 2; }

# The secret lives in the login keychain, where gh's and claude's credentials
# already live. That is also why this must be a LaunchAgent and never a crontab
# entry: outside the GUI session the login keychain is not in the search list,
# `security` returns empty, and the request would 405 — reported as UNKNOWN,
# but for a reason that looks nothing like the real one.
SECRET="${ELENCHUS_STATUS_SECRET:-}"
if [ -z "$SECRET" ]; then
  SECRET=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
fi
if [ -z "$SECRET" ]; then
  warn "no status secret (keychain service '$KEYCHAIN_SERVICE', or \$ELENCHUS_STATUS_SECRET)."
  warn "set it with: security add-generic-password -s '$KEYCHAIN_SERVICE' -a \"\$USER\" -w"
  exit 2
fi

response=$(curl -sS --max-time 20 -w $'\n%{http_code}' \
  -H "X-My Socratic App-Status: $SECRET" "$STATUS_URL" 2>/dev/null) \
  || { warn "could not reach $STATUS_URL"; exit 2; }

http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [ "$http_code" != "200" ]; then
  # 405 is the deliberate answer to an unauthenticated caller: the route is
  # invisible without its secret, byte-identical to any other GET. So a 405
  # here means the secret is wrong, or the Worker predates the route.
  case "$http_code" in
    405) warn "HTTP 405 — the status route is not deployed, or the secret is wrong." ;;
    *)   warn "HTTP $http_code from $STATUS_URL." ;;
  esac
  exit 2
fi

if ! printf '%s' "$body" | jq -e '.day and .requests and .tokens' >/dev/null 2>&1; then
  warn "the status route answered 200 with a body this script cannot read."
  exit 2
fi

day=$(printf '%s' "$body" | jq -r '.day')
binding=$(printf '%s' "$body" | jq -r '.binding')
headroom=$(printf '%s' "$body" | jq -r '.headroom')
# Rounded for the human line and the notification only. The --json path emits
# the body's own value untouched, so nothing downstream loses precision.
headroom_pct=$(printf '%s' "$body" | jq -r '(.headroom * 1000 | round) / 10')
req_used=$(printf '%s' "$body" | jq -r '.requests.used')
req_ceil=$(printf '%s' "$body" | jq -r '.requests.ceiling')
tok_used=$(printf '%s' "$body" | jq -r '.tokens.used')
tok_ceil=$(printf '%s' "$body" | jq -r '.tokens.ceiling')

bound=$(printf '%s' "$body" \
  | jq -r 'if .requests.used >= .requests.ceiling or .tokens.used >= .tokens.ceiling
           then "yes" else "no" end')
low=$(printf '%s' "$body" \
  | jq -r --argjson min "$HEADROOM_MIN" 'if .headroom < $min then "yes" else "no" end')

status=0
verdict="Headroom is fine."
if [ "$bound" = "yes" ]; then
  status=1
  verdict="A ceiling has BOUND today — the free tier is refusing everyone until 00:00 UTC."
elif [ "$low" = "yes" ]; then
  status=1
  verdict="Headroom is below $HEADROOM_MIN — the '$binding' ceiling is the one closing in."
fi

if $JSON_OUTPUT; then
  printf '%s' "$body" | jq -c --arg verdict "$verdict" --argjson status "$status" \
    '{day, binding, headroom, requests, tokens, verdict: $verdict, status: $status}'
else
  echo "My Socratic App free tier — UTC day $day"
  echo
  printf '  %-10s %12s / %-12s\n' "requests" "$req_used" "$req_ceil"
  printf '  %-10s %12s / %-12s\n' "tokens"   "$tok_used" "$tok_ceil"
  printf '  %-10s %11s%%   (binding ceiling: %s)\n' "headroom" "$headroom_pct" "$binding"
  echo
  echo "$verdict"
fi

# A finding nobody is told about is the failure this whole file exists to stop,
# so exit 1 AND exit 2 both notify. Exit 2 especially: "could not run" is the
# state most easily mistaken for a quiet day.
if [ "$status" -ne 0 ] && [ -x "$NOTIFIER" ] && ! $JSON_OUTPUT; then
  body_file=$(mktemp)
  {
    echo "$verdict"
    echo
    echo "requests: $req_used / $req_ceil"
    echo "tokens:   $tok_used / $tok_ceil"
    echo "headroom: ${headroom_pct}% (binding: $binding)"
  } > "$body_file"
  "$NOTIFIER" "My Socratic App — free tier ceiling" "$body_file" --priorite 4 >/dev/null 2>&1 || true
  rm -f "$body_file"
fi

exit "$status"
