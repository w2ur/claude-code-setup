#!/usr/bin/env bash
#
# netlify-plan-watch.sh — weekly watch on Netlify's Legacy-plan wording.
#
# Why: the Netlify account is on the Legacy Free plan (created before
# 2025-09-04), which has no credits. On the credit-based Free plan every
# production deploy costs credits (15 each when this was written), the
# account gets 300 a month, and running out PAUSES EVERY SITE on the account
# until the monthly reset — the hub included. With auto-deploy on push to main
# across several repos, that budget is a week of ordinary work. Legacy is safe
# only as long as Netlify keeps it; an end-of-Legacy announcement is the one
# event worth catching, and it will show up on the pricing docs first.
#
# What: fetch the "How credits work" docs page and extract two sentences:
#   L — the Legacy sentence ("…before September 4, 2025… Legacy pricing plan…")
#   D — the deploy-cost sentence ("each successful production deploy consumes…")
# and compare them against a baseline. A deploy counter is deliberately NOT
# built: on Legacy, deploys cost nothing, so counting them measures nothing.
#
# Exit convention (portfolio-wide):
#   0 — both sentences match the baseline (or the baseline was just created).
#   1 — a finding: L or D differs, or L is gone while the page is intact.
#   2 — unknown: fetch failed, non-200, or the page anchor is missing (the page
#       moved or was restructured — nothing was measured, which is not "quiet").
# Both 1 and 2 push one notification through notifier.sh. Title + which
# sentence changed only; the docs text itself is public anyway.
#
# A finding never rewrites the baseline: the alert repeats every run until
# the owner reads the page and runs `netlify-plan-watch.sh --accept`, which
# rewrites the baseline from the live page. A warning that clears itself
# after one push is one a busy week loses.
#
# Every run ends with ONE timestamped summary line, so the log's mtime is a
# liveness signal for jobs-inventory.sh.
#
# Overrides (tests): CLAUDE_DIR, NETLIFY_DOCS_URL (file:// works), NOTIFIER_BIN.

set -euo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
URL="${NETLIFY_DOCS_URL:-https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/}"
NOTIFIER="${NOTIFIER_BIN:-$CLAUDE_DIR/scripts/notifier.sh}"
STATE_DIR="$CLAUDE_DIR/state/netlify-plan-watch"
BASELINE="$STATE_DIR/baseline.txt"

ACCEPT=0
case "${1:-}" in
  --accept) ACCEPT=1 ;;
  "") ;;
  *) echo "usage: netlify-plan-watch.sh [--accept]" >&2; exit 2 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

summary() { printf '%s netlify-plan-watch %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

notify() {
  [ -x "$NOTIFIER" ] || return 0
  printf '%s\n' "$2" > "$TMP/body"
  "$NOTIFIER" "$1" "$TMP/body" --priorite high >/dev/null 2>&1 || true
}

unknown() {
  notify "netlify-plan-watch UNKNOWN (exit 2)" "$1 — Legacy-plan status not measured."
  summary "UNKNOWN: $1, exit 2" >&2
  exit 2
}

# --- fetch -------------------------------------------------------------------
# curl handles file:// too, which is what the tests use; http_code is 000 there.
code=$(curl -sS -L --max-time 30 -o "$TMP/page.html" -w '%{http_code}' "$URL" 2>/dev/null) || unknown "fetch failed"
case "$URL" in
  file://*) ;;
  *) [ "$code" = "200" ] || unknown "HTTP $code" ;;
esac

# Strip tags to one text run per line, decode the few entities that matter,
# collapse whitespace.
sed 's/<[^>]*>/\n/g' "$TMP/page.html" \
  | sed -e "s/&#x27;/'/g" -e "s/&#39;/'/g" -e 's/&quot;/"/g' -e 's/&amp;/\&/g' -e 's/&nbsp;/ /g' \
  | tr -s ' \t' '  ' | sed -e 's/^ *//' -e 's/ *$//' > "$TMP/text"
text=$(cat "$TMP/text")

# --- anchor: is this still the page we think it is? ---------------------------
# Here-strings, not pipes: `printf | grep -q` under pipefail can SIGPIPE on a
# match and read as "not found".
grep -q '^How credits work$' <<<"$text" || unknown "page anchor 'How credits work' missing"
grep -q '^Production deploys$' <<<"$text" || unknown "page anchor 'Production deploys' missing"

# --- extract -----------------------------------------------------------------
# L: the first long line naming a Legacy pricing plan (nav links are short).
L=$(awk 'length > 80 && /[Ll]egacy pricing plan/ { print; exit }' <<<"$text")
D=$(awk '/each successful production deploy consumes/ { print; exit }' <<<"$text")

printf 'L: %s\nD: %s\n' "$L" "$D" > "$TMP/current"

if [ "$ACCEPT" = 1 ] || [ ! -f "$BASELINE" ]; then
  [ -n "$L" ] || unknown "no Legacy sentence to baseline"
  mkdir -p "$STATE_DIR"
  cp "$TMP/current" "$BASELINE"
  if [ "$ACCEPT" = 1 ]; then summary "baseline accepted, exit 0"; else summary "baseline created, exit 0"; fi
  exit 0
fi

# --- compare -----------------------------------------------------------------
changed=""
base_L=$(sed -n 's/^L: //p' "$BASELINE")
base_D=$(sed -n 's/^D: //p' "$BASELINE")
if [ -z "$L" ]; then
  changed="Legacy sentence GONE"
elif [ "$L" != "$base_L" ]; then
  changed="Legacy sentence changed"
fi
if [ "$D" != "$base_D" ]; then
  changed="${changed:+$changed; }deploy-cost sentence changed"
fi

if [ -n "$changed" ]; then
  notify "netlify-plan-watch FINDING (exit 1)" "$changed on Netlify's 'How credits work' page. Read it, then run netlify-plan-watch.sh --accept."
  diff "$BASELINE" "$TMP/current" >&2 || true
  summary "FINDING: $changed, exit 1"
  exit 1
fi

summary "ok, exit 0"
exit 0
