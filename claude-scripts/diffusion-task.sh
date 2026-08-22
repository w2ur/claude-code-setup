#!/usr/bin/env bash
# diffusion-task.sh — lance une commande périodique du pipeline de diffusion.
#
# UN script pour les quatre lignes, pas un par ligne : elles ne diffèrent que
# par le nom de la commande. Toute la logique éditoriale vit dans le prompt du
# plugin content-pipeline ; ici il n'y a que du plombage et des garde-fous.
#
# LaunchAgent et jamais crontab. Deux raisons de la même famille, toutes deux
# documentées dans ~/.claude/CLAUDE.md :
#   1. `claude` lit ses identifiants OAuth dans le trousseau de session. Hors
#      session graphique il rapporte « Not logged in » et ne se rabat PAS sur
#      ~/.claude/.credentials.json.
#   2. Le dossier de travail est un mount Google Drive fourni par un File
#      Provider de la session graphique. Hors session, il est vide ou absent —
#      et un dossier vide est exactement ce que le garde-fou ci-dessous refuse.
#
# Codes de sortie :
#   0 — la commande a tourné et rendu 0
#   1 — la commande a tourné et rendu autre chose (une CONSTATATION)
#   2 — n'a PAS PU tourner, ou a été interrompue. À lire comme « inconnu »,
#       jamais comme « rien à faire ». Un dépassement du chien de garde tombe
#       ici parce que l'issue est ambiguë : le post peut être parti ou non.
set -uo pipefail

TACHE="${1:-}"
SRC="${DIFFUSION_SRC:-$HOME/Library/CloudStorage/{email}/Mon Drive/diffusion}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
LIMITE="${DIFFUSION_TASK_TIMEOUT:-2400}"   # 40 min

stamp() { date "+%Y-%m-%d %H:%M:%S"; }
die()   { printf '%s FATAL %s\n' "$(stamp)" "$1" >&2; exit 2; }

case "$TACHE" in
  quotidienne|my-trading-app|devlog|releve|show) ;;
  *) die "tâche inconnue : « ${TACHE:-<vide>} » (attendu : quotidienne|my-trading-app|devlog|releve|show)" ;;
esac

