#!/usr/bin/env bash
#
# usage-watch.sh — weekly served-bytes trend across the portfolio.
#
# Why served bytes and not a usage API: Vercel exposes usage ONLY through
# billing data, and billing data requires being billed — a charges query over
# the whole Hobby period returns `costs_not_found`. A billing-based monitor
# would go blind on the revert to Hobby, which is the state we are aiming for.
# christograph blew its limits at ~17 MB PER REQUEST, so the signal that
# matters is unit cost, and an HTTP request measures that on any plan.
# Layer 2b (billing charges, Step 7 below) is kept as a bonus block that
# degrades gracefully rather than the primary signal.
#
# Why a script and not `claude -p`: a crontab job runs outside the GUI login
# session, cannot reach the login keychain, and `claude -p` always fails
# "Not logged in". A script needs no Claude credentials.
#
# Hosts are DISCOVERED (Vercel API, GET /v9/projects), the route list at
# $ROUTES is an OVERLAY: it carries only what discovery cannot observe —
# non-Vercel hosts (e.g. the Netlify-hosted hub), deep routes worth watching
# beyond "/", and per-host control paths. A discovered Vercel project with no
# overlay entry is still probed at "/" with a generic bogus control path, so
# a newly deployed project is monitored automatically. Discovery is entirely
# optional: an unreadable token or a failed API call falls back to the
# overlay alone and logs "discovery skipped" — it never fails the run.
#
# Three drift signals so staleness is never silent:
#   NEW   — a route with no prior baseline entry (logged, not a warning).
#   STALE — an overlay site whose name matches a discovered Vercel project,
#           but whose declared base is no longer among that project's
#           aliases (warning; degrades the run).
#   (a 404 on any declared route is just the general non-2xx warning below.)
#
# A permanently unmeasurable host (a catch-all SPA, for example) is
# acknowledged, never silently skipped: give it an overlay entry with
# "ignore": "<non-empty reason>" instead of routes/control. This works for
# discovered hosts too, since the overlay dict is what NEW_SITES already
# checks membership against. A missing/empty reason is refused (WARN,
# degrading) and the host falls through to normal probing — there is no
# way to silence a host without recording why.
#
# Usage: usage-watch.sh [--help]
# Exit:  0 ok · 2 ran but degraded (missing route list, curl failure,
#             non-2xx, catch-all, empty route list, stale overlay entry) ·
#        1 hard error (missing dependency, bad arguments)
#
# Env overrides (for testing against a fixture tree — production runs use
# every default):
#   CLAUDE_DIR        default $HOME/.claude   (routes/baselines/log live here)
#   VERCEL_TOKEN_FILE default $HOME/.config/vercel-usage/token
#   VERCEL_TEAM_ID    default team_UQ5YF1tQxCCq3SObgTXoHcE0

set -euo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
ROUTES="$CLAUDE_DIR/usage-watch-routes.json"
BASELINES="$CLAUDE_DIR/usage-baselines.json"
LOG="$CLAUDE_DIR/usage-watch.log"
RATIO=3

TOKEN_FILE="${VERCEL_TOKEN_FILE:-$HOME/.config/vercel-usage/token}"
TEAM_ID="${VERCEL_TEAM_ID:-team_UQ5YF1tQxCCq3SObgTXoHcE0}"
# Bogus path used as the catch-all control for any host discovery adds that
# has no overlay entry (and so no owner-declared control of its own).
DISCOVERY_CONTROL="/nope-xyz-control"

case "${1:-}" in
  --help|-h) sed -n '2,51p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 1 ;;
esac

DEGRADED=0
warn() { echo "WARN: $*" >&2; DEGRADED=1; }

command -v curl >/dev/null 2>&1 || { echo "FATAL: curl not found" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "FATAL: python3 not found" >&2; exit 1; }

[ -r "$ROUTES" ] || { warn "no readable route list at $ROUTES"; exit 2; }

