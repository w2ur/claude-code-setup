#!/usr/bin/env bash
# PreToolUse hook on Bash(git commit ...):
# Warn (not block) when dependency/config files changed but .portfolio.yml wasn't staged.
# Surfaces the "docs updated in the same commit as code" rule from CLAUDE.md.

input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

# Pure-shell pre-filter: skip the python3 spawn for the common case of a
# command that doesn't mention git at all.
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
    pass
" 2>/dev/null)

# Only intercept git commit commands (match anywhere, so chained forms like
# `git add -A && git commit ...` or `cd repo && git commit ...` are caught too)
echo "$cmd" | grep -qE "git[[:space:]]+commit" || exit 0

# Resolve target repo: leading `cd <path> &&` in the command takes priority
# (at PreToolUse time the cd hasn't executed yet), stdin cwd as fallback.
dir=$(echo "$cmd" | sed -E -n 's/^[[:space:]]*cd[[:space:]]+([^&]*)&&.*/\1/p' | sed -E -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]\$//")
dir="${dir/#\~/$HOME}"
if [ -z "$dir" ]; then
  dir=$(echo "$input" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('cwd', ''))" 2>/dev/null)
fi
[ -z "$dir" ] && dir="$PWD"

repo=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$repo/.portfolio.yml" ] || exit 0

staged=$(git -C "$repo" diff --cached --name-only 2>/dev/null)
has_deps=$(echo "$staged" | grep -E "^(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|netlify\.toml|vercel\.json|wrangler\.toml)$" || true)
has_portfolio=$(echo "$staged" | grep -E "^\.portfolio\.yml$" || true)
has_readme=$(echo "$staged" | grep -E "^README\.md$" || true)

if [ -n "$has_deps" ] && [ -z "$has_portfolio$has_readme" ]; then
  msg="portfolio-drift: $has_deps changed but .portfolio.yml / README.md not staged. Consider if stack/deploy/url fields need a refresh before committing."
  MSG="$msg" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': os.environ['MSG']}, 'systemMessage': os.environ['MSG']}))
"
fi

exit 0
