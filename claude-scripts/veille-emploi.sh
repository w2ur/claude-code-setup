#!/usr/bin/env bash
# veille-emploi.sh — relève la veille d'offres et pousse un résumé. SANS MODÈLE.
#
# Lancé par `com.example.veille-emploi` (LaunchAgent, 8h37). Aucun jugement
# éditorial ici : le script enchaîne des outils déterministes du plugin
# `recherche-emploi` et rend un compte.
#
# ── Le digest brut, ajouté le 2026-08-22 ───────────────────────────────────
# Mesuré ce jour-là : 302 offres ingérées, 39 présentées, 260 encore à
# « Repérée » — dont dix-sept de niveau Direction jamais montrées, trois
# datant du 11 août. La relève était devenue quotidienne le matin même ; la
# présentation, elle, exigeait qu'une session s'ouvre. Le dispositif
# accélérait donc en amont d'un entonnoir dont l'étape suivante ne se
# déclenche pas toute seule : PLUS LA VEILLE EST BONNE, PLUS L'ARRIÉRÉ
# GROSSIT.
#
# `digest_brut.py` rend la liste, sans commentaire, et marque les offres
# « Présentée » — deuxième des trois écritures automatiques autorisées, sans
# laquelle les mêmes huit offres reviendraient chaque matin. Le point fort, la
# réserve et le conseil restent le travail de `digest-matin`, en session, avec
# {author-first-name} : ce script sépare *être informé* de *être conseillé*, et seul le
# second a besoin d'un modèle.
#
# ── LaunchAgent obligatoire, jamais crontab ────────────────────────────────
# Deux raisons cumulées, chacune suffisante :
#   1. `lire_alertes.py` lit le mot de passe IMAP au TROUSSEAU DE SESSION.
#      Hors session graphique, `security` rend une chaîne vide SANS erreur —
#      donc zéro message, donc un « rien de neuf » parfaitement silencieux.
#      C'est le piège déjà payé sur `gh` et sur `claude -p`.
#   2. Le dossier est sur iCloud Drive, un montage File Provider qui n'existe
#      que dans la session graphique.
#
# ── Ordre des étapes, et pourquoi il ne se permute pas ─────────────────────
# Le marquage `$VeilleTraitee` vient APRÈS l'écriture de l'état. Marquer
# d'abord, c'est perdre les alertes si l'écriture échoue. Et `ranger_etat`
# précède `tableau_de_bord`, qui lit `courant.json` que le premier écrit.
#
# ── Codes de sortie ────────────────────────────────────────────────────────
#   0 relevé fait · 1 anomalie de contenu ou relances dues
#   2 n'a pas pu tourner — à lire comme *inconnu*, jamais « rien de neuf »
set -uo pipefail

export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DOSSIER="${JOB_SEARCH_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Job Search}"
PLUGIN="${RE_PLUGIN:-$HOME/.claude/plugins/local/recherche-emploi}"
NOTIFIER="${NOTIFIER_BIN:-$HOME/.claude/scripts/notifier.sh}"
TRAVAIL="$(mktemp -d "${TMPDIR:-/tmp}/veille-emploi.XXXXXX")"
LIMITE="${VEILLE_LIMITE:-1500}"        # chien de garde : 25 min
trap 'rm -rf "$TRAVAIL"' EXIT

stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }
fatal() { printf '%s FATAL %s\n' "$(stamp)" "$1" >&2; exit 2; }
info()  { printf '%s %s\n' "$(stamp)" "$1"; }

# ── Gardes. Un manque est *inconnu*, jamais « rien à faire ».
command -v uv >/dev/null 2>&1 || fatal "uv introuvable dans le PATH ($PATH)"
[ -d "$DOSSIER" ] || fatal "dossier absent : $DOSSIER"
[ -s "$DOSSIER/etat/courant.json" ] || fatal \
  "etat/courant.json absent ou vide — iCloud a-t-il évincé le fichier ? Voir « find etat -type f -flags +dataless »."
[ -x "$PLUGIN/skills/veille-ingestion/scripts/lire_alertes.py" ] || fatal \
  "plugin recherche-emploi introuvable sous $PLUGIN"

V="$PLUGIN/skills/veille-ingestion/scripts"
R="$PLUGIN/references/scripts"
rc_global=0