probe() {  # $1 = url -> "<http_code> <wire_bytes> <redirects>" or "" plus a non-zero return
  # -L is load-bearing: a wire-bytes probe that stops at the first hop measures
  # the redirect response, not the page a visitor actually receives, which is
  # the quantity that bills. Measured on {portfolio-site-url}/lettre: 301/98 B
  # without -L, 200/21726 B (1 hop) with it — a 220x understatement that the
  # ratchet (which only warns on GROWTH) would have silently accepted as a new,
  # permanently wrong baseline the moment any route started redirecting.
  # http_code and size_download report the FINAL hop once redirects are
  # followed; num_redirects is the hop count, carried forward so a route that
  # starts redirecting (0 -> N hops) is visible rather than inferred.
  curl -sSL -H 'Accept-Encoding: gzip' -o /dev/null \
       -w '%{http_code} %{size_download} %{num_redirects}' -m 25 "$1" 2>/dev/null
}

# ------------------------------------------------------------------ discovery
# Every value below is TAB-separated: "name<TAB>chosen_base<TAB>alias1,alias2,...".
# chosen_base prefers a non-*.vercel.app alias (a real custom domain), falling
# back to the first alias when a project has none (dev-only projects like
# elevate_conversations).
DISCOVERED_TSV=""
if [ -r "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
  RAW_PROJECTS=""
  RAW_PROJECTS="$(curl -sS -H "Authorization: Bearer $TOKEN" -m 25 \
    "https://api.vercel.com/v9/projects?limit=100&teamId=$TEAM_ID" 2>/dev/null || true)"
  if [ -z "$RAW_PROJECTS" ]; then
    echo "INFO: discovery skipped — Vercel API request failed" >&2
  else
    DISCOVERED_TSV="$(python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
projects = data.get('projects', [])
if not isinstance(projects, list):
    sys.exit(1)
for p in projects:
    name = p.get('name')
    if not name:
        continue
    targets = p.get('targets') or {}
    prod = targets.get('production') if isinstance(targets, dict) else None
    aliases = (prod or {}).get('alias') if isinstance(prod, dict) else None
    if not isinstance(aliases, list):
        aliases = []
    aliases = [a for a in aliases if isinstance(a, str) and a]
    non_vercel = [a for a in aliases if not a.endswith('.vercel.app')]
    chosen = non_vercel[0] if non_vercel else (aliases[0] if aliases else None)
    if not chosen:
        continue
    print('\t'.join([name, chosen, ','.join(aliases)]))
" "$RAW_PROJECTS" || true)"
    [ -z "$DISCOVERED_TSV" ] && echo "INFO: discovery skipped — could not parse Vercel API response" >&2
  fi
else
  echo "INFO: discovery skipped — token unreadable at $TOKEN_FILE" >&2
fi

# STALE — an overlay site whose name IS a known Vercel project (from the map
# above) but whose declared `base` host is no longer among that project's
# current aliases: the domain moved or the project changed underneath the
# overlay. An overlay site whose name matches no discovered project (e.g.
# "hub", which is Netlify-hosted) is presumed intentionally non-Vercel and is
# never checked here — that is exactly the "cannot be observed" case the
# overlay exists for.
if [ -n "$DISCOVERED_TSV" ]; then
  STALE_SITES="$(python3 -c "
import json, sys
d = json.load(open(sys.argv[2]))
disc = {}
for line in sys.argv[1].splitlines():
    if not line.strip():
        continue
    parts = line.split('\t')
    if len(parts) < 3:
        continue
    name, base, aliases = parts[0], parts[1], parts[2]
    disc[name] = set(a.strip() for a in aliases.split(',') if a.strip())
for site, cfg in d.items():
    if site not in disc:
        continue
    base = cfg.get('base', '')
    host = base.split('://', 1)[-1].rstrip('/')
    if host not in disc[site]:
        print(site + '\t' + base)
" "$DISCOVERED_TSV" "$ROUTES")"
  while IFS=$'\t' read -r s b; do
    [ -z "$s" ] && continue
    warn "$s: STALE — overlay base $b no longer among $s's discovered aliases"
  done <<< "$STALE_SITES"
fi

# NEW_SITES — discovered projects with no overlay entry at all. Probed at "/"
# with the generic discovery control; the ratchet step below logs NEW for
# each such route the first time it is seen.
NEW_SITES=""
if [ -n "$DISCOVERED_TSV" ]; then
  NEW_SITES="$(python3 -c "
import json, sys
d = json.load(open(sys.argv[2]))
for line in sys.argv[1].splitlines():
    if not line.strip():
        continue
    parts = line.split('\t')
    if len(parts) < 2:
        continue
    name, base = parts[0], parts[1]
    if name in d:
        continue
    print(name + '\t' + base)
" "$DISCOVERED_TSV" "$ROUTES")"
fi

# ------------------------------------------------------------- probe loop
# An overlay entry may carry "ignore": "<reason>" instead of routes/control —
# a permanent, per-host acknowledgement for a site that is unmeasurable by
# this probe (a catch-all SPA, for example), NOT a general skip mechanism.
# It works for DISCOVERED hosts too: adding the site's key to the overlay
# with only base+ignore is enough, since the overlay dict is the same one
# NEW_SITES already checks membership against — a site once discovered as
# "new" simply stops appearing there once it has any overlay entry at all.
# A missing or empty reason is refused: it is logged as a WARN (degrading)
# and the site falls through to normal probing instead of being silenced,
# so a bare `"ignore": true` cannot quietly turn the detector off.
RESULTS=""
ROUTE_COUNT=0
IGNORED_COUNT=0
while IFS=$'\t' read -r KIND F1 F2 F3 F4; do
  [ -z "$KIND" ] && continue
  case "$KIND" in
    IGNORED)
      IGNORED_COUNT=$((IGNORED_COUNT + 1))
      echo "INFO: $F2 ignored — $F3" >&2
      continue
      ;;
    BADIGNORE)
      warn "$F1: ignore flag present but missing/empty reason — still monitoring"
      continue
      ;;
  esac
  site="$F1"; base="$F2"; route="$F3"; control="$F4"
  [ -z "$site" ] && continue
  ROUTE_COUNT=$((ROUTE_COUNT + 1))

  CTL=$(probe "$base$control") || { warn "$site: curl exit $? on control $control"; continue; }
  read -r _CTL_CODE CTL_BYTES _CTL_REDIRECTS <<< "$CTL"

  OUT=$(probe "$base$route") || { warn "$site$route: curl exit $?"; continue; }
  read -r CODE BYTES REDIRECTS <<< "$OUT"

  case "$CODE" in 2*) ;; *) warn "$site$route: HTTP $CODE"; continue ;; esac

  # A catch-all rewrite serves the same body for every path. STRICT EQUALITY
  # IS NOT ENOUGH: an SPA that echoes the path into its HTML differs by a few
  # bytes and would sail through. Measured — my-bias-app / vs control: 5142 vs
  # 5153 (0.2%). Use a 10% band.
  if python3 -c "import sys; r=$BYTES; c=$CTL_BYTES; sys.exit(0 if abs(r-c)/max(r,c,1) < 0.10 else 1)"; then
    warn "$site$route: CATCHALL — $BYTES vs control $CTL_BYTES (<10% apart); not recorded"
    continue
  fi

  RESULTS="$RESULTS$site$route\t$BYTES\t$REDIRECTS\n"
