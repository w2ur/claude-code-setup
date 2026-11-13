#!/usr/bin/env bash
# notifier.sh — pousse un message vers le canal de notification de {author-first-name} (ntfy).
#
# Générique à dessein : model-watch.sh, gate-watch.sh, distribution-watch.sh (via notify-on-exit.sh) et elenchus-watch.sh
# sortent 1 sur des trouvailles que personne ne lit autrement. Un seul canal,
# une seule redaction, un seul endroit où le sujet est écrit.
#
# CANAL : ntfy.sh, choix assumé de {author-first-name} le 2026-08-21. Le même sujet est lu
# par l'application téléphone ET par https://ntfy.sh/<sujet> dans un navigateur.
# Ce qui est accepté en connaissance de cause : le corps du message transite par
# un serveur tiers, protégé par la seule difficulté de deviner le nom du sujet.
# Les sujets réservés sont payants et l'auto-hébergement coûte un serveur : ni
# l'un ni l'autre ne passe la politique zéro coût.
#
# REDACTION — la raison d'être de ce script, et pas une précaution de confort.
# Les appelants lisent secrets.json et composent des appels curl
# portant « Authorization: Bearer … ». Un run qui échoue en recopiant sa commande
# enverrait le jeton en clair sur un sujet public. Deux filets, pas un :
#   1. les VALEURS LITTÉRALES lues dans secrets.json, ce qui est exact et ne
#      dépend d'aucune heuristique ;
#   2. les motifs génériques du hook secret-scan, pour ce qui viendrait d'ailleurs.
# Le premier filet attrape ce que le second ne peut pas voir : un jeton
# propriétaire ne ressemble à aucun motif connu.
#
# Codes de sortie :
#   0 — envoyé, OU canal écarté exprès (`NTFY_TOPIC=` écrit vide dans la conf)
#   1 — appelé de travers, ou l'envoi a échoué, OU le corps a été retenu
#       (filet littéral requis mais indisponible : seul un message de
#       remplacement part, jamais le contenu). Une CONSTATATION.
#       An undelivered message is still 1 even when it was spooled for the
#       next call (see "Transport: retry, then spool" below). A withheld body
#       is 1 too, so that callers which record state on 0 (offers marked as
#       pushed, a comment marked as armed) do not record content that never
#       left; a deferred (--a) message with a withheld body sends nothing.
#       --dry and --dry-all print what would be sent and stay 0.
#   2 — pas de canal par accident : conf absente, ou conf sans ligne
#       NTFY_TOPIC. Rien n'est envoyé et l'appelant ne doit rien marquer livré.
#
# Test overrides: NOTIFIER_CONF, NOTIFIER_RETRY_DELAYS, NOTIFIER_SPOOL_DIR,
# NOTIFIER_SPOOL_MAX (scripts/tests/notifier/transport.sh).
set -uo pipefail

CONF="${NOTIFIER_CONF:-$HOME/.claude/scripts/.notifier.conf}"
SECRETS="${NOTIFIER_SECRETS:-$HOME/Library/CloudStorage/{email}/Drive/{private-workspace}/secrets.json}"

TITRE=""; CORPS=""; LIEN=""; PRIORITE="default"; DRY=0; QUAND=""

die() { printf 'notifier: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --lien)     LIEN="${2:-}"; shift 2 ;;
    --priorite) PRIORITE="${2:-}"; shift 2 ;;
    --a)        QUAND="${2:-}"; shift 2 ;;
    --dry)      DRY=1; shift ;;
    --dry-all)  DRY=2; shift ;;
    -h|--help)  echo "usage: notifier.sh <titre> <fichier-corps> [--lien URL] [--priorite N] [--a EPOCH] [--dry|--dry-all]"; exit 0 ;;
    *)          if [ -z "$TITRE" ]; then TITRE="$1"; elif [ -z "$CORPS" ]; then CORPS="$1"; else die "argument inattendu : $1"; fi; shift ;;
  esac
done

