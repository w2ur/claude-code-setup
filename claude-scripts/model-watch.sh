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
# Models are DISCOVERED, never hand-listed — from each repo's wrangler.toml
# (`UPSTREAM_MODEL` chains) and from each repo's Netlify functions (`url:` /
# `model:` literal pairs) — so a new project is covered without editing this
# file, the same principle as usage-watch.sh discovering hosts from the Vercel
# API. The second source exists because the first missed an outage: my-bias-app's
# Groq model lived in a .ts constant, was retired on 2026-08-16, and nothing
# here looked at it for two weeks.
#
# Groq has no public free catalogue, so its models are checked the other way
# round: against the public deprecations page. Only the FIRST <code> of each
# table row is read — the retired id — because the third column names the
# replacement, and a substring grep over the whole page flagged
# openai/gpt-oss-120b as retired on its first run for exactly that reason.
# The retired set must still contain a model known to be retired
# (llama-3.3-70b-versatile) or the probe is treated as broken (exit 2) rather
# than as everything being current.
#
# Reports state; never edits config. Choosing a replacement needs an eval set,
# which is what elenchus/scripts/bake-off.mjs is for.
#
# Exit: 0 all configured models present and free (OpenRouter) or not retired
# (Groq); 1 at least one missing, priced or retired; 2 the check could not run
# (no jq, no network, a probe page that no longer names a known-retired model).
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
      findings="${findings}${repo}\t${rank}\t${model}\tok\topenrouter\n"
    else
      findings="${findings}${repo}\t${rank}\t${model}\tMISSING\topenrouter\n"
      status=1
    fi
  done <<< "$(printf '%s' "$chain" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
done < <(find "$DEV_DIR" -maxdepth 2 -name wrangler.toml -not -path '*/node_modules/*' 2>/dev/null)

# Second source: Netlify functions. A `url: '…'` literal sets the provider for
# the `model: '…'` literals that follow it — the layout of the UPSTREAMS block
# in my-bias-app's analyze-biases.ts. \x27 is the single quote, kept out of the
# shell's own quoting.
read -r -d '' extract_pairs <<'AWK' || true
match($0, /url:[[:space:]]*\x27[^\x27]+\x27/)   { u = substr($0, RSTART, RLENGTH); sub(/url:[[:space:]]*\x27/, "", u); sub(/\x27$/, "", u); host = u }
match($0, /model:[[:space:]]*\x27[^\x27]+\x27/) { m = substr($0, RSTART, RLENGTH); sub(/model:[[:space:]]*\x27/, "", m); sub(/\x27$/, "", m); print host "\t" m }
AWK
groq_pairs=""
while IFS= read -r fn; do
  grep -qE 'api\.groq\.com|openrouter\.ai' "$fn" 2>/dev/null || continue
  repo=$(printf '%s' "$fn" | sed -E "s#^$DEV_DIR/([^/]+)/.*#\\1#")
  rank=0
  while IFS=$'\t' read -r host model; do
    [ -n "$model" ] || continue
    rank=$((rank + 1))
    case "$host" in
      *openrouter.ai*)
        if printf '%s\n' "$free_ids" | grep -qxF "$model"; then
          findings="${findings}${repo}\t${rank}\t${model}\tok\topenrouter\n"
        else
          findings="${findings}${repo}\t${rank}\t${model}\tMISSING\topenrouter\n"
          status=1
        fi ;;
      *api.groq.com*)
        groq_pairs="${groq_pairs}${repo}\t${rank}\t${model}\n" ;;
    esac
  done < <(awk "$extract_pairs" "$fn")
done < <(find "$DEV_DIR" -maxdepth 5 -path '*/netlify/functions/*.ts' -not -path '*/node_modules/*' -not -path '*/__tests__/*' -not -path '*/lib/*' -not -name '*.test.ts' 2>/dev/null)

if [ -n "$groq_pairs" ]; then
  page=$(curl -sSL --max-time 20 https://console.groq.com/docs/deprecations) \
    || { echo "WARN: could not reach the Groq deprecations page." >&2; exit 2; }
  # One line per table row, then the first <code>…</code> of each row.
  retired=$(printf '%s' "$page" | sed 's/<tr/\n<tr/g' | grep '^<tr' \
    | awk 'match($0, /<code[^>]*>[^<]+<\/code>/) { c = substr($0, RSTART, RLENGTH); sub(/<code[^>]*>/, "", c); sub(/<\/code>$/, "", c); print c }' \
    | sort -u)
  # Falsifying control: the retired set must still name a model we KNOW is
  # retired, or an empty/odd set would mean the page changed shape, not that
  # every model is safe. Here-strings, not pipes: under pipefail, `grep -q`
  # closing the pipe on its first match gives printf a SIGPIPE on a large
  # string, and the "failure" of that pipeline reads as "not found".
  if ! grep -qxF 'llama-3.3-70b-versatile' <<< "$retired"; then
    echo "WARN: the Groq deprecations page no longer names llama-3.3-70b-versatile — probe shape changed, cannot judge Groq models." >&2
    exit 2
  fi
  while IFS=$'\t' read -r repo rank model; do
    [ -n "$model" ] || continue
    if grep -qxF "$model" <<< "$retired"; then
      findings="${findings}${repo}\t${rank}\t${model}\tRETIRED\tgroq\n"
      status=1
    else
      findings="${findings}${repo}\t${rank}\t${model}\tok\tgroq\n"
    fi
  done <<< "$(printf '%b' "$groq_pairs")"
fi

if [ -z "$findings" ]; then
  echo "No repo under $DEV_DIR configures an OpenRouter or Groq upstream."
  exit 0
fi

if $JSON_OUTPUT; then
  printf '%b' "$findings" | jq -R -s -c 'split("\n") | map(select(length>0) | split("\t"))
    | map({repo:.[0], rank:(.[1]|tonumber), model:.[2], state:.[3], provider:.[4]})
    | {checked_models: length, missing: map(select(.state!="ok")) | length, entries: .}'
else
  echo "Configured model availability"
  echo
  printf '%b' "$findings" | awk -F'\t' '{printf "  %-16s #%s  %-11s %-40s %s\n", $1, $2, $5, $3, $4}'
  echo
  if [ "$status" -eq 1 ]; then
    echo "At least one configured model is no longer listed as free, or is retired."
    echo "Re-pick with: OPENROUTER_API_KEY=... node ~/Dev/elenchus/scripts/bake-off.mjs --max-tokens=8000"
  else
    echo "All configured models present and free (OpenRouter) or not retired (Groq)."
  fi
fi

exit "$status"
