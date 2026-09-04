#!/usr/bin/env bash
# Reports how much of the Elenchus free tier's daily allowance is left, and
# which of the three service-wide ceilings — extension requests, web
# requests, tokens — is closest to binding.
#
# This exists because the free tier's success case and its failure case look
# identical from outside. When a service-wide ceiling is reached the proxy
# refuses everyone for the rest of the UTC day, and nothing anywhere says so:
# the extension shows a per-user "daily limit" message, which is what a heavy
# individual user sees too. The first report would come from a stranger who
# has no way to reach us.
#
# It reads GET /status on the Worker, which calls the rate limiter's peek() —
# a read that claims no quota. Watching the service therefore never consumes
# what it is watching, and that invariant is pinned by a test in
# elenchus-proxy/test/status.test.js rather than trusted.
#
# TIMING IS PART OF THE DESIGN. The counters roll over at 00:00 UTC, computed
# inside the Durable Object from its own clock (currentDay() is toISOString()).
# A run scheduled for the morning in Paris would sample a UTC day only a few
# hours old and read near-zero every single time — a watcher that always says
# "plenty left", including on the day the service refused everyone at 23:00.
# The LaunchAgent fires at 23:47 Paris, which is 21:47 UTC: ~91% of the UTC day
# elapsed in summer, ~95% in winter.
#
# The status secret is NOT the extension's X-Elenchus-Key. That key ships
# inside the .crx and is not an authentication boundary — anyone who unpacks a
# published build holds it — so it must never open an operational surface.
#
# Reports state; never changes a ceiling. Raising one is a provider decision
# that needs the published RPD re-derived in the same change, which is what
# elenchus-proxy/test/token-budget.test.js guards.
#
# Exit: 0 headroom above the threshold; 1 a ceiling has bound today, a web
# finding was raised, or headroom is below the threshold; 2 the check could
# not run — which must be read as UNKNOWN, never as healthy. A 405 is exit 2,
# not exit 0: it means the route is not deployed or the secret is wrong, and
# a watcher that cannot see the counters knows nothing about them.
#
# NOTIFICATION. A finding nobody is told about is the failure this whole file
# exists to stop, so exit 1 AND exit 2 both notify — exit 2 especially,
# because "could not run" is the state most easily mistaken for a quiet day.
# Every exit-2 site below therefore goes through die2(), which notifies
# before exiting, rather than a bare `exit 2` that would return before ever
# reaching a notifier call.
#
# The web surface's own headroom hitting 0 is NOT a finding: a drained web
# bucket is the intended steady state (the web gate is meant to be tight),
# and the top-level `headroom` field the proxy publishes already excludes it
# for the same reason. It is printed, never paged on.
set -euo pipefail

STATUS_URL="${ELENCHUS_STATUS_URL:-https://elenchus-proxy.william-445.workers.dev/status}"
KEYCHAIN_SERVICE="${ELENCHUS_KEYCHAIN_SERVICE:-elenchus-status}"
HEADROOM_MIN="${ELENCHUS_HEADROOM_MIN:-0.20}"
NOTIFIER="${NOTIFIER_BIN:-$HOME/.claude/scripts/notifier.sh}"

JSON_OUTPUT=false
[ "${1:-}" = "--json" ] && JSON_OUTPUT=true

warn() { echo "WARN: $*" >&2; }

# Single push path for every non-zero exit, so a finding is never silent.
# --json runs stay quiet on purpose: that mode is for a caller that reads the
# body itself, not a human waiting on a push.
notify() {
  # $1 = title, $2 = body text (may be multi-line)
  if $JSON_OUTPUT; then return 0; fi
  [ -x "$NOTIFIER" ] || return 0
  local body_file
  body_file=$(mktemp)
  printf '%s\n' "$2" > "$body_file"
  "$NOTIFIER" "$1" "$body_file" --priorite 4 >/dev/null 2>&1 || true
  rm -f "$body_file"
}

# Every "could not run" exit goes through here. Previously six sites did a
# bare `exit 2` above the notifier block at the bottom of the file and the
# owner never heard about it — this closes that gap structurally, so a
# seventh early-exit added later can't reopen it by accident.
die2() {
  warn "$1"
  notify "Elenchus watch — could not run (exit 2 = unknown)" "$1"
  exit 2
}

command -v curl >/dev/null 2>&1 || die2 "curl not found — cannot run."
command -v jq   >/dev/null 2>&1 || die2 "jq not found — cannot run."

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
  die2 "no status secret (keychain service '$KEYCHAIN_SERVICE', or \$ELENCHUS_STATUS_SECRET). Set it with: security add-generic-password -s '$KEYCHAIN_SERVICE' -a \"\$USER\" -w"
fi

response=$(curl -sS --max-time 20 -w $'\n%{http_code}' \
  -H "X-Elenchus-Status: $SECRET" "$STATUS_URL" 2>/dev/null) \
  || die2 "could not reach $STATUS_URL"

http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [ "$http_code" != "200" ]; then
  # 405 is the deliberate answer to an unauthenticated caller: the route is
  # invisible without its secret, byte-identical to any other GET. So a 405
  # here means the secret is wrong, or the Worker predates the route.
  case "$http_code" in
    405) die2 "HTTP 405 — the status route is not deployed, or the secret is wrong." ;;
    *)   die2 "HTTP $http_code from $STATUS_URL." ;;
  esac
