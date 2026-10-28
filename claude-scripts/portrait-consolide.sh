#!/usr/bin/env bash
# portrait-consolide.sh — weekly PROPOSAL of updates to the owner portrait
# (~/.claude/portrait.md), drawn from the auto-memories written that week.
#
# It proposes and never writes the portrait. The portrait is imported into every
# session, so a wrong fact in it misleads every session at once; an unattended
# model must not be the one to put it there. The owner reads the proposal in the
# /portrait pane and applies or dismisses it there (`/portrait applique`,
# `/portrait ecarte`), where portrait-check.sh guards the size after each write.
# This script only ever writes $ETAT/proposition-<date>.md.
#
# Run by the LaunchAgent com.example.portrait, never by cron: `claude -p` reads
# its OAuth credentials from the login keychain, which exists only in the GUI
# session.
#
# Constants, owned here and restated nowhere:
#   FENETRE_JOURS — one week, the cadence of the agent: each run reads what the
#     previous run has not seen.
#   MODELE — pinned, same pin as my-editor-app/tools/graphe/extraire.py: an
#     unattended judgment must not move with the alias.
#   MAX_PROPOSITIONS — what the owner can judge in one sitting; passed to the
#     prompt as {{MAX}}. A longer answer is still written whole, never truncated
#     in silence.
#   DELAI_S — launchd has no timeout of its own; one call over ten minutes is a
#     hung call, not a slow one.
#
# Exit codes follow the portfolio convention: 0 nothing to propose (no recent
# memory, or the model proposed nothing), 1 a proposal written, 2 could not run
# (missing or unreadable memories root or portrait, `claude` absent, timeout,
# invalid JSON). Only 1 and 2 notify; the notifier topic is PUBLIC, so the body
# is counts and a fixed cause, never a proposed text or a path. Every run ends
# with one timestamped summary line, so the log's age is a liveness signal.
#
# The prompt goes to `claude -p` on stdin: `claude --help` (2026-10-27) has no
# file-input flag, and a prompt in argv would be visible in `ps`. The prompt is
# built from memory text, so the call is closed: `--tools ""` removes the
# built-in tools, `--strict-mcp-config` with no `--mcp-config` loads no MCP
# server (`--tools` alone leaves connectors reachable), and
# `--no-session-persistence` leaves no resumable session behind. All three
# checked in `claude --help` on 2026-10-27.
#
# The prompt carries the portrait size and the margin under the threshold, read
# from portrait-check.sh (the single owner of that number), so the model can keep
# each addition net-neutral.
#
# Test overrides: PORTRAIT_MEMOIRES, PORTRAIT, PORTRAIT_ETAT, PORTRAIT_CLAUDE,
# PORTRAIT_NOTIFIER, PORTRAIT_CHECK.
set -euo pipefail
# wc -m counts bytes when no locale is set (the launchd case); pin one.
export LC_ALL=C.UTF-8

FENETRE_JOURS=7
MODELE=claude-opus-5-5
DELAI_S=600
MAX_PROPOSITIONS=8

export PATH="/Users/{username}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"

MEMOIRES="${PORTRAIT_MEMOIRES:-/Users/{username}/.claude/projects}"
PORTRAIT_FICHIER="${PORTRAIT:-$HOME/.claude/portrait.md}"
ETAT="${PORTRAIT_ETAT:-/Users/{username}/.claude/state/portrait}"
CLAUDE="${PORTRAIT_CLAUDE:-claude}"
NOTIFIER="${PORTRAIT_NOTIFIER:-/Users/{username}/.claude/scripts/notifier.sh}"
CHECK="${PORTRAIT_CHECK:-/Users/{username}/.claude/scripts/portrait-check.sh}"
MODELE_PROMPT="/Users/{username}/.claude/scripts/prompts/portrait-consolide.md"

n_memoires=0
n_propositions=0

# fd 3 is the real stdout: fin may run inside a loop whose stdout is a file.
exec 3>&1

TMP="$(mktemp -d)" || {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) portrait-consolide exit 2 (0 mémoires, 0 propositions : mktemp impossible)"
  exit 2
}
trap 'rm -rf "$TMP"' EXIT

# notify <title> <body text>: the notifier reads its body from a file.
notify() {
  printf '%s\n' "$2" > "$TMP/corps" 2>/dev/null || true
  "$NOTIFIER" "$1" "$TMP/corps" || echo "notifier failed: $?" >&2
}

# fin <rc> [cause]: the one summary line, a notification on 2, then exit.
fin() {
  local rc="$1" cause="${2:-}" suffixe=""
  [ -z "$cause" ] || suffixe=" : $cause"
  if [ "$rc" -eq 2 ]; then
    echo "portrait-consolide: $cause" >&2
    notify "portrait: exit 2" "$cause ($n_memoires mémoires, $n_propositions propositions)"
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) portrait-consolide exit $rc ($n_memoires mémoires, $n_propositions propositions$suffixe)" >&3
  exit "$rc"
}

# Any command that fails outside an explicit `|| fin` is unknown, never healthy.
trap 'fin 2 "erreur inattendue"' ERR

[ -d "$MEMOIRES" ] && [ -r "$MEMOIRES" ] || fin 2 "racine des mémoires illisible"
[ -f "$PORTRAIT_FICHIER" ] && [ -r "$PORTRAIT_FICHIER" ] && [ -s "$PORTRAIT_FICHIER" ] || fin 2 "portrait illisible"
[ -r "$MODELE_PROMPT" ] || fin 2 "prompt introuvable"

