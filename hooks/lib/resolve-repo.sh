#!/bin/bash
# resolve-repo.sh — shared "which directory does this git command target"
# helper for push/README hooks. Sourced, not executed — the shebang is here
# only so shellcheck knows the target shell.
#
# resolve_repo_dir <cmd> <input>
#   cmd   — the shell command text (already extracted from tool_input.command)
#   input — the raw PreToolUse JSON, for its .cwd fallback
#
# Prints a directory on stdout. That directory is NOT necessarily a git repo
# and NOT necessarily a repo's toplevel — resolving the actual repo, and
# deciding what to do when there isn't one, is deliberately left to the
# caller. An earlier version of this helper tried to be helpful and silently
# returned the raw directory whenever `git rev-parse --show-toplevel` failed
# on it; combined with push-build-gate's nested-package scan, that turned
# `git push` run from ANY non-repo directory (e.g. `~/Dev`, or any directory
# merely mentioning the words "git push") into a build of every child repo
# underneath it — reproduced live on 2026-09-24, see the D11 fix-round-1
# review. The caller is expected to immediately follow this with its own
#   repo=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
# so a directory this helper couldn't place in a real repo is a no-op, never
# a guess.
#
# Priority, matching where a `cd` or `-C` would actually land at PreToolUse
# time (nothing in the command has executed yet):
#   1. `git -C <path> ... push`  — explicit target, wins over stdin cwd
#   2. leading `cd <path> &&`    — the shell hasn't cd'd yet, so read it here
#   3. stdin cwd
#   4. this process's $PWD
resolve_repo_dir() {
  local cmd="$1" input="$2" dir

  dir=$(echo "$cmd" | sed -E -n 's/.*git[[:space:]]+-C[[:space:]]+([^[:space:]]+).*/\1/p' | head -1 | sed -E -e "s/^['\"]//" -e "s/['\"]\$//")
  if [ -z "$dir" ]; then
    dir=$(echo "$cmd" | sed -E -n 's/^[[:space:]]*cd[[:space:]]+([^&]*)&&.*/\1/p' | sed -E -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]\$//")
  fi
  dir="${dir/#\~/$HOME}"
  if [ -z "$dir" ]; then
    dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
  fi
  [ -z "$dir" ] && dir="$PWD"

  printf '%s' "$dir"
}