fi

# v2 shape: no top-level .requests — the per-surface breakdown lives under
# .surfaces. Against a v1-shape body this fails (missing .surfaces.extension),
# which is the intended "cannot read" outcome, not a crash.
if ! printf '%s' "$body" | jq -e '.day and .tokens and .surfaces.extension.requests' >/dev/null 2>&1; then
  die2 "the status route answered 200 with a body this script cannot read."
fi

day=$(printf '%s' "$body" | jq -r '.day')
binding=$(printf '%s' "$body" | jq -r '.binding')
headroom=$(printf '%s' "$body" | jq -r '.headroom')
# Rounded for the human line and the notification only. The --json path emits
# the body's own value untouched, so nothing downstream loses precision.
headroom_pct=$(printf '%s' "$body" | jq -r '(.headroom * 1000 | round) / 10')

req_used=$(printf '%s' "$body" | jq -r '.surfaces.extension.requests.used')
req_ceil=$(printf '%s' "$body" | jq -r '.surfaces.extension.requests.ceiling')
tok_used=$(printf '%s' "$body" | jq -r '.tokens.used')
tok_ceil=$(printf '%s' "$body" | jq -r '.tokens.ceiling')

# Web surface: read defensively. A missing ceiling and a cleared Turnstile
# secret move no counter and are otherwise invisible — they are findings in
# their own right below, not just display fields.
web_req_used=$(printf '%s' "$body" | jq -r '.surfaces.web.requests.used // "n/a"')
web_req_ceil=$(printf '%s' "$body" | jq -r '.surfaces.web.requests.ceiling // "n/a"')
web_ceil_missing=$(printf '%s' "$body" | jq -r 'if .surfaces.web.requests.ceiling == null then "yes" else "no" end')
web_turnstile_missing=$(printf '%s' "$body" | jq -r 'if .surfaces.web.turnstileSecretPresent == true then "no" else "yes" end')
# Draining the web bucket to zero is the intended steady state (the web gate
# is meant to be tight) — this is display-only, never a status input.
web_dry=$(printf '%s' "$body" | jq -r 'if (.surfaces.web.headroom // 1) == 0 then "yes" else "no" end')

# "bound" and "low" both stay scoped to extension + tokens, same as the
# top-level `headroom` the proxy publishes — the web surface is deliberately
# excluded from both, for the reason in web_dry above.
bound=$(printf '%s' "$body" \
  | jq -r 'if .surfaces.extension.requests.used >= .surfaces.extension.requests.ceiling
             or .tokens.used >= .tokens.ceiling
           then "yes" else "no" end')
low=$(printf '%s' "$body" \
  | jq -r --argjson min "$HEADROOM_MIN" 'if .headroom < $min then "yes" else "no" end')

status=0
verdict="Headroom is fine."
if [ "$bound" = "yes" ]; then
  status=1
  verdict="A ceiling has BOUND today — the free tier is refusing everyone until 00:00 UTC."
elif [ "$web_ceil_missing" = "yes" ]; then
  status=1
  verdict="MAX_DAILY_REQUESTS_WEB is missing or unparseable — every web request is 500ing."
elif [ "$web_turnstile_missing" = "yes" ]; then
  status=1
  verdict="The web gate's Turnstile secret is cleared or was never deployed — every web request is refused (\"Verification failed.\")."
elif [ "$low" = "yes" ]; then
  status=1
  verdict="Headroom is below $HEADROOM_MIN — the '$binding' ceiling is the one closing in."
fi

if [ "$web_dry" = "yes" ]; then
  web_suffix=" (dry — by design)"
elif [ "$web_ceil_missing" = "yes" ]; then
  web_suffix=" (MAX_DAILY_REQUESTS_WEB not set)"
else
  web_suffix=""
fi

if $JSON_OUTPUT; then
  printf '%s' "$body" | jq -c --arg verdict "$verdict" --argjson status "$status" \
    '{day, binding, headroom, surfaces, tokens, verdict: $verdict, status: $status}'
else
  echo "Elenchus free tier — UTC day $day"
  echo
  printf '  %-10s extension %s/%s · web %s/%s%s\n' "requests" "$req_used" "$req_ceil" "$web_req_used" "$web_req_ceil" "$web_suffix"
  printf '  %-10s %12s / %-12s\n' "tokens"   "$tok_used" "$tok_ceil"
  printf '  %-10s %11s%%   (binding ceiling: %s)\n' "headroom" "$headroom_pct" "$binding"
  if [ "$web_turnstile_missing" = "yes" ]; then
    echo "  web turnstile secret: MISSING"
  fi
  echo
  echo "$verdict"
fi

# A finding nobody is told about is the failure this whole file exists to
# stop, so exit 1 AND exit 2 both notify (see die2() above for the six early
# exit-2 sites that used to return silently before ever reaching here).
if [ "$status" -ne 0 ]; then
  web_line="web:       $web_req_used / $web_req_ceil$web_suffix"
  notify_body=$(cat <<EOF
$verdict

extension: $req_used / $req_ceil
$web_line
tokens:    $tok_used / $tok_ceil
headroom:  ${headroom_pct}% (binding: $binding)
EOF
)
  notify "Elenchus — free tier ceiling" "$notify_body"
fi

exit "$status"
