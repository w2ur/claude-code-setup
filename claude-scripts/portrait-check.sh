#!/usr/bin/env bash
# portrait-check.sh - bounds the owner portrait (~/.claude/portrait.md).
#
# Why the threshold lives here and nowhere else: portrait.md is imported into
# every session by `@portrait.md` from the global CLAUDE.md, so its size is a
# tax paid on every session. claude-md-weight.sh does not follow imported
# files, so it cannot see that tax; this script is the only bound on it.
# THRESHOLD is the owner's choice: roughly a thousand tokens for a portrait
# loaded in every session. This is the single source of the number; docs must
# not restate it.
#
# Exit: 0 under the threshold, 1 at or over it, 2 missing, unreadable or empty (unknown).
set -euo pipefail
# wc -m counts bytes when no locale is set (the launchd and env -i case); pin one.
export LC_ALL=C.UTF-8

THRESHOLD=4000
PORTRAIT="${PORTRAIT:-$HOME/.claude/portrait.md}"

if [ ! -f "$PORTRAIT" ]; then
  echo "portrait-check: $PORTRAIT is missing; cannot judge its size" >&2
  exit 2
fi

if [ ! -r "$PORTRAIT" ]; then
  echo "portrait-check: $PORTRAIT is unreadable; cannot judge its size" >&2
  exit 2
fi

size=$(wc -m < "$PORTRAIT" | tr -d ' ')
if [ "$size" -eq 0 ]; then
  echo "portrait-check: $PORTRAIT is empty; cannot judge its size" >&2
  exit 2
fi

if [ "$size" -ge "$THRESHOLD" ]; then
  echo "portrait-check: $PORTRAIT is $size characters, at or over the threshold of $THRESHOLD"
  exit 1
fi
echo "portrait-check: $PORTRAIT is $size characters (threshold $THRESHOLD)"
exit 0