# Le chien de garde : launchd n'a pas de délai maximal, un blocage resterait
# jusqu'au redémarrage. Un kill sort en 2, jamais en 1 : l'issue est ambiguë.
( sleep "$LIMITE"; kill -TERM $$ 2>/dev/null ) & CHIEN=$!
trap 'kill "$CHIEN" 2>/dev/null; rm -rf "$TRAVAIL"' EXIT

info "1/6 relevé IMAP"
# `rc=$?` DANS un `if ! cmd` rend le statut de la NÉGATION, pas celui de la
# commande — le test suivant était donc toujours faux et le script continuait
# sur un relevé vide. Mesuré le 2026-08-22 au premier démarrage sous launchd.
caffeinate -i "$V/lire_alertes.py" --depuis 2d > "$TRAVAIL/mail.json" 2>"$TRAVAIL/mail.err"
rc_mail=$?
cat "$TRAVAIL/mail.err" >&2
CANAL_MAIL=1
if [ "$rc_mail" -ge 2 ]; then
  # Le script sort en 2 quand une fenêtre entière ne rend rien : il ne sait pas
  # distinguer « période calme » de « filtre serveur cassé », et il a raison de
  # ne pas trancher. Mais ce n'est pas une raison d'abandonner le canal ATS ni
  # les relances, qui n'en dépendent pas. On coupe le canal e-mail, on le DIT,
  # et on sort en 2 à la fin : une partie du relevé est *inconnue*.
  CANAL_MAIL=0
  MAIL_MUET=$(head -1 "$TRAVAIL/mail.err")
  rc_global=2
  info "canal e-mail indisponible (code $rc_mail) — on poursuit sans lui"
elif [ "$rc_mail" -ne 0 ]; then
  rc_global=1
fi

info "2/6 extraction et grille"
if [ "$CANAL_MAIL" -eq 1 ]; then
  caffeinate -i "$V/extraire_offres.py" "$TRAVAIL/mail.json" "$TRAVAIL/offres.json" 2>"$TRAVAIL/extraction.err" \
    || fatal "extraction impossible"
  cat "$TRAVAIL/extraction.err" >> "$TRAVAIL/log"
else
  info "extraction sautée : pas de relevé e-mail"
fi
# Un board dont plus rien ne sort doit se voir sur le téléphone, pas dans un
# log. C'est la panne la plus discrète du dispositif : l'extraction continue de
# rendre des offres, simplement plus les siennes.
MUETS=""
[ -s "$TRAVAIL/extraction.err" ] && MUETS=$(sed -n 's/.*messages sans extraction : //p' "$TRAVAIL/extraction.err" | head -1)
[ "$CANAL_MAIL" -eq 1 ] && { caffeinate -i "$V/applique_grille.py" "$TRAVAIL/offres.json" \
  "$TRAVAIL/scorees.json" 2>>"$TRAVAIL/log" || fatal "grille impossible"; }

info "3/6 collecte ATS"
# Sortie 1 = anomalie de contenu, 2 = une source est tombée : les deux se
# rapportent, aucune n'annule le versement du canal e-mail.
caffeinate -i "$V/collecte_ats.py" --depuis 7 > "$TRAVAIL/ats.json" 2>>"$TRAVAIL/log"
rc_ats=$?
[ "$rc_ats" -ne 0 ] && rc_global=1
[ -s "$TRAVAIL/ats.json" ] || { info "collecte ATS sans sortie — canal e-mail seul"; : > "$TRAVAIL/ats.json"; }

