#!/usr/bin/env bash
# intendant.sh — what needs a human today, and nothing else.
#
# vigie is a panel you OPEN: 17 sources, everything, always.
# intendant is an address you ASK: only the items requiring a decision.
# Same data, different consumer — so the data stays in vigie and this only reads it.
#
# THE ACCOUNTABILITY MECHANISM, and the reason this is worth a script at all:
# a source that cannot be read renders `SIGNAL LOST: <name>` and NEVER an empty
# section. An aggregator that silently drops a dead input manufactures "all clear",
# which is the failure this portfolio has already recorded three times: gate-watch
# on an unauthenticated `gh` (zero rows == "no repo has PRs"), vigie's fresh
# snapshot behind a frozen dist/, and a CI gate whose `jq all()` over an empty set
# returned true. The queue getting SHORTER when an input dies is the bug.
#
# Reports state. Never edits, never dispatches, never opens a PR.
#
# Exit: 0 nothing to do · 1 the queue is non-empty (a finding) · 2 at least one
# source could not be read = *unknown*, never "all clear". Partial-unknown counts
# as 2 even when the rest ran: part of the sweep is unknown, the rest ran.
#
# A source may also answer DEGRADED — `mark <name> true "<reason>"`: it produced
# items, but something about them is unknown (a truncated fetch, a classifier
# running against a stale input). That renders its own `DEGRADED:` line and
# exits 2, for the same reason a dead source does: the queue is short or
# mis-sorted by an amount nobody can see. Marking a degraded read `ok` and
# saying nothing — which is what this did until 2026-09-05 — is the "a short
# queue and a dead input look identical" failure in its quietest form.
#
# CLAUDE_DIR / DEV_DIR and each source's own *_STATE var redirect it at a fixture.

set -uo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
DEV_DIR="${DEV_DIR:-$HOME/Dev}"
SNAPSHOT="${VIGIE_SNAPSHOT:-$DEV_DIR/vigie/src/data/snapshot.json}"
MIDAS_ISSUES_STATE="${MIDAS_ISSUES_STATE:-}"
JOBS="${JOBS_INVENTORY:-$CLAUDE_DIR/scripts/jobs-inventory.sh}"

JSON=0; NOTIFY=0
case "${1:-}" in
  --json)   JSON=1 ;;
  --notify) NOTIFY=1 ;;
esac
NOTIFIER="${NOTIFIER_BIN:-$CLAUDE_DIR/scripts/notifier.sh}"
TODAY=$(date -u +%Y-%m-%d)

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq not found — UNKNOWN, not clear" >&2; exit 2; }

ITEMS='[]'   # [{source,severity,text}]
SRC='{}'     # {name:{ok,reason}}

add_item() { # source severity text
  ITEMS=$(jq -c --arg s "$1" --arg v "$2" --arg t "$3" \
    '. + [{source:$s,severity:$v,text:$t}]' <<<"$ITEMS")
}
mark() { # name ok reason
  SRC=$(jq -c --arg n "$1" --argjson ok "$2" --arg r "${3:-}" \
    '.[$n] = {ok:$ok, reason:$r}' <<<"$SRC")
}

