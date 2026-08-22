#!/usr/bin/env bash
# publication-arm.sh — arme une notification portant le commentaire à coller,
# à l'heure exacte de publication de chaque post programmé.
#
# POURQUOI CE N'EST PAS UN AGENT QUI SCRUTE. ntfy tient le calendrier lui-même
# (en-tête X-At) : on arme, il délivre. Si la machine dort ou redémarre à l'heure
# dite, la notification part quand même — ce qu'un agent local interrogeant
# `pipeline.json` toutes les quinze minutes ne peut pas garantir, et il aurait
# tourné 96 fois par jour pour rater justement la nuit.
#
# LA FENÊTRE EST DE 72 HEURES, ET ELLE A ÉTÉ MESURÉE, pas lue : le 2026-08-21,
# `X-At` à +3 jours est accepté, à +4 jours refusé (« invalid delay parameter:
# too large »). Les posts sont programmés jusqu'à deux semaines à l'avance, d'où
# un passage QUOTIDIEN qui arme ce qui entre dans la fenêtre. Marge de sécurité
# à 71 h pour ne pas courir après la limite.
#
# L'ÉTAT VIT ICI, JAMAIS DANS pipeline.json. Le `CLAUDE.md` du dossier compte
# trois écrivains sur ce fichier et c'est ce dénombrement qui justifie sa règle
# de lecture-fusion-écriture. Ce script n'en sera pas un quatrième : il LIT
# `pipeline.json` et n'écrit que dans son propre fichier d'état.
#
# La clé d'état inclut `scheduled_at` : un post reprogrammé change de clé et se
# réarme donc tout seul, au lieu d'être considéré comme déjà traité.
#
# Codes de sortie :
#   0 — passage terminé (y compris « rien à armer », qui est le cas normal)
#   1 — au moins un armement a échoué. Une CONSTATATION.
#   2 — n'a PAS PU tourner. À lire comme « inconnu », jamais comme « rien à faire ».
set -uo pipefail

SRC="${DIFFUSION_SRC:-$HOME/Library/CloudStorage/{email}/Mon Drive/diffusion}"
ETAT="${PUBLICATION_ARM_STATE:-$HOME/.claude/publication-arm.state}"
NOTIFIER="${NOTIFIER_BIN:-$HOME/.claude/scripts/notifier.sh}"
FENETRE="${PUBLICATION_ARM_WINDOW:-255600}"   # 71 h

stamp() { date "+%Y-%m-%d %H:%M:%S"; }
die()   { printf '%s FATAL %s\n' "$(stamp)" "$1" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || die "jq introuvable (PATH=$PATH)"
[ -x "$NOTIFIER" ] || die "notifier introuvable : $NOTIFIER"
# Source absente ou méconnaissable = INCONNU, jamais « rien à armer ». Même
# garde-fou que diffusion-mirror.sh et diffusion-task.sh, et pour la même raison :
# un Drive démonté rendrait une liste vide, indistinguable d'une semaine calme.
[ -d "$SRC" ] || die "dossier de diffusion absent : $SRC"
[ -f "$SRC/pipeline.json" ] || die "dossier sans pipeline.json — pas le dossier attendu : $SRC"

touch "$ETAT" 2>/dev/null || die "fichier d'état non inscriptible : $ETAT"

maintenant=$(date +%s)
limite=$(( maintenant + FENETRE ))

# Frontière texte brut. MIROIR PARTIEL et assumé de `toPlainText`
# (my-editor-app/src/lib/comments/clean-comment.ts) : LinkedIn et Instagram ne
# rendent pas le Markdown, et le sérialiseur de l'éditeur échappe tout ce qui
# pourrait relancer une syntaxe. Sans cette passe, un `utm\_source` se collerait
# tel quel et casserait le suivi, et les `<…>` des autoliens — présents dans TOUS
# les commentaires réels du dossier — s'afficheraient en clair.
#
# DUPLICATION ASSUMÉE, et c'est une dette : si `toPlainText` change, cette
# fonction ne le saura pas. Elle est acceptée parce que l'alternative — faire
# tourner du TypeScript compilé depuis un LaunchAgent — coûte plus cher que le
# risque, et parce qu'une divergence se verrait à l'œil dans la notification.
texte_brut() {
  sed -E \
    -e 's|<(https?://[^>]+)>|\1|g' \
    -e 's|\[([^]]*)\]\((https?://[^) ]+)\)|\1 (\2)|g' \
    -e 's|\\([][!"#$%&'"'"'()*+,./:;<=>?@^_`{|}~-])|\1|g'
}

# Chemin du commentaire, selon le type de contenu. Reproduit resolveCommentContent
# + ROOT_BY_TYPE : un type court (synthesis/native/recycle/my-trading-app/devlog) vit dans
# posts/{slug}/comment.md ; un reel dans reels/{slug}/instagram-comment.md ; un
# article dans articles/{slug}/{plateforme}-comment.md.
chemin_commentaire() {
  case "$2" in
    reel)            printf '%s/reels/%s/instagram-comment.md' "$SRC" "$1" ;;
    article|null|"") printf '%s/articles/%s/%s-comment.md' "$SRC" "$1" "$3" ;;
    *)               printf '%s/posts/%s/comment.md' "$SRC" "$1" ;;
  esac
}

