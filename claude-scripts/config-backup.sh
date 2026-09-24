#!/usr/bin/env bash
# Nightly push of the two private config backup repos (my-config-backup and
# my-plugins-backup): commit whatever changed since the last run, scan it
# for secrets first, push. Run by com.example.config-backup at 03:47.
#
# Why a LaunchAgent and not cron: `git push` authenticates through the
# osxkeychain credential helper, and the login keychain is only reachable
# from the GUI session (see the scheduled-jobs skill).
#
# What it backs up: ~/.claude (its .gitignore allow-list decides what is
# tracked) and ~/.claude/plugins/local — NOT a plugin nested there with its
# own git repo, which the outer one ignores. ~/Dev/workflow-guide.html
# is copied into ~/.claude first, since it lives outside every repo.
#
# Secret gate: before each commit, `gitleaks git --staged` runs on the index.
# A finding exits 2 with NOTHING committed or pushed, and the index is reset
# (`git reset -q`) so the next run starts from the same state and stops again
# until a human looks. The repos' own pre-commit hook runs the same scan a
# second time on commit.
#
# Exit: 0 ok · 1 finding · 2 could not run. This script has no "finding" of
# its own: a secret in the index, a missing repo or a failed push all mean
# the backup did not happen, which is 2 (unknown), never 0.
#
# Env overrides (tests):
#   CONFIG_BACKUP_REPOS  colon-separated repo paths
#                        (default $HOME/.claude:$HOME/.claude/plugins/local)
#   GUIDE_SRC / GUIDE_DST  workflow-guide copy (default ~/Dev → ~/.claude)
#
# Liveness line: every exit ends with one timestamped summary line, so the
# log's mtime moves on a clean night too (launchd does not touch it on a run
# that writes nothing) — log age is this job's only stop signal.

set -uo pipefail

START="$(date +%s)"
COMMITS=0
PUSHES=0

finish() {
  local rc=$?
  local ts dur
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dur=$(( $(date +%s) - START ))
  if [ "$rc" -eq 0 ]; then
    echo "$ts config-backup ok: $COMMITS commit(s), $PUSHES push(es), ${dur}s, exit 0"
  else
    echo "$ts config-backup FAILED: exit $rc, ${dur}s" >&2
  fi
}
trap finish EXIT

die() { echo "config-backup: $1" >&2; exit 2; }

[ -n "${HOME:-}" ] || die "HOME is not set"
command -v git >/dev/null || die "git not on PATH"
command -v gitleaks >/dev/null || die "gitleaks not on PATH"

REPOS="${CONFIG_BACKUP_REPOS:-$HOME/.claude:$HOME/.claude/plugins/local}"
GUIDE_SRC="${GUIDE_SRC:-$HOME/Dev/workflow-guide.html}"
GUIDE_DST="${GUIDE_DST:-$HOME/.claude/workflow-guide.html}"

if [ -f "$GUIDE_SRC" ]; then
  cp "$GUIDE_SRC" "$GUIDE_DST" || die "could not copy $GUIDE_SRC"
else
  echo "config-backup: $GUIDE_SRC missing — guide copy skipped" >&2
fi

IFS=: read -r -a repo_list <<< "$REPOS"
for repo in "${repo_list[@]}"; do
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "$repo is not a git repo"

  git -C "$repo" add -A || die "$repo: git add failed"
  if ! git -C "$repo" diff --cached --quiet; then
    if ! (cd "$repo" && gitleaks git --staged --redact --no-banner >&2); then
      git -C "$repo" reset -q
      die "$repo: gitleaks found a secret in the staged changes — nothing committed"
    fi
    git -C "$repo" commit -q -m "chore(backup): nightly snapshot" \
      || die "$repo: commit failed"
    COMMITS=$((COMMITS + 1))
  fi

  ahead="$(git -C "$repo" rev-list --count '@{u}..HEAD' 2>/dev/null)" \
    || die "$repo: no upstream branch"
  if [ "$ahead" -gt 0 ]; then
    git -C "$repo" push -q || die "$repo: push failed"
    PUSHES=$((PUSHES + 1))
  fi
done

exit 0