# `claude` : le lien ~/.local/bin/claude et non le chemin versionné, qui bouge
# à chaque mise à jour automatique.
if [ ! -x "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
[ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || die "claude introuvable (PATH=$PATH)"

# Source absente ou méconnaissable = INCONNU, jamais « rien à faire ». Même
# garde-fou que diffusion-mirror.sh, et pour la même raison.
[ -d "$SRC" ] || die "dossier de diffusion absent : $SRC"
[ -f "$SRC/pipeline.json" ] || die "dossier sans pipeline.json — pas le dossier attendu : $SRC"

cd "$SRC" || die "cd impossible : $SRC"

# VERROU — une seule ligne à la fois.
#
# Les quatre lignes écrivent toutes dans `pipeline.json`, et le `CLAUDE.md` du
# dossier compte déjà trois écrivains concurrents pour justifier sa règle de
# lecture-fusion-écriture. Deux sessions du modèle en parallèle en feraient un
# quatrième et un cinquième, chacune composant du JSON à la main — précisément
# l'écrivain que ce CLAUDE.md désigne comme le seul à risque.
#
# Les horaires les séparent déjà par construction (quotidienne 05:07 + 40 min de
# chien de garde au pire, contre 05:57 pour le week-end), mais un déclenchement
# manuel ne connaît pas ces horaires. `mkdir` est atomique, c'est ce qui en fait
# un verrou et non une course.
#
# Un verrou périmé (plus de deux heures, soit trois fois le pire cas) est repris
# plutôt que respecté : un run tué par un redémarrage laisserait sinon le
# pipeline bloqué jusqu'à ce que quelqu'un s'en aperçoive.
VERROU="${DIFFUSION_LOCK:-${TMPDIR:-/tmp}/diffusion-task.lock}"
if ! mkdir "$VERROU" 2>/dev/null; then
  if [ -d "$VERROU" ] && [ -z "$(find "$VERROU" -maxdepth 0 -mmin -120 2>/dev/null)" ]; then
    printf '%s AVERTISSEMENT verrou périmé repris : %s\n' "$(stamp)" "$VERROU" >&2
    rm -rf "$VERROU" && mkdir "$VERROU" 2>/dev/null || die "verrou impossible à reprendre : $VERROU"
  else
    die "une autre ligne de diffusion tourne déjà ($VERROU) — rien n'est lancé"
  fi
fi
trap 'rm -rf "$VERROU"' EXIT


# ---------------------------------------------------------------------------
# VEILLE — pourquoi ce bloc existe, et pourquoi `caffeinate -i` seul ne suffit
# pas.
#
# Le 2026-08-22, la quotidienne lancée à 05:15:35 est morte à 06:08 sur
# « Your computer went to sleep mid-response », et la ligne My Trading App de 05:57 s'est
# vu refuser le verrou que ce cadavre tenait encore. La cause n'était ni le
# verrou ni le modèle : la machine dormait sur batterie, et launchd a lancé le
# métier à l'intérieur d'une fenêtre DarkWake. Le journal d'énergie la chiffre
# lui-même :
#
#   05:15:35  SleepService: window begins with cap time=180 secs
#   05:16:06  SleepService: window has terminated
#   05:16:06  Entering Sleep state ... [System: No Assertions]
#
# Une fenêtre DarkWake est donc PLAFONNÉE À 180 SECONDES par le service qui
# l'ouvre — celle-ci s'est refermée en 31. Une session `claude -p` demande vingt
# à quarante minutes. Le rapport est de un à quatre cents.
#
# ET `caffeinate -i` NE L'EMPÊCHE PAS. C'est le piège de ce correctif, parce que
# `-i` est la réponse réflexe et qu'elle a l'air raisonnable : `claude` prend
# d'ailleurs déjà cette assertion tout seul (`caffeinate -i -t 300`, vérifié en
# listant les processus). Mais `PreventUserIdleSystemSleep` ne couvre que le
# sommeil D'INACTIVITÉ ; la fermeture d'une fenêtre SleepService est un autre
# chemin. La même trace le montre : une assertion tenue depuis 15 minutes est
# relâchée d'office au moment du sommeil, sur un « [System: No Assertions] ».
#
# D'où les deux gestes ci-dessous, dans cet ordre :
#
#   1. SUR BATTERIE, on PROMEUT la fenêtre en réveil complet avec `caffeinate
#      -u`, qui déclare l'utilisateur actif et rallume l'écran. Une fois en
#      réveil complet, il n'y a plus de plafond de service : ce sont les délais
#      d'inactivité ordinaires qui s'appliquent — et ceux-là, `-i` les tient.
#      Le prix est réel et assumé : l'écran s'allume à l'heure du métier.
#   2. ON TIENT ensuite l'assertion pour toute la durée du run, avec `-w` qui la
#      relâche exactement quand le processus sort. `-s` est ajouté sans condition
#      parce qu'il est gratuit : sur secteur il empêche le sommeil tout court,
#      sur batterie `caffeinate` l'ignore (man caffeinate : « valid only when
#      system is running on AC power »).
#
# On ne peut PAS vérifier ce bloc à chaud : il ne se déclenche que sur une
# machine réellement endormie. C'est pourquoi il JOURNALISE la source
# d'alimentation et l'assertion obtenue — le journal de demain matin est la
# preuve, pas ce commentaire.
SECTEUR="inconnue"
case "$(pmset -g batt 2>/dev/null | head -1)" in
  *"'AC Power'"*)      SECTEUR="secteur" ;;
  *"'Battery Power'"*) SECTEUR="batterie" ;;
esac

if [ "$SECTEUR" = "batterie" ]; then
  # -t 2 et pas davantage : `-u` sert à PROMOUVOIR le réveil, pas à le tenir.
  # C'est l'assertion suivante qui tient.
  caffeinate -u -t 2 2>/dev/null || printf '%s AVERTISSEMENT promotion du réveil impossible\n' "$(stamp)" >&2
fi
printf '%s ==== %s : démarrage (limite %ss) ====\n' "$(stamp)" "$TACHE" "$LIMITE"