done < <(
  python3 -c "
import json, sys
d = json.load(open('$ROUTES'))
new_lines = sys.argv[1].splitlines() if len(sys.argv) > 1 else []

for site, cfg in d.items():
    base = cfg.get('base', '')
    ignore = cfg.get('ignore')
    if isinstance(ignore, str) and ignore.strip():
        print('\t'.join(['IGNORED', site, base, ignore.strip()]))
        continue
    if ignore is not None:
        # present but invalid (empty string, or a non-string like \`true\`):
        # refuse to silence — flag it and fall through to normal probing.
        print('\t'.join(['BADIGNORE', site, base]))
    routes, control = cfg.get('routes'), cfg.get('control')
    if isinstance(routes, list) and control:
        for r in routes:
            print('\t'.join(['ROUTE', site, base, r, control]))
    else:
        # no routes declared (a bare ignore-only entry that failed
        # validation above) — fall back to the generic discovery default
        # so a misconfigured ignore still results in real monitoring.
        print('\t'.join(['ROUTE', site, base, '/', '$DISCOVERY_CONTROL']))

for line in new_lines:
    if not line.strip():
        continue
    name, base = line.split('\t')
    print('\t'.join(['ROUTE', name, base, '/', '$DISCOVERY_CONTROL']))
" "$NEW_SITES"
)

