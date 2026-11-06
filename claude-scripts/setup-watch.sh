#!/usr/bin/env bash
# setup-watch.sh — weekly PROPOSAL about the health of the Claude Code setup:
# login expiry, Claude Code CHANGELOG versions not yet reviewed, scheduled jobs
# failing since a dated first sighting. No model call anywhere.
#
# It proposes and never applies. It writes $ETAT/proposition-<date>.md in the
# portrait sheet shape and pushes counts. The owner reads the sheet in a session.
#
# Run by the LaunchAgent com.example.setup-watch, never by cron: the CLI reads
# its OAuth credentials from the login keychain, which exists only in the GUI
# session. The only CLI call is `auth status`.
#
# Constants, owned here and restated nowhere:
#   SEUIL_CONNEXION_JOURS — the job is weekly, so a threshold equal to the CLI's
#     own warning distance can be crossed between two runs with no notice left;
#     this one guarantees at least one week of notice.
#   DELAI_AUTH_S, DELAI_HTTP_S — launchd has no timeout of its own; a call over
#     the limit is a hung call, not a slow one.
#   MAX_VERSIONS_LISTEES — what one sitting can judge; beyond it one summary item
#     names the remainder count, and the excerpt file still holds everything.
#
# The CHANGELOG is read from the repository file, not the RSS feed (the RSS omits
# every "Fixed" line). Versions are skipped upstream, so the reviewed-up-to marker
# ($ETAT/revu-jusqua) is matched as an exact heading line, and a marker that is
# not in the body makes the section unknown. Only --traite moves the marker.
#
# Exit codes follow the portfolio convention: 0 healthy (news alone is 0), 1 a
# finding (login under the threshold or logged out, a failing job), 2 could not
# run = unknown. Any section unknown makes the run 2; the other sections still
# run and report. Every run ends with one timestamped summary line on stdout, so
# the log's age is a liveness signal.
#
# Every exit 2 pushes exactly one counts-only message, wherever it is reached
# (unknown section, unreadable clock, ERR trap, sheet not written): a run that
# could not run must not look like a quiet week. Two exits have no push to send
# and say so on stderr instead: no temp dir (mktemp failed) and no push-text.sh.
# A new sheet is written before
# any older pending sheet is retired, so a failed write loses nothing.
#
# Each section runs in its own subshell with errexit on: a section that breaks
# is recorded as unknown and the next sections and the sheet still happen. A
# section reports through files under $TMP, never through shell globals.
#
# Failing jobs come from jobs-inventory.sh --json. Only the forms launchd leaves empty ("-",
# "(never exited)") are unknown; every other last_exit (integer, signed, "N: NAME",
# NOT LOADED) is a failure, as jobs-inventory counts it. EXEMPT_EXIT1 lists the jobs whose
# exit 1 is not a failure: com.example.portrait (1 = a proposal was written) and
# com.example.setup-watch itself (its exit 1 restates findings already listed).
#
# Test overrides: SETUP_WATCH_ETAT, SETUP_WATCH_CLAUDE, SETUP_WATCH_INVENTAIRE,
# NOTIFIER_BIN (the standard notifier override, read by push-text.sh),
# SETUP_WATCH_CHANGELOG_URL (a file:// URL in tests), SETUP_WATCH_NOW (epoch
# seconds), SETUP_WATCH_DELAI_AUTH_S.
# No -E, deliberately: with it every $(...) inherits the ERR trap, which either
# ran fin twice (bash 5) or, when made to exit quietly in the subshell, let a
# failure inside a case word or a [ ] test read as healthy (reviews 4 and 5).
# The ERR trap covers top-level commands only; a function checks its own risky
# commands with an explicit "|| fin 2".
set -euo pipefail
# Pin a locale: launchd sets none.
export LC_ALL=C.UTF-8

SEUIL_CONNEXION_JOURS=14
DELAI_AUTH_S="${SETUP_WATCH_DELAI_AUTH_S:-30}"
DELAI_HTTP_S=30
MAX_VERSIONS_LISTEES=7
# Exit 1 means "a proposal was written" for the portrait job and "the findings this
# run lists" for this one: counting either would make every finding re-report
# itself the next week.
EXEMPT_EXIT1="com.example.portrait com.example.setup-watch"

export PATH="/Users/{username}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"

