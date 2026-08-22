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

# --json exists for vigie, following the precedent model-watch.sh set. The exit
# contract is IDENTICAL in both modes (0 complete / 1 outstanding / 2 could not
# run) because vigie reads the code as well as the payload: exit 1 is a finding,
# exit 2 means the report is untrustworthy.
JSON_MODE=false
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=true ;;
    *) echo "FATAL: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# The FATAL guards below stay exactly as they are in JSON mode: they write to
# stderr and exit 2, which is already the right shape. They must NOT become JSON
# rows — a row implies the check ran, and exit 2 means nothing here can be
# trusted.
command -v curl >/dev/null 2>&1 || { echo "FATAL: curl not on PATH" >&2; exit 2; }
curl -s -o /dev/null --max-time 15 https://registry.npmjs.org/react \
  || { echo "FATAL: no network, or npm registry unreachable — refusing to report" >&2; exit 2; }

# ---------------------------------------------------------------- Python (uv)
# uv is the sole Python manager on this machine, so the interpreter is resolved
# explicitly instead of inherited from a bare `python3`, which is not
# trustworthy here: it resolves to /opt/homebrew/bin/python3, which exists ONLY
# as a dependency of gcloud-cli/mpv/yt-dlp/vapoursynth/peon-ping, and behind it
# sits Apple's /usr/bin/python3 (3.9.6). Order: `uv python find` (forced to
# managed-only), then uv's ~/.local/bin shim, since the scheduled PATHs are not
# uniform about carrying uv.
#
# exit 2, matching the curl/network guards above: Python is what escapes every
# JSON field, so without it this script cannot emit a trustworthy row at all —
# and a row implies the check ran.
resolve_uv_python() {
  local candidate
  if command -v uv >/dev/null 2>&1; then
    candidate="$(UV_PYTHON_PREFERENCE=only-managed uv python find 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  fi
  # Sorted on the MINOR field numerically: a lexical sort puts 3.9 above 3.12.
  candidate="$(printf '%s\n' "$HOME"/.local/bin/python3.* 2>/dev/null \
               | grep -E '/python3\.[0-9]+$' | sort -t. -k2,2n | tail -1)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  return 1
}
PYTHON="$(resolve_uv_python || true)"
[ -n "$PYTHON" ] || { echo "FATAL: no uv-managed Python found (uv python find failed and no ~/.local/bin/python3.N shim) — refusing to report" >&2; exit 2; }

outstanding=0
JSON_ROWS=()

json_escape() { printf '%s' "$1" | "$PYTHON" -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }
emit_json_row() { # kind name state detail
  JSON_ROWS+=("{\"kind\":$(json_escape "$1"),\"name\":$(json_escape "$2"),\"state\":$(json_escape "$3"),\"detail\":$(json_escape "$4")}")
}

# say_ok / say_action take (kind, name, message). `outstanding` is incremented in
# BOTH modes — the exit code is computed from it, so a JSON run that skipped it
# would exit 0 while reporting outstanding work.
say_ok() {
  if $JSON_MODE; then emit_json_row "$1" "$2" "ok" "$3"; return; fi
  printf '  \033[32mOK\033[0m       %s\n' "$3"
}
say_action() {
  outstanding=$((outstanding + 1))
  if $JSON_MODE; then emit_json_row "$1" "$2" "action" "$3"; return; fi
  printf '  \033[33mACTION\033[0m   %s\n' "$3"
}

# Section headers are prose for a person; in JSON mode they would corrupt stdout.
section() { $JSON_MODE || echo "$1"; }

section "== Package registries =="

# A public library nobody can install is a library nobody finds. npm and PyPI
# are search surfaces that need no audience and no posting.
check_npm() {
  local pkg="$1" repo="$2"
  local code private note
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://registry.npmjs.org/$pkg")
  if [ "$code" = "200" ]; then
    say_ok npm "$pkg" "npm: $pkg is published"
    return
  fi

  # READ the private flag rather than assert it. This message used to state
  # flatly that the repo sets "private": true and that removing it needs the
  # owner's sign-off — which stopped being true for free-image-source the day
  # that sign-off was given, leaving the watcher confidently wrong. A watcher
  # that narrates unverified state is worse than one that says nothing.
  private=$(sed -n 's/.*"private"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$repo/package.json" 2>/dev/null | head -1)
  case "$private" in
    true)  note="$repo/package.json still sets \"private\": true — a DELIBERATE setting its CLAUDE.md requires the owner's explicit sign-off to remove. Decide, do not default." ;;
    "")    note="$repo/package.json sets no \"private\" flag, so nothing blocks a publish but the publish itself." ;;
    *)     note="$repo/package.json sets \"private\": $private — publishable, and not yet published." ;;
  esac
  say_action npm "$pkg" "npm: $pkg is NOT published (HTTP $code). $note"
}
check_npm french-sentences ~/Dev/french-sentences
check_npm free-image-source ~/Dev/free-image-source