# --permission-mode acceptEdits : les écritures de fichiers passent seules, les
# commandes Bash restent soumises à la liste d'autorisations de
# diffusion/.claude/settings.json. Un besoin imprévu est donc refusé, pas
# exécuté — on échoue du côté fermé.
# La sortie part dans un fichier ET dans le journal. Le fichier alimente la
# notification ; le journal garde tout, y compris ce que le plafond de taille
# écarte.
#
# CE QUI PART EN NOTIFICATION, ET POURQUOI. En mode `-p`, stdout est le SEUL
# message final du modèle — pas la transcription des appels d'outils. Vérifié le
# 2026-08-21 sur une sonde `/content-pipeline:show` : le journal ne contenait que
# le tableau formaté, aucun bruit d'outil. L'« extraction » demandée par la revue
# du plan est donc structurelle, elle n'a pas à être parsée. Le risque résiduel
# est qu'un message final CITE une erreur portant un jeton — c'est précisément ce
# que la redaction de notifier.sh attrape, et elle a été mise en échec une fois
# avec les vrais secrets avant d'être crue.
SORTIE=$(mktemp -t "diffusion-$TACHE") || die "mktemp a échoué"
trap 'rm -rf "$VERROU"; rm -f "$SORTIE"' EXIT

"$CLAUDE_BIN" -p "/content-pipeline:$TACHE" \
  --permission-mode acceptEdits \
  --output-format text > "$SORTIE" 2>&1 &
pid=$!

# On tient l'assertion pour toute la durée du run. `-w` la relâche exactement
# quand le processus sort — pas de fuite si le chien de garde tue avant la fin.
caffeinate -i -m -s -w "$pid" 2>/dev/null &
cafeine=$!
# Attente bornée plutôt qu'un délai fixe : l'enregistrement de l'assertion
# n'est pas instantané quand la machine lance en même temps un processus aussi
# lourd que `claude`. Un `sleep 1` a rapporté un faux négatif à la sonde du
# 2026-08-22 — et un contrôle qui crie au loup est un contrôle qu'on apprend à
# ignorer.
essais=0
# `grep > /dev/null` et JAMAIS `grep -q` : sous `set -o pipefail`, `grep -q`
# sort dès la première correspondance, `pmset` reçoit un SIGPIPE, et le code de
# la conduite devient 141. Le contrôle rapportait donc « non trouvé » exactement
# quand il trouvait. Mesuré le 2026-08-22 : 141 avec `-q`, 0 avec la redirection,
# 1 sur un pid inexistant — les deux réponses, sinon la vérification ne prouve rien.
until pmset -g assertions 2>/dev/null | grep "Process ID $pid" > /dev/null || [ "$essais" -ge 25 ]; do essais=$((essais+1)); sleep 0.2; done
if [ "$essais" -lt 25 ]; then
  printf '%s veille : alimentation %s, assertion tenue pour le pid %s\n' "$(stamp)" "$SECTEUR" "$pid"
else
  printf '%s AVERTISSEMENT veille : assertion NON obtenue (alimentation %s) — le run peut être coupé par un retour en sommeil\n' "$(stamp)" "$SECTEUR" >&2
fi

# Chien de garde : launchd n'a pas de délai maximum, et un run bloqué le
# resterait jusqu'au prochain redémarrage.
( sleep "$LIMITE"; kill -TERM "$pid" 2>/dev/null ) >/dev/null 2>&1 &
chien=$!

wait "$pid"; rc=$?
kill "$chien" 2>/dev/null; wait "$chien" 2>/dev/null
# `-w` relâche déjà l'assertion quand le pid sort ; ce kill couvre le cas où
# caffeinate survivrait à un chemin de sortie imprévu.
kill "$cafeine" 2>/dev/null; wait "$cafeine" 2>/dev/null

cat "$SORTIE"

# ntfy plafonne un message à 4096 octets. Un post LinkedIn plus son commentaire
# tiennent largement dessous ; on tronque quand même, en le DISANT, plutôt que de
# laisser ntfy couper en silence — une notification tronquée sans marque se lit
# comme un post qui s'arrête au milieu d'une phrase.
NOTIF=$(mktemp -t "diffusion-notif-$TACHE") || die "mktemp a échoué"
trap 'rm -rf "$VERROU"; rm -f "$SORTIE" "$NOTIF"' EXIT
head -c 3600 "$SORTIE" > "$NOTIF"
if [ "$(wc -c < "$SORTIE")" -gt 3600 ]; then
  printf '\n\n[…] Message tronqué. Suite dans ~/.claude/diffusion-%s.log\n' "$TACHE" >> "$NOTIF"
