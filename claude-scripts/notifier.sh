#!/usr/bin/env bash
# notifier.sh — pousse un message vers le canal de notification de {author-first-name} (ntfy).
#
# Générique à dessein : les tâches de diffusion s'en servent pour la fenêtre de
# veto, mais model-watch.sh et gate-watch.sh sortent 1 sur des trouvailles que
# personne ne lit non plus. Un seul canal, une seule redaction, un seul endroit
# où le sujet est écrit.
#
# CANAL : ntfy.sh, choix assumé de {author-first-name} le 2026-08-21. Le même sujet est lu
# par l'application téléphone ET par https://ntfy.sh/<sujet> dans un navigateur.
# Ce qui est accepté en connaissance de cause : le texte d'un post non encore
# publié transite par un serveur tiers, protégé par la seule difficulté de
# deviner le nom du sujet. La fenêtre d'exposition est de quatre heures. Les
# sujets réservés sont payants et l'auto-hébergement coûte un serveur : ni l'un
# ni l'autre ne passe la politique zéro coût.
#
# REDACTION — la raison d'être de ce script, et pas une précaution de confort.
# Les commandes du pipeline lisent secrets.json et composent des appels curl
# portant « Authorization: Bearer … ». Un run qui échoue en recopiant sa commande
# enverrait le jeton en clair sur un sujet public. Deux filets, pas un :
#   1. les VALEURS LITTÉRALES lues dans secrets.json, ce qui est exact et ne
#      dépend d'aucune heuristique ;
#   2. les motifs génériques du hook secret-scan, pour ce qui viendrait d'ailleurs.
# Le premier filet attrape ce que le second ne peut pas voir : un jeton Buffer
# ne ressemble à aucun motif connu.
#
# Codes de sortie :
#   0 — envoyé, OU aucun canal configuré (l'absence de canal n'est pas une panne
#       du travail qu'on rapporte ; le script appelant ne doit pas échouer pour ça)
#   1 — appelé de travers, ou l'envoi a échoué. Une CONSTATATION.
set -uo pipefail

CONF="${NOTIFIER_CONF:-$HOME/.claude/scripts/.notifier.conf}"
SECRETS="${DIFFUSION_SECRETS:-$HOME/Library/CloudStorage/{email}/Mon Drive/diffusion/secrets.json}"

TITRE=""; CORPS=""; LIEN=""; PRIORITE="default"; DRY=0; QUAND=""

die() { printf 'notifier: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --lien)     LIEN="${2:-}"; shift 2 ;;
    --priorite) PRIORITE="${2:-}"; shift 2 ;;
    --a)        QUAND="${2:-}"; shift 2 ;;
    --dry)      DRY=1; shift ;;
    -h|--help)  echo "usage: notifier.sh <titre> <fichier-corps> [--lien URL] [--priorite N] [--a EPOCH] [--dry]"; exit 0 ;;
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

[ -n "$TITRE" ] || die "titre manquant"
[ -n "$CORPS" ] || die "fichier de corps manquant"
[ -f "$CORPS" ] || die "corps introuvable : $CORPS"

# --- Redaction ---------------------------------------------------------------
# Filet 1 : les valeurs littérales. On ne retient que les clés dont le NOM dit
# qu'elles sont secrètes — redacter dispatch_url rendrait les messages illisibles
# sans rien protéger.
literaux=""
if [ -r "$SECRETS" ] && command -v jq >/dev/null 2>&1; then
  literaux=$(jq -r '[paths(scalars) as $p | select(($p[-1]|tostring|test("token|key|secret|password";"i"))) | getpath($p)] | .[] | select(type=="string" and length >= 12)' "$SECRETS" 2>/dev/null | sort -u)
fi

# Les littéraux passent par l'environnement, jamais par argv : argv est lisible
# dans `ps` par n'importe quel processus de l'utilisateur.
corps_propre=$(REDACT_VALS="$literaux" awk '
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
  }' "$CORPS" | sed -E \
    -e 's/(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])sk_(live|test)_[A-Za-z0-9]{16,}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])gh[pos]_[A-Za-z0-9]{30,}/\1[SECRET RETIRE]/g' \
    -e 's/(^|[^A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/\1[SECRET RETIRE]/g' \
    -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._~+/=-]{12,}/\1[SECRET RETIRE]/g' \
    -e 's/((token|password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*"?)[A-Za-z0-9_.-]{12,}/\1[SECRET RETIRE]/gI')

if [ "$DRY" -eq 1 ]; then
  printf '%s\n' "$corps_propre"
  exit 0
fi

# --- Canal -------------------------------------------------------------------
# Pas de configuration = pas de canal = rien à faire, et surtout pas une erreur.
[ -f "$CONF" ] || exit 0
# shellcheck source=/dev/null
. "$CONF"
NTFY_TOPIC="${NTFY_TOPIC:-}"
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"
[ -n "$NTFY_TOPIC" ] || exit 0

command -v curl >/dev/null 2>&1 || die "curl introuvable (PATH=$PATH)"

args=(-s -S --max-time 20 -o /dev/null -w '%{http_code}'
      -H "Title: $TITRE" -H "Priority: $PRIORITE" -H "Markdown: yes")
[ -n "$LIEN" ] && args+=(-H "Click: $LIEN")
[ -n "$QUAND" ] && args+=(-H "X-At: $QUAND")

code=$(printf '%s' "$corps_propre" | curl "${args[@]}" --data-binary @- "$NTFY_SERVER/$NTFY_TOPIC" 2>&1) || {
  printf 'notifier: envoi echoue (%s)\n' "$code" >&2; exit 1; }

case "$code" in
  2*) exit 0 ;;
  *)  printf 'notifier: ntfy a repondu %s\n' "$code" >&2; exit 1 ;;
esac
