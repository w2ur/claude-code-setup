#!/usr/bin/env bash
#
# sync-repo-about.sh — push each repo's Layer 2 pitch to its GitHub "About".
#
# The portfolio already has a source of truth for a one-line project pitch:
# `tagline_en` in the README frontmatter (Layer 2 of the M12 architecture).
# GitHub's repo description is a second place for the same string, and a
# hand-typed second copy is a copy that drifts — which is the exact failure
# mode decision M12 retired `.portfolio.yml` to stop.
#
# So: read Layer 2, write GitHub. Never the reverse, and never invent copy.
#
# TWO AUDIENCES, TWO FIELDS. The first version of this script pushed
# `tagline_en` everywhere and the dry run showed why that is wrong: a tagline
# is editorial voice written for a portfolio tile, where the surrounding page
# already supplies the context. A GitHub About is functional orientation for
# someone who landed on the repo with no context at all. Collapsing them
# turned "Claude Code hooks, agents and commands for running 10+ personal apps
# without babysitting every diff — MIT, 2 blocking hooks included" into "My
# Claude Code workflow, anonymized and documented", which is a real loss on
# the public repos where the About does the most work.
#
# So the frontmatter may carry an optional `about_en`, and this script prefers
# it. Where a repo has no `about_en`, the tagline is the right About and gets
# used. Still exactly one source of truth per string, still living in the repo
# that owns it — the split is between audiences, not between copies.
#
# No model involved. Deterministic. Safe by default (dry-run).
#
# Usage:
#   sync-repo-about.sh              # dry run — print what would change
#   sync-repo-about.sh --apply      # actually write to GitHub
#   DEV_DIR=/tmp/fixture sync-repo-about.sh   # run against a fixture tree
#
# Exit codes:
#   0  every repo either matches or was updated
#   1  at least one repo could not be processed (bad frontmatter, no remote)
#   2  a prerequisite is missing (gh not on PATH, not authenticated)
#
# NOTE ON PATH: if this is ever invoked from cron, cron's default PATH
# (/usr/bin:/bin) does not contain `gh`. Set PATH explicitly in the crontab
# entry. This script exits 2 rather than silently skipping every repo,
# because a monitor that degrades to a no-op is worse than one that fails.

set -uo pipefail

DEV_DIR="${DEV_DIR:-$HOME/Dev}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

if ! command -v gh >/dev/null 2>&1; then
  echo "FATAL: gh is not on PATH (PATH=$PATH)" >&2
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "FATAL: gh is not authenticated" >&2
  exit 2
fi
if [ ! -d "$DEV_DIR" ]; then
  echo "FATAL: DEV_DIR does not exist: $DEV_DIR" >&2
  exit 2
fi

# Repos deliberately excluded, with the reason. Keep this list short and
# justified — an unexplained exclusion becomes an unnoticed gap.
#
#   analytics — README is vendored verbatim from upstream Umami. Adding our
#               frontmatter to it would conflict on the next vendor sync, and
#               its About is already accurate and hand-set.
#   {github-username}      — the GitHub *profile* repo: its README.md is rendered as the
#               public profile page at github.com/{github-username}. GitHub renders YAML
#               frontmatter as a visible table, so Layer 2 keys would show up
#               as clutter at the top of the profile. Its About is hand-set.
EXCLUDED="analytics {github-username}"

# Extract a scalar from the README's YAML frontmatter (first --- block only).
# Strips surrounding single or double quotes. Empty output means absent.
read_frontmatter() {
  awk -v key="$2" '
    /^---[[:space:]]*$/ { n++; next }
    n == 1 && index($0, key ":") == 1 {
      sub(/^[^:]*:[[:space:]]*/, "")
      sub(/[[:space:]]+$/, "")
      # strip matching outer quotes
      if ((substr($0,1,1) == "\"" && substr($0,length($0),1) == "\"") ||
          (substr($0,1,1) == "'"'"'" && substr($0,length($0),1) == "'"'"'"))
        $0 = substr($0, 2, length($0) - 2)
      print
      exit
    }
    n >= 2 { exit }
  ' "$1"
}

changed=0; matched=0; skipped=0; failed=0

for dir in "$DEV_DIR"/*/; do
  repo_dir="${dir%/}"
  name="$(basename "$repo_dir")"
  [ -d "$repo_dir/.git" ] || continue

  case " $EXCLUDED " in
    *" $name "*) printf '  %-24s SKIP     (deliberately excluded)\n' "$name"
                 skipped=$((skipped + 1)); continue ;;
  esac

  # The remote is the authority on the repo's name, not the folder name —
  # they are supposed to match, and this is where we find out they don't.
  remote="$(git -C "$repo_dir" remote get-url origin 2>/dev/null)"
  if [ -z "$remote" ]; then
    printf '  %-24s SKIP     (no origin remote — not a GitHub repo)\n' "$name"
    skipped=$((skipped + 1)); continue
  fi
  slug="$(printf '%s' "$remote" | sed -E 's#(git@github\.com:|https://github\.com/)##; s#\.git$##')"
  case "$slug" in
    */*) ;;
    *) printf '  %-24s FAIL     (unparseable remote: %s)\n' "$name" "$remote"
       failed=$((failed + 1)); continue ;;
  esac

  if [ "${slug#*/}" != "$name" ]; then
    printf '  %-24s WARN     folder name != repo name (%s)\n' "$name" "$slug"
  fi

  readme="$repo_dir/README.md"
  if [ ! -f "$readme" ]; then
    printf '  %-24s SKIP     (no README.md)\n' "$name"
    skipped=$((skipped + 1)); continue
  fi

  # `about_en` wins when present; `tagline_en` is the fallback. See the
  # two-audiences note in the header for why both exist.
  want="$(read_frontmatter "$readme" about_en)"
  src="about_en"
  if [ -z "$want" ]; then
    want="$(read_frontmatter "$readme" tagline_en)"
    src="tagline_en"
  fi
  if [ -z "$want" ]; then
    printf '  %-24s FAIL     (no about_en or tagline_en in README frontmatter)\n' "$name"
    failed=$((failed + 1)); continue
  fi

  have="$(gh repo view "$slug" --json description --jq '.description' 2>/dev/null)"
  if [ "$have" = "$want" ]; then
    printf '  %-24s ok\n' "$name"
    matched=$((matched + 1)); continue
  fi

  if [ "$APPLY" -eq 1 ]; then
    if gh repo edit "$slug" --description "$want" >/dev/null 2>&1; then
      printf '  %-24s UPDATED  %s\n' "$name" "$want"
      changed=$((changed + 1))
    else
      printf '  %-24s FAIL     (gh repo edit rejected the write)\n' "$name"
      failed=$((failed + 1))
    fi
  else
    printf '  %-24s WOULD SET  (from %s)\n      from: %s\n      to:   %s\n' "$name" "$src" "${have:-<empty>}" "$want"
    changed=$((changed + 1))
  fi
done

echo
if [ "$APPLY" -eq 1 ]; then
  echo "updated=$changed  already-correct=$matched  skipped=$skipped  failed=$failed"
else
  echo "would-update=$changed  already-correct=$matched  skipped=$skipped  failed=$failed"
  echo "(dry run — re-run with --apply to write)"
fi

[ "$failed" -gt 0 ] && exit 1
exit 0
