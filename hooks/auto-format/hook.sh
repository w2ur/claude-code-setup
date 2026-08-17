#!/usr/bin/env bash
# PostToolUse hook: auto-format file after Claude edits it.
# Silent fallback — never blocks the tool use. Runs only if the project has a formatter config.

# Read hook JSON input from stdin
input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

# Extract file path from tool_input.
#
# `jq`, not `python3`, and the reason is not taste. uv is the sole Python
# manager on this machine, so a bare `python3` here resolves to a Homebrew
# interpreter that exists only as a dependency of gcloud-cli/mpv/yt-dlp, with
# Apple's 3.9.6 behind it — an interpreter this hook never chose and cannot see
# change. Routing it through uv instead would be worse: this hook fires on
# EVERY Write and Edit, so a uv resolution per keystroke-batch is a cost paid
# thousands of times for one field lookup.
#
# The right answer is to need no interpreter at all. `jq` is /usr/bin/jq (Apple
# ships it) so it resolves under any PATH this hook can inherit, and it is one
# process rather than an interpreter start-up.
#
# `// empty` preserves the old semantics exactly: a missing or null field, or
# malformed JSON (jq exits non-zero, prints nothing), all yield the empty
# string, and the guard below exits 0 silently. That was `except Exception:
# pass` before — same behaviour, and deliberately so. This hook must never
# block an edit because it could not read its own input.
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[ -z "$file_path" ] && exit 0
[ ! -f "$file_path" ] && exit 0

# Walk up to find project root and format based on detected config
dir=$(dirname "$file_path")
while [ "$dir" != "/" ] && [ "$dir" != "$HOME" ]; do
  case "$file_path" in
    *.js|*.jsx|*.ts|*.tsx|*.json|*.md|*.css|*.scss|*.html|*.yaml|*.yml|*.mjs|*.cjs)
      has_prettier_config=0
      if [ -f "$dir/.prettierrc" ] || [ -f "$dir/.prettierrc.json" ] || [ -f "$dir/.prettierrc.js" ] || [ -f "$dir/.prettierrc.yaml" ] || [ -f "$dir/.prettierrc.yml" ] || [ -f "$dir/.prettierrc.toml" ] || [ -f "$dir/.prettierrc.json5" ] || [ -f "$dir/prettier.config.js" ] || [ -f "$dir/prettier.config.mjs" ]; then
        has_prettier_config=1
      elif [ -f "$dir/package.json" ] && node -e "const p=require('$dir/package.json'); process.exit(p.prettier ? 0 : 1)" 2>/dev/null; then
        has_prettier_config=1
      fi
      if [ "$has_prettier_config" = "1" ]; then
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