ETAT="${SETUP_WATCH_ETAT:-/Users/{username}/.claude/state/setup-watch}"
CLAUDE="${SETUP_WATCH_CLAUDE:-claude}"
INVENTAIRE="${SETUP_WATCH_INVENTAIRE:-/Users/{username}/.claude/scripts/jobs-inventory.sh}"
URL_CHANGELOG="${SETUP_WATCH_CHANGELOG_URL:-https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md}"
MARQUEUR="$ETAT/revu-jusqua"
NOW="${SETUP_WATCH_NOW:-$(date +%s)}"

n_versions=0
n_echecs=0
jours_connexion=""

# --traite <YYYY-MM-DD> [<x.y.z>]: retire a pending sheet. The one place the
# reviewed-up-to marker is written, so that it can only move to a version the
# owner was shown: a marker that advanced by itself would either mark unread
# versions as reviewed or never move. Not a scheduled run: one confirmation line,
# no summary line, no push. Exit 0 done, 2 refused (one French line on stderr).
traiter() {
  local d="${1:-}" v="${2:-}" feuille traitees="$ETAT/traitees" statut
  refus() { echo "setup-watch --traite : $1" >&2; exit 2; }
  [ "$#" -ge 1 ] && [ "$#" -le 2 ] || refus "usage : --traite AAAA-MM-JJ [x.y.z]"
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || refus "date invalide : $d"
  [ "$(date -j -f %Y-%m-%d "$d" +%Y-%m-%d 2> /dev/null)" = "$d" ] || refus "date invalide : $d"
  feuille="$ETAT/proposition-$d.md"
  [ -f "$feuille" ] || refus "aucune feuille en attente pour $d"
  [ ! -e "$traitees/proposition-$d.md" ] || refus "la feuille du $d est déjà traitée"
  if [ -n "$v" ]; then
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refus "version invalide : $v"
    # The excerpt holds only the versions this sheet showed.
    [ -f "$ETAT/changelog-$d.md" ] && grep -Fxq "## $v" "$ETAT/changelog-$d.md" \
      || refus "la version $v ne figure pas dans l'extrait de cette feuille"
    printf '%s\n' "$v" > "$ETAT/.revu.$$" && mv -f "$ETAT/.revu.$$" "$MARQUEUR" \
      || refus "écriture du repère impossible"
    statut="revue: $v"
  else
    statut="traitée"
  fi
  mkdir -p "$traitees" || refus "dossier des feuilles traitées impossible"
  { printf '%s\n' "$statut"; cat "$feuille"; } > "$ETAT/.traitee.$$" \
    && mv -f "$ETAT/.traitee.$$" "$traitees/proposition-$d.md" \
    && rm -f "$feuille" \
    || refus "retrait de la feuille impossible"
  if [ -e "$ETAT/changelog-$d.md" ]; then
    mv -f "$ETAT/changelog-$d.md" "$traitees/changelog-$d.md" || refus "retrait de l'extrait impossible"
  fi
  printf '0\n' > "$ETAT/.non-traitees.$$" && mv -f "$ETAT/.non-traitees.$$" "$ETAT/non-traitees" \
    || refus "remise à zéro du compteur impossible"
  echo "feuille du $d retirée ($statut)"
}

if [ "${1:-}" = "--traite" ]; then
  shift
  traiter "$@"
  exit 0
fi

# Sourced after --traite, which pushes nothing. Without the library no push can
# be sent, so this is an exit 2 with the summary line, not a crash.
# Tested with -r first: bash 3.2 (macOS /bin/bash) exits on a failed `.` under
# errexit even inside `||`.
PUSH_TEXT_LIB="$(dirname "${BASH_SOURCE[0]}")/push-text.sh"
[ -r "$PUSH_TEXT_LIB" ] || {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) setup-watch exit 2 (0 versions, 0 échecs, connexion ? j : push-text.sh illisible)"
  echo "setup-watch: push-text.sh missing or unreadable, no push sent" >&2
  exit 2
}
. "$PUSH_TEXT_LIB"

# fd 3 is the real stdout: fin may run where stdout is a file.
exec 3>&1

TMP="$(mktemp -d)" || {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) setup-watch exit 2 (0 versions, 0 échecs, connexion ? j : mktemp impossible)"
  echo "setup-watch: mktemp failed, no push sent" >&2
  exit 2
}
trap 'rm -rf "$TMP"' EXIT
: > "$TMP/items"

# 1 once this run has pushed (or tried to).
pousse=0