armes=0; ignores=0; echecs=0

while IFS=$'\t' read -r slug plateforme type due titre; do
  [ -n "$slug" ] || continue

  iso=$(printf '%s' "$due" | sed -E 's/\.[0-9]+Z$/Z/')
  epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null || true)
  if [ -z "$epoch" ]; then
    printf '%s IGNORE %s/%s : scheduled_at illisible (%s)\n' "$(stamp)" "$slug" "$plateforme" "$due" >&2
    ignores=$((ignores+1)); continue
  fi

  # Hors fenêtre : soit déjà passé, soit trop loin — il sera armé un prochain jour.
  [ "$epoch" -gt "$maintenant" ] || { ignores=$((ignores+1)); continue; }
  [ "$epoch" -le "$limite" ]     || { ignores=$((ignores+1)); continue; }

  cle="$slug|$plateforme|$iso"
  if grep -qxF "$cle" "$ETAT" 2>/dev/null; then
    ignores=$((ignores+1)); continue
  fi

  fichier=$(chemin_commentaire "$slug" "$type" "$plateforme")
  if [ ! -f "$fichier" ]; then
    printf '%s IGNORE %s/%s : pas de commentaire (%s)\n' "$(stamp)" "$slug" "$plateforme" "${fichier#$SRC/}" >&2
    ignores=$((ignores+1)); continue
  fi

  corps=$(mktemp -t publication-arm) || die "mktemp a échoué"
  texte_brut < "$fichier" > "$corps"
  if [ ! -s "$corps" ]; then
    printf '%s IGNORE %s/%s : commentaire vide\n' "$(stamp)" "$slug" "$plateforme" >&2
    rm -f "$corps"; ignores=$((ignores+1)); continue
  fi

  if "$NOTIFIER" "Commentaire à coller — ${titre:-$slug}" "$corps" \
       --priorite high --a "$epoch"; then
    printf '%s\n' "$cle" >> "$ETAT"
    printf '%s ARME %s/%s pour %s\n' "$(stamp)" "$slug" "$plateforme" "$iso"
    armes=$((armes+1))
  else
    printf '%s ECHEC %s/%s : notifier a refusé\n' "$(stamp)" "$slug" "$plateforme" >&2
    echecs=$((echecs+1))
  fi
  rm -f "$corps"
done < <(jq -r '
  .articles[]
  | . as $a
  | (.platforms // {}) | to_entries[]
  | select(.value.status == "scheduled" and (.value.scheduled_at // "") != "")
  | [$a.slug, .key, ($a.type // "article"), .value.scheduled_at, ($a.title // $a.slug)]
  | @tsv' "$SRC/pipeline.json" 2>/dev/null)

printf '%s passage terminé : %s armé(s), %s ignoré(s), %s échec(s)\n' "$(stamp)" "$armes" "$ignores" "$echecs"
[ "$echecs" -eq 0 ] || exit 1
exit 0
