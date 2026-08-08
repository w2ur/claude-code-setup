#!/usr/bin/env bash
#
# distribution-watch.sh — is each committed distribution channel actually done?
#
# WHY THIS IS NOT A CANDIDATE GENERATOR. The obvious version of this script
# proposes "what should I post next". That solves a problem the portfolio does
# not have: on 2026-08-08 the launch journal in
# {portfolio-site}/strategy/strategie-visibilite.md already held FIVE
# decided-but-unexecuted launches from a single day in August — two Reddit
# posts, a LinkedIn post and a newsletter issue, all still "à poster". The
# owner has since stated plainly that the social channels will never happen.
# Generating more candidates would only lengthen a list nobody works from.
#
# So this checks STATE, not ideas. Every channel below is one the owner can
# complete without maintaining a social presence: publish once, indexed
# forever. The script asks the registry or the upstream README whether the
# thing is actually there, and prints the exact next action when it is not.
#
# No model. Deterministic. Read-only — it never posts, publishes or opens a PR.
#
# Usage:
#   distribution-watch.sh
#
# Exit codes:
#   0  every committed channel is complete
#   1  at least one channel has an outstanding action
#   2  a prerequisite is missing (curl absent, no network)
#
# Cadence: fortnightly is plenty — these are publish-once channels, not a feed.
# If it is ever scheduled, note that a model is NOT involved, so plain cron is
# fine (unlike `claude -p`, which cannot reach the macOS login keychain). Give
# the crontab entry an explicit PATH: cron's default (/usr/bin:/bin) has curl
# but the exit-code contract below is worth keeping honest.

set -uo pipefail

command -v curl >/dev/null 2>&1 || { echo "FATAL: curl not on PATH" >&2; exit 2; }
curl -s -o /dev/null --max-time 15 https://registry.npmjs.org/react \
  || { echo "FATAL: no network, or npm registry unreachable — refusing to report" >&2; exit 2; }

outstanding=0
say_ok()     { printf '  \033[32mOK\033[0m       %s\n' "$1"; }
say_action() { printf '  \033[33mACTION\033[0m   %s\n' "$1"; outstanding=$((outstanding + 1)); }

echo "== Package registries =="

# A public library nobody can install is a library nobody finds. npm and PyPI
# are search surfaces that need no audience and no posting.
check_npm() {
  local pkg="$1" repo="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://registry.npmjs.org/$pkg")
  if [ "$code" = "200" ]; then
    say_ok "npm: $pkg is published"
  else
    say_action "npm: $pkg is NOT published (HTTP $code). $repo/package.json currently sets \"private\": true — that is a DELIBERATE setting and its CLAUDE.md requires the owner's explicit sign-off to remove. Decide, do not default."
  fi
}
check_npm french-sentences ~/Dev/french-sentences
check_npm wikimedia-source ~/Dev/wikimedia-source

pypi=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://pypi.org/pypi/midas-core/json)
if [ "$pypi" = "200" ]; then
  say_ok "PyPI: midas-core is published (verified author {author-name}, source {github-username}/midas-core)"
else
  say_action "PyPI: midas-core returns HTTP $pypi — the repo README promises 'pip install', so this must resolve"
fi

echo
echo "== Awesome-list PRs =="

# The two awesome-* forks are kept ONLY to carry these PRs (owner decision,
# 2026-08-08). If no PR is ever opened they revert to being bookmarks and the
# delete recommendation stands — so this check is what keeps that decision
# honest rather than aspirational.
# NOTE: absence from the upstream README does NOT mean "go open a PR". The
# first version of this function made exactly that inference and was wrong on
# both lists — PRs #537 (awesome-quant) and #86 (awesome-systematic-trading)
# had been open since 2026-08-03. Telling the owner to open a duplicate PR is
# worse than saying nothing. So: check the README first, and when the entry is
# absent, ask GitHub whether a PR is already in flight before naming an action.
check_awesome() {
  local upstream="$1" branch="$2" needle="$3"
  local body n pr
  body=$(curl -s --max-time 25 "https://raw.githubusercontent.com/$upstream/$branch/README.md")
  if [ -z "$body" ]; then
    say_action "awesome: could not read $upstream README ($branch) — check the branch name before trusting this"
    return
  fi
  n=$(printf '%s' "$body" | grep -ci -- "$needle" || true)
  if [ "$n" -gt 0 ]; then
    say_ok "awesome: $needle is merged into $upstream"
    return
  fi

  if ! command -v gh >/dev/null 2>&1; then
    say_action "awesome: $needle absent from $upstream, and gh is unavailable to check for an open PR — verify by hand before acting"
    return
  fi
  pr=$(gh api "repos/$upstream/pulls?state=open&per_page=100" \
        --jq '.[] | select(.user.login=="{github-username}") | "#\(.number) opened \(.created_at[0:10])"' 2>/dev/null | head -1)
  if [ -n "$pr" ]; then
    say_ok "awesome: $upstream — PR $pr is open and waiting. Nothing to do; do NOT open a second one."
  else
    say_action "awesome: $needle absent from $upstream and no open {github-username} PR — this is the one case where opening a PR is the action"
  fi
}
check_awesome paperswithbacktest/awesome-systematic-trading main midas-core \
  || check_awesome paperswithbacktest/awesome-systematic-trading master midas-core
check_awesome wilsonfreitas/awesome-quant master midas-core

echo
if [ "$outstanding" -eq 0 ]; then
  echo "All committed channels complete."
  exit 0
fi
echo "$outstanding outstanding action(s)."
echo
echo "Deliberately NOT tracked here: Hacker News, Reddit, and daily social"
echo "posting. Retired 2026-08-08 — the owner does not use those platforms and"
echo "will not start. Leaving them on a checklist manufactures guilt, not reach."
exit 1