fi

notifier() {
  local titre="$1" prio="$2"
  [ -x "$HOME/.claude/scripts/notifier.sh" ] || return 0
  "$HOME/.claude/scripts/notifier.sh" "$titre" "$NOTIF" \
    --priorite "$prio" --lien "https://my-editor-app.example.com" \
    || printf '%s AVERTISSEMENT notification non délivrée\n' "$(stamp)" >&2
}

if [ "$rc" -ge 128 ]; then
  printf '%s FATAL %s : interrompu par le chien de garde après %ss. Issue AMBIGUË — vérifier la file Buffer et pipeline.json avant de relancer.\n' "$(stamp)" "$TACHE" "$LIMITE" >&2
  printf '\n\n⚠ Run interrompu par le chien de garde après %ss. Issue AMBIGUË : le post peut être parti ou non. Vérifier la file Buffer.\n' "$LIMITE" >> "$NOTIF"
  notifier "$TACHE — INTERROMPU, issue incertaine" "urgent"
  exit 2
fi
if [ "$rc" -ne 0 ]; then
  printf '%s ERREUR %s : claude a rendu %s\n' "$(stamp)" "$TACHE" "$rc" >&2
  notifier "$TACHE — ERREUR (code $rc)" "high"
  exit 1
fi

printf '%s ==== %s : terminé ====\n' "$(stamp)" "$TACHE"

# Le commentaire se colle À LA MAIN.
#
# NE PAS essayer de le faire programmer par Buffer. Le schéma expose bien
# `LinkedInPostMetadataInput.firstComment` — vérifié par introspection le
# 2026-08-21 — mais ce compte n'a PAS l'option, qui est payante, et l'envoyer
# casse la publication : `createPost` échoue, le dispatch fait `continue`, et le
# post ne part pas du tout. Le champ dans le schéma dit ce que l'API accepte en
# FORME, pas ce que le forfait AUTORISE. La tentative a été faite puis annulée le
# soir même ; si une prochaine session « découvre » ce champ, c'est ce paragraphe
# qu'elle doit lire avant de le brancher.
cat >> "$NOTIF" <<'RAPPEL'

——
Le commentaire est à coller à la main sous le post. Il te sera renvoyé seul,
à l'heure de la publication.
RAPPEL

# Priorité NORMALE, décision de {author-first-name} : ce message sonne à six heures du matin
# un samedi, et la fenêtre de veto court jusqu'à 10:00. Visible au réveil suffit ;
# réveiller serait payer le prix d'une urgence qui n'en est pas une.
notifier "$TACHE — à lire avant 10:00" "default"

# ---------------------------------------------------------------------------
# Le rappel « commentaire à coller », armé à l'heure exacte de publication, est
# délégué à publication-arm.sh — qui est de toute façon appelé chaque jour pour
# les six à dix autres posts.
#
# UN SEUL MÉCANISME QUI ARME, ET C'EST LE POINT. Une première version armait ici,
# directement, et le passage quotidien aurait trouvé la même entrée : deux
# notifications identiques pour le même post. Le fichier d'état partagé est ce
# qui l'empêche, et il n'a de sens que s'il n'existe qu'un seul écrivain.
#
# L'appeler ici plutôt que d'attendre le passage du lendemain sert à une chose :
# le My Trading App du samedi publie à 10:00 le jour même, il ne doit pas dépendre d'un
# agent qui passera après. Un échec n'est pas fatal au run — le post est parti,
# c'est l'essentiel — mais il est dit.
if [ -x "$HOME/.claude/scripts/publication-arm.sh" ]; then
  "$HOME/.claude/scripts/publication-arm.sh" \
    || printf '%s AVERTISSEMENT armement des rappels incomplet — voir ci-dessus\n' "$(stamp)" >&2
fi

exit 0
