#!/bin/bash
# doc-guard.sh — PostToolUse hook for Write operations
# Checks if a .portfolio.yml modification is paired with README/CLAUDE.md updates.
# Returns exit 0 always (advisory, does not block), but prints a warning.

FILE_PATH="$1"

# Only trigger on .portfolio.yml writes
if [[ "$FILE_PATH" != *".portfolio.yml"* ]]; then
  exit 0
fi

# Check git staged files for documentation co-changes
STAGED=$(git diff --cached --name-only 2>/dev/null)

# If no git context (not in a repo), skip
if [ $? -ne 0 ]; then
  exit 0
fi

HAS_README=false
HAS_CLAUDE=false

echo "$STAGED" | grep -q "README.md" && HAS_README=true
echo "$STAGED" | grep -q "CLAUDE.md" && HAS_CLAUDE=true

if [ "$HAS_README" = false ] && [ "$HAS_CLAUDE" = false ]; then
  echo "⚠️  doc-guard: .portfolio.yml was modified but neither README.md nor CLAUDE.md are staged."
  echo "   Reminder: documentation should be updated in the same commit as manifest changes."
  echo "   If this is a sync-only change (no user-facing impact), this warning can be ignored."
fi

exit 0
