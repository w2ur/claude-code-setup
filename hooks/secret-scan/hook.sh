#!/bin/bash
# hook.sh — PreToolUse blocking hook
# Scans file content being written or edited for common secret patterns.
# Blocks the operation and prints a warning if a secret pattern is detected.
# Skips .env.example files and ~/.claude/plans/ (internal docs).

INPUT=$(cat)

# Field extraction goes through `jq`, not `python3`.
#
# uv is the sole Python manager on this machine, so a bare `python3` here
# resolves to a Homebrew interpreter that exists only as a dependency of
# gcloud-cli/mpv/yt-dlp, with Apple's 3.9.6 behind it — an interpreter this
# hook never chose. Routing it through uv would be worse rather than better:
# this is a PreToolUse hook on every Write, Edit and NotebookEdit, so it is one
# of the hottest paths in the whole setup.
#
# It was also spawning an interpreter THREE times per invocation to read three
# fields out of one document. One `jq` call now reads all three, and `jq` is
# /usr/bin/jq (Apple ships it), so it resolves under any PATH this hook can
# inherit and needs no interpreter at all.
#
# Tab-separated on one line, with @tsv doing the escaping: a raw multi-line
# CONTENT would otherwise be indistinguishable from the field separator. The
# content field is base64'd for exactly that reason — it is arbitrary file text
# and can contain anything, including tabs and newlines — and decoded below.
# `// ""` preserves the old `.get(field, '')` semantics, and a parse failure
# leaves every field empty, which the guards below already treat as "nothing to
# scan" exactly as `except`-less python3 + `2>/dev/null` did.
# IFS=$'\t' is load-bearing: the default IFS also splits on spaces, so a path
# like "Mon Drive/notes.md" would land its tail in the next variable.
IFS=$'\t' read -r TOOL_NAME FILE_PATH CONTENT_B64 <<<"$(printf '%s' "$INPUT" | jq -r '
  [ (.tool_name // ""),
    (.tool_input.file_path // .tool_input.notebook_path // ""),
    (((.tool_input.content // .tool_input.new_string // .tool_input.new_source // "") | @base64))
  ] | @tsv' 2>/dev/null)"

case "$TOOL_NAME" in
  Write|Edit|NotebookEdit) ;;
  *) exit 0 ;;
esac

CONTENT=$(printf '%s' "$CONTENT_B64" | base64 --decode 2>/dev/null)

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
# (matches both double- and single-quoted values)
check_regex "(token|password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9_\-]{12,}[\"']" "hardcoded credential assignment"

exit 0
