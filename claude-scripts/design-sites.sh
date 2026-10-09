#!/usr/bin/env bash
# Every live website of the portfolio, DERIVED (never hand-listed), for the
# design audit. Sources, unioned: (a) `gh repo list` homepages, (b) the hub
# inventory's reachable URLs (inventory.json `.urls` is an OBJECT keyed by URL,
# so it is read through to_entries, never `.urls[]`).
#
# Rules: forks dropped; code/package hosts (github.com, npmjs.com) dropped;
# `www.` and a trailing /fr /en locale segment are ignored for dedupe (the
# first-seen URL is printed); the hub host collapses to ONE site (its /en/stories/*
# and drift.html pages belong to the hub, one audit per host) and is printed as
# its root with the hub repo attributed when a repo's homepage is that root.
# An inventory URL is attributed to a repo by host match against inventory
# `.repos.*.homepage`, then against the gh list; else the repo column is `-`
# ("no repo context", never `?`). When several gh repos share a homepage host
# (a repo and its generated mirror), the tiebreak is deterministic, never gh
# order: the repo with `$DEV_DIR/<repo>/CLAUDE.md` first, then the shorter name,
# then alphabetical.
#
# stdout: `<repo>\t<url>` per site. stderr: `gap\t<repo>` for each git repo in
# $DEV_DIR carrying a deploy config (vercel.json, wrangler.toml, netlify.toml,
# next.config.*) whose repo has no homepage in the gh list. A wrangler.toml
# with no `[assets]` or `[site]` table is an API worker, not a site, and does
# not count as a deploy config.
# Test overrides: GH_JSON (gh output fixture), INVENTORY_JSON, DEV_DIR.
#
# THIS SCRIPT IS THE SOURCE OF TRUTH for the exclusion list and the hub host.
#
# Exit 0 = list complete. 1 = gaps found (list still printed). 2 = could not
# run (gh failed, unreadable/invalid input, an empty list, or a DEV_DIR that is
# missing or holds no git repo, so the gap check cannot run) — UNKNOWN, never
# "no sites".
set -uo pipefail

GH_OWNER="{github-username}"
HUB_HOST="{portfolio-site-url}"
INVENTORY_JSON="${INVENTORY_JSON:-$HOME/Dev/{portfolio-site}/src/data/inventory.json}"
DEV_DIR="${DEV_DIR:-$HOME/Dev}"

shopt -s nullglob
repos_in_dev=("$DEV_DIR"/*/.git)
(( ${#repos_in_dev[@]} > 0 )) || { echo "no git repo under DEV_DIR ($DEV_DIR): gap check cannot run" >&2; exit 2; }

if [[ -n "${GH_JSON:-}" ]]; then
  gh_out=$(cat "$GH_JSON") || { echo "cannot read GH_JSON: $GH_JSON" >&2; exit 2; }
else
  gh_out=$(gh repo list "$GH_OWNER" --limit 500 --no-archived --json name,homepageUrl,isFork,isPrivate) \
    || { echo "gh repo list failed" >&2; exit 2; }
fi
jq -e 'type == "array"' <<<"$gh_out" >/dev/null 2>&1 || { echo "gh output is not a JSON array" >&2; exit 2; }

inv_out=$(cat "$INVENTORY_JSON") || { echo "cannot read inventory: $INVENTORY_JSON" >&2; exit 2; }
jq -e 'type == "object"' <<<"$inv_out" >/dev/null 2>&1 || { echo "inventory is not a JSON object" >&2; exit 2; }

claude_repos=$(jq -r '.[].name' <<<"$gh_out" | while IFS= read -r r; do [[ -e "$DEV_DIR/$r/CLAUDE.md" ]] && printf '%s\n' "$r"; done | jq -R . | jq -s .)

sites=$(jq -rn --argjson gh "$gh_out" --argjson inv "$inv_out" --arg hub "$HUB_HOST" --argjson claude "$claude_repos" '
  def host: sub("^https?://"; "") | split("/")[0] | ascii_downcase | sub("^www\\."; "");
  def path: sub("^https?://[^/]*"; "") | sub("[?#].*$"; "") | sub("/(fr|en)/?$"; "") | sub("/+$"; "");
  def key: if host == $hub then host else host + path end;
  def excluded: host | IN("github.com", "npmjs.com");
  def rooturl: path == "" ;
  [ $gh[] | select(.isFork | not) | select((.homepageUrl // "") != "") ]
    | sort_by([(if (.name | IN($claude[])) then 0 else 1 end), (.name | length), .name]) as $ghrepos
  | [ ($inv.repos // {}) | to_entries[] | select((.value.homepage // "") != "")
      | {repo: .key, url: .value.homepage} ] as $invrepos
  | def attribute($u):
      ( [ $invrepos[] | select((.url | host) == ($u | host)) ]
        + [ $ghrepos[] | {repo: .name, url: .homepageUrl} | select((.url | host) == ($u | host)) ] )
      | (map(select(.url | rooturl)) + .) | (.[0].repo // "-");
    ( [ $ghrepos[] | {repo: .name, url: .homepageUrl} ]
      + [ ($inv.urls // {}) | to_entries[] | select(.value.ok == true) | .key | {repo: attribute(.), url: .} ] )
  | map(select(.url | excluded | not))
  | reduce .[] as $e ([];
      ($e.url | key) as $k
      | (map(.key) | index($k)) as $i
      | if $i == null then . + [{key: $k, repo: $e.repo, url: $e.url, root: ($e.url | rooturl)}]
        elif (.[$i].repo == "-" and $e.repo != "-") then .[$i].repo = $e.repo
        elif ($e.url | rooturl) and (.[$i].root | not) then .[$i].repo = $e.repo | .[$i].root = true
        else . end)
  | .[] | [.repo, (if (.url | host) == $hub then "https://\($hub)" else .url end)] | @tsv')

[[ -n "$sites" ]] || { echo "no sites derived: empty list is unknown" >&2; exit 2; }
printf '%s\n' "$sites"

homepaged=$(jq -r '.[] | select(.isFork | not) | select((.homepageUrl // "") != "") | .name' <<<"$gh_out")
rc=0
for dir in "$DEV_DIR"/*/; do
  dir=${dir%/}; name=${dir##*/}
  [[ -e "$dir/.git" ]] || continue
  deploy=0
  for f in "$dir"/vercel.json "$dir"/wrangler.toml "$dir"/netlify.toml "$dir"/next.config.*; do
    [[ -e "$f" ]] || continue
    [[ "$f" == */wrangler.toml ]] && ! grep -Eq '^[[:space:]]*\[(assets|site)\]' "$f" && continue   # API worker
    deploy=1; break
  done
  (( deploy )) || continue
  grep -Fxq -- "$name" <<<"$homepaged" || { printf 'gap\t%s\n' "$name" >&2; rc=1; }
done
exit $rc
