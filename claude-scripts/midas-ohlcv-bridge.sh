#!/bin/bash
# TEMPORARY quota bridge — delete on/after 2026-09-17 (it deletes itself).
#
# Why this exists: the GitHub Actions included-usage meter was exhausted on
# 2026-08-18, which BLOCKS every GitHub-hosted run until the meter resets.
# Measured bracket for the exhaustion: {portfolio-site}/scheduled-rebuild
# succeeded at 06:25 UTC and my-trading-app/check-triggers failed at 13:42 UTC the same
# day. A blocked run fails in 3-8 s with ZERO steps executed — that empty step
# list, not the exit status, is how a quota block is told from a code failure.
#
# RETRACTED 2026-08-18: this said "the calendar-month reset at 00:00 UTC on
# Sep 1", and EXPIRES below read 2026-09-01 to match. That was an assumption
# about a calendar-month meter, never checked against the billing page. The
# real reset is **2026-09-17** — this account is on a billing-cycle meter
# anchored to its own date, not to the 1st. The error was not cosmetic: it
# would have deleted this bridge 16 days early, the OHLCV store would have
# stopped advancing, and once the newest equity benchmark close passed 4
# calendar days old, scripts/fetch_market_data.py raises StaleMarketDataError
# and Step 1 of every daily session aborts — a silent stop whose symptom
# arrives days after the cause. Do not "restore" the 1st.
#
# NOTE the billing API cannot confirm this from here: the gh token carries
# 'repo'/'workflow' but not 'user', so /users/{u}/settings/billing/actions
# 404s. The date is the owner's, read off github.com/settings/billing. Also
# note /actions/runs/{id}/timing is USELESS on this account — it reports
# billable total_ms 0 even for runs that demonstrably executed for minutes.
# Use job-level started_at/completed_at deltas if you ever need to re-measure.
#
# `fetch-ohlcv` is the desk-critical workflow of the set — the failure chain
# above is why — so the store gets advanced from this Mac instead.
#
# WHY 17:30 UTC AND NOT 06:00, the hour the workflow uses. Measured 2026-08-18
# at 07:28 UTC: Yahoo served Monday 08-17 as a row with a NaN close for AAPL
# and URTH — US names, not only European ones. `build_new_rows` drops a row
# with no close, so a 06:00 run cannot capture the previous trading day at all;
# the store had 952 of 1,150 symbols still sitting on Friday 08-14. The
# eu-close-probe's phase 1 found the same withdrawal window for European
# closes (populated ~17:00-20:18 UTC, NULL by 22:23, restored the next
# afternoon) and concluded it was European-specific. It is not. 17:30 UTC sits
# inside the populated window and ahead of the 20:00 UTC session.
#
# The fetch contract is UNCHANGED: fetch_ohlcv.py still sets end = yesterday,
# so only complete bars are ever stored and snapshot dating does not move.
#
# Runs as a launchd LaunchAgent, never crontab: a cron job has no access to the
# GUI login keychain, and this pushes to GitHub over the credential helper.

set -uo pipefail

REPO="${MIDAS_REPO:-$HOME/Dev/my-trading-app}"
PLIST="$HOME/Library/LaunchAgents/com.example.midas-ohlcv-bridge.plist"
LABEL="com.example.midas-ohlcv-bridge"
EXPIRES="2026-09-17"   # billing-cycle reset, NOT the 1st — see docblock

echo "=== midas-ohlcv-bridge $(date -u +%FT%TZ) ==="

# --- self-expiry -----------------------------------------------------------
# A temporary daily writer to main that outlives its reason is worse than the
# outage it patched, so it removes itself rather than nagging forever.
TODAY="$(date -u +%F)"
if [[ "$TODAY" > "$EXPIRES" || "$TODAY" == "$EXPIRES" ]]; then
  echo "EXPIRED: the Actions quota reset on ${EXPIRES}. Removing this bridge."
  rm -f "$PLIST"
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  echo "Removed ${PLIST}. Confirm the 06:00 UTC fetch-ohlcv cron is running again."
  exit 0
fi

# --- guards ----------------------------------------------------------------
# FATAL, never a skip: a bridge that quietly does nothing is indistinguishable
# from a bridge that worked, and the symptom (a dead session) arrives days later.
PY="$REPO/.venv/bin/python"
for tool in git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: $tool not on PATH"; exit 2; }
done
[[ -x "$PY" ]] || { echo "FATAL: no venv interpreter at $PY"; exit 2; }
cd "$REPO" || { echo "FATAL: cannot cd to $REPO"; exit 2; }

# --- sync ------------------------------------------------------------------
git fetch origin --quiet || { echo "FATAL: git fetch failed"; exit 2; }
if ! git merge --ff-only origin/main --quiet; then
  echo "FATAL: local main will not fast-forward (dirty tree or divergence)."
  echo "       Resolve by hand — this bridge must never merge or rebase blindly."
  exit 2
fi

# --- fetch -----------------------------------------------------------------
"$PY" scripts/fetch_ohlcv.py
rc=$?
# Mirrors fetch-ohlcv.yml's `committable` gate exactly: 2 = a row was
# quarantined, 3 = a vendor outage. BOTH mean "commit this, then go red" —
# throwing away a night's good rows because of bad news was the 2026-08-10
# defect. Any other non-zero is a crash, whose half-written store must not land.
case "$rc" in
  0|2|3) committable=true ;;
  *)     committable=false ;;
esac
echo "fetch_ohlcv.py exited ${rc} (committable=${committable})"

if [[ "$committable" != "true" ]]; then
  echo "FATAL: not committing a store written by a crashed run."
  exit "$rc"
fi

# --- commit + push ---------------------------------------------------------
# Same pathspecs as the workflow. Absent paths are filtered out first: `git
# status` exits 0 for a path that does not exist while `git add` exits 128,
# which is how fetch-ohlcv threw away two nights of prices in 2026-08.
PATHS="data/market/ohlcv/ data/market/quarantine/ data/market/corporate_actions.jsonl data/portfolios/ data/tickers.json"
present=()
for p in $PATHS; do
  if [[ -e "$p" ]] || git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    present+=("$p")
  else
    echo "Skipping '$p' — matches nothing in the worktree or the index."
  fi
done

if [[ ${#present[@]} -eq 0 ]] || [[ -z "$(git status --porcelain -- "${present[@]}")" ]]; then
  echo "No OHLCV changes to commit."
  exit "$rc"
fi

git add -- "${present[@]}" || { echo "FATAL: git add failed"; exit 2; }
git commit -q -m "[data] $(date -u +%F) OHLCV update (local bridge — Actions quota)" \
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
