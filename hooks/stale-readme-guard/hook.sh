#!/usr/bin/env bash
# PreToolUse hook on Bash(git push ...):
# Warn (not block) when unpushed commits change deploy/dependency files but README.md is untouched.
# Catches drift that individual commits missed, across the full unpushed range.

input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

cmd=$(echo "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except Exception:
    pass" 2>/dev/null)

echo "$cmd" | grep -qE "^git[[:space:]]+push" || exit 0

repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
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
  echo "⚠️  stale-readme-guard: deploy/dependency files changed in unpushed commits but README.md was not updated." >&2
  echo "   Files: $(echo "$has_deps" | tr '\n' ' ')" >&2
  echo "   Verify README still accurately describes the project before pushing." >&2
fi

exit 0