pypi=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://pypi.org/pypi/midas-core/json)
if [ "$pypi" = "200" ]; then
  say_ok pypi midas-core "PyPI: midas-core is published (verified author {author-name}, source {github-username}/midas-core)"
else
  say_action pypi midas-core "PyPI: midas-core returns HTTP $pypi — the repo README promises 'pip install', so this must resolve"
fi

section ""
section "== Awesome-list PRs =="

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
    say_action awesome "$upstream" "awesome: could not read $upstream README ($branch) — check the branch name before trusting this"
    return
  fi
  n=$(printf '%s' "$body" | grep -ci -- "$needle" || true)
  if [ "$n" -gt 0 ]; then
    say_ok awesome "$upstream" "awesome: $needle is merged into $upstream"
    return
  fi

  if ! command -v gh >/dev/null 2>&1; then
    say_action awesome "$upstream" "awesome: $needle absent from $upstream, and gh is unavailable to check for an open PR — verify by hand before acting"
    return
  fi
  pr=$(gh api "repos/$upstream/pulls?state=open&per_page=100" \
        --jq '.[] | select(.user.login=="{github-username}") | "#\(.number) opened \(.created_at[0:10])"' 2>/dev/null | head -1)
  if [ -n "$pr" ]; then
    say_ok awesome "$upstream" "awesome: $upstream — PR $pr is open and waiting. Nothing to do; do NOT open a second one."
  else
    say_action awesome "$upstream" "awesome: $needle absent from $upstream and no open {github-username} PR — this is the one case where opening a PR is the action"
  fi
}
check_awesome paperswithbacktest/awesome-systematic-trading main midas-core \
  || check_awesome paperswithbacktest/awesome-systematic-trading master midas-core
check_awesome wilsonfreitas/awesome-quant master midas-core

section ""
section "== Chrome Web Store =="

# A LISTING THAT HAS BEEN TAKEN DOWN LOOKS EXACTLY LIKE A HEALTHY ONE to a
# status-code check. Measured 2026-08-22: the Store answers HTTP 200 for any
# 32-character extension ID, including one that has never existed — it simply
# resolves to .../detail/empty-title/<id>. So `res.ok` is unfalsifiable here,
# and the assertion has to be on the SLUG in the resolved URL.
#
# My Socratic App was rejected twice before it went live (keyword spam in the listing
# description, case "Yellow Argon"). A later takedown or an accidental
# unpublish would otherwise be completely silent — the extension keeps working
# for everyone who already installed it, so nothing breaks visibly.
#
# The control is INSIDE the check on purpose. A one-off measurement in a
# comment rots; re-proving at runtime that a nonexistent listing is
# distinguishable is what makes today's OK mean something. If the two ever
# resolve alike, this reports an action rather than a pass — the same shape
# check_awesome uses when it cannot read a README.
check_webstore() {
  local id="$1" slug="$2"
  local base='https://chromewebstore.google.com/detail'
  local live control

  live=$(curl -s -o /dev/null -L --max-time 25 -w '%{url_effective}' "$base/$id") || {
    say_action webstore "$slug" "Chrome Web Store: could not reach the listing for $slug — verify by hand before trusting this"
    return
  }
  control=$(curl -s -o /dev/null -L --max-time 25 -w '%{url_effective}' "$base/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") || control=''

  if [ -z "$control" ] || [ "${control##*/detail/}" = "${live##*/detail/}" ]; then
    say_action webstore "$slug" "Chrome Web Store: the control did not distinguish a nonexistent listing, so this check proves nothing today — verify $slug by hand"
    return
  fi

  case "$live" in
    */detail/"$slug"/"$id"*)
      say_ok webstore "$slug" "Chrome Web Store: $slug is published and resolves to its own slug" ;;
    *)
      say_action webstore "$slug" "Chrome Web Store: $slug did NOT resolve to its own slug (got $live) — the listing may have been unpublished or taken down" ;;
  esac
}
check_webstore bodfmokjnmkkdobfcnfbplnbplgdbfgl my-socratic-app

if $JSON_MODE; then
  printf '{"channels":[%s],"outstanding":%d}\n' "$(IFS=,; echo "${JSON_ROWS[*]}")" "$outstanding"
  [ "$outstanding" -eq 0 ] && exit 0 || exit 1
fi

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
