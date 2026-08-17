#!/usr/bin/env bash
#
# tech-debt-triage.sh — Phase 1 of the monthly technical health review.
#
# Why a script and not `claude -p "/tech-debt --triage-only"`: Phase 1 is fully
# deterministic. Every signal is a shell one-liner, the scoring is a fixed
# weight table, and the output is a sort. Per CLAUDE.md, deterministic work gets
# a script and no model. The judgement lives in Phase 2 (deep review), which
# stays interactive and is NOT part of this script.
#
# It also removes the reason the cron entry never worked: a crontab job runs
# outside the GUI login session, so it cannot reach the login keychain and
# `claude -p` always fails "Not logged in". A script needs no credentials.
#
# Read-only. It never writes to the rotation tracker: "last scan" means last
# *deep review* (Phase 2), not last triage, so a triage run must not reset it.
#
# Usage: tech-debt-triage.sh [--json] [--help]
# Exit:  0 ok · 2 ran but degraded (a required tool was missing) · 1 hard error
#
# Env overrides (for testing against a fixture tree):
#   DEV_DIR   default $HOME/Dev
#   HUB_REPO  default $DEV_DIR/{portfolio-site}

set -euo pipefail

DEV_DIR="${DEV_DIR:-$HOME/Dev}"
HUB_REPO="${HUB_REPO:-$DEV_DIR/{portfolio-site}}"
EDITORIAL="$HUB_REPO/src/data/editorial.ts"
ROTATION="$DEV_DIR/.tech-debt-rotation.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCANNER="$SCRIPT_DIR/dev-scanner.sh"

OUTPUT_JSON=0
case "${1:-}" in
  --json) OUTPUT_JSON=1 ;;
  --help|-h) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 1 ;;
esac

DEGRADED=0
warn() { echo "WARN: $*" >&2; DEGRADED=1; }

# Every value that reaches a tab-separated record goes through this. A newline
# or tab in any field silently splits the row and corrupts every row after it,
# which is exactly what a stray `|| echo '?'` produced once. Collapse to the
# first line and strip tabs and pipes (pipes would break the markdown table).
sanitize() { printf '%s' "${1:-}" | tr -d '\t|' | head -n 1 | tr -d '\n'; }

[ -x "$SCANNER" ] || { echo "FATAL: $SCANNER not found or not executable" >&2; exit 1; }

# A missing npm must be loud, never silent. Under cron's default PATH
# (/usr/bin:/bin) npm is unresolvable — Homebrew installs it to
# fnm's alias dir (~/.local/share/fnm/aliases/default/bin) — so the dependency
# signals would quietly read "?" for every repo, forever. That is the failure
# mode this warning exists to catch; the crontab entry carries an explicit
# PATH= for the same reason. (This comment said /opt/homebrew/bin until
# 2026-08-17. It was true when written; fnm took node and npm over on
# 2026-08-15 and both Homebrew binaries ceased to exist — re-verified with
# `which -a` rather than carried forward.)
HAVE_NPM=1
command -v npm >/dev/null 2>&1 || { HAVE_NPM=0; warn "npm not on PATH — vuln/outdated signals unavailable for every repo"; }
command -v git >/dev/null 2>&1 || { echo "FATAL: git not on PATH" >&2; exit 1; }

# ---------------------------------------------------------------- Python (uv)
# uv is the sole Python manager on this machine, so the interpreter is resolved
# explicitly instead of inherited from a bare `python3`, which is not
# trustworthy here: it resolves to /opt/homebrew/bin/python3, which exists ONLY
# as a dependency of gcloud-cli/mpv/yt-dlp/vapoursynth/peon-ping, and the thing
# waiting behind it is Apple's /usr/bin/python3 (3.9.6). 3.9 runs today's
# stdlib-only snippets fine — measured — so that downgrade would be INVISIBLE
# until one of them used 3.10+ syntax. Order: `uv python find` (forced to
# managed-only), then uv's ~/.local/bin shim; the shim fallback matters because
# the scheduled PATHs are not uniform (the cleanup entry carries no uv).
# FATAL, never a skip — same rule as npm above.
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
[ -n "$PYTHON" ] || { echo "FATAL: no uv-managed Python found (uv python find failed and no ~/.local/bin/python3.N shim). Refusing to fall back to a system python." >&2; exit 1; }