info "4/6 versement à l'état"
ARGS=()
[ "$CANAL_MAIL" -eq 1 ] && ARGS+=(--mail "$TRAVAIL/scorees.json")
[ -s "$TRAVAIL/ats.json" ] && ARGS+=(--ats "$TRAVAIL/ats.json")
[ ${#ARGS[@]} -eq 0 ] && fatal "aucun canal n'a rendu quoi que ce soit — *inconnu*, pas « rien de neuf »"
caffeinate -i "$V/verse_etat.py" "$DOSSIER" "${ARGS[@]}" > "$TRAVAIL/versement.json" 2>>"$TRAVAIL/log" \
  || fatal "versement impossible — les alertes ne sont PAS marquées, rien n'est perdu"

info "5/6 rangement, digest brut, vue, marquage"
caffeinate -i "$R/ranger_etat.py" "$DOSSIER" --appliquer >>"$TRAVAIL/log" 2>&1 || rc_global=1
# Le digest lit `courant.json` : il passe donc APRÈS un premier rangement, et
# un second suit pour promouvoir l'instantané qu'il écrit. `ranger_etat` est
# idempotent, le répéter ne coûte rien et évite d'écrire le pointeur à la main.
if ! caffeinate -i "$R/digest_brut.py" "$DOSSIER" --appliquer \
       > "$TRAVAIL/digest.txt" 2>>"$TRAVAIL/log"; then
  rc_global=1
  info "digest brut en échec — la veille elle-même a réussi, l'état est intact"
  : > "$TRAVAIL/digest.txt"
fi
caffeinate -i "$R/ranger_etat.py" "$DOSSIER" --appliquer >>"$TRAVAIL/log" 2>&1 || rc_global=1
caffeinate -i "$R/valide_etat.py" "$DOSSIER/etat/courant.json" >>"$TRAVAIL/log" 2>&1 || rc_global=1
caffeinate -i "$R/tableau_de_bord.py" "$DOSSIER" >>"$TRAVAIL/log" 2>&1 || rc_global=1
[ "$CANAL_MAIL" -eq 1 ] && { caffeinate -i "$V/lire_alertes.py" --marquer "$TRAVAIL/mail.json" \
  >>"$TRAVAIL/log" 2>&1 || rc_global=1; }

info "6/6 relances"
# Toujours exécuté, même si tout ce qui précède a échoué : une relance en
# retard ne dépend pas de la réussite du relevé.
caffeinate -i "$R/relances_dues.py" "$DOSSIER" > "$TRAVAIL/relances.txt" 2>&1
rc_rel=$?

# ── Compte rendu
NEUVES=$(sed -n 's/.*"nouvelles": *\([0-9]*\).*/\1/p' "$TRAVAIL/versement.json" | head -1)
DUES=$(grep -c '^  20' "$TRAVAIL/relances.txt" 2>/dev/null || echo 0)
{
  printf 'Veille du %s\n\n' "$(date '+%d/%m/%Y')"
  printf '%s offre(s) nouvelle(s) à l état.\n' "${NEUVES:-?}"
  [ "$rc_ats" -ne 0 ] && printf 'Collecte ATS : code %s, à vérifier.\n' "$rc_ats"
  [ -n "${MUETS:-}" ] && [ "$MUETS" != "{}" ] && printf 'Boards muets : %s\n' "$MUETS"
  [ "$CANAL_MAIL" -eq 0 ] && printf 'CANAL E-MAIL MUET — %s\n' "${MAIL_MUET:-sans détail}"
  if [ -s "$TRAVAIL/digest.txt" ]; then
    printf '\nÀ regarder :\n'
    cat "$TRAVAIL/digest.txt"
    printf '\nDétail : rapports/digest_%s.md\n' "$(date '+%Y%m%d')"
    printf 'Le ⚠︎ signale une offre qui ressemble à une candidature déjà déposée.\n'
  fi
  printf '\n%s relance(s) due(s) :\n' "$DUES"
  head -12 "$TRAVAIL/relances.txt"
  printf '\nPour le point fort, la réserve et le conseil : /digest en session.\n'
} > "$TRAVAIL/corps.txt"
cat "$TRAVAIL/corps.txt"
cat "$TRAVAIL/log" 2>/dev/null

if [ -x "$NOTIFIER" ]; then
  PRIO="default"; [ "$rc_rel" -eq 1 ] && PRIO="high"
  "$NOTIFIER" "Veille emploi — ${NEUVES:-?} offres, ${DUES} relance(s)" \
    "$TRAVAIL/corps.txt" --priorite "$PRIO" \
    || printf '%s AVERTISSEMENT notification non délivrée\n' "$(stamp)" >&2
fi

# Une relance due ne dégrade pas un « inconnu » en « anomalie » : 2 gagne.
[ "$rc_rel" -eq 1 ] && [ "$rc_global" -lt 2 ] && rc_global=1
info "fin, code $rc_global"
exit "$rc_global"
