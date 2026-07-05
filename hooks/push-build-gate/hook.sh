#!/bin/bash
# hook.sh — PreToolUse hook (Bash matcher)
# Blocking build gate: runs `npm run build` only when the command contains
# `git push`, and blocks the push on build failure or compiler warnings.

input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

# Pure-shell pre-filter: skip the python3 spawn entirely for the common case
# of a command that doesn't mention git at all.
case "$input" in
  *git*) ;;
  *) exit 0 ;;
esac

cmd=$(echo "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except Exception:
    pass" 2>/dev/null)

echo "$cmd" | grep -qE "git[[:space:]]+push" || exit 0

# Resolve target repo: leading `cd <path> &&` in the command takes priority
# (at PreToolUse time the cd hasn't executed yet), stdin cwd as fallback.
dir=$(echo "$cmd" | sed -E -n 's/^[[:space:]]*cd[[:space:]]+([^&]*)&&.*/\1/p' | sed -E -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]\$//")
dir="${dir/#\~/$HOME}"
if [ -z "$dir" ]; then
  dir=$(echo "$input" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('cwd', ''))" 2>/dev/null)
fi
[ -z "$dir" ] && dir="$PWD"

[ -f "$dir/package.json" ] || exit 0

BUILD_CMD=$(node -e "const p=require('$dir/package.json'); console.log(p.scripts && p.scripts.build || '')" 2>/dev/null)
[ -z "$BUILD_CMD" ] && exit 0

OUTPUT=$(cd "$dir" && npm run build --if-present 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "push-build-gate: build FAILED in $dir (exit $EXIT_CODE)" >&2
  echo "$OUTPUT" >&2
  exit 2
fi

# Compiler-style warning counts only — avoid matching "0 warnings"/"no warnings".
WARNING_LINES=$(echo "$OUTPUT" | grep -E "[1-9][0-9]* warning")
if [ -n "$WARNING_LINES" ]; then
  echo "push-build-gate: build succeeded in $dir but found warnings (zero-warning policy):" >&2
  echo "$WARNING_LINES" >&2
  exit 2
fi

exit 0
