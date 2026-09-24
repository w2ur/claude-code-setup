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

# `jq`, not `python3`: uv is the sole Python manager here, so a bare `python3`
# resolves to a Homebrew interpreter that exists only as another formula's
# dependency, with Apple's 3.9.6 behind it. A field lookup needs no interpreter
# at all — `jq` is /usr/bin/jq (Apple ships it). `// empty` keeps the previous
# `except: pass` semantics: malformed input yields the empty string and the
# match below simply fails, so this advisory hook stays silent rather than
# erroring on input it could not read.
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Match anywhere so chained forms (`npm test && git push`, `cd repo && git push`,
# `git -C <path> push`) are caught too, not only commands that literally start
# with `git push`.
echo "$cmd" | grep -qE "git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push" || exit 0

# Resolve target repo: shared with push-build-gate/hook.sh, which is where the
# `git -C <path> push` bypass this hook also had was originally fixed
# (2026-08-03) — see that file's history for why this couldn't just
# special-case a `cd`. Fail loudly (exit 1 is non-blocking, but its stderr is
# still surfaced — unlike exit 0) if the sibling lib is missing, rather than
# silently letting a failed `source` fall through this advisory hook.
LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/resolve-repo.sh"
if [ ! -r "$LIB" ]; then
  echo "stale-readme-guard: cannot load $LIB — check NOT RUN" >&2
  exit 1
fi
# shellcheck source=../lib/resolve-repo.sh
source "$LIB"
dir=$(resolve_repo_dir "$cmd" "$input")

# `resolve_repo_dir` does not itself validate that `$dir` is a git repo —
# that is this line's job, and a directory it isn't is a silent no-op here
# (this hook is advisory; push-build-gate is where a non-repo cwd matters).
repo=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0

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
  # Emitted through `jq -n --arg`, which encodes $msg for us. The message
  # carries a file list and free prose, so hand-rolled quoting would be
  # escaping-sensitive — the same reason this used json.dumps before. jq rather
  # than python3 because uv is the sole Python manager here and this needs no
  # interpreter: malformed output would be a hook contract violation, not a
  # missing feature.
  jq -n --arg msg "$msg" '{
    hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $msg},
    systemMessage: $msg
  }'
fi

exit 0