# An overlay that resolved to zero PROBED routes is only a problem if
# nothing was legitimately ignored either — an overlay made entirely of
# acknowledged catch-alls is a deliberate, valid state, not an empty config.
if [ "$ROUTE_COUNT" -eq 0 ] && [ "$IGNORED_COUNT" -eq 0 ]; then
  warn "no routes to check — overlay is empty and discovery yielded nothing"
fi

# --------------------------------------------------- ratchet + log write
# Identical semantics to the push-build-gate payload ratchet
# (hooks/push-build-gate/payload_gate.py): store `last` and `first_seen` per
# route, warn at > RATIO x either. A route not staying under the per-run
# ratio must still trip the cumulative first_seen comparison, which is why
# first_seen is carried forward rather than reset.
#
# COLLAPSE, not just growth: a route dropping below 1/3 of its last baseline
# is either a genuine payload fix or a route that broke, started redirecting
# without -L catching it, or began serving an error page — both are worth a
# line, so this warns (never fails) on either direction, not growth alone.
#
# REDIRECTS: the hop count travels with each measurement now that probe()
# follows redirects (see probe()'s comment). Persisted per route so a route
# going from 0 hops to >0 is visible on its own, even when the byte count
# barely moves — reported as an informational line, not a warning, since a
# new redirect is not itself a payload problem once it is being followed.
#
# The python exit code is captured in the FIRST statement of the `||`
# branch, with nothing evaluated in between, so it cannot be clobbered before
# it is read — the fragile pattern this replaces re-tested `$?` a line later,
# after `set -e` semantics around a piped command make that unreliable.
RATCHET_RC=0
printf "$RESULTS" | python3 -c "
import sys, json, os, datetime
bl_path = '$BASELINES'
try:
    bl = json.load(open(bl_path))
    if not isinstance(bl, dict):
        bl = {}
except Exception:
    bl = {}                       # corrupt baseline must never block the run

warnings, new_keys, redirect_starts, out = [], [], [], {}
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    key, byts, hops = line.split('\t')
    byts, hops = int(byts), int(hops)
    old = bl.get(key) if isinstance(bl.get(key), dict) else None
    if old:
        last, first = old.get('last', 0), old.get('first_seen', 0)
        mult = max((byts / last if last else 0), (byts / first if first else 0))
        if mult > $RATIO:
            warnings.append(f'{key}: {byts} B, {mult:.1f}x baseline')
        elif last and byts < last / 3:
            warnings.append(f'{key}: {byts} B, collapsed to {byts / last:.2f}x last ({last} B)')
        old_hops = old.get('redirects', 0)
        if hops > 0 and old_hops == 0:
            redirect_starts.append(f'{key}: 0 -> {hops} hop(s)')
        first = old.get('first_seen', byts)
    else:
        first = byts
        new_keys.append(key)
    out[key] = {'last': byts, 'first_seen': first, 'redirects': hops}

