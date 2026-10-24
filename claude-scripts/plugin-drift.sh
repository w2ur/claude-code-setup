#!/usr/bin/env bash
# plugin-drift.sh — does every installed copy of a local plugin still match its
# source under ~/.claude/plugins/local?
#
# Why it exists: `claude plugin install` copies a plugin into plugins/cache, and
# editing plugins/local/<p>/ afterwards changes nothing that runs until a
# reinstall. A stale copy answers with the old prompt and nothing says so.
#
# For each directory <p> under plugins/local, every entry of
# installed_plugins.json keyed `<p>@local` is compared, in every scope, via its
# installPath (several scopes often share one path; each path is diffed once).
# `.git` and `__pycache__` are excluded from the comparison.
#
# Exit: 0 every copy matches · 1 drift (one line per differing file, naming
# plugin, version and file) · 2 could not run: manifest unreadable, no local
# plugin found, or a bad toolchain — *unknown*, never "healthy".
#
# Env override (tests): CLAUDE_DIR (default $HOME/.claude).
set -uo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
MANIFEST="$CLAUDE_DIR/plugins/installed_plugins.json"
LOCAL="$CLAUDE_DIR/plugins/local"

die() { echo "plugin-drift: $1" >&2; exit 2; }

command -v jq >/dev/null || die "jq not on PATH"
[ -r "$MANIFEST" ] || die "manifest unreadable: $MANIFEST"
jq -e '.plugins | type == "object"' "$MANIFEST" >/dev/null 2>&1 \
  || die "manifest has no .plugins object: $MANIFEST"
[ -d "$LOCAL" ] || die "no local plugins directory: $LOCAL"

found=0
drift=0
for dir in "$LOCAL"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  found=$((found + 1))
  # unique "version<TAB>installPath" pairs across all scopes
  while IFS=$'\t' read -r version path; do
    [ -n "$path" ] || continue
    if [ ! -d "$path" ]; then
      echo "DRIFT $name@$version: installed copy missing ($path)"
      drift=$((drift + 1))
      continue
    fi
    out="$(diff -rq -x .git -x __pycache__ "${dir%/}" "$path" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      continue
    elif [ "$rc" -ne 1 ]; then
      die "diff failed for $name@$version (exit $rc)"
    fi
    while IFS= read -r line; do
      line="${line//${dir%/}/<local>}"
      line="${line//$path/<installed>}"
      echo "DRIFT $name@$version: $line"
      drift=$((drift + 1))
    done <<< "$out"
  done < <(jq -r --arg k "$name@local" \
    '.plugins[$k] // [] | map([.version, .installPath] | @tsv) | unique[]' "$MANIFEST")
done

[ "$found" -gt 0 ] || die "zero local plugins found under $LOCAL"
if [ "$drift" -gt 0 ]; then
  echo "plugin-drift: $drift differing file(s)" >&2
  exit 1
fi
exit 0
