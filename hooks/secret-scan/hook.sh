#!/bin/bash
# hook.sh — PreToolUse blocking hook
# Scans file content being written or edited for common secret patterns.
# Blocks the operation and prints a warning if a secret pattern is detected.
# Skips .env.example files (they are meant to contain placeholder secrets).

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

# Check for secret patterns
check_pattern() {
  local pattern="$1"
  local label="$2"
  if echo "$CONTENT" | grep -qF "$pattern" 2>/dev/null; then
    echo "SECRET SCAN: Blocked write to $FILE_PATH"
    echo "  Detected pattern: $label ($pattern)"
    echo "  Use environment variables instead of hardcoded secrets."
    exit 1
  fi
}

check_pattern "sk-"         "API key (sk-)"
check_pattern "pk_"         "API key (pk_)"
check_pattern "AKIA"        "AWS access key (AKIA)"
check_pattern "ghp_"        "GitHub personal access token (ghp_)"
check_pattern "glpat-"      "GitLab personal access token (glpat-)"
check_pattern 'token = "'   "hardcoded token assignment"
check_pattern 'password = "' "hardcoded password assignment"
check_pattern 'secret = "'  "hardcoded secret assignment"

exit 0
