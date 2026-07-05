#!/usr/bin/env bash
# PreToolUse hook on Bash(git push ...):
# Warn (not block) when unpushed commits change deploy/dependency files but README.md is untouched.
# Catches drift that individual commits missed, across the full unpushed range.

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
    pass" 2>/dev/null)

# Match anywhere so chained forms (`npm test && git push`, `cd repo && git push`)
# are caught too, not only commands that literally start with `git push`.
echo "$cmd" | grep -qE "git[[:space:]]+push" || exit 0

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

# Base: upstream of current branch, fallback to origin/main
base=$(git -C "$repo" rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo "origin/main")
# If the base doesn't exist (fresh repo, no origin/main yet), skip silently
git -C "$repo" rev-parse --verify "$base" >/dev/null 2>&1 || exit 0

changed=$(git -C "$repo" diff "$base"..HEAD --name-only 2>/dev/null)
[ -z "$changed" ] && exit 0

has_deps=$(echo "$changed" | grep -E "^(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|netlify\.toml|vercel\.json|wrangler\.toml|next\.config\.(js|mjs|ts)|astro\.config\.(js|mjs|ts))$" || true)
has_readme=$(echo "$changed" | grep -E "^README\.md$" || true)

if [ -n "$has_deps" ] && [ -z "$has_readme" ]; then
  files=$(echo "$has_deps" | tr '\n' ' ')
  msg="stale-readme-guard: deploy/dependency files changed in unpushed commits but README.md was not updated. Files: $files. Verify README still accurately describes the project before pushing."
  MSG="$msg" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': os.environ['MSG']}, 'systemMessage': os.environ['MSG']}))
"
fi

exit 0
