#!/usr/bin/env bash
# cleanup-cron.sh
#
# Unattended monthly wrapper around disk-hygiene.sh's AUTO tier.
#
# Why a script and not `claude -p "/cleanup"`: /cleanup's Steps 1-4 make
# git commits in project repos and can trigger /sync-setup, and its CONFIRM
# tier is interactive by design (it asks the owner before touching
# projects/ or plugins/ entries) -- none of that is safe to run unattended
# from cron. This wrapper covers Step 0's AUTO tier only: plan, apply
# (AUTO tier, no --yes-* flags), verify, and report.
#
# Deterministic: no model is ever invoked, no git command is ever run,
# nothing outside $CLAUDE_DIR is written by this script.
#
# Usage:
#   cleanup-cron.sh
#
# Honours CLAUDE_DIR the same way disk-hygiene.sh does, so this can be
# exercised against a dirtied copy for testing.
set -euo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

# Derive the sibling disk-hygiene.sh path from this script's own location
# rather than hardcoding a user path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HYGIENE_SCRIPT="$SCRIPT_DIR/disk-hygiene.sh"

echo "=== $(date '+%Y-%m-%d %H:%M') cleanup-cron ==="

if [ ! -x "$HYGIENE_SCRIPT" ]; then
  echo "ERROR: $HYGIENE_SCRIPT not found or not executable -- aborting"
  exit 1
fi

SIZE_BEFORE="$(du -sh "$CLAUDE_DIR" 2>/dev/null | cut -f1)"
echo "size before: $SIZE_BEFORE"

echo "[plan]"
if ! PLAN_OUTPUT="$(CLAUDE_DIR="$CLAUDE_DIR" "$HYGIENE_SCRIPT" plan)"; then
  echo "ERROR: $HYGIENE_SCRIPT plan exited non-zero"
  exit 1
fi
echo "$PLAN_OUTPUT"

echo "[apply]"
if ! APPLY_OUTPUT="$(CLAUDE_DIR="$CLAUDE_DIR" "$HYGIENE_SCRIPT" apply)"; then
  echo "ERROR: $HYGIENE_SCRIPT apply exited non-zero"
  exit 1
fi
echo "$APPLY_OUTPUT"

echo "[verify]"
if ! VERIFY_OUTPUT="$(CLAUDE_DIR="$CLAUDE_DIR" "$HYGIENE_SCRIPT" plan)"; then
  echo "ERROR: $HYGIENE_SCRIPT plan (verify pass) exited non-zero"
  exit 1
fi
echo "$VERIFY_OUTPUT"

VERIFY_AUTO="$(printf '%s\n' "$VERIFY_OUTPUT" | tail -1 | sed -E 's/.*auto=([0-9]+).*/\1/')"
if [ "$VERIFY_AUTO" != "0" ]; then
  echo "WARNING: sweep did not converge -- verify pass still reports auto=$VERIFY_AUTO (expected 0)"
  exit 1
fi

SIZE_AFTER="$(du -sh "$CLAUDE_DIR" 2>/dev/null | cut -f1)"
echo "size: $SIZE_BEFORE -> $SIZE_AFTER"

# The SUMMARY's confirm= count ALREADY includes REPORT-verb lines --
# disk-hygiene.sh emits them with tier "confirm" (marketplaces with no
# enabled plugin). Do not add REPORT lines on top of it; that inflates the
# owner-action count in an unattended log, which is exactly the kind of
# wrong number nobody is present to sanity-check.
PENDING_COUNT="$(printf '%s\n' "$VERIFY_OUTPUT" | tail -1 | sed -E 's/.*confirm=([0-9]+).*/\1/')"

if [ "$PENDING_COUNT" -eq 0 ]; then
  echo "owner action: none"
else
  echo "owner action: $PENDING_COUNT item(s) need a human confirmation -- run /cleanup interactively. Pending paths:"
  printf '%s\n' "$VERIFY_OUTPUT" | awk -F'\t' '$1 == "DELETE" || $1 == "ARCHIVE" || $1 == "REPORT" { print "  " $1 "\t" $2 }' | grep -v $'\t''$' || true
fi
