#!/usr/bin/env bash
# Check deploy status for every production app in the portfolio.
# Reads ~/Dev/*/.portfolio.yml for status=production + url fields.

set -u

DEV="${DEV_DIR:-$HOME/Dev}"
cd "$DEV" || { echo "Dev dir not found: $DEV" >&2; exit 1; }

# Extract a top-level YAML scalar field — handles "url: https://..." correctly
yml_field() {
  local file="$1" field="$2"
  awk -v k="^${field}:" '$0 ~ k { sub(k"[[:space:]]*", ""); gsub(/^"|"$/, ""); print; exit }' "$file"
}

printf "%-3s  %-22s  %-5s  %-22s  %s\n" "" "SLUG" "HTTP" "LAST CI" "URL"
printf "%s\n" "────────────────────────────────────────────────────────────────────────────────"

for dir in */; do
  yml="${dir}.portfolio.yml"
  [ -f "$yml" ] || continue

  slug=$(yml_field "$yml" slug)
  url=$(yml_field "$yml" url)
  status=$(yml_field "$yml" status)

  [ "$status" = "production" ] || continue
  case "$url" in http*) ;; *) continue ;; esac

  http=$(curl -sI -o /dev/null -w "%{http_code}" -m 5 -L "$url" 2>/dev/null || echo "000")

  ci="—"
  if [ -d "${dir}.git" ]; then
    ci_raw=$(gh -R "{github-username}/${slug}" run list -L 1 --json status,conclusion 2>/dev/null || echo "")
    if [ -n "$ci_raw" ] && [ "$ci_raw" != "[]" ]; then
      ci=$(printf '%s' "$ci_raw" | python3 -c "import sys,json
try:
    d = json.load(sys.stdin)
    if d: print(f\"{d[0]['status']}/{d[0].get('conclusion') or '-'}\")
except Exception: pass" 2>/dev/null)
      [ -z "$ci" ] && ci="—"
    fi
  fi

  case "$http" in
    200|301|302) emoji="✅" ;;
    000|4??|5??) emoji="❌" ;;
    *) emoji="⚠️ " ;;
  esac

  printf "%-3s  %-22s  %-5s  %-22s  %s\n" "$emoji" "$slug" "$http" "$ci" "$url"
done
