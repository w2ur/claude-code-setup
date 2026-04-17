#!/usr/bin/env bash
# PreToolUse hook on Bash(git commit ...):
# Warn (not block) when dependency/config files changed but .portfolio.yml wasn't staged.
# Surfaces the "docs updated in the same commit as code" rule from CLAUDE.md.

input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

cmd=$(echo "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except Exception:
    pass
" 2>/dev/null)

# Only intercept git commit commands
echo "$cmd" | grep -qE "^git[[:space:]]+commit" || exit 0

repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$repo/.portfolio.yml" ] || exit 0

staged=$(git -C "$repo" diff --cached --name-only 2>/dev/null)
has_deps=$(echo "$staged" | grep -E "^(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|netlify\.toml|vercel\.json|wrangler\.toml)$" || true)
has_portfolio=$(echo "$staged" | grep -E "^\.portfolio\.yml$" || true)
has_readme=$(echo "$staged" | grep -E "^README\.md$" || true)

if [ -n "$has_deps" ] && [ -z "$has_portfolio$has_readme" ]; then
  echo "⚠️  portfolio-drift: $has_deps changed but .portfolio.yml / README.md not staged." >&2
  echo "   Consider if stack/deploy/url fields need a refresh before committing." >&2
fi

exit 0
