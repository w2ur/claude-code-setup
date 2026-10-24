#!/usr/bin/env bash
# Monthly retention for the Umami instance (~/Dev/analytics, Neon Postgres):
# visit data older than RETENTION_MONTHS is deleted, then nothing else is.
# Owner decision 2026-10-19: 13 months. The privacy notices of the tracked
# sites state the same number; change both together.
#
# Usage: umami-retention.sh [--dry-run]
#   --dry-run  counts what would be deleted in a READ ONLY transaction.
#
# LAUNCHAGENT, NEVER CRONTAB. The connection string lives in the login keychain
# (service `umami-retention`, account $USER). Outside the GUI session `security`
# returns an empty string with no error.
#
# DIRECT HOST ONLY, as for db-backup. A "-pooler." host is rewritten to the
# direct one as a safety net; store the direct string anyway.
#
# TABLES. Visit data, from prisma/schema.prisma of the analytics repo, in
# FK-safe order (children first), all inside ONE transaction, so a failure
# rolls everything back:
#   event_data      by its own created_at, or because its website_event is old
#   website_event   created_at
#   session_data    created_at
#   revenue         created_at
#   session_replay  created_at
#   heatmap_event   created_at
#   session_link    created_at (no FK)
#   session         created_at, and only when no website_event, session_data or
#                   revenue row still references it (a session can outlive its
#                   first day; deleting it would break the FK or drop live data)
# NEVER touched: user, website, team, team_user, report, annotation, segment,
# link, pixel, board, share, api_key, app_setting, session_replay_saved (an
# owner-pinned marker holding a name and a visit id, no visitor data). Rows
# with a NULL created_at are never deleted: their age is unknown.
# No batching: the instance is a handful of low-traffic sites and one
# all-or-nothing transaction is worth more than smaller statements. Revisit if
# a first real run shows tens of thousands of rows per table.
#
# The URL is a psql argument, so it is visible in `ps` for the run on this
# single-user machine. It is never printed: psql's stderr is captured and any
# URL in it is redacted before it reaches the log or the alert.
#
# Numbers this script owns: RETENTION_MONTHS. Command prose must not restate it.
#
# Exit: 0 done (or dry-run counted); 1 a finding (the delete errored, rolled
# back); 2 could not run — no psql, missing keychain item, connection failed,
# or the database has no Umami schema — UNKNOWN, never healthy. Non-zero exits
# of a real run alert through notifier.sh; a dry-run never alerts.
set -uo pipefail

RETENTION_MONTHS=13
KEYCHAIN_SERVICE="umami-retention"

NOTIFIER="${NOTIFIER_BIN:-$HOME/.claude/scripts/notifier.sh}"
ACCOUNT="${USER:-$(id -un)}"

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: umami-retention.sh [--dry-run]" >&2; exit 2 ;;
esac

warn() { echo "WARN: $*" >&2; }

notify() {
  [ "$DRY_RUN" -eq 0 ] || return 0
  [ -x "$NOTIFIER" ] || return 0
  local body_file
  body_file=$(mktemp)
  printf '%s\n' "$2" > "$body_file"
  "$NOTIFIER" "$1" "$body_file" --priorite 4 >/dev/null 2>&1 || true
  rm -f "$body_file"
}

die2() {
  warn "$1"
  notify "umami-retention — could not run (exit 2 = unknown)" "$1"
  exit 2
}

redact() { sed -E 's#postgres(ql)?://[^[:space:]"'"'"']*#<url-redacted>#g'; }

PSQL="${UMAMI_RETENTION_PSQL:-}"
if [ -z "$PSQL" ]; then
  PSQL=$(command -v psql 2>/dev/null || true)
  [ -z "$PSQL" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
fi
[ -n "$PSQL" ] && [ -x "$PSQL" ] || die2 "psql not found. Install it with: brew install libpq"

url=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$ACCOUNT" -w 2>/dev/null || true)
[ -n "$url" ] || die2 "no keychain item (service '$KEYCHAIN_SERVICE', account \$USER). Set it with: security add-generic-password -U -s '$KEYCHAIN_SERVICE' -a \"\$USER\" -w"
url=$(printf '%s' "$url" | sed -E 's#^([a-z]+://[^/@]*@[^/?]*)-pooler\.#\1.#')

err=$(mktemp)
trap 'rm -f "$err"' EXIT

# Preflight: reachable, and really an Umami database. A wrong URL that connects
# to some other database must be "unknown", not "nothing to delete".
probe=$("$PSQL" -X -q -A -t -v ON_ERROR_STOP=1 "$url" \
  -c "select to_regclass('public.website_event') is not null and to_regclass('public.session') is not null" 2>"$err")
if [ $? -ne 0 ]; then
  die2 "connection failed — $(tail -n 3 "$err" | redact | tr '\n' ' ')"
fi
[ "$probe" = "t" ] || die2 "connected, but the database has no Umami schema (website_event/session) — wrong URL?"

# One predicate per table, shared by the dry-run counts and the real deletes.
CUTOFF="now() - interval '${RETENTION_MONTHS} months'"
P_EVENT_DATA="created_at < ${CUTOFF} or website_event_id in (select event_id from website_event where created_at < ${CUTOFF})"
P_SESSION="created_at < ${CUTOFF}
  and not exists (select 1 from website_event e where e.session_id = session.session_id and (e.created_at >= ${CUTOFF} or e.created_at is null))
  and not exists (select 1 from session_data d where d.session_id = session.session_id and (d.created_at >= ${CUTOFF} or d.created_at is null))
  and not exists (select 1 from revenue r where r.session_id = session.session_id and (r.created_at >= ${CUTOFF} or r.created_at is null))"

# table|predicate, in deletion order.
STEPS=(
  "event_data|${P_EVENT_DATA}"
  "website_event|created_at < ${CUTOFF}"
  "session_data|created_at < ${CUTOFF}"
  "revenue|created_at < ${CUTOFF}"
  "session_replay|created_at < ${CUTOFF}"
  "heatmap_event|created_at < ${CUTOFF}"
  "session_link|created_at < ${CUTOFF}"
  "session|${P_SESSION}"
)

if [ "$DRY_RUN" -eq 1 ]; then
  sql="begin read only;"$'\n'
else
  sql="begin;"$'\n'
fi
for step in "${STEPS[@]}"; do
  table=${step%%|*}
  pred=${step#*|}
  if [ "$DRY_RUN" -eq 1 ]; then
    sql+="select '${table}', count(*) from ${table} where ${pred};"$'\n'
  else
    sql+="with d as (delete from ${table} where ${pred} returning 1) select '${table}', count(*) from d;"$'\n'
  fi
done
if [ "$DRY_RUN" -eq 1 ]; then
  sql+="rollback;"$'\n'
else
  sql+="commit;"$'\n'
fi

out=$("$PSQL" -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 "$url" <<<"$sql" 2>"$err")
if [ $? -ne 0 ]; then
  detail=$(tail -n 3 "$err" | redact | tr '\n' ' ')
  warn "retention delete failed (rolled back) — $detail"
  notify "umami-retention — finding" "delete failed, transaction rolled back — $detail"
  exit 1
fi

mode=$([ "$DRY_RUN" -eq 1 ] && echo "would delete" || echo "deleted")
echo "umami-retention: $mode rows older than ${RETENTION_MONTHS} months"
printf '%s\n' "$out" | redact | while read -r table n; do
  echo "  $table: $n"
done
exit 0