# fin <rc> [cause]: the one summary line, then exit.
fin() {
  local rc="$1" cause="${2:-}" suffixe=""
  [ -z "$cause" ] || suffixe=" : $cause"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) setup-watch exit $rc ($n_versions versions, $n_echecs échecs, connexion ${jours_connexion:-?} j$suffixe)" >&3
  # Every exit 2 pushes exactly once: pousser already did on the normal path, any
  # other path (clock, ERR trap, sheet write) reaches here first. Counts only.
  if [ "$rc" -eq 2 ] && [ "$pousse" -eq 0 ]; then
    pousse=1
    push_text "setup-watch" "setup-watch: could not run, state unknown. Detail in its log."
  fi
  exit "$rc"
}

# Outside a section, any failed command is unknown, never healthy.
trap 'fin 2 "erreur inattendue"' ERR

case "$NOW" in ''|*[!0-9]*) fin 2 "horloge illisible" ;; esac
AUJOURDHUI="$(date -r "$NOW" +%Y-%m-%d)"

# item <op> <texte> <source>: one sheet line, op in ! i ?.
item() {
  local texte="${2//$'\t'/ }"
  texte="${texte//$'\n'/ }"
  printf '%s\t%s\t%s\n' "$1" "$texte" "$3" >> "$TMP/items"
}

# sec_etat <section> <ok|constat|inconnu>
sec_etat() { printf '%s\n' "$2" > "$TMP/etat_$1"; }

# inconnu <section> <cause> <source>: the section could not tell.
inconnu() {
  sec_etat "$1" inconnu
  item '?' "$1 : $2" "$3"
}

section_connexion() {
  local rc=0 jours expire
  command -v "$CLAUDE" > /dev/null 2>&1 || { inconnu connexion "CLI absent" "auth status"; return 0; }
  # perl's alarm survives exec: a hung call is killed by SIGALRM (rc 142).
  /usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' "$DELAI_AUTH_S" \
    "$CLAUDE" auth status > "$TMP/auth" 2> /dev/null || rc=$?
  if [ "$rc" -eq 142 ]; then inconnu connexion "délai dépassé" "auth status"; return 0; fi

  # Stdout is parsed first, whatever the rc: logged out may exit non-zero.
  if ! /usr/bin/jq -e 'type == "object" and has("loggedIn")' "$TMP/auth" > /dev/null 2>&1; then
    inconnu connexion "réponse illisible" "auth status"; return 0
  fi
  if [ "$(/usr/bin/jq -r '.loggedIn' "$TMP/auth")" = "false" ]; then
    sec_etat connexion constat
    item '!' "connexion : non connecté" "auth status"
    return 0
  fi
  [ "$(/usr/bin/jq -r '.loggedIn' "$TMP/auth")" = "true" ] \
    || { inconnu connexion "réponse illisible" "auth status"; return 0; }

  expire="$(/usr/bin/jq -r 'if (.loginExpiresAt | type) == "string" then .loginExpiresAt else empty end' "$TMP/auth")"
  [ -n "$expire" ] || { inconnu connexion "échéance absente" "auth status"; return 0; }
  jours="$(/usr/bin/jq -r --argjson now "$NOW" \
    '(.loginExpiresAt | sub("\\.[0-9]+Z$"; "Z") | fromdate) as $e | (($e - $now) / 86400) | floor' \
    "$TMP/auth" 2> /dev/null)" || { inconnu connexion "échéance illisible" "auth status"; return 0; }
  case "$jours" in ''|*[!0-9-]*) inconnu connexion "échéance illisible" "auth status"; return 0 ;; esac
  printf '%s\n' "$jours" > "$TMP/jours_connexion"
  if [ "$jours" -lt "$SEUIL_CONNEXION_JOURS" ]; then
    sec_etat connexion constat
    if [ "$jours" -lt 0 ]; then item '!' "connexion expirée ($jours j)" "auth status"
    else item '!' "connexion expire dans $jours j" "auth status"; fi
  else
    sec_etat connexion ok
  fi
}

