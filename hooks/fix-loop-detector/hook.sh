#!/bin/bash
# hook.sh — PostToolUse hook (Bash matcher)
# Detects fix-loop patterns: multiple fix: commits touching the same file in a short window.
# Advisory only — outputs a warning but always exits 0.
#
# Stdin format: {"tool_name": "Bash", "tool_input": {"command": "git commit ..."}}

# Read stdin into a variable
INPUT=$(cat)

# Extract the command string from the JSON payload.
# Use python3 for reliable JSON parsing (available on macOS).
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

# Only care about fix: or fix( commits (Conventional Commits format)
# Check the commit message embedded in the command, OR inspect the most recent commit.
# The commit may already be recorded by the time PostToolUse fires, so we check git log.

# Verify we are inside a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    exit 0
fi

# Collect fix: commits from the last 30 minutes
RECENT_FIX_COMMITS=$(git log \
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
        git diff-tree --no-commit-id -r --name-only "$HASH" 2>/dev/null
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

# Emit warning
echo ""
echo "WARNING fix-loop-detector: possible fix loop detected in the last 30 minutes."
echo ""
echo "  The following file(s) have been modified across 3+ fix: commits:"
echo ""
while IFS= read -r LINE; do
    COUNT=$(echo "$LINE" | awk '{print $1}')
    FILE=$(echo "$LINE" | awk '{print $2}')
    echo "    $FILE  ($COUNT fix: commits)"
done <<< "$LOOPING_FILES"
echo ""
echo "  This matches the escalation rule: after 2 failed fix attempts, STOP."
echo "  Consider invoking the troubleshooter agent to diagnose the root cause"
echo "  instead of continuing to patch the same file."
echo ""

exit 0