tmp = bl_path + '.tmp'
json.dump(out, open(tmp, 'w'), indent=2)
os.replace(tmp, bl_path)
stamp = datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
total = sum(v['last'] for v in out.values())
redirected = sum(1 for v in out.values() if v['redirects'] > 0)
with open('$LOG', 'a') as fh:
    fh.write(f'{stamp}\troutes={len(out)}\ttotal_bytes={total}\twarnings={len(warnings)}\tnew={len(new_keys)}\tredirected={redirected}\n')
for k in new_keys:
    print('NEW: ' + k, file=sys.stderr)
for r in redirect_starts:
    print('INFO: started redirecting — ' + r, file=sys.stderr)
for w in warnings:
    print('WARN: ' + w, file=sys.stderr)
sys.exit(3 if warnings else 0)
" || RATCHET_RC=$?

if [ "$RATCHET_RC" -eq 3 ]; then
  DEGRADED=1
elif [ "$RATCHET_RC" -ne 0 ]; then
  warn "ratchet step failed (python exit $RATCHET_RC)"
fi

# --------------------------------------- Layer 2b — billing (optional extra)
# DELIBERATE EXCEPTION to the exit-2-on-degradation rule: a 404
# `costs_not_found` from /v1/billing/charges means Vercel has no billing data
# to return, which on the Hobby plan is the expected and CORRECT state, not a
# degraded run. Do not "fix" this into a warning — it would fire every week
# for as long as the account stays on Hobby, which is the state the whole
# usage-monitoring effort exists to reach. See design spec §5.2.
if [ -r "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
  read -r BILL_FROM BILL_TO <<BILLDATES
$(python3 -c "
import datetime
now = datetime.datetime.now(datetime.UTC).replace(microsecond=0)
frm = now - datetime.timedelta(days=7)
print(frm.strftime('%Y-%m-%dT%H:%M:%SZ'), now.strftime('%Y-%m-%dT%H:%M:%SZ'))
")
BILLDATES

  BILL_URL="https://api.vercel.com/v1/billing/charges?teamId=${TEAM_ID}&from=${BILL_FROM}&to=${BILL_TO}"
  BILL_TMP="$(mktemp)"
  trap '[ -n "${BILL_TMP:-}" ] && rm -f "$BILL_TMP"' EXIT

  BILL_CODE=""
  BILL_CURL_RC=0
  BILL_CODE="$(curl -sS -H "Authorization: Bearer $TOKEN" -o "$BILL_TMP" \
    -w '%{http_code}' -m 25 "$BILL_URL" 2>/dev/null)" || BILL_CURL_RC=$?

  if [ "$BILL_CURL_RC" -ne 0 ]; then
    warn "billing: curl exit $BILL_CURL_RC on charges endpoint"
  elif [ "$BILL_CODE" = "404" ]; then
    echo "billing: unavailable on this plan" >> "$LOG"
  elif [ "$BILL_CODE" = "200" ]; then
    python3 -c "
import json, sys, datetime
by_service, by_project = {}, {}
with open(sys.argv[1], encoding='utf-8') as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        qty = obj.get('ConsumedQuantity', 0)
        if not isinstance(qty, (int, float)):
            continue
        service = obj.get('ServiceName', 'unknown')
        by_service[service] = by_service.get(service, 0) + qty
        proj = (obj.get('Tags') or {}).get('ProjectName', 'unknown')
        by_project[proj] = by_project.get(proj, 0) + qty
stamp = datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
svc = ','.join(f'{k}={v}' for k, v in sorted(by_service.items()))
prj = ','.join(f'{k}={v}' for k, v in sorted(by_project.items()))
with open(sys.argv[2], 'a', encoding='utf-8') as out:
    out.write(f'{stamp}\tbilling_by_service={svc}\tbilling_by_project={prj}\n')
" "$BILL_TMP" "$LOG" || warn "billing: failed to parse charges response"
  else
    warn "billing: unexpected HTTP $BILL_CODE from charges endpoint"
  fi
else
  echo "billing: skipped — token unreadable at $TOKEN_FILE" >> "$LOG"
fi

[ "$DEGRADED" -eq 1 ] && exit 2
exit 0