# Unreviewed CHANGELOG versions, cut at the reviewed-up-to marker. News is never
# a finding: it makes items, not an exit code. Failures, in order, first wins.
section_changelog() {
  local marqueur version entrees fixed src="changelog-$AUJOURDHUI.md" n i=0 reste
  # 1. The marker: one line, a version. Missing or malformed is unknown, never
  #    "everything is new".
  marqueur="$(cat "$MARQUEUR" 2> /dev/null)" || marqueur=""
  [[ "$marqueur" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || { inconnu changelog "repère absent" "revu-jusqua"; return 0; }
  # 2. Unconditional fetch, no cache: change is detected by content.
  /usr/bin/curl -fsS --max-time "$DELAI_HTTP_S" "$URL_CHANGELOG" > "$TMP/changelog" 2> /dev/null \
    || { inconnu changelog "CHANGELOG injoignable" "$src"; return 0; }
  # 3. A 200 that is not the changelog (empty, error page, truncated).
  grep -Eq '^## [0-9]+\.[0-9]+\.[0-9]+$' "$TMP/changelog" \
    || { inconnu changelog "CHANGELOG méconnaissable" "$src"; return 0; }
  # 4. Falsifying control: the marker heading must be an exact line of the body.
  #    Versions are skipped upstream, so membership is by whole line, never by
  #    number or substring; a file, not a pipe (SIGPIPE under pipefail).
  grep -Fxq "## $marqueur" "$TMP/changelog" \
    || { inconnu changelog "repère introuvable dans le CHANGELOG" "$src"; return 0; }

  awk -v m="## $marqueur" '
    $0 == m { exit }
    /^## [0-9]+\.[0-9]+\.[0-9]+$/ { vu = 1 }
    vu { print }
  ' "$TMP/changelog" > "$TMP/extrait"
  awk '
    function sortir() { if (v != "") print v "\t" n "\t" f }
    /^## [0-9]+\.[0-9]+\.[0-9]+$/ { sortir(); v = substr($0, 4); n = 0; f = 0; next }
    /^- / { n++; if ($0 ~ /^- Fixed/) f++ }
    END { sortir() }
  ' "$TMP/extrait" > "$TMP/versions"
  n="$(wc -l < "$TMP/versions" | tr -d ' ')"
  printf '%s\n' "$n" > "$TMP/n_versions"

  while IFS=$'\t' read -r version entrees fixed; do
    i=$((i + 1))
    [ "$i" -le "$MAX_VERSIONS_LISTEES" ] || break
    item i "$version : $entrees entrées, dont $fixed Fixed" "$src"
  done < "$TMP/versions"
  if [ "$n" -gt "$MAX_VERSIONS_LISTEES" ]; then
    reste=$((n - MAX_VERSIONS_LISTEES))
    item i "$reste versions de plus, voir l'extrait" "$src"
  fi
  sec_etat changelog ok
}

# Failing jobs, keyed on the first date setup-watch saw each one failing, kept in
# its own state ($ETAT/echecs.tsv: label, first-seen date, last exit). Never
# parsed from other jobs' logs. The date is a first sighting, not the start of
# the failure, hence the lower bound in the sheet.
section_echecs() {
  local rc=0 etat="$ETAT/echecs.tsv"
  "$INVENTAIRE" --json > "$TMP/inventaire.json" 2> /dev/null || rc=$?
  # The inventory exits 1 whenever any job fails, the normal case here: 0 and 1
  # are read; 2, a crash, a non-array or an empty list is unknown.
  if [ "$rc" -gt 1 ] || ! /usr/bin/jq -e \
      'type == "array" and length > 0 and all(.[]; type == "object" and (.label | type) == "string")' \
      "$TMP/inventaire.json" > /dev/null 2>&1; then
    inconnu echecs "inventaire illisible" "jobs-inventory"; return 0
  fi
  if [ -e "$etat" ]; then
    cat "$etat" > "$TMP/echecs.avant" 2> /dev/null \
      || { inconnu echecs "état illisible" "echecs.tsv"; return 0; }
  else
    : > "$TMP/echecs.avant"
  fi

  /usr/bin/jq -n --rawfile st "$TMP/echecs.avant" --slurpfile inv "$TMP/inventaire.json" \
    --arg today "$AUJOURDHUI" --arg exempt "$EXEMPT_EXIT1" '
    def jour($d): ($d + "T00:00:00Z") | fromdate;
    ($exempt | split(" ")) as $ex
    | ($st | split("\n") | map(select(length > 0) | {line: ., f: split("\t")})
        | map({key: .f[0], value: {date: .f[1], line: .line}}) | from_entries) as $old
    | [ $inv[0][]
        | .label as $l | ((.last_exit // "") | tostring) as $e | (.schedule // "") as $s
        | if $e == "0"
             or ($e == "143" and $s == "at login, kept alive")
             or ($e == "1" and ($ex | any(. == $l)))
          then {kind: "sain"}
          elif $e == "" or $e == "-" or $e == "(never exited)"
          then (if $old[$l] then {kind: "inconnu", line: $old[$l].line} else {kind: "inconnu"} end)
          else ($old[$l].date // $today) as $d
                | {kind: "echec", label: $l, e: $e, d: $d,
                   jours: (((jour($today) - jour($d)) / 86400) | floor)}
          end ]
    | { state: [ .[] | if .kind == "echec" then "\(.label)\t\(.d)\t\(.e)"
                       elif .kind == "inconnu" and .line then .line else empty end ],
        items: [ .[] | select(.kind == "echec")
                 | "!\t\(.label) : \(if .e == "NOT LOADED" then "non chargé" else "exit \(.e)" end) depuis le \(.d) (≥ \(.jours) j)\tjobs-inventory" ] }
  ' > "$TMP/echecs.json" || { inconnu echecs "état illisible" "echecs.tsv"; return 0; }

  /usr/bin/jq -r '.state[]' "$TMP/echecs.json" > "$TMP/echecs.nouveau" \
    || { inconnu echecs "état illisible" "echecs.tsv"; return 0; }
  mkdir -p "$ETAT" && cp "$TMP/echecs.nouveau" "$ETAT/.echecs.$$" && mv -f "$ETAT/.echecs.$$" "$etat" \
    || { rm -f "$ETAT/.echecs.$$"; inconnu echecs "état non écrit" "echecs.tsv"; return 0; }

  /usr/bin/jq -r '.items[]' "$TMP/echecs.json" >> "$TMP/items" \
    || { inconnu echecs "état illisible" "echecs.tsv"; return 0; }
  n="$(/usr/bin/jq '.items | length' "$TMP/echecs.json")"
  printf '%s\n' "$n" > "$TMP/n_echecs"
  if [ "$n" -gt 0 ]; then sec_etat echecs constat; else sec_etat echecs ok; fi
}

# run_section <name>: errexit on inside, isolated from the ERR trap of the
# caller; a section that breaks is unknown and never stops the next ones.
run_section() {
  local nom="$1" rc=0
  trap - ERR
  set +e
  ( set -e; "section_$nom" )
  rc=$?
  set -e
  trap 'fin 2 "erreur inattendue"' ERR
  if [ "$rc" -ne 0 ]; then
    inconnu "$nom" "erreur inattendue" "setup-watch.sh"
  fi
  return 0
}

etat_de() { local f="$TMP/etat_$1"; cat "$f" 2>/dev/null || echo inconnu; }  # unreadable = unknown, never empty

# code_sortie: 2 if any section is unknown, else 1 if any is a finding, else 0.
code_sortie() {
  local s e=0 f=0
  for s in connexion changelog echecs; do
    case "$(etat_de "$s")" in
      inconnu) e=1 ;;
      constat) f=1 ;;
    esac
  done
  if [ "$e" -eq 1 ]; then echo 2; elif [ "$f" -eq 1 ]; then echo 1; else echo 0; fi
}

# ecrire_feuille: the sheet, the excerpt, supersession of older pending sheets.
# Sets feuille_ecrite (0/1) and cause_fin. Items are ordered unknown, finding,
# news (breakage before news), numbered from 1, one line each and nothing else,
# so the sheet stays parseable by the portrait pane's item shape.
feuille_ecrite=0
cause_fin=""
ecrire_feuille() {
  local cible="$ETAT/proposition-$AUJOURDHUI.md" op f d deplacees=0 compteur=0
  [ -s "$TMP/items" ] || return 0
  mkdir -p "$ETAT/traitees" || return 1
  # A manual rerun on a day already treated must not recreate a pending sheet.
  if [ -e "$ETAT/traitees/proposition-$AUJOURDHUI.md" ]; then
    cause_fin="feuille du jour déjà traitée"
    return 0
  fi
  : > "$TMP/ordre"
  for op in '?' '!' i; do
    awk -F'\t' -v o="$op" '$1 == o' "$TMP/items" >> "$TMP/ordre" || return 1
  done
  awk -F'\t' '{ printf "%d. [%s] %s — %s\n", NR, $1, $2, $3 }' "$TMP/ordre" > "$TMP/feuille" || return 1
  if [ "$n_versions" -gt 0 ]; then
    cp "$TMP/extrait" "$ETAT/.extrait.$$" || return 1
  fi

  # The new sheet is written FIRST: an older pending sheet is retired only once
  # its successor exists, so a failed write loses nothing.
  rm -f "$ETAT/changelog-$AUJOURDHUI.md"
  if [ "$n_versions" -gt 0 ]; then
    mv -f "$ETAT/.extrait.$$" "$ETAT/changelog-$AUJOURDHUI.md" || return 1
  fi
  mv -f "$TMP/feuille" "$cible" || return 1

  # Every other pending sheet (and its excerpt) is retired as superseded: one
  # pending sheet at a time, the counter keeps the loss visible.
  for f in "$ETAT"/proposition-*.md; do
    [ -e "$f" ] || continue
    [ "$f" != "$cible" ] || continue
    d="${f##*/proposition-}"; d="${d%.md}"
    { printf 'remplacée: %s\n' "$AUJOURDHUI"; cat "$f"; } > "$TMP/remplacee" || return 1
    mv -f "$TMP/remplacee" "$ETAT/traitees/proposition-$d.md" || return 1
    rm -f "$f"
    if [ -e "$ETAT/changelog-$d.md" ]; then mv -f "$ETAT/changelog-$d.md" "$ETAT/traitees/changelog-$d.md" || return 1; fi
    deplacees=$((deplacees + 1))
  done
  if [ "$deplacees" -gt 0 ]; then
    if [ -s "$ETAT/non-traitees" ]; then compteur="$(cat "$ETAT/non-traitees")"; fi
    case "$compteur" in ''|*[!0-9]*) compteur=0 ;; esac
    printf '%s\n' "$((compteur + deplacees))" > "$ETAT/.non-traitees.$$" || return 1
    mv -f "$ETAT/.non-traitees.$$" "$ETAT/non-traitees" || return 1
  fi

  feuille_ecrite=1
}

# pluriel <n> <singular> <plural>
pluriel() { if [ "$1" -eq 1 ]; then printf '%s %s' "$1" "$2"; else printf '%s %s' "$1" "$3"; fi; }

# pousser <rc>: counts only. The topic is public, so no job label, no version
# text, no path, no cause: unknown sections are named by fixed words.
pousser() {
  local rc="$1" corps="" inconnus="" s en_attente=0
  if [ "$feuille_ecrite" -ne 1 ] && [ "$rc" -eq 0 ]; then pousse=1; return 0; fi
  if [ "$n_versions" -gt 0 ]; then
    corps+="$(pluriel "$n_versions" 'version non revue' 'versions non revues')"
  fi
  if [ "$n_echecs" -gt 0 ]; then
    corps+="${corps:+ · }$(pluriel "$n_echecs" 'échec' 'échecs')"
  fi
  if [ -n "$jours_connexion" ]; then corps+="${corps:+ · }connexion $jours_connexion j"; fi
  for s in connexion changelog echecs; do
    if [ "$(etat_de "$s")" = inconnu ]; then
      case "$s" in echecs) s="tâches" ;; esac
      inconnus+="${inconnus:+, }$s"
    fi
  done
  if [ -n "$inconnus" ]; then corps+="${corps:+ · }inconnu : $inconnus"; fi
  if [ -s "$ETAT/non-traitees" ]; then
    en_attente="$(cat "$ETAT/non-traitees")" || fin 2 "compteur de feuilles illisible"
  fi
  case "$en_attente" in ''|*[!0-9]*) en_attente=0 ;; esac
  if [ "$en_attente" -gt 0 ]; then
    corps+="${corps:+ · }$(pluriel "$en_attente" 'feuille non traitée' 'feuilles non traitées')"
  fi
  # push_text never fails the caller: a failing notifier cannot change the exit code.
  # pousse is set only once the push is attempted: a failure above leaves it 0,
  # so fin still pushes the exit-2 message.
  pousse=1
  push_text "setup-watch" "$corps"
}

for s in connexion changelog echecs; do run_section "$s"; done

[ ! -f "$TMP/jours_connexion" ] || jours_connexion="$(cat "$TMP/jours_connexion")"
[ ! -f "$TMP/n_versions" ] || n_versions="$(cat "$TMP/n_versions")"
[ ! -f "$TMP/n_echecs" ] || n_echecs="$(cat "$TMP/n_echecs")"

rc="$(code_sortie)"
ecrire_feuille || fin 2 "écriture de la feuille impossible"
pousser "$rc"
fin "$rc" "$cause_fin"