# ── vigie snapshot ──────────────────────────────────────────────────────────
# READABLE AND PARSEABLE IS NOT HEALTHY (2026-09-05, round-5 review). Until
# this, `[ -r ] && jq -e .` was the entire health test, and two ways a
# snapshot lies without being malformed both rendered as a full, healthy panel
# — the queue getting SHORTER when an input dies, which is the failure this
# script's header names:
#
#   - NOBODY WROTE IT. vigie's collector stops (LaunchAgent broken, node
#     missing, one crash leaving the previous file in place) and the file sits
#     there readable, valid, with every `.sources.*.ok` frozen `true` from the
#     last good run. Every count below is then days old, and a repo that
#     acquired PR traffic since, an env var documented nowhere, or a plan that
#     crossed the archive cutoff after the collector died never enters the
#     queue — while the run says every source answered in full. So the
#     snapshot's own `generated_at` is the freshness test: com.example.vigie-refresh
#     runs daily, and VIGIE_MAX_AGE_HOURS is the slack on that.
#   - IT HAS NO `.sources` MAP. `{}` is valid JSON, so the guard passed; the
#     `down` jq below then ERRORED ("null has no keys"), its stderr went to
#     /dev/null, and the numeric coercion turned that error into 0 = "every
#     collector healthy". A schema rename would do it in silence.
#
# Both are SIGNAL LOST rather than a warn item, and the counts are not printed
# at all: a source that cannot be vouched for must not contribute numbers to a
# queue somebody reads as complete. Contrast `jobs` below, which distinguishes
# "could not run" from "ran and found nothing", and `midas-issues`, which
# treats a silently truncated read as DEGRADED.
VIGIE_MAX_AGE_HOURS="${VIGIE_MAX_AGE_HOURS:-26}"
vigie_lost=""
down=0
if [ ! -r "$SNAPSHOT" ] || ! jq -e . "$SNAPSHOT" >/dev/null 2>&1; then
  vigie_lost="unreadable: $SNAPSHOT"
else
  gen=$(jq -r '.generated_at // ""' "$SNAPSHOT" 2>/dev/null)
  # fromdateiso8601 wants exactly %Y-%m-%dT%H:%M:%SZ; vigie writes millis.
  gen_epoch=$(jq -r '(.generated_at // "") | sub("\\.[0-9]+Z$";"Z") | (try fromdateiso8601 catch "")' "$SNAPSHOT" 2>/dev/null)
  case "$gen_epoch" in ''|*[!0-9]*) gen_epoch="" ;; esac
  if [ -z "$gen_epoch" ]; then
    vigie_lost="snapshot carries no readable generated_at (${gen:-<absent>}) — a collector that stopped days ago cannot be told from a sweep that just ran: $SNAPSHOT"
  else
    age_h=$(( ( $(date -u +%s) - gen_epoch ) / 3600 ))
    if [ "$age_h" -ge "$VIGIE_MAX_AGE_HOURS" ]; then
      vigie_lost="snapshot is ${age_h}h old (generated_at $gen, refreshed daily) — nothing wrote it, so its counts are frozen at the last good run and this queue would be short by whatever changed since"
    elif [ "$age_h" -lt -1 ]; then
      vigie_lost="snapshot is dated in the FUTURE (generated_at $gen) — its age cannot be judged, so neither can its counts"
    fi
  fi
  if [ -z "$vigie_lost" ]; then
    # One expression for both failures: a missing/non-object `.sources` yields
    # "?" and a jq error yields "", and neither may become 0.
    down=$(jq -r 'if (.sources|type) == "object" then [.sources|to_entries[]|select(.value.ok==false)]|length else "?" end' "$SNAPSHOT" 2>/dev/null)
    case "$down" in
      ''|*[!0-9]*)
        vigie_lost="snapshot has no readable .sources map (got '${down:-<jq error>}') — which of vigie's own collectors ran is unknown, and a dead one reads here as nothing to report"
        down=0
        ;;
    esac
  fi
fi

if [ -n "$vigie_lost" ]; then
  mark vigie false "$vigie_lost"