# --a : livraison différée, en secondes epoch.
#
# ntfy tient le calendrier lui-même (en-tête X-At), ce qui vaut bien mieux qu'un
# agent local qui interroge l'état toutes les quinze minutes : si la machine dort
# ou redémarre, la notification part quand même. Mesuré le 2026-08-21 :
# +3 jours acceptés, +4 jours REFUSÉS (« invalid delay parameter: too large »).
# La limite est donc de 72 heures et il faut réarmer au-delà — ne pas la déduire
# d'une documentation, elle a été trouvée en la faisant échouer.
if [ -n "$QUAND" ]; then
  case "$QUAND" in
    ''|*[!0-9]*) die "--a attend des secondes epoch, reçu : $QUAND" ;;
  esac
  maintenant=$(date +%s)
  delta=$(( QUAND - maintenant ))
  [ "$delta" -gt 10 ] || die "--a est dans le passé ou trop proche (${delta}s) : rien n'est envoyé plutôt qu'envoyé tout de suite"
  [ "$delta" -le 259200 ] || die "--a dépasse les 72 h que ntfy accepte (${delta}s) : réarmer plus tard"
fi

# A newline in the title or the link would shift the spool's one-field-per-line
# format and split the HTTP header. The title has its CR and LF collapsed to
# spaces; a URL has no use for either, so the link loses them outright.
TITRE="${TITRE//$'\r'/ }"
TITRE="${TITRE//$'\n'/ }"
LIEN="${LIEN//$'\r'/}"
LIEN="${LIEN//$'\n'/}"

[ -n "$TITRE" ] || die "titre manquant"
[ -n "$CORPS" ] || die "fichier de corps manquant"
[ -f "$CORPS" ] || die "corps introuvable : $CORPS"