# ---------------------------------------------------------------- Signal B map
# Prominence = position in editorial.ts's array (Layer 3 of the M12 manifest
# replacement). The array order IS the canonical order, so file order is the
# signal. Join on `repo:`, NOT `slug:` — a slug is a URL slug and can carry
# `repo: null` (e.g. `backtester`), which matches no directory in ~/Dev.
# Note the values are single-quoted in that file.
declare -a EDITORIAL_REPOS=()
if [ -r "$EDITORIAL" ]; then
  while IFS= read -r r; do
    [ -n "$r" ] && EDITORIAL_REPOS+=("$r")
  done < <(grep -oE "repo: '[^']+'" "$EDITORIAL" 2>/dev/null | sed -E "s/^repo: '//; s/'$//")
else
  warn "editorial.ts unreadable at $EDITORIAL — prominence scores 0 for every repo"
fi

editorial_rank() { # -> 1-based index, or 0 if absent
  local target="$1" i=1
  for r in ${EDITORIAL_REPOS+"${EDITORIAL_REPOS[@]}"}; do
    [ "$r" = "$target" ] && { echo "$i"; return; }
    i=$((i + 1))
  done
  echo 0
}

# ---------------------------------------------------------------- Signal C map
ROTATION_JSON="{}"
if [ -r "$ROTATION" ]; then
  ROTATION_JSON="$(cat "$ROTATION")"
else
  warn "rotation tracker unreadable at $ROTATION — every repo scores as 'never scanned'"
fi

TODAY_EPOCH="$(date +%s)"

days_since_scan() { # -> integer days, or -1 for never
  "$PYTHON" -c '
import sys, json, datetime
data = json.loads(sys.argv[1] or "{}")
val = data.get(sys.argv[2])
if not val:
    print(-1); raise SystemExit
try:
    d = datetime.date.fromisoformat(val)
except ValueError:
    print(-1); raise SystemExit
print((datetime.date.today() - d).days)
' "$ROTATION_JSON" "$1" 2>/dev/null || echo -1
}

# ------------------------------------------------------------------ collection
ROWS="$(mktemp)"
trap 'rm -f "$ROWS"' EXIT

REPO_COUNT=0
while IFS=$'\t' read -r name path is_git; do
  [ "$is_git" = "true" ] || continue
  [ -d "$path" ] || continue
  REPO_COUNT=$((REPO_COUNT + 1))

  # Signal A — commit activity (change velocity, a proxy for risk)
  commits="$(git -C "$path" log --since='30 days ago' --oneline 2>/dev/null | wc -l | tr -d ' ')"
  commits="${commits:-0}"
  if   [ "$commits" -gt 10 ]; then score_a=2
  elif [ "$commits" -ge 1 ];  then score_a=1
  else                             score_a=0
  fi

  # Signal B — portfolio prominence
  rank="$(editorial_rank "$name")"
  if   [ "$rank" -eq 0 ]; then score_b=0
  elif [ "$rank" -le 6 ]; then score_b=2
  else                         score_b=1
  fi

  # Signal C — time since last deep review
  days="$(days_since_scan "$name")"
  if   [ "$days" -lt 0 ];  then score_c=3; last_scan="never"
  elif [ "$days" -gt 60 ]; then score_c=2; last_scan="${days}d"
  elif [ "$days" -ge 30 ]; then score_c=1; last_scan="${days}d"
  else                          score_c=0; last_scan="${days}d"
  fi

  # Signal D — quick issue detection (no install, no build)
  #
  # TRAP: `npm outdated` and `npm audit` exit NON-ZERO when they find something
  # — which is the normal case. Under `set -o pipefail` that makes the whole
  # pipeline fail *after* python has already printed its number, so a trailing
  # `|| echo '?'` fires too and the variable ends up holding TWO lines. That
  # embeds a newline in a tab-separated record and shreds every row below it.
  # So: capture the raw JSON first with `|| true`, then parse it separately.
  vulns="-"; outdated="-"; score_d=0
  if [ "$HAVE_NPM" -eq 1 ] && [ -f "$path/package.json" ]; then
    raw_outdated="$( (cd "$path" && npm outdated --json 2>/dev/null) || true )"
    outdated="$(printf '%s' "$raw_outdated" | "$PYTHON" -c '
import sys, json
try: print(len(json.load(sys.stdin)))
except Exception: print("?")
' 2>/dev/null || true)"
    raw_audit="$( (cd "$path" && npm audit --json 2>/dev/null) || true )"
    vulns="$(printf '%s' "$raw_audit" | "$PYTHON" -c '
import sys, json
try:
    m = json.load(sys.stdin).get("metadata", {}).get("vulnerabilities", {})
    print(m.get("high", 0) + m.get("critical", 0))