else
  # A DEAD COLLECTOR SHORTENS THIS QUEUE, not just vigie's own panel
  # (2026-09-05, round-4 review). A failed collector leaves
  # `.sources.<name>.ok == false` AND `.data.<name> == null` — verified live
  # against the snapshot's own `techdebt` entry — so every `// 0` and every
  # `[…]|length` below reads a dead input as "nothing to report". A repo with
  # PR traffic and no CI gate then never enters the queue, and the run exits 1
  # ("non-empty, every source answered in full") with no line saying why. So
  # the snapshot is a DEGRADED read whenever any of its collectors is down —
  # its own `DEGRADED:` line and exit 2. The warn item stays for the detail;
  # it sorts below every act item and changes no exit code, so it was never
  # the accountability mechanism.
  if [ "$down" -gt 0 ]; then
    mark vigie true "$down of vigie's own collectors are down — every count below is derived from a partial snapshot, so a dead collector reads here as a short queue"
    add_item vigie warn "$down of vigie's own collectors are down — its panel is partial"
  else
    mark vigie true
  fi
  n=$(jq -r '.data.gatewatch.missing // 0' "$SNAPSHOT")
  [ "$n" -gt 0 ] 2>/dev/null && add_item vigie act "$n repo(s) have PR traffic but no CI gate — /tech-debt"
  n=$(jq -r '[.data.envdrift[]?|(.undocumented//{})|keys[]?]|length' "$SNAPSHOT")
  [ "$n" -gt 0 ] 2>/dev/null && add_item vigie act "$n env var(s) documented nowhere — see vigie envdrift band"
  n=$(jq -r '[.data.plans.plans[]?|select((.held|not) and .days_until_archive<=0)]|length' "$SNAPSHOT")
  [ "$n" -gt 0 ] 2>/dev/null && add_item vigie act "$n plan(s) past the archive cutoff and not held — /cleanup"
fi

# ── scheduled jobs ──────────────────────────────────────────────────────────
# jobs-inventory.sh exits 1 when it HAS a finding and still prints valid JSON.
# Treating non-zero as unreadable is wrong here — 0 and 1 both mean it ran.
# Only 2 (could not run) is genuinely unknown. Same shape as vigie's
# runAllowing([1]) for the gatewatch collector.
J=""; JRC=9
if [ -x "$JOBS" ]; then J=$("$JOBS" --json 2>/dev/null); JRC=$?; fi
if { [ "$JRC" = 0 ] || [ "$JRC" = 1 ]; } && jq -e . <<<"$J" >/dev/null 2>&1; then
  mark jobs true
  # Which exits are worth a human. NOT every non-zero:
  #   0   healthy
  #   1   a finding — the watcher already reported it through its own channel;
  #       re-surfacing here is the nagging that teaches you to skip the queue
  #   143 launchd cycling a KeepAlive job with SIGTERM (vigie-serve) — normal
  #   "(never exited)" — jobs-inventory's own wording for an agent that has not
  #       run since load. Normal for a monthly/weekly schedule, not a failure.
  #   2   could not run = *unknown*. Nobody else reports this one. It is the
  #       whole point: a job killed by its watchdog exits 2 rather than 1
  #       precisely because the outcome is ambiguous.
  # Anything outside {0,1,143} is unexpected and also surfaces.
  while IFS=$'\t' read -r label ex; do
    [ -z "$label" ] && continue
    if [ "$ex" = "2" ]; then
      add_item jobs act "scheduled job '$label' exited 2 = could not run, outcome unknown"
    else
      add_item jobs warn "scheduled job '$label' exited $ex (unexpected)"
    fi
  done < <(jq -r '.[]|(.last_exit|tostring) as $e|select(($e|test("never")|not) and ($e|test("^(0|1|143|null)$")|not))|[.label,$e]|@tsv' <<<"$J" 2>/dev/null)
else
  mark jobs false "jobs-inventory.sh exit $JRC — could not run"
fi

# ── my-trading-app GitHub issues ──────────────────────────────────────────────────────
# .github/actions/failure-issue files one persistent issue per CAUSE on
# {github-username}/my-trading-app when a scheduled writer fails, and closes it on the next success
# — but nothing in this portfolio ever read the tracker. 17 such issues
# (#50-#66) sat open and unread for 11 days (2026-08-24..09-04, the GH006
# branch-protection outage) before this source existed (2026-09-05).
# MIDAS_ISSUES_STATE, like the other *_STATE vars, redirects this at a fixture
# file instead of calling `gh` — same shape as the other *_STATE overrides
# above, but here the live path is a command, not a file, so the fixture
# stands in for its JSON stdout.
# `gh issue list` truncates at --limit and says nothing about it (2026-09-05,
# round-3 review): under the original `--limit 50`, fifty rows back was
# byte-identical to "there are exactly fifty". The 2026-08-24..09-04 outage
# filed 17 issues in 11 days, so a wider one — or a public repo accumulating
# human-filed issues — reaches fifty easily, and the row that stops being
# fetched may be the auto-merge-session one that means the watcher is halted:
# the queue getting SHORTER as the outage gets WIDER, which is the failure
# named in this script's header. So: fetch well past any plausible real count,
# and treat hitting the ceiling as a degraded read that says so.
MIDAS_ISSUE_LIMIT="${MIDAS_ISSUE_LIMIT:-200}"
if [ -n "$MIDAS_ISSUES_STATE" ]; then
  MI_JSON=$(cat "$MIDAS_ISSUES_STATE" 2>/dev/null); MI_RC=$?