# Recent memories, MEMORY.md indexes excluded. A find error is unknown, not empty.
find "$MEMOIRES" -path '*/memory/*.md' ! -name MEMORY.md -mtime "-$FENETRE_JOURS" -print0 \
  > "$TMP/liste" 2>/dev/null || fin 2 "parcours des mémoires impossible"

: > "$TMP/memoires"
while IFS= read -r -d '' chemin; do
  {
    printf '### %s\n\n' "$chemin"
    cat "$chemin"
    printf '\n'
  } >> "$TMP/memoires" 2>/dev/null || fin 2 "mémoire illisible"
  n_memoires=$((n_memoires + 1))
done < "$TMP/liste"

[ "$n_memoires" -gt 0 ] || fin 0 "rien de neuf"

command -v "$CLAUDE" > /dev/null 2>&1 || fin 2 "claude absent"

# Size and margin, counted the way portrait-check.sh counts, against the
# threshold read from that script rather than restated here.
seuil="$(sed -n 's/^THRESHOLD=\([0-9][0-9]*\)$/\1/p' "$CHECK" 2>/dev/null)" || fin 2 "seuil illisible"
[ -n "$seuil" ] || fin 2 "seuil illisible"
taille="$(wc -m < "$PORTRAIT_FICHIER" | tr -d ' ')" || fin 2 "portrait illisible"
# portrait-check.sh refuses at >= the threshold, so the last allowed size is seuil - 1.
marge=$((seuil - taille - 1))

# {{PORTRAIT}} and {{MEMOIRES}} sit on lines of their own and are copied
# verbatim, where a ${var//…} substitution would interpret `&` in their text.
# Only the numbers are substituted inline, and only in the template's own lines.
while IFS= read -r ligne || [ -n "$ligne" ]; do
  case "$ligne" in
    '{{PORTRAIT}}') cat "$PORTRAIT_FICHIER" || fin 2 "portrait illisible" ;;
    '{{MEMOIRES}}') cat "$TMP/memoires" || fin 2 "mémoire illisible" ;;
    *)
      ligne="${ligne//\{\{TAILLE\}\}/$taille}"
      ligne="${ligne//\{\{MARGE\}\}/$marge}"
      ligne="${ligne//\{\{MAX\}\}/$MAX_PROPOSITIONS}"
      printf '%s\n' "$ligne"
      ;;
  esac
done < "$MODELE_PROMPT" > "$TMP/prompt" || fin 2 "prompt non construit"

# perl's alarm survives exec: the model call is killed by SIGALRM (rc 142).
rc=0
/usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' "$DELAI_S" \
  "$CLAUDE" -p --model "$MODELE" --output-format json \
  --strict-mcp-config --no-session-persistence --tools "" \
  < "$TMP/prompt" > "$TMP/sortie" 2> "$TMP/erreurs" || rc=$?
[ "$rc" -ne 142 ] || fin 2 "délai dépassé"
[ "$rc" -eq 0 ] || fin 2 "claude a échoué (rc $rc)"

/usr/bin/jq -e 'type == "object" and (.is_error != true) and (.result | type == "string")' \
  "$TMP/sortie" > /dev/null 2>&1 || fin 2 "réponse de claude invalide"
# A fenced answer is tolerated: the fence lines are dropped before parsing.
{ /usr/bin/jq -r '.result' "$TMP/sortie" | sed '/^[[:space:]]*```/d' > "$TMP/brut"; } \
  || fin 2 "réponse de claude invalide"

# Slurped, so that several JSON values in one answer are seen as several:
# `jq -e` on its own judges only the last value, and a first empty list would
# hide a second non-empty one. Exactly one object is accepted.
/usr/bin/jq -e -s '
  length == 1
  and (.[0] | type == "object")
  and (.[0].propositions | type == "array")
  and all(.[0].propositions[];
    type == "object"
    and (.op | IN("+", "~", "-"))
    and (.texte | type == "string" and length > 0)
    and (.source | type == "string" and length > 0)
    and (if .op == "~" then (.texte | test("^ancien: .+ \\| nouveau: .+")) else true end))
' "$TMP/brut" > /dev/null 2>&1 || fin 2 "JSON invalide"
/usr/bin/jq -s '.[0]' "$TMP/brut" > "$TMP/resultat" || fin 2 "JSON invalide"

n_propositions="$(/usr/bin/jq '.propositions | length' "$TMP/resultat")" || fin 2 "JSON invalide"
case "$n_propositions" in ''|*[!0-9]*) fin 2 "JSON invalide" ;; esac
[ "$n_propositions" -gt 0 ] || fin 0

mkdir -p "$ETAT" || fin 2 "dossier d'état impossible"
cible="$ETAT/proposition-$(date +%Y-%m-%d).md"
/usr/bin/jq -r '
  .propositions | to_entries[]
  | "\(.key + 1). [\(.value.op)] \(.value.texte | gsub("[\r\n]+"; " ")) — \(.value.source | gsub("[\r\n]+"; " "))"
' "$TMP/resultat" > "$TMP/proposition" || fin 2 "écriture de la proposition impossible"
mv "$TMP/proposition" "$cible" || fin 2 "écriture de la proposition impossible"

# Counts only: the topic is public.
notify "portrait: 1 proposition" "$n_propositions propositions, $n_memoires mémoires lues"
fin 1
