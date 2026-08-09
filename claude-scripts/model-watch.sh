#!/usr/bin/env bash
# Reports whether the OpenRouter models each repo has configured are still
# listed and still free.
#
# This exists because the model chain hides its own degradation: OpenRouter
# walks to the next entry on a runtime failure, so a failing primary produces a
# perfectly good 200 and the service can sit on the last entry for weeks looking
# healthy.
#
# Delisting is worse and is why this runs weekly rather than never. Measured
# 2026-08-08: OpenRouter validates the whole `models` array up front, so ONE
# unlisted entry returns 400 for a request the primary could have served. A
# delisted model in position 2 is not a degradation, it is an outage — and
# nothing in the request path reports it until users do.
#
# Models are DISCOVERED from each repo's wrangler.toml, never hand-listed, so a
# new project that uses OpenRouter is covered without editing this file — the
# same principle as usage-watch.sh discovering hosts from the Vercel API.
#
# Reports state; never edits config. Choosing a replacement needs an eval set,
# which is what my-socratic-app/scripts/bake-off.mjs is for.
#
# Exit: 0 all configured models present and free; 1 at least one missing or now
# priced; 2 the check could not run (no jq, no network).
set -euo pipefail

DEV_DIR="${DEV_DIR:-$HOME/Dev}"
JSON_OUTPUT=false
[ "${1:-}" = "--json" ] && JSON_OUTPUT=true

command -v jq >/dev/null 2>&1 || { echo "WARN: jq not found — cannot run. Add /opt/homebrew/bin to PATH." >&2; exit 2; }

catalogue=$(curl -sS --max-time 20 https://openrouter.ai/api/v1/models) \
  || { echo "WARN: could not reach the OpenRouter models endpoint." >&2; exit 2; }

free_ids=$(printf '%s' "$catalogue" \
  | jq -r '.data[] | select(.pricing.prompt=="0" and .pricing.completion=="0") | .id' | sort)

if [ -z "$free_ids" ]; then
  echo "WARN: the models endpoint returned zero free models — treating as unreachable rather than as everything being delisted." >&2
  exit 2
fi

findings=""
status=0

while IFS= read -r toml; do
  grep -q 'openrouter\.ai' "$toml" 2>/dev/null || continue
  repo=$(basename "$(dirname "$toml")")
  chain=$(grep -E '^[[:space:]]*UPSTREAM_MODEL[[:space:]]*=' "$toml" | head -1 | sed -E 's/.*=[[:space:]]*"([^"]*)".*/\1/')
  [ -n "$chain" ] || continue

  rank=0
  while IFS= read -r model; do
    [ -n "$model" ] || continue
    rank=$((rank + 1))
    if printf '%s\n' "$free_ids" | grep -qxF "$model"; then
      findings="${findings}${repo}\t${rank}\t${model}\tok\n"
    else
      findings="${findings}${repo}\t${rank}\t${model}\tMISSING\n"
      status=1
    fi
  done <<< "$(printf '%s' "$chain" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
done < <(find "$DEV_DIR" -maxdepth 2 -name wrangler.toml -not -path '*/node_modules/*' 2>/dev/null)

if [ -z "$findings" ]; then
  echo "No repo under $DEV_DIR configures an OpenRouter upstream."
  exit 0
fi

if $JSON_OUTPUT; then
  printf '%b' "$findings" | jq -R -s -c 'split("\n") | map(select(length>0) | split("\t"))
    | map({repo:.[0], rank:(.[1]|tonumber), model:.[2], state:.[3]})
    | {checked_models: length, missing: map(select(.state=="MISSING")) | length, entries: .}'
else
  echo "OpenRouter model availability"
  echo
  printf '%b' "$findings" | awk -F'\t' '{printf "  %-16s #%s  %-48s %s\n", $1, $2, $3, $4}'
  echo
  if [ "$status" -eq 1 ]; then
    echo "At least one configured model is no longer listed as free."
    echo "Re-pick with: OPENROUTER_API_KEY=... node ~/Dev/my-socratic-app/scripts/bake-off.mjs --max-tokens=8000"
  else
    echo "All configured models present and free."
  fi
fi

exit "$status"