# --- Redaction ---------------------------------------------------------------
# Filet 1 : les valeurs littérales. On ne retient que les clés dont le NOM dit
# qu'elles sont secrètes — redacter dispatch_url rendrait les messages illisibles
# sans rien protéger.
# The first net is REQUIRED by default. When it cannot be loaded (secrets.json
# sits on a cloud mount that may be absent, jq may be missing, the file may be
# unreadable JSON, or it may hold no qualifying literal at all), the generic
# patterns alone would let a proprietary token through, so the body is withheld
# and a line saying why replaces it. The alert still arrives; its content does
# not, and the exit code is 1 so that callers do not record it as delivered.
# The title is still filtered, but only by the generic patterns: with no net
# loaded the literal pass has nothing to apply. That residue is accepted
# because a title names the job, not its output. The link is DROPPED in that
# case: a URL can carry a credential no generic pattern knows.
# In optional mode a secrets file that exists but is unusable is reported on
# stderr (the body is still sent); a file that does not exist stays silent,
# which is what optional is for.
# A machine with no secrets file at all sets NOTIFIER_LITERALS=optional in
# its conf (or in the environment, which wins). Any value other than
# "optional" means "required": a typo in the conf must not silence alerts, and
# must not weaken the redaction either.
literals_env="${NOTIFIER_LITERALS:-}"
# Only the conf may choose "no channel": an empty NTFY_TOPIC inherited from
# the environment is dropped, so it cannot pass for that choice.
[ -n "${NTFY_TOPIC:-}" ] || unset NTFY_TOPIC
if [ -f "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi

# No channel: decide BEFORE touching the secrets file (a cloud mount).
# Only a conf that writes `NTFY_TOPIC=` empty means "no channel, on purpose"
# (exit 0, silent). A missing conf, or one that never names a topic, is a
# broken channel: exit 2, because every caller records a message as delivered
# on 0 and the alert would be lost with nothing saying so.
if [ "$DRY" -eq 0 ]; then
  if [ ! -f "$CONF" ]; then
    printf 'notifier: configuration absente (%s), rien n'\''est envoyé\n' "$CONF" >&2
    exit 2
  fi
  if [ ! -r "$CONF" ]; then
    printf 'notifier: configuration illisible (%s), rien n'\''est envoyé\n' "$CONF" >&2
    exit 2
  fi
  if [ -z "${NTFY_TOPIC+set}" ]; then
    printf 'notifier: NTFY_TOPIC absent de la configuration, rien n'\''est envoyé (NTFY_TOPIC= vide pour se passer de canal)\n' >&2
    exit 2
  fi
  [ -n "$NTFY_TOPIC" ] || exit 0
fi

LITERALS_MODE="${literals_env:-${NOTIFIER_LITERALS:-required}}"
if [ "$LITERALS_MODE" != "optional" ]; then
  if [ "$LITERALS_MODE" != "required" ]; then
    printf 'notifier: NOTIFIER_LITERALS inconnu « %s », traité comme « required »\n' "$LITERALS_MODE" >&2
  fi
  LITERALS_MODE="required"
fi

literaux=""; filet_absent=""
if [ ! -r "$SECRETS" ]; then
  filet_absent="secrets illisibles"
elif ! command -v jq >/dev/null 2>&1; then
  filet_absent="jq absent"
elif ! literaux=$(jq -r '[paths(scalars) as $p | select(($p[-1]|tostring|test("token|key|secret|password";"i"))) | getpath($p)] | .[] | select(type=="string" and length >= 12)' "$SECRETS" 2>/dev/null | sort -u); then
  filet_absent="secrets non analysables"
  literaux=""
elif [ -z "$literaux" ]; then
  # A 0-byte file, {} or a file whose keys were renamed parses fine and yields
  # nothing: that is the net being absent, not the net finding nothing to hide.
  filet_absent="aucun secret lu"
fi

# redact_stdin: filters stdin to stdout. Literal pass first, then the generic
# patterns. The literals go through the environment, never argv: argv is
# readable in `ps` by any process of the user.
redact_stdin() {
  REDACT_VALS="$literaux" awk '
    BEGIN {
      n = 0
      m = split(ENVIRON["REDACT_VALS"], arr, "\n")
      for (i = 1; i <= m; i++) if (length(arr[i]) >= 12) lit[++n] = arr[i]
    }
    {
      line = $0
      for (i = 1; i <= n; i++) {
        while ((p = index(line, lit[i])) > 0)
          line = substr(line, 1, p - 1) "[SECRET RETIRE]" substr(line, p + length(lit[i]))
      }
      print line
    }' | sed -E \
    -e 's/(^|[^A-Za-z0-9_])(napi|sbp|nfp)_[A-Za-z0-9]{20,}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])sb_secret_[A-Za-z0-9_-]{20,}/\1[SECRET RETIRE]/g' \
    -e 's~([A-Za-z][A-Za-z0-9+.-]*://[^:/@[:space:]]*:)[^@/?#[:space:]]+@~\1[SECRET RETIRE]@~g' \
    -e 's/(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])sk_(live|test)_[A-Za-z0-9]{16,}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])gh[pos]_[A-Za-z0-9]{30,}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/\1[SECRET RETIRE]/g' \
    -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._~+/=-]{12,}/\1[SECRET RETIRE]/g' \
    -e 's/((token|password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*"?)[A-Za-z0-9_.-]{12,}/\1[SECRET RETIRE]/gI'
}

WITHHELD=0
lien_propre=""
if [ -n "$filet_absent" ] && [ "$LITERALS_MODE" = "required" ]; then
  WITHHELD=1
  corps_propre="[corps retenu : les secrets n'ont pas pu être lus pour la rédaction ($filet_absent). Le contenu n'a pas quitté la machine ; rétablir l'accès puis relancer la tâche.]"
  printf 'notifier: corps retenu, %s\n' "$filet_absent" >&2
else
  if [ -n "$filet_absent" ] && [ -e "$SECRETS" ]; then
    printf 'notifier: filet littéral inactif (mode optional), %s\n' "$filet_absent" >&2
  fi
  corps_propre=$(redact_stdin < "$CORPS")
  [ -z "$LIEN" ] || lien_propre=$(printf '%s\n' "$LIEN" | redact_stdin)
fi
titre_propre=$(printf '%s\n' "$TITRE" | redact_stdin)

if [ "$DRY" -ge 1 ]; then
  if [ "$DRY" -eq 2 ]; then
    printf 'Title: %s\nClick: %s\n' "$titre_propre" "$lien_propre"
  fi
  printf '%s\n' "$corps_propre"
  exit 0
fi

# --- Canal -------------------------------------------------------------------
# The no-channel cases were decided above, before the secrets file is touched.
NTFY_TOPIC="${NTFY_TOPIC:-}"
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"

# A deferred message with a withheld body sends nothing: its caller records
# nothing on exit 1 and re-arms it on its next pass.
if [ "$WITHHELD" -eq 1 ] && [ -n "$QUAND" ]; then
  printf 'notifier: message différé non envoyé, corps retenu (%s)\n' "$filet_absent" >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || die "curl introuvable (PATH=$PATH)"

# --- Transport: retry, then spool -------------------------------------------
# Measured in the logs of three scheduled jobs, vigie among them: a push
# that met a DNS failure (curl exit 6) was simply lost — one attempt, a line
# on stderr nobody reads, and the finding it carried never reached the phone.
# Two defences, each owned by the numbers below:
#   1. a bounded retry with backoff, on TRANSIENT failures only: transport
#      errors, HTTP 5xx (an ntfy outage) and 429 (rate limited). Any other
#      4xx from ntfy is an answer, and asking again would get the same one;
#   2. if every attempt failed transiently, the message is written
#      to a spool, and the next call that reaches ntfy sends the spool FIRST,
#      oldest first, its title prefixed with the time it was queued.
# The exit code does not change: a spooled message is still exit 1, because
# it was not delivered by this call, and callers already read 1 that way.
#
# NOT spooled: a deferred message (--a). Its caller records
# nothing on exit 1 and re-arms it on its next pass, so a spooled copy would
# be delivered twice. Nor a --dry run, which never sends.
#
# Numbers this script owns:
#   RETRY_DELAYS "5 20 60" — seconds slept before each retry, so 4 attempts
#     over ~85 s plus curl's own 20 s ceiling per attempt. Long enough to ride
#     out a Wi-Fi wake-up or a resolver hiccup, short enough that a nightly
#     job is not held for minutes.
#   SPOOL_MAX 20 — messages kept. Beyond it the OLDEST is dropped and counted;
#     the count is pushed as one line on the next flush, never silently lost.
#     Twenty is about two weeks of the usual failure traffic: past that, the
#     old ones describe a state that has long changed.
#   LOCK_STALE 600 — seconds after which a flush lock is reclaimed, so a call
#     killed mid-flush cannot freeze the spool forever.
RETRY_DELAYS="${NOTIFIER_RETRY_DELAYS:-5 20 60}"
SPOOL_DIR="${NOTIFIER_SPOOL_DIR:-$HOME/.claude/notifier-spool}"
SPOOL_MAX="${NOTIFIER_SPOOL_MAX:-20}"
LOCK_STALE=600

TMPW=$(mktemp -d) || die "mktemp impossible"
trap 'rm -rf "$TMPW"' EXIT

# curl exit codes that mean "never got an answer": could not resolve host (6),
# could not connect (7), timeout (28), TLS handshake (35), empty reply (52),
# receive failure (56).
is_transport() { case "$1" in 6|7|28|35|52|56) return 0 ;; *) return 1 ;; esac; }

