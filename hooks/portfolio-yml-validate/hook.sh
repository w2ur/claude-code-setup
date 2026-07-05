#!/usr/bin/env bash
# PostToolUse hook on Write|Edit of *.portfolio.yml:
# Validates required fields, slug=folder consistency, numeric sort_order. Warns, doesn't block.

input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

file_path=$(echo "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('file_path', ''))
except Exception:
    pass" 2>/dev/null)

case "$file_path" in
  */.portfolio.yml) ;;
  *) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0

yml_field() {
  awk -v k="^$1:" '$0 ~ k { sub(k"[[:space:]]*", ""); gsub(/^"|"$/, ""); print; exit }' "$file_path"
}

# Required fields per portfolio-conventions skill
required="name slug tagline description audience visibility status surface_type url portfolio_card portfolio_link badge icon_emoji icon_file stack sort_order"

missing=""
for field in $required; do
  grep -qE "^${field}:" "$file_path" || missing+=" $field"
done

# slug must match folder name
folder=$(basename "$(dirname "$file_path")")
slug=$(yml_field slug)

# surface_type must be one of the 9 valid values; some values require story_slug
surface_type=$(yml_field surface_type)
valid_surface="flagship personal-live external-story internal-story tool-widget meta hidden archived hub"
story_slug=$(yml_field story_slug)
if [ -n "$surface_type" ]; then
  echo "$valid_surface" | grep -qw "$surface_type" || surface_bad=1
  case "$surface_type" in
    personal-live|internal-story|tool-widget|archived)
      [ -z "$story_slug" ] && surface_needs_story=1 ;;
  esac
fi

# sort_order must be numeric
sort_order=$(yml_field sort_order)

warnings=""
[ -n "$missing" ] && warnings+="   Missing fields:$missing\n"
[ -n "$slug" ] && [ "$slug" != "$folder" ] && warnings+="   slug '$slug' does not match folder '$folder'\n"
[ -n "$surface_bad" ] && warnings+="   surface_type '$surface_type' is not one of: $valid_surface\n"
[ -n "$surface_needs_story" ] && warnings+="   surface_type '$surface_type' requires a story_slug\n"
if [ -n "$sort_order" ]; then
  case "$sort_order" in
    ''|*[!0-9]*) warnings+="   sort_order '$sort_order' is not a number\n" ;;
  esac
fi

if [ -n "$warnings" ]; then
  msg=$(printf ".portfolio.yml validation:\n%b" "$warnings")
  MSG="$msg" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': os.environ['MSG']}}))
"
fi

exit 0
