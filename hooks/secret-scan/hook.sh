#!/bin/bash
# hook.sh — PreToolUse blocking hook
# Scans file content being written or edited, and Bash commands being run,
# for common secret patterns.
# Blocks the operation and prints a warning if a secret pattern is detected.
# Skips .env.example files and ~/.claude/plans/ (internal docs).

INPUT=$(cat)

# Field extraction goes through `jq`, not `python3`.
#
# uv is the sole Python manager on this machine, so a bare `python3` here
# resolves to a Homebrew interpreter that exists only as a dependency of
# gcloud-cli/mpv/yt-dlp, with Apple's 3.9.6 behind it — an interpreter this
# hook never chose. Routing it through uv would be worse rather than better:
# this is a PreToolUse hook on every Write, Edit and NotebookEdit, so it is one
# of the hottest paths in the whole setup.
#
# It was also spawning an interpreter THREE times per invocation to read three
# fields out of one document. One `jq` call now reads all three, and `jq` is
# /usr/bin/jq (Apple ships it), so it resolves under any PATH this hook can
# inherit and needs no interpreter at all.
#
# Joined with \x1f (unit separator) on one line, not @tsv/tab: bash's `read`
# treats any run of IFS *whitespace* characters (space, tab, newline) as a
# single delimiter and trims it at the edges, even when IFS is set to only
# one of them — so an empty FILE_PATH field (always the case for a Bash
# payload, which has no file_path) collapsed into the adjacent field and
# silently discarded CONTENT_B64. \x1f is not whitespace, so empty fields
# stay empty and every field lands where it belongs.
# The content field is base64'd because it is arbitrary file text and can
# contain anything, including \x1f itself — and decoded below.
# `// ""` preserves the old `.get(field, '')` semantics, and a parse failure
# leaves every field empty, which the guards below already treat as "nothing to
# scan" exactly as `except`-less python3 + `2>/dev/null` did.
# `.tool_input.command` is added for the Bash matcher: a Bash PreToolUse call
# carries the shell command there, not in `content`/`new_string`/`new_source`,
# so a secret pasted straight into a command line (e.g. as an env prefix) was
# invisible to this hook until it was registered on Bash too.
IFS=$'\x1f' read -r TOOL_NAME FILE_PATH CONTENT_B64 <<<"$(printf '%s' "$INPUT" | jq -r '
  [ (.tool_name // ""),
    (.tool_input.file_path // .tool_input.notebook_path // ""),
    (((.tool_input.content // .tool_input.new_string // .tool_input.new_source // .tool_input.command // "") | @base64))
  ] | join("\u001f")' 2>/dev/null)"

case "$TOOL_NAME" in
  Write|Edit|NotebookEdit|Bash) ;;
  *) exit 0 ;;
esac

CONTENT=$(printf '%s' "$CONTENT_B64" | base64 --decode 2>/dev/null)

# Skip .env.example files — they are placeholders by design
if [[ "$FILE_PATH" == *".env.example" ]]; then
  exit 0
fi

# Skip ~/.claude/plans/ — internal plan/review docs often discuss secret patterns textually
if [[ "$FILE_PATH" == "$HOME/.claude/plans/"* ]]; then
  exit 0
fi

# Check for secret patterns — use word boundaries and require plausible secret body
# to avoid false positives on words like "task-", "disk-", "ask-".
check_regex() {
  local pattern="$1"
  local label="$2"
  if echo "$CONTENT" | grep -qE "$pattern" 2>/dev/null; then
    {
      echo "SECRET SCAN: Blocked write to $FILE_PATH"
      echo "  Detected pattern: $label"
      echo "  Use environment variables instead of hardcoded secrets."
    } >&2
    exit 2
  fi
}

# API keys — require prefix at word boundary + realistic body length
check_regex '(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}'   "OpenAI/Anthropic-style API key (sk-...)"
check_regex '(^|[^A-Za-z0-9_])pk_(live|test)_[A-Za-z0-9]{16,}' "Stripe publishable key (pk_live/pk_test_...)"
check_regex '(^|[^A-Za-z0-9_])sk_(live|test)_[A-Za-z0-9]{16,}' "Stripe secret key (sk_live/sk_test_...)"
check_regex '(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}'        "AWS access key (AKIA...)"
check_regex '(^|[^A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}'    "GitHub personal access token (ghp_...)"
check_regex '(^|[^A-Za-z0-9_])gho_[A-Za-z0-9]{30,}'    "GitHub OAuth token (gho_...)"
check_regex '(^|[^A-Za-z0-9_])ghs_[A-Za-z0-9]{30,}'    "GitHub app token (ghs_...)"
check_regex '(^|[^A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}' "GitLab personal access token (glpat-...)"
check_regex '(^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}' "GitHub fine-grained PAT (github_pat_...)"
check_regex '(^|[^A-Za-z0-9_])npg_[A-Za-z0-9]{10,}'          "Neon API key/password (npg_...)"

# Neon Postgres connection strings carry a real, database-scoped password —
# unlike a generic postgresql:// URI (e.g. the "user:password@host" placeholder
# in docs), so this anchors on the neon.tech host rather than the credential
# shape, which the placeholder also has. Both the postgres:// and postgresql://
# schemes are issued by Neon, and a real host carries region and (optionally)
# pooler segments, e.g. ep-cool-name-123456-pooler.us-east-2.aws.neon.tech, so
# dots and hyphens are both allowed between "ep-" and the ".neon.tech" suffix —
# which still also matches the bare ep-x.neon.tech shape.
check_regex 'postgres(ql)?://[^:@[:space:]]+:[^@[:space:]]+@ep-[A-Za-z0-9.-]+\.neon\.tech' "Neon Postgres connection string"

# Is $1 an obvious placeholder rather than a real secret? Value-based, not
# pattern-based, on purpose: a value that is a run of x's, wrapped in angle
# brackets, or a whole-value template like "your-api-key" or "changeme" is
# routine in READMEs and .env.sample / .env.local.example files, and the
# credential/API-key checks below would otherwise block ordinary
# documentation work.
#
# Anchored to the *whole* value with ^...$, not a bare substring match: an
# earlier version flagged any value containing "your"/"example"/"here"/
# "placeholder"/"changeme" ANYWHERE, so a real 40-char key that merely
# happened to contain "here" (or had "-here" appended to it) was silently
# exempted — a real regression a reviewer caught by building exactly that
# value at runtime. Every template below is lowercase letters, dashes and
# underscores only (no digits), which is what distinguishes a hand-typed
# placeholder from a real generated key: a real key's alphabet essentially
# always contains a digit somewhere in 16+ characters, and a value that does
# is never a match here regardless of which word it contains.
is_placeholder_value() {
  local v="$1"
  if printf '%s' "$v" | grep -qiE '^<.*>$'; then
    return 0
  fi
  if printf '%s' "$v" | grep -qiE '^x+$'; then
    return 0
  fi
  if printf '%s' "$v" | grep -qiE '^(your|my)[-_a-z]*(key|token|secret)[-_a-z]*$'; then
    return 0
  fi
  if printf '%s' "$v" | grep -qiE '^[-_a-z]*(here|example|placeholder|changeme)[-_a-z]*$'; then
    return 0
  fi
  return 1
}

# Scans $CONTENT for a key equals value shaped assignment ($1, extended
# regex, case-insensitive) and blocks unless the matched value is a
# placeholder (per is_placeholder_value above). Shared by the quoted
# credential rule and the API-key rule below, so a placeholder is exempted
# consistently regardless of quoting or letter case.
check_key_value() {
  local pattern="$1" label="$2"
  local matches
  matches=$(printf '%s\n' "$CONTENT" | grep -oiE "$pattern" 2>/dev/null)
  [ -z "$matches" ] && return 0
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    local value="${m##*[:=]}"
    value=$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//')
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    if is_placeholder_value "$value"; then
      continue
    fi
    {
      echo "SECRET SCAN: Blocked write to $FILE_PATH"
      echo "  Detected pattern: $label"
      echo "  Use environment variables instead of hardcoded secrets."
    } >&2
    exit 2
  done <<<"$matches"
}

# Hardcoded assignments — quoted values only (double- or single-quoted).
# Case-insensitive, so an uppercase key name is covered too, not just the
# lowercase "token"/"password"/"secret"/"api_key" wording.
check_key_value "(token|password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9_-]{12,}[\"']" "hardcoded credential assignment"

# A key ending in _API_KEY, assigned either quoted or unquoted — e.g. a shell
# env prefix, an export line with a quoted value, or a bare .env-style line.
# The unquoted branch's character class excludes the dollar sign, so a
# variable reference on the right-hand side does not match.
check_key_value '(^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]*_API_KEY=(["'"'"'][A-Za-z0-9_-]{16,}["'"'"']|[A-Za-z0-9_-]{16,})' "*_API_KEY assignment"

exit 0

# Known limit, not fixable by a regex scanner: a secret that only ever
# appears encoded (e.g. base64) in $CONTENT is not detected.