# send_once <title> <priority> <link> <at> <body-file>
# Sets SEND_CURL (curl exit) and SEND_HTTP. Returns 0 delivered, 1 answered
# with a final refusal, 2 transient (transport failure, HTTP 5xx or 429).
send_once() {
  local a=(-s -S --max-time 20 -o /dev/null -w '%{http_code}'
           -H "Title: $1" -H "Priority: $2" -H "Markdown: yes")
  [ -n "$3" ] && a+=(-H "Click: $3")
  [ -n "$4" ] && a+=(-H "X-At: $4")
  SEND_HTTP=$(curl "${a[@]}" --data-binary @"$5" "$NTFY_SERVER/$NTFY_TOPIC" 2>"$TMPW/curl.err")
  SEND_CURL=$?
  if [ "$SEND_CURL" -ne 0 ]; then
    is_transport "$SEND_CURL" && return 2
    return 1
  fi
  # 5xx (ntfy down or overloaded) and 429 (rate limited) say "not now", not
  # "never": they are retried and spooled like a transport failure.
  case "$SEND_HTTP" in 2*) return 0 ;; 5*|429) return 2 ;; *) return 1 ;; esac
}

spool_count() { find "$SPOOL_DIR" -maxdepth 1 -name '*.msg' 2>/dev/null | wc -l | tr -d ' '; }

