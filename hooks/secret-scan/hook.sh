#!/bin/bash
# hook.sh — PreToolUse blocking hook
# Scans file content being written or edited for common secret patterns.
# Blocks the operation and prints a warning if a secret pattern is detected.
# Skips .env.example files and ~/.claude/plans/ (internal docs).

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('tool_name', ''))" 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('file_path', ''))" 2>/dev/null)

# Determine content field based on tool
if [ "$TOOL_NAME" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('content', ''))" 2>/dev/null)
elif [ "$TOOL_NAME" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('new_string', ''))" 2>/dev/null)
else
  exit 0
fi

# Skip .env.example files — they are placeholders by design
if [[ "$FILE_PATH" == *".env.example" ]]; then
  exit 0
fi

# Skip ~/.claude/plans/ — internal plan/review docs often discuss secret patterns textually
if [[ "$FILE_PATH" == "$HOME/.claude/plans/"* ]]; then
  exit 0
fi

# Check for secret patterns — use word boundaries and require plausible secret body
# to avoid false positives on words like "task-", "disk-", "ask-".
check_regex() {
  local pattern="$1"
  local label="$2"
  if echo "$CONTENT" | grep -qE "$pattern" 2>/dev/null; then
    {
      echo "SECRET SCAN: Blocked write to $FILE_PATH"
      echo "  Detected pattern: $label"
      echo "  Use environment variables instead of hardcoded secrets."
    } >&2
    exit 2
  fi
}

# API keys — require prefix at word boundary + realistic body length
check_regex '(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}'   "OpenAI/Anthropic-style API key (sk-...)"
check_regex '(^|[^A-Za-z0-9_])pk_(live|test)_[A-Za-z0-9]{16,}' "Stripe publishable key (pk_live/pk_test_...)"
check_regex '(^|[^A-Za-z0-9_])sk_(live|test)_[A-Za-z0-9]{16,}' "Stripe secret key (sk_live/sk_test_...)"
check_regex '(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}'        "AWS access key (AKIA...)"
check_regex '(^|[^A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}'    "GitHub personal access token (ghp_...)"
check_regex '(^|[^A-Za-z0-9_])gho_[A-Za-z0-9]{30,}'    "GitHub OAuth token (gho_...)"
check_regex '(^|[^A-Za-z0-9_])ghs_[A-Za-z0-9]{30,}'    "GitHub app token (ghs_...)"
check_regex '(^|[^A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}' "GitLab personal access token (glpat-...)"

# Hardcoded assignments — require a non-empty, non-placeholder value
check_regex '(token|password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*"[A-Za-z0-9_\-]{12,}"' "hardcoded credential assignment"

exit 0
