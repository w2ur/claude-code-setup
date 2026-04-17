#!/usr/bin/env bash
# PostToolUse hook: auto-format file after Claude edits it.
# Silent fallback — never blocks the tool use. Runs only if the project has a formatter config.

# Read hook JSON input from stdin
input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

# Extract file path from tool_input
file_path=$(echo "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {})
    print(ti.get('file_path', ''))
except Exception:
    pass
" 2>/dev/null)

[ -z "$file_path" ] && exit 0
[ ! -f "$file_path" ] && exit 0

# Walk up to find project root and format based on detected config
dir=$(dirname "$file_path")
while [ "$dir" != "/" ] && [ "$dir" != "$HOME" ]; do
  case "$file_path" in
    *.js|*.jsx|*.ts|*.tsx|*.json|*.md|*.css|*.scss|*.html|*.yaml|*.yml|*.mjs|*.cjs)
      if [ -f "$dir/.prettierrc" ] || [ -f "$dir/.prettierrc.json" ] || [ -f "$dir/.prettierrc.js" ] || [ -f "$dir/prettier.config.js" ] || [ -f "$dir/prettier.config.mjs" ]; then
        (cd "$dir" && npx --no-install prettier --write "$file_path" >/dev/null 2>&1) || true
        exit 0
      fi
      ;;
    *.py)
      if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/ruff.toml" ] || [ -f "$dir/.ruff.toml" ]; then
        (cd "$dir" && ruff format "$file_path" >/dev/null 2>&1) || true
        exit 0
      fi
      ;;
    *.rs)
      if [ -f "$dir/Cargo.toml" ]; then
        (cd "$dir" && rustfmt "$file_path" >/dev/null 2>&1) || true
        exit 0
      fi
      ;;
  esac
  dir=$(dirname "$dir")
done

exit 0