else
  MI_JSON=$(gh issue list -R {github-username}/my-trading-app --state open \
              --json number,title,createdAt,updatedAt --limit "$MIDAS_ISSUE_LIMIT" 2>/dev/null)
  MI_RC=$?
fi
if [ "$MI_RC" = 0 ] && jq -e . <<<"$MI_JSON" >/dev/null 2>&1; then
  MI_DEGRADED=""
  # The automated writers' failure-issue titles are stable prefixes
  # ("<job>: ...", per .github/actions/failure-issue). They are DISCOVERED
  # from the my-trading-app checkout at run time, never hand-listed: every `title:`
  # under a `./.github/actions/failure-issue` step in .github/workflows/*.yml,
  # taking each `<word>: ` the value contains (a title may be a `${{ a && 'x: …'
  # || 'y: …' }}` expression — fetch-ohlcv varies by mode, auto-merge-session by
  # cause — and both literals count). The hand-typed list this replaced was
  # stale on the day it was written: it omitted attest-ledger,
  # session-integrity and auto-merge-session — the last being the one alert
  # that means "a fill is unpublished and the watcher is halted".
  # Two literal titles do not go through that action and are added by hand:
  # session-watchdog's "Missing weekday session <date>" and the trigger-gate
  # Worker's "trigger-gate worker failing" (workers/trigger-gate/README.md).
  # Everything else open on the repo is a human-filed issue — warn, don't act.
  #
  # THE STATIC LIST IS A FLOOR, NOT AN ALTERNATIVE (2026-09-05, round-3
  # review). Discovery reads the LOCAL checkout while the issues come live
  # from origin, and this machine's `~/Dev/my-trading-app` is routinely behind
  # origin/main — cloud sessions push daily. Using the discovered set INSTEAD
  # of the static one meant a title introduced by a workflow on origin and not
  # yet pulled classified as a human-filed `warn` item, printed unmarked below
  # every act item: exactly the misfiling this discovery exists to prevent,
  # reintroduced through the other door. The two are unioned, so a stale
  # checkout can only ever ADD, never subtract. What remains uncoverable — a
  # title newer than both — is what the drift check below reports as degraded.
  MIDAS_WORKFLOWS="${MIDAS_WORKFLOWS_DIR:-$DEV_DIR/my-trading-app/.github/workflows}"
  MI_STATIC='check-triggers-crypto|check-triggers|fetch-ohlcv|fetch-sentiment|refresh-leaderboard|refresh-universes|resweep-held-tickers|core-drift-guard|attest-ledger|session-integrity|auto-merge-session'
  MI_PREFIXES=""
  if [ -d "$MIDAS_WORKFLOWS" ]; then
    MI_PREFIXES=$(awk '
      /uses: *\.\/\.github\/actions\/failure-issue/ { infi=1; next }
      infi && /^ *- (name|uses|id):/                     { infi=0 }
      infi && /^ *title: */ {
        s=$0; sub(/^ *title: */, "", s)
        while (match(s, /[A-Za-z0-9_-]+: /)) {
          print substr(s, RSTART, RLENGTH-2); s=substr(s, RSTART+RLENGTH)
        }
        infi=0
      }' "$MIDAS_WORKFLOWS"/*.yml 2>/dev/null | sort -u | paste -sd '|' -)
  fi
  if [ -z "$MI_PREFIXES" ]; then
    MI_DEGRADED="automated-title prefixes from the static list alone — $MIDAS_WORKFLOWS unreadable, so a title added since it was frozen is misfiled as human-filed"
  else
    # Is the checkout the discovery read the one origin has? One-sided by
    # construction: `origin/main` here is only as fresh as the last fetch, so
    # this catches the drift it can see and says nothing about the rest —
    # which is why the static floor above exists rather than this replacing
    # it. No fetch: a queue command must not do network work on a repo.
    MI_REPO=$(cd "$MIDAS_WORKFLOWS/../.." 2>/dev/null && pwd)
    if [ -n "$MI_REPO" ] && git -C "$MI_REPO" rev-parse --git-dir >/dev/null 2>&1; then
      if ! git -C "$MI_REPO" rev-parse -q --verify origin/main >/dev/null 2>&1; then
        MI_DEGRADED="cannot tell whether $MIDAS_WORKFLOWS is current — $MI_REPO has no origin/main to compare against"
      elif ! git -C "$MI_REPO" diff --quiet HEAD origin/main -- .github/workflows 2>/dev/null; then
        MI_DEGRADED="$MIDAS_WORKFLOWS differs from $MI_REPO's origin/main ref, itself dated $(git -C "$MI_REPO" log -1 --format=%cs origin/main 2>/dev/null) — a failure-issue title only origin knows about would be misfiled as human-filed. git -C $MI_REPO fetch && git merge --ff-only"
      fi
    else
      MI_DEGRADED="cannot tell whether $MIDAS_WORKFLOWS is current — $MIDAS_WORKFLOWS is not inside a git checkout"
    fi
  fi
  # The union: discovery may add, never subtract (see above).
  MI_PREFIXES=$(printf '%s\n%s\n' "$MI_PREFIXES" "$MI_STATIC" | tr '|' '\n' \
                  | sed '/^$/d' | sort -u | paste -sd '|' -)
  MI_COUNT=$(jq -r 'length' <<<"$MI_JSON")
  if [ "$MI_COUNT" -ge "$MIDAS_ISSUE_LIMIT" ] 2>/dev/null; then
    add_item midas-issues act "the open-issue fetch hit its ceiling at $MIDAS_ISSUE_LIMIT — issues past it are NOT in this queue (raise MIDAS_ISSUE_LIMIT)"
    MI_DEGRADED="truncated at --limit $MIDAS_ISSUE_LIMIT: $MI_COUNT rows came back, so there are probably more that this queue never saw${MI_DEGRADED:+; $MI_DEGRADED}"
  fi
  mark midas-issues true "$MI_DEGRADED"
  [ -n "$MI_DEGRADED" ] && echo "intendant: midas-issues degraded — $MI_DEGRADED" >&2
  MI_RE="^($MI_PREFIXES): "
  while IFS=$'\t' read -r n title days; do
    [ -z "$n" ] && continue
    if [[ "$title" =~ $MI_RE ]] \
       || [[ "$title" == *"Missing weekday session"* ]] \
       || [[ "$title" == *"trigger-gate worker failing"* ]]; then
      add_item midas-issues act "#$n $title (open $days days)"
    else
      add_item midas-issues warn "#$n $title (open $days days)"
    fi
  done < <(jq -r --arg now "$TODAY" \
    '.[] | [(.number|tostring), .title,
            ((((($now+"T00:00:00Z")|fromdateiso8601) - (.createdAt|fromdateiso8601))/86400)|floor|tostring)]
           | @tsv' <<<"$MI_JSON" 2>/dev/null)
else
  mark midas-issues false "gh issue list failed or returned non-JSON"
fi
# ── emit ────────────────────────────────────────────────────────────────────
DOWN=$(jq -r '[to_entries[]|select(.value.ok==false)]|length' <<<"$SRC")
# A source that answered but told us its answer is incomplete. Counted apart
# from DOWN because the two read differently (one has no items at all, the
# other has items it cannot vouch for) and together for the exit code, which
# is one bit: is any part of this sweep unknown?
PARTIAL=$(jq -r '[to_entries[]|select(.value.ok and (.value.reason//"")!="")]|length' <<<"$SRC")
NITEM=$(jq -r 'length' <<<"$ITEMS")

if [ "$JSON" = 1 ]; then
  jq -n --argjson s "$SRC" --argjson i "$ITEMS" --arg g "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{generated_at:$g, sources:$s, items:$i}'
else
  echo "── intendant — $(date '+%a %d %b %H:%M') ──"
  # SIGNAL LOST first: a dead source must never look like a short queue.
  jq -r 'to_entries[]|select(.value.ok==false)|"  SIGNAL LOST: \(.key) — \(.value.reason)"' <<<"$SRC"
  # Then the sources that answered with a caveat. This predicate used to exist
  # nowhere: a reason was rendered for ok==false only, so a degraded read was
  # recorded in --json and invisible to every human path.
  jq -r 'to_entries[]|select(.value.ok and (.value.reason//"")!="")|"  DEGRADED: \(.key) — \(.value.reason)"' <<<"$SRC"
  if [ "$NITEM" = 0 ]; then
    [ "$DOWN" = 0 ] && [ "$PARTIAL" = 0 ] && echo "  nothing needs you." \
      || echo "  no items from the sources that answered in full — NOT an all-clear."
  else
    # `act` first and marked. Severity was computed for every item and
    # printed by nothing, so "auto-merge-session: a watcher fallback branch
    # did not reach main" — a fill unpublished and the watcher halted — read
    # exactly like a feature request someone filed. Sorting is stable within
    # a severity, so each source keeps its own order.
    jq -r '(map(select(.severity=="act")) + map(select(.severity!="act")))[]
           | "  \(if .severity=="act" then "!" else " " end) [\(.source)] \(.text)"' <<<"$ITEMS"
  fi
fi

# --notify: push the queue through the single channel. Counts only, which the
# items already are — notifier.sh's ntfy topic is PUBLIC and redacts secrets,
# not personal data, so nothing here may carry a name or a status.
# Silence when there is nothing to say AND every source answered: a daily
# notification that always fires is one you stop reading. A SIGNAL LOST still
# notifies, because "the sweep did not run" is exactly what you need told.
if [ "$NOTIFY" = 1 ] && [ -x "$NOTIFIER" ] \
   && { [ "$NITEM" -gt 0 ] || [ "$DOWN" -gt 0 ] || [ "$PARTIAL" -gt 0 ]; }; then
  BODY=$(mktemp); {
    jq -r 'to_entries[]|select(.value.ok==false)|"SIGNAL LOST: \(.key)"' <<<"$SRC"
    jq -r 'to_entries[]|select(.value.ok and (.value.reason//"")!="")|"DEGRADED: \(.key)"' <<<"$SRC"
    jq -r '(map(select(.severity=="act")) + map(select(.severity!="act")))[]
           | "\(if .severity=="act" then "!" else " " end) [\(.source)] \(.text)"' <<<"$ITEMS"
  } > "$BODY"
  TITLE="Intendant — $NITEM item(s)"
  [ "$DOWN" -gt 0 ] && TITLE="$TITLE, $DOWN source(s) LOST"
  [ "$PARTIAL" -gt 0 ] && TITLE="$TITLE, $PARTIAL degraded"
  PRIO=default; { [ "$DOWN" -gt 0 ] || [ "$PARTIAL" -gt 0 ]; } && PRIO=high
  "$NOTIFIER" "$TITLE" "$BODY" --priorite "$PRIO" >/dev/null 2>&1 \
    || echo "intendant: notification not delivered" >&2
  rm -f "$BODY"
fi

# Degraded counts as 2 with dead: both mean the queue is short or mis-sorted by
# an amount the reader cannot see, which is the one thing this must never
# render as a normal-looking day.
{ [ "$DOWN" -gt 0 ] || [ "$PARTIAL" -gt 0 ]; } && exit 2
[ "$NITEM" -gt 0 ] && exit 1
exit 0
