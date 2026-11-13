#!/bin/bash
# hook.sh — PreToolUse blocking hook
# Scans file content being written or edited, and Bash commands being run,
# for common secret patterns.
# Blocks the operation and prints a warning if a secret pattern is detected.
# Skips .env.example files and ~/.claude/plans/ (internal docs).

# A check that could not run must never look like a check that passed. Every
# path below that cannot scan ends in refuse(), exit 2 with a one-line reason on
# stderr that names the cause and says the write was not scanned.
refuse() {
  echo "SECRET SCAN: Blocked, $1; this write was NOT scanned." >&2
  exit 2
}

# Every external tool the scan uses, checked once, up front, before stdin is
# read: a tool that is missing cannot then be discovered halfway through (a
# missing base64 used to decode to an empty string and a missing grep made every
# pattern "not found", so both waved every write through; a missing jq already
# refused). `command -v` is a builtin, so this costs no process. All six are in
# /usr/bin or /bin on macOS; on a machine without one the hook's stderr is the
# only place to tell the owner why every write is refused.
MISSING=""
for tool in cat jq base64 grep sed sort; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
[ -z "$MISSING" ] || refuse "required tool(s) not found on PATH:$MISSING"

INPUT=$(cat) || refuse "stdin could not be read"

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
# A parse failure, an empty stdin or a payload with no tool_name is REFUSED
# below, not read as "nothing to scan": only a well-formed payload for a tool
# this hook does not cover may pass. The record ends with a sentinel field so a
# file_path holding a newline or \x1f (which would shift or cut the fields and
# lose the content) is refused rather than scanned as empty. HAS_CONTENT tells a
# missing content field (refused) from an empty one (an empty file, scanned).
# `.tool_input.command` is added for the Bash matcher: a Bash PreToolUse call
# carries the shell command there, not in `content`/`new_string`/`new_source`,
# so a secret pasted straight into a command line (e.g. as an env prefix) was
# invisible to this hook until it was registered on Bash too.
PARSED=$(printf '%s' "$INPUT" | jq -r '
  [ (.tool_name // ""),
    (.tool_input.file_path // .tool_input.notebook_path // ""),
    ((.tool_input.edit_mode | select(type == "string")) // ""),
    ((.tool_input.content // .tool_input.new_string // .tool_input.new_source // .tool_input.command) != null | tostring),
    (((.tool_input.content // .tool_input.new_string // .tool_input.new_source // .tool_input.command // "") | @base64)),
    "end"
  ] | join("\u001f")' 2>/dev/null) || refuse "the hook payload is not valid JSON"
IFS=$'\x1f' read -r TOOL_NAME FILE_PATH EDIT_MODE HAS_CONTENT CONTENT_B64 END_MARK <<<"$PARSED"

[ "$END_MARK" = "end" ] || refuse "the hook payload could not be read (empty, or an unreadable field)"
[ -n "$TOOL_NAME" ] || refuse "the hook payload names no tool"

case "$TOOL_NAME" in
  Write|Edit|NotebookEdit|Bash) ;;
  *) exit 0 ;;
esac

# Deleting a notebook cell writes nothing: there is no text to scan. Only that
# one shape passes; a delete that does carry a new_source is still scanned, and
# every other NotebookEdit without a new_source is refused just below.
if [ "$TOOL_NAME" = "NotebookEdit" ] && [ "$EDIT_MODE" = "delete" ] && [ "$HAS_CONTENT" != "true" ]; then
  exit 0
fi

[ "$HAS_CONTENT" = "true" ] || refuse "the $TOOL_NAME payload carries no content to scan"

CONTENT=$(printf '%s' "$CONTENT_B64" | base64 --decode 2>/dev/null) || refuse "the content could not be decoded"

# Skip .env.example files — they are placeholders by design
if [[ "$FILE_PATH" == *".env.example" ]]; then
  exit 0
fi

# Lexically resolve "." and ".." segments of an absolute path into NORM_PATH,
# in pure bash (no process, no file access, no symlink resolution). The plans
# exemption below tests the normalised path: a prefix match on the raw one let
# "$HOME/.claude/plans/../../Dev/x/.env" through. ".." at the root stays at the
# root, as the kernel resolves it. A relative path is returned unchanged: it
# can never sit under the absolute plans folder.
normalize_path() {
  NORM_PATH="$1"
  [[ "$1" == /* ]] || return 0
  local -a segs out=()
  local seg n=0 i joined="" IFS=/
  read -ra segs <<<"$1"
  for seg in "${segs[@]}"; do
    case "$seg" in
      ""|.) ;;
      ..) [ "$n" -gt 0 ] && n=$((n - 1)) ;;
      *) out[n]="$seg"; n=$((n + 1)) ;;
    esac
  done
  for ((i = 0; i < n; i++)); do
    joined="$joined/${out[i]}"
  done
  NORM_PATH="${joined:-/}"
}

# Skip ~/.claude/plans/ — internal plan/review docs often discuss secret patterns textually
normalize_path "$FILE_PATH"
if [[ "$NORM_PATH" == "$HOME/.claude/plans/"* ]]; then
  exit 0
fi

# Check for secret patterns — use word boundaries and require plausible secret body
# to avoid false positives on words like "task-", "disk-", "ask-".
# grep -q on the text $1 with the remaining arguments; returns grep's verdict,
# 0 for a match and 1 for none. grep exits 2 or more when it could not run
# (killed, out of memory, unreadable input), and that must not read as "no
# match": the content would look clean without having been scanned, so it is
# refused. A herestring, not a pipe: no process is spawned, and a -q early exit
# cannot SIGPIPE a writer.
scan_q() {
  local text="$1" rc
  shift
  grep -q "$@" <<<"$text" 2>/dev/null
  rc=$?
  [ "$rc" -le 1 ] || refuse "grep failed at run time (exit $rc)"
  return "$rc"
}

check_regex() {
  local pattern="$1"
  local label="$2"
  # -e: a pattern may start with a dash (the PEM header).
  if scan_q "$CONTENT" -E -e "$pattern"; then
    {
      echo "SECRET SCAN: Blocked write to $FILE_PATH"
      echo "  Detected pattern: $label"
      echo "  Use environment variables instead of hardcoded secrets."
    } >&2
    exit 2
  fi
}

# Each vendor pattern is registered, then all are tried in ONE pass as a single
# alternation: thirteen passes over a 2 MB file cost 1.5 s, and the hook has 5 s
# before its timeout blocks the write. Only when the group matches are the
# patterns run one by one, to name the one that did.
VENDOR_P=()
VENDOR_L=()
vendor() {
  VENDOR_P[${#VENDOR_P[@]}]="$1"
  VENDOR_L[${#VENDOR_L[@]}]="$2"
}

# API keys — require prefix at word boundary + realistic body length
vendor '(^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}'   "OpenAI/Anthropic-style API key (sk-...)"
vendor '(^|[^A-Za-z0-9_])pk_(live|test)_[A-Za-z0-9]{16,}' "Stripe publishable key (pk_live/pk_test_...)"
vendor '(^|[^A-Za-z0-9_])sk_(live|test)_[A-Za-z0-9]{16,}' "Stripe secret key (sk_live/sk_test_...)"
vendor '(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}'        "AWS access key (AKIA...)"
vendor '(^|[^A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}'    "GitHub personal access token (ghp_...)"
vendor '(^|[^A-Za-z0-9_])gho_[A-Za-z0-9]{30,}'    "GitHub OAuth token (gho_...)"
vendor '(^|[^A-Za-z0-9_])ghs_[A-Za-z0-9]{30,}'    "GitHub app token (ghs_...)"
vendor '(^|[^A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}' "GitLab personal access token (glpat-...)"
vendor '(^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}' "GitHub fine-grained PAT (github_pat_...)"
vendor '(^|[^A-Za-z0-9_])xox[abposr]-[A-Za-z0-9-]{10,}' "Slack token (xoxb-/xoxp-...)"
vendor '(^|[^A-Za-z0-9_])AIza[0-9A-Za-z_-]{35}'   "Google API key (AIza...)"
vendor '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----' "PEM private key"
vendor '(^|[^A-Za-z0-9_])npg_[A-Za-z0-9]{10,}'          "Neon API key/password (npg_...)"

# Neon Postgres connection strings carry a real, database-scoped password —
# unlike a generic postgresql:// URI (e.g. the "user:password@host" placeholder
# in docs), so this anchors on the neon.tech host rather than the credential
# shape, which the placeholder also has. Both the postgres:// and postgresql://
# schemes are issued by Neon, and a real host carries region and (optionally)
# pooler segments, e.g. ep-cool-name-123456-pooler.us-east-2.aws.neon.tech, so
# dots and hyphens are both allowed between "ep-" and the ".neon.tech" suffix —
# which still also matches the bare ep-x.neon.tech shape.
vendor 'postgres(ql)?://[^:@[:space:]]+:[^@[:space:]]+@ep-[A-Za-z0-9.-]+\.neon\.tech' "Neon Postgres connection string"

VENDOR_ALL=""
for vp in "${VENDOR_P[@]}"; do
  VENDOR_ALL="${VENDOR_ALL:+$VENDOR_ALL|}($vp)"
done
if scan_q "$CONTENT" -E -e "$VENDOR_ALL"; then
  vi=0
  for vp in "${VENDOR_P[@]}"; do
    check_regex "$vp" "${VENDOR_L[vi]}"
    vi=$((vi + 1))
  done
  refuse "a vendor pattern matched in the group but not alone"
fi

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
# [[ text =~ regex ]] without a process. A regex that cannot compile returns 2,
# and that must not read as "no match": it is refused, like a grep that failed.
re_match() {
  local rc
  [[ $1 =~ $2 ]]
  rc=$?
  [ "$rc" -le 1 ] || refuse "a pattern could not be compiled"
  return "$rc"
}

RE_PH_ANGLE='^<.*>$'
RE_PH_X='^x+$'
RE_PH_YOUR='^(your|my)[-_a-z]*(key|token|secret)[-_a-z]*$'
RE_PH_REPLACE='^(replace|insert)[-_][-_a-z0-9]*$'
RE_PH_WORD='^[-_a-z]*(here|example|placeholder|changeme)[-_a-z]*$'
RE_PH_ENV='^(process\.env|import\.meta\.env|os\.environ|os\.getenv)(\.|$)'
RE_PH_PLACEHOLDER='^placeholder[-_a-z0-9]*$'
RE_DIGIT='[0-9]'
RE_LETTER='[A-Za-z]'
RE_LOWER='[a-z]'
RE_WORDS='^([a-z]+([_-][a-z]+)+|[A-Z]+([_-][A-Z]+)+)$'
# A path, a URL without credentials or a resource reference, never a value:
#   /etc/..., /run/secrets/...: an absolute path under a known root, or one
#     whose segments are all lower case (/api/v1/oauth/token). Any leading
#     slash used to do, so a base64 value that starts with one and holds a
#     second passed; such a value carries an upper-case letter.
#   ./x, ../x, ~/x;
#   scheme://host/... with no @;
#   projects/123456/secrets/name/versions/latest: three lower-case segments or
#     more. A generated value with two slashes carries an upper-case letter.
RE_PATH='^(/(etc|usr|var|run|tmp|opt|home|Users|private|app|data|srv|mnt|secrets|workspace|root|Library|Volumes|config|certs|keys|ssl|vault|dev|proc|nix|bin)/|/[a-z0-9._-]+(/[a-z0-9._-]*)+$|\.{1,2}/|~/|[a-z][a-z0-9+.-]*://[^@]*$|[a-z0-9._-]+(/[a-z0-9._-]+){2,}$)'

RE_CRYPT='^\$(2[abxy]?|[156]|argon2(id|i|d)|scrypt|pbkdf2[a-z0-9-]*)\$'
RE_BENIGN_NAME='(^|_)(PUBLIC|PUBLISHABLE|ANON|CACHE|SORT|PARTITION|PRIMARY|FOREIGN|IDEMPOTENCY)_'

# No process is spawned per value: a file of 500 distinct placeholder lines
# used to fork six greps a line (8 s). Case-insensitive, as the greps were.
is_placeholder_value() {
  local v="$1" rc=1
  # A value that says it is one, lower case only: placeholder_auth_secret_32_chars.
  # Case-sensitive, so a mixed-case value that merely starts with the word is not exempt.
  if re_match "$v" "$RE_PH_PLACEHOLDER"; then
    return 0
  fi
  shopt -s nocasematch
  if re_match "$v" "$RE_PH_ANGLE" || re_match "$v" "$RE_PH_X" \
    || re_match "$v" "$RE_PH_YOUR" || re_match "$v" "$RE_PH_REPLACE" \
    || re_match "$v" "$RE_PH_WORD" || re_match "$v" "$RE_PH_ENV"; then
    # "replace-with-64-hex-chars" is an instruction, digits included: the
    # separator right after the word keeps a random key from slipping in.
    # process.env.X, os.environ[...] are reads from the environment.
    rc=0
  fi
  shopt -u nocasematch
  return "$rc"
}

# What kind of file is being written decides how an UNQUOTED right-hand side
# and a quoted "$..." read.
#   IS_CODE: a source file, where an unquoted right-hand side is an expression
#     (a call, a property read, an identifier), never a literal.
#   DOLLAR_LITERAL: a language whose quoted strings do not interpolate $NAME,
#     so a quoted value that starts with a dollar sign is the value itself.
# A Bash command is neither: unquoted there is a literal and $NAME a reference.
IS_CODE=0
DOLLAR_LITERAL=0
if [ "$TOOL_NAME" != "Bash" ]; then
  FILE_EXT=""
  case "$FILE_PATH" in *.*) FILE_EXT="${FILE_PATH##*.}" ;; esac
  case "$FILE_EXT" in
    py|pyi|ipynb|js|jsx|mjs|cjs|ts|tsx|mts|cts|go|rs|java|c|h|cc|cpp|hpp|rb|lua)
      IS_CODE=1; DOLLAR_LITERAL=1 ;;
    php|pl|pm|kt|kts|groovy|gradle|dart|scala|swift|cs|astro|vue|svelte)
      IS_CODE=1 ;;
  esac
fi

# Scans $CONTENT for a key equals value shaped assignment ($1, extended
# regex) and blocks unless the matched value is a placeholder (per
# is_placeholder_value above). Shared by every rule below, so a placeholder is
# exempted consistently regardless of quoting or letter case.
#
# The arguments after the label are flags:
#   digit   the value must carry a digit;
#   mix     a digit AND a letter (a bare number or a plain word is never a
#           generated secret);
#   path    skip a value that reads as a path or a URL without credentials;
#   benign  skip a key NAME with a whole segment that says it is not a secret
#           (PUBLIC, PUBLISHABLE, ANON, CACHE, SORT...). The name only, by
#           segment: the value used to be tested too, so PYPI_PUBLISH_KEY and
#           any value containing "anon" were skipped;
#   cs      match case-sensitively (the pattern then names upper-case keys, so
#           a lower-case cache_key= keyword argument is not an env name).
#
# Matches are de-duplicated by sort -u, then checked without spawning a
# process: thousands of identical or distinct placeholder lines cost one grep
# and one sort.
check_key_value() {
  local pattern="$1" label="$2" f
  shift 2
  local need="" skip_path="" skip_benign="" grep_i="-i" qkword=""
  for f in "$@"; do
    case "$f" in
      digit|mix) need="$f" ;;
      path) skip_path=1 ;;
      benign) skip_benign=1 ;;
      cs) grep_i="" ;;
      qkword) qkword=1 ;;
      *) refuse "check_key_value was given an unknown flag ($f)" ;;
    esac
  done
  local matches rc m w name rawname value quoted
  matches=$(grep -oE $grep_i -e "$pattern" <<<"$CONTENT" 2>/dev/null)
  rc=$?
  [ "$rc" -le 1 ] || refuse "grep failed at run time (exit $rc)"
  [ -z "$matches" ] && return 0
  matches=$(LC_ALL=C sort -u <<<"$matches" 2>/dev/null) || refuse "sort failed at run time"
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    # Drop the one boundary character a pattern may have captured before the
    # key name, then split at the FIRST colon or equals sign: the key name
    # holds neither, while a value may (a quoted password with a = in it).
    w="$m"
    case "$w" in [A-Za-z0-9_]*) ;; *) w="${w#?}" ;; esac
    rawname="${w%%[:=]*}"
    rawname="${rawname%"${rawname##*[![:space:]]}"}"
    name="$rawname"
    name="${name%"${name##*[![:space:]\"\']}"}"
    name="${name##*[[:space:]]}"
    value="${w#*[:=]}"
    value="${value#"${value%%[![:space:]]*}"}"
    quoted=""
    case "$value" in \"*|\'*) quoted=1 ;; esac
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    # Under a QUOTED key (JSON, an object literal), a quoted value made of words
    # joined by _ or -, all lower case or all upper case, names something: an
    # i18n message id, an env variable name. Demanding a letter and a digit
    # instead was tried and withdrawn: an all-letters secret then passed.
    if [ -n "$qkword" ]; then
      case "$rawname" in
        *\"|*\') if re_match "$value" "$RE_WORDS"; then continue; fi ;;
      esac
    fi
    if [ -n "$skip_benign" ] && re_match "$name" "$RE_BENIGN_NAME"; then
      continue
    fi
    # In a source file, an unquoted value under a name with a lower-case
    # letter is an expression: token=load_token_v2, a hashlib call, a property
    # read. An upper-case name keeps being checked: FOO_TOKEN=... inside a
    # string handed to a shell is an env assignment whatever the file.
    # Known gap, on purpose: a lower-case assignment written INSIDE a string of a
    # source file (a DSN, a shell line) is exempt too. Telling a string from
    # code by counting quotes before the match was tried and withdrawn: it
    # blocked ordinary lines (a URL or an apostrophe earlier on the line) and
    # cost one pass over the whole content per match.
    if [ "$IS_CODE" = 1 ] && [ -z "$quoted" ] && re_match "$name" "$RE_LOWER"; then
      continue
    fi
    # A reference, not a value: "...${VAR}...", $VAR, $(command). Where quoted
    # strings do not interpolate, a quoted "$..." is the value itself and is
    # checked, unless it is a crypt-style password HASH ($2b$10$...).
    case "$value" in
      *'${'*) continue ;;
      '$'*)
        if [ "$DOLLAR_LITERAL" != 1 ] || [ -z "$quoted" ]; then
          continue
        fi
        if re_match "$value" "$RE_CRYPT"; then
          continue
        fi
        ;;
    esac
    if is_placeholder_value "$value"; then
      continue
    fi
    # Unquoted names like TOKEN_FILE=some-long-file-name are plain words; a
    # generated secret of 16+ characters carries a digit, so the unquoted
    # rule opts in to requiring one.
    if [ -n "$need" ] && ! re_match "$value" "$RE_DIGIT"; then
      continue
    fi
    if [ "$need" = "mix" ] && ! re_match "$value" "$RE_LETTER"; then
      continue
    fi
    # A value with two slashes from its start (/etc/ssl/...) is a path, and so
    # is ./x, ../x and ~/x. A single leading slash is not: / is a base64
    # character, so a generated secret can start with one. scheme://host/... with
    # no @ is a URL without credentials.
    if [ -n "$skip_path" ] && re_match "$value" "$RE_PATH"; then
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

# Building blocks of the patterns below. KEYQ is an optional closing quote
# after the key name, so a quoted key ("api_key": ...) matches like a bare one.
# The value classes hold the slash: it is a base64 character, and without it a
# generated value stopped matching at its first slash. The path flag is what
# keeps /run/secrets/... and https://... clean.
QT="[\"']"
KEYQ="[\"']?"
SYM='[A-Za-z0-9_!@#$%^&*+=.,~?:;|/-]'
UNQ='[A-Za-z0-9_!@#$%^&*+.~/-]'

# Every rule below needs one of these words in the key name (api_key, _KEY and
# access-key all hold "key"). Content without any of them is clean for all six,
# in one pass instead of six. A new rule with a new word must add it here; its
# own block test fails if it does not.
if ! scan_q "$CONTENT" -iE -e 'token|passw|secret|key'; then
  exit 0
fi

# Hardcoded assignments — quoted values only (double- or single-quoted).
# Case-insensitive, so an uppercase key name is covered too, not just the
# lowercase "token"/"password"/"secret"/"api_key" wording.
check_key_value "(token|password|secret|api[_-]?key)${KEYQ}[[:space:]]*[:=][[:space:]]*${QT}[A-Za-z0-9_-]{12,}${QT}" "hardcoded credential assignment" qkword

# The same, with symbols allowed in the quoted value (a password such as
# Ab1!cd...), and with the named key families (SECRET_KEY = '...' in a Django
# settings file, "private_key": "..."). Wider, so a digit and a letter are
# required, and a path or a URL is skipped. A generic NAME_KEY = '...' is
# deliberately not matched with spaces around the sign: that is the shape of a
# localStorage constant (const STORAGE_KEY = 'app-state-v2').
check_key_value "(password|passwd|token|secret|api[_-]?key|(secret|access|private|signing|encryption)[_-]?key)${KEYQ}[[:space:]]*[:=][[:space:]]*${QT}${SYM}{12,}${QT}" "hardcoded credential assignment" mix path

# Unquoted password: DB_PASSWORD=... or YAML "password: ..." anywhere on a line
# (also after "- " in a compose list, or as a docker -e argument). A digit and
# a letter are required, so password=password, password: string, password: true
# and a bare number stay clean.
check_key_value "(^|[^A-Za-z0-9_])[A-Za-z0-9_]*(password|passwd)${KEYQ}[[:space:]]*[:=][[:space:]]*${UNQ}{12,}" "unquoted password assignment" mix path

# A key ending in _API_KEY, assigned either quoted or unquoted — e.g. a shell
# env prefix, an export line with a quoted value, or a bare .env-style line.
# The unquoted branch's character class excludes the dollar sign, so a
# variable reference on the right-hand side does not match.
check_key_value '(^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]*_API_KEY=(["'"'"'][A-Za-z0-9_-]{16,}["'"'"']|[A-Za-z0-9_-]{16,})' "*_API_KEY assignment"

# Any other UPPER-CASE name ending in _KEY (STRIPE_KEY, SIGNING_KEY...), quoted
# or not. Case-sensitive: cache_key=..., sort_key=... are keyword arguments.
# Names with a benign segment are skipped, a bare key=/key: is never matched
# (React key=, i18n "key"), and a digit and a letter are required.
check_key_value '(^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]*_KEY=(["'"'"'][A-Za-z0-9_/+-]{16,}["'"'"']|[A-Za-z0-9_/+-]{16,})' "*_KEY assignment" mix path benign cs

# Unquoted token/secret assignment, anywhere an assignment can start: the
# start of a line (optionally after `export`), after whitespace, ; | ( or a
# quote (docker -e "NAME=..."), after = (--env=NAME=...) and after a dash
# (--token=..., client-secret=...). The same in a written file as in a Bash
# command: a compose list entry or a script line is the same assignment.
# Two differences by tool. A Bash command also starts one after & (a && b),
# while a written file does not: &token=... there is a signed URL in a data
# file. A written file also accepts spaces around the sign and a colon
# (aws_secret_access_key = ..., client_secret: ...), which is not shell syntax.
# The name must END in the secret word (so SECRET_KEY_PATH, TOKEN_CACHE_DIR,
# TOKENIZER_MODEL do not match) and the value is skipped when it reads as a
# path. The value class excludes <, $, { and quotes, so TOKEN=<...>,
# TOKEN=${VAR} and an empty TOKEN= never match, and is_placeholder_value plus
# the digit requirement drop prose-like values.
if [ "$TOOL_NAME" = "Bash" ]; then
  ASSIGN_LEAD="(^|[[:space:];&|(\"'=-])"
  ASSIGN_SIGN='='
else
  ASSIGN_LEAD="(^|[[:space:];|(\"'=-])"
  ASSIGN_SIGN='[[:space:]]*[:=][[:space:]]*'
fi
check_key_value "${ASSIGN_LEAD}(export[[:space:]]+)?[A-Za-z0-9_]*(token|secret|secret_key|secret_key_base|secret_access_key)${ASSIGN_SIGN}[A-Za-z0-9_+/.-]{16,}" "unquoted token/secret assignment" digit path

exit 0
