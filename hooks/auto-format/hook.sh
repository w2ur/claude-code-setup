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

# No prettier branch: no repo in this portfolio ships a prettier config, so it
# never fired (confirmed by grep across ~/Dev before removal) — owner decision
# D16 drops it rather than fixing the per-directory `node -e require()` spawn
# that never enabled it.
case "$file_path" in
  *.py)
    dir=$(dirname "$file_path")
    repo_root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
    [ -z "$repo_root" ] && exit 0

    # "Configured" = a ruff.toml / .ruff.toml at the repo root, or a
    # pyproject.toml carrying a [tool.ruff] table or [tool.ruff.*] subtable.
    # A bare pyproject.toml with no ruff section is NOT configured — that was
    # the bug: my-trading-app and midas-core have pyproject.toml but no [tool.ruff],
    # and every edit reformatted the whole file regardless.
    ruff_configured=0
    if [ -f "$repo_root/ruff.toml" ] || [ -f "$repo_root/.ruff.toml" ]; then
      ruff_configured=1
    elif [ -f "$repo_root/pyproject.toml" ] && grep -Eq '^\[tool\.ruff(\.[A-Za-z0-9_.-]+)?\]' "$repo_root/pyproject.toml"; then
      ruff_configured=1
    fi

    [ "$ruff_configured" = "1" ] && (cd "$repo_root" && ruff format "$file_path" >/dev/null 2>&1)
    ;;
  *.rs)
    dir=$(dirname "$file_path")
    while [ "$dir" != "/" ] && [ "$dir" != "$HOME" ]; do
      if [ -f "$dir/Cargo.toml" ]; then
        (cd "$dir" && rustfmt "$file_path" >/dev/null 2>&1)
        break
      fi
      dir=$(dirname "$dir")
    done
    ;;
esac

exit 0