except Exception: print("?")
' 2>/dev/null || true)"
    outdated="$(sanitize "${outdated:-?}")"
    vulns="$(sanitize "${vulns:-?}")"
    [ "$vulns" != "?" ] && [ "$vulns" -gt 0 ] 2>/dev/null && score_d=$((score_d + vulns))
    [ "$outdated" != "?" ] && [ "$outdated" -gt 5 ] 2>/dev/null && score_d=$((score_d + 1))
  fi

  logs="$(grep -rn 'console\.log' \
      --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
      --exclude-dir=.next --exclude-dir=.astro --exclude-dir=.git \
      "$path" 2>/dev/null | grep -vc '\.test\.' || true)"
  logs="${logs:-0}"
  [ "$logs" -gt 3 ] && score_d=$((score_d + 1))

  notes=""
  [ "$logs" -gt 3 ] && notes="${logs} console.log"
  if [ -f "$path/.nvmrc" ]; then
    nv="$(tr -d ' \n' < "$path/.nvmrc" 2>/dev/null || true)"
    [ -n "$nv" ] && notes="${notes:+$notes, }Node ${nv} (.nvmrc)"
  fi
  [ -z "$notes" ] && notes="—"

  total=$((score_a + score_b + score_c + score_d))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(sanitize "$total")" "$(sanitize "$name")" "$(sanitize "$commits")" \
    "$(sanitize "$last_scan")" "$(sanitize "$vulns")" "$(sanitize "$outdated")" \
    "$(sanitize "$notes")" >> "$ROWS"
done < <(
  "$SCANNER" --json 2>/dev/null | "$PYTHON" -c '
import sys, json
for p in json.load(sys.stdin).get("projects", []):
    print("%s\t%s\t%s" % (p.get("name",""), p.get("path",""), str(p.get("is_git", False)).lower()))
'
)

# ---------------------------------------------------------------------- output
SORTED="$(sort -t$'\t' -k1,1nr -k2,2 "$ROWS")"

if [ "$OUTPUT_JSON" -eq 1 ]; then
  # stdout must be JSON and nothing else, so the SUMMARY line goes to stderr
  # here and the same two counters are folded into the object instead.
  printf '%s\n' "$SORTED" | "$PYTHON" -c '
import sys, json, datetime
rows = []
for i, line in enumerate(l for l in sys.stdin.read().splitlines() if l.strip()):
    score, name, commits, last, vulns, outdated, notes = line.split("\t")
    rows.append({"rank": i + 1, "app": name, "score": int(score),
                 "commits_30d": int(commits), "last_scan": last,
                 "vulns_high_critical": vulns, "outdated": outdated, "notes": notes})
print(json.dumps({"generated_at": datetime.datetime.now().astimezone().isoformat(),
                  "repo_count": int(sys.argv[1]), "degraded": bool(int(sys.argv[2])),
                  "app_count": len(rows), "apps": rows}, indent=2))
' "$REPO_COUNT" "$DEGRADED"
  echo "SUMMARY repos=${REPO_COUNT} degraded=${DEGRADED}" >&2
  [ "$DEGRADED" -eq 1 ] && exit 2
  exit 0
else
  echo "## Tech Debt Triage — $(date '+%Y-%m-%d %H:%M')"
  echo
  echo "| # | App | Score | Commits (30d) | Last Scan | Vulns | Outdated | Issues |"
  echo "|---|-----|-------|---------------|-----------|-------|----------|--------|"
  i=1
  while IFS=$'\t' read -r score name commits last vulns outdated notes; do
    [ -n "$score" ] || continue
    printf '| %d | %s | %s | %s | %s | %s | %s | %s |\n' \
      "$i" "$name" "$score" "$commits" "$last" "$vulns" "$outdated" "$notes"
    i=$((i + 1))
  done <<< "$SORTED"
  echo
  # paste -sd', ' would cycle the two delimiter characters, giving "a,b c,d".
  TOP="$(printf '%s\n' "$SORTED" | head -4 | cut -f2 | awk '{a = a ? a ", " $0 : $0} END {print a}')"
  echo "recommended: review the top 3-4 ($TOP)"
  echo
  echo "Phase 2 is deliberately NOT automated — run \`/tech-debt <app> ...\` to deep-review."
fi

echo "SUMMARY repos=${REPO_COUNT} degraded=${DEGRADED}"
[ "$DEGRADED" -eq 1 ] && exit 2
exit 0