spool_add() {  # spool_add <title> <priority> <link> <body-file>
  mkdir -p "$SPOOL_DIR" && chmod 700 "$SPOOL_DIR" || return 1
  local f; f="$SPOOL_DIR/$(date +%s)-$$-$RANDOM.msg"
  { printf '%s\n%s\n%s\n%s\n' "$1" "$2" "$3" "$(date +%s)"; cat "$4"; } > "$f" || return 1
  local dropped=0
  while [ "$(spool_count)" -gt "$SPOOL_MAX" ]; do
    rm -f "$(find "$SPOOL_DIR" -maxdepth 1 -name '*.msg' | sort | head -1)"
    dropped=$((dropped + 1))
  done
  if [ "$dropped" -gt 0 ]; then
    local prev; prev=$(cat "$SPOOL_DIR/dropped" 2>/dev/null); prev=${prev:-0}
    printf '%s\n' "$((prev + dropped))" > "$SPOOL_DIR/dropped"
  fi
}

# Sends what the spool holds, oldest first. Stops at the first transient
# failure (network or ntfy still down; the rest waits for the next call). A
# message ntfy ANSWERS with a final refusal is dropped and counted — it would
# be refused again forever. Returns 2 when it stopped on a transient failure.
flush_spool() {
  [ -d "$SPOOL_DIR" ] || return 0
  local lock="$SPOOL_DIR/.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    local age=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || date +%s) ))
    [ "$age" -gt "$LOCK_STALE" ] || return 0   # another call is flushing
    rmdir "$lock" 2>/dev/null; mkdir "$lock" 2>/dev/null || return 0
  fi
  local f rc=0 refused=0 t p l q
  for f in $(find "$SPOOL_DIR" -maxdepth 1 -name '*.msg' | sort); do
    t=$(sed -n 1p "$f"); p=$(sed -n 2p "$f"); l=$(sed -n 3p "$f"); q=$(sed -n 4p "$f")
    tail -n +5 "$f" > "$TMPW/spooled.txt"
    send_once "[en attente depuis $(date -r "${q:-0}" '+%d/%m %H:%M')] $t" "$p" "$l" "" "$TMPW/spooled.txt"
    case $? in
      0) rm -f "$f" ;;
      2) rc=2; break ;;
      *) rm -f "$f"; refused=$((refused + 1)) ;;
    esac
  done
  local dropped; dropped=$(cat "$SPOOL_DIR/dropped" 2>/dev/null); dropped=${dropped:-0}
  dropped=$((dropped + refused))
  if [ "$rc" -eq 0 ] && [ "$dropped" -gt 0 ]; then
    printf '%s notification(s) en attente perdue(s) : spool plein ou refus de ntfy. Voir les logs des jobs.\n' \
      "$dropped" > "$TMPW/dropped.txt"
    if send_once "notifier — $dropped notification(s) perdue(s)" "high" "" "" "$TMPW/dropped.txt"; then
      rm -f "$SPOOL_DIR/dropped"
    else
      printf '%s\n' "$dropped" > "$SPOOL_DIR/dropped"
    fi
  elif [ "$refused" -gt 0 ]; then
    printf '%s\n' "$dropped" > "$SPOOL_DIR/dropped"
  fi
  rmdir "$lock" 2>/dev/null
  return "$rc"
}

printf '%s' "$corps_propre" > "$TMPW/corps.txt"

flush_spool
attempt=0
for delay in "" $RETRY_DELAYS; do
  if [ -n "$delay" ]; then sleep "$delay"; fi
  attempt=$((attempt + 1))
  send_once "$titre_propre" "$PRIORITE" "$lien_propre" "$QUAND" "$TMPW/corps.txt"
  case $? in
    0) [ "$WITHHELD" -eq 0 ] || exit 1
       exit 0 ;;
    1) printf 'notifier: ntfy a repondu %s (curl %s) %s\n' "$SEND_HTTP" "$SEND_CURL" "$(head -1 "$TMPW/curl.err")" >&2
       exit 1 ;;
  esac
  printf 'notifier: essai %s, echec transitoire (curl %s, http %s)\n' "$attempt" "$SEND_CURL" "$SEND_HTTP" >&2
done

# A withheld placeholder is never spooled: replaying it later would deliver
# nothing, and the caller re-runs the task on exit 1.
if [ -z "$QUAND" ] && [ "$WITHHELD" -eq 0 ] && spool_add "$titre_propre" "$PRIORITE" "$lien_propre" "$TMPW/corps.txt"; then
  printf 'notifier: envoi echoue apres %s essai(s), message mis en attente (%s en attente)\n' \
    "$attempt" "$(spool_count)" >&2
else
  printf 'notifier: envoi echoue apres %s essai(s), message NON mis en attente\n' "$attempt" >&2
fi
exit 1
