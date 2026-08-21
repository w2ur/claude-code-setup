#!/usr/bin/env bash
# diffusion-mirror.sh — miroir unidirectionnel du dossier de diffusion
# Google Drive (source de vérité) → iCloud Drive (sauvegarde).
#
# Google Drive reste authoritative : l'My Editor App (Vercel) et /api/dispatch lisent
# l'API Drive et ne peuvent pas lire iCloud. Ce miroir ne se relit jamais vers
# Drive — il n'existe aucun chemin de retour, et c'est délibéré.
#
# Codes de sortie, dans la convention du portefeuille :
#   0 — le miroir est à jour
#   1 — rclone a signalé une erreur pendant la copie
#   2 — n'a PAS PU tourner. À lire comme « inconnu », jamais comme « à jour ».
set -uo pipefail

SRC="${DIFFUSION_SRC:-$HOME/Library/CloudStorage/{email}/Mon Drive/diffusion}"
DST="${DIFFUSION_DST:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/diffusion}"
BACKUP_ROOT="${DIFFUSION_BACKUP:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/diffusion-effaces}"
FLOOR="${DIFFUSION_FLOOR:-500}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "FATAL $*"; exit 2; }

command -v rclone >/dev/null 2>&1 || die "rclone introuvable sur le PATH ($PATH)"

# --- Le garde-fou porte sur la SOURCE ---------------------------------------
# `rclone sync` propage les suppressions. Une source vide ou démontée n'est pas
# une source vide : c'est une source ABSENTE, et la propager efface la seule
# autre copie. Le mount Drive est fourni par un File Provider de la session
# graphique — hors session, ou Drive non démarré, ce dossier est vide ou absent.
[ -d "$SRC" ] || die "source absente : $SRC"
[ -f "$SRC/pipeline.json" ] || die "source sans pipeline.json — pas le dossier attendu : $SRC"

count=$(find "$SRC" -type f 2>/dev/null | wc -l | tr -d ' ')
[ "$count" -ge "$FLOOR" ] 2>/dev/null \
  || die "source à $count fichiers, plancher $FLOOR — refus de propager des suppressions"

log "source OK : $count fichiers"

# --- La copie ---------------------------------------------------------------
# Pas de --checksum, délibérément. iCloud tourne avec optimize-storage=1 : une
# comparaison par empreinte rematérialiserait les 159 Mo à chaque passage, ce qui
# annule exactement l'éviction qui rend ce miroir gratuit en disque. La
# comparaison par défaut (taille + date de modification) n'ouvre aucun fichier.
#
# --backup-dir plutôt qu'un sync sec : une suppression côté source déplace le
# fichier au lieu de l'effacer. Le répertoire est un FRÈRE de la destination,
# jamais un enfant — sinon rclone le synchroniserait à son tour.
mkdir -p "$DST" || die "destination non créable : $DST"

rclone sync "$SRC" "$DST" \
  --backup-dir "$BACKUP_ROOT/$(date +%Y-%m-%d)" \
  --exclude ".DS_Store" \
  --exclude ".*.icloud" \
  --create-empty-src-dirs \
  --stats-one-line \
  --stats 0 \
  --verbose 2>&1 | sed 's/^/    /'
rc=${PIPESTATUS[0]}

if [ "$rc" -ne 0 ]; then
  log "ERREUR rclone (code $rc) — le miroir peut être partiel"
  exit 1
fi

mirrored=$(find "$DST" -type f 2>/dev/null | wc -l | tr -d ' ')
log "miroir à jour : $mirrored fichiers côté iCloud (source : $count)"
