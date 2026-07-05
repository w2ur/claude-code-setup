#!/bin/bash
# hook.sh — PostToolUse hook (Bash matcher)
# Detects fix-loop patterns: multiple fix: commits touching the same file in a short window.
# Advisory only — always exits 0, surfaces findings via hookSpecificOutput.additionalContext.
#
# Stdin format: {"tool_name": "Bash", "tool_input": {"command": "git commit ..."}, "cwd": "..."}

INPUT=$(cat)

COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('command', ''))
except Exception:
    print('')
" 2>/dev/null)

# Only proceed if this is a git commit command
if ! echo "$COMMAND" | grep -q "git commit"; then
    exit 0
fi

# Resolve target repo dir: stdin cwd first (PostToolUse — the cd already ran
# by the time this fires), fall back to parsing a leading `cd <path> &&`.
DIR=$(echo "$INPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('cwd', ''))" 2>/dev/null)
if [ -z "$DIR" ]; then
  DIR=$(echo "$COMMAND" | sed -E -n 's/^[[:space:]]*cd[[:space:]]+([^&]*)&&.*/\1/p' | sed -E -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  DIR="${DIR/#\~/$HOME}"
fi
[ -z "$DIR" ] && DIR="$PWD"

# Verify we are inside a git repository
if ! git -C "$DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    exit 0
fi

# Collect fix: commits from the last 30 minutes
RECENT_FIX_COMMITS=$(git -C "$DIR" log \
    --since="30 minutes ago" \
    --format="%H %s" \
    2>/dev/null | grep -E "^[a-f0-9]+ fix[:(]")

if [ -z "$RECENT_FIX_COMMITS" ]; then
    exit 0
fi

# Extract commit hashes
COMMIT_HASHES=$(echo "$RECENT_FIX_COMMITS" | awk '{print $1}')
COMMIT_COUNT=$(echo "$COMMIT_HASHES" | wc -l | tr -d ' ')

# Need at least 3 fix: commits for any file to hit the threshold
if [ "$COMMIT_COUNT" -lt 3 ]; then
    exit 0
fi

# For each fix: commit, list the files it touched, then count per-file occurrences
FILE_COUNTS=$(
    for HASH in $COMMIT_HASHES; do
        git -C "$DIR" diff-tree --no-commit-id -r --name-only "$HASH" 2>/dev/null
    done | sort | uniq -c | sort -rn
)

if [ -z "$FILE_COUNTS" ]; then
    exit 0
fi

# Check if any file was modified 3 or more times
LOOPING_FILES=$(echo "$FILE_COUNTS" | awk '$1 >= 3 {print $1, $2}')

if [ -z "$LOOPING_FILES" ]; then
    exit 0
fi

FILE_LIST=$(echo "$LOOPING_FILES" | awk '{print $2 " (" $1 " fix: commits)"}' | tr '\n' '; ')
MSG="fix-loop-detector: possible fix loop detected in the last 30 minutes. Files modified across 3+ fix: commits: $FILE_LIST This matches the escalation rule: after 2 failed fix attempts, STOP and consider invoking the troubleshooter agent instead of continuing to patch the same file."

MSG="$MSG" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': os.environ['MSG']}}))
"

exit 0
