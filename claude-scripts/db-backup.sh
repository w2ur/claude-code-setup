#!/usr/bin/env bash
# Nightly pg_dump of every database listed in ~/.claude/db-backup.json, into
# iCloud Drive (off-provider, outside dev-mirror), mode 600, newest KEEP kept.
#
# Adding a database (Umami, Tsundoku, a household copy) is one config line:
#   { "name": "<kebab-name>", "keychain_service": "db-backup.<kebab-name>" }
# plus one `security add-generic-password` for that service. No code change.
#
# LAUNCHAGENT, NEVER CRONTAB. The connection strings live in the login
# keychain. Outside the GUI session `security` returns an empty string with no
# error, so a crontab job would report "no credential" for a reason that looks
# nothing like the real one. Item: service = keychain_service, account = $USER.
#
# DIRECT HOST ONLY. pg_dump holds a session-level connection and takes
# catalogue locks; Neon's PgBouncer pooler (host contains "-pooler") runs in
# transaction mode and breaks that. Store the direct string. As a safety net
# this script also rewrites "-pooler." out of the host, so a pooled string
# stored by mistake still dumps.
#
# The connection string is passed to pg_dump as its dbname argument (the only
# form it accepts), so it is visible in `ps` for the dump's duration on this
# single-user machine. It is never printed: pg_dump's stderr is captured and
# any URL in it is redacted before it reaches the log or the alert.
#
# Numbers this script owns: KEEP, MIN_BYTES. Command prose must not restate
# them.
# My Budget App's privacy notice (/confidentialite) states that each nightly copy
# is deleted after 14 days, i.e. KEEP at one dump a night: change both together.
#
# A dump is only counted if it is a custom-format archive (PGDMP magic) of at
# least MIN_BYTES. An empty or tiny file is deleted and is a finding: a backup
# that "succeeded" into nothing is the failure this job exists to stop.
#
# Exit: 0 every database dumped and verified; 1 a finding (pg_dump failed, or
# the dump was empty/tiny/not an archive); 2 could not run for at least one
# database (no config, no pg_dump, iCloud absent, missing keychain item) —
# UNKNOWN, never healthy. 2 outranks 1. Every non-zero exit alerts through
# notifier.sh. Restore: pg_restore --no-owner -d <target-url> <file>.dump
set -uo pipefail

KEEP=14
MIN_BYTES=4096

CONFIG="${DB_BACKUP_CONFIG:-$HOME/.claude/db-backup.json}"
ICLOUD_ROOT="${DB_BACKUP_ICLOUD_ROOT:-$HOME/Library/Mobile Documents/com~apple~CloudDocs}"
DEST="${DB_BACKUP_DEST:-$ICLOUD_ROOT/exports/db-backups}"
NOTIFIER="${NOTIFIER_BIN:-$HOME/.claude/scripts/notifier.sh}"
ACCOUNT="${USER:-$(id -un)}"

umask 077

warn() { echo "WARN: $*" >&2; }

notify() {
  [ -x "$NOTIFIER" ] || return 0
  local body_file
  body_file=$(mktemp)
  printf '%s\n' "$2" > "$body_file"
  "$NOTIFIER" "$1" "$body_file" --priorite 4 >/dev/null 2>&1 || true
  rm -f "$body_file"
}

die2() {
  warn "$1"
  notify "db-backup — could not run (exit 2 = unknown)" "$1"
  exit 2
}

redact() { sed -E 's#postgres(ql)?://[^[:space:]"'"'"']*#<url-redacted>#g'; }

command -v jq >/dev/null 2>&1 || die2 "jq not found — cannot run."

PG_DUMP="${DB_BACKUP_PG_DUMP:-}"
if [ -z "$PG_DUMP" ]; then
  PG_DUMP=$(command -v pg_dump 2>/dev/null || true)
  [ -z "$PG_DUMP" ] && [ -x /opt/homebrew/opt/libpq/bin/pg_dump ] && PG_DUMP=/opt/homebrew/opt/libpq/bin/pg_dump
fi
[ -n "$PG_DUMP" ] && [ -x "$PG_DUMP" ] || die2 "pg_dump not found. Install it with: brew install libpq"

[ -f "$CONFIG" ] || die2 "config not found: $CONFIG"
entries=$(jq -r '.[] | [.name, .keychain_service] | @tsv' "$CONFIG" 2>/dev/null) \
  || die2 "config is not a JSON array of {name, keychain_service}: $CONFIG"
[ -n "$entries" ] || die2 "config lists no databases: $CONFIG"

# An absent iCloud root means Drive is not mounted; mkdir -p would invent a
# local folder that never syncs and the dump would look saved.
[ -d "$ICLOUD_ROOT" ] || die2 "iCloud Drive not found at: $ICLOUD_ROOT"

stamp=$(date +%Y-%m-%d)
worst=0
report=""

note() { # $1 = level (1|2), $2 = line
  report+="$2"$'\n'
  warn "$2"
  [ "$1" -gt "$worst" ] && worst=$1
  return 0
}

while IFS=$'\t' read -r name service; do
  case "$name" in
    ''|*[!a-z0-9-]*|-*) note 2 "$name: invalid name in config (kebab-case only)"; continue ;;
  esac
  [ -n "$service" ] || { note 2 "$name: no keychain_service in config"; continue; }

  url=$(security find-generic-password -s "$service" -a "$ACCOUNT" -w 2>/dev/null || true)
  if [ -z "$url" ]; then
    note 2 "$name: no keychain item (service '$service', account \$USER). Set it with: security add-generic-password -U -s '$service' -a \"\$USER\" -w"
    continue
  fi
  url=$(printf '%s' "$url" | sed -E 's#^([a-z]+://[^/@]*@[^/?]*)-pooler\.#\1.#')

  outdir="$DEST/$name"
  mkdir -p "$outdir" && chmod 700 "$outdir" || { note 2 "$name: cannot create $outdir"; continue; }

  tmp="$outdir/.$name-$stamp.dump.partial"
  err=$(mktemp)
  if ! "$PG_DUMP" -Fc --no-owner --no-privileges -f "$tmp" "$url" 2>"$err"; then
    detail=$(tail -n 3 "$err" | redact | tr '\n' ' ')
    rm -f "$tmp" "$err"
    note 1 "$name: pg_dump failed — $detail"
    continue
  fi
  rm -f "$err"

  size=$(wc -c < "$tmp" 2>/dev/null | tr -d ' ')
  size=${size:-0}
  magic=$(head -c 5 "$tmp" 2>/dev/null || true)
  if [ "$size" -lt "$MIN_BYTES" ] || [ "$magic" != "PGDMP" ]; then
    rm -f "$tmp"
    note 1 "$name: dump rejected (${size} bytes, below ${MIN_BYTES} or not a pg_dump archive) — not counted as a backup"
    continue
  fi

  chmod 600 "$tmp"
  mv -f "$tmp" "$outdir/$name-$stamp.dump"

  # Retention: dated names sort lexically; drop everything past the newest KEEP.
  # shellcheck disable=SC2012
  ls -1 "$outdir" | grep -E "^$name-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$" | sort -r | tail -n +"$((KEEP + 1))" \
    | while read -r old; do rm -f "$outdir/$old"; done

  echo "db-backup ok: $name $stamp ${size} bytes"
done <<< "$entries"

if [ "$worst" -ne 0 ]; then
  notify "db-backup — $([ "$worst" -eq 2 ] && echo 'could not run (unknown)' || echo 'finding')" "$report"
fi
exit "$worst"
