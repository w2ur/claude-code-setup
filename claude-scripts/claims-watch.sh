#!/usr/bin/env bash
#
# claims-watch.sh — does what the portfolio says in public still match the code
# and the data?
#
# About a dozen findings of the October 2026 review were one defect: a public
# page states something the repo no longer supports (a figure, a README that
# opens on raw front matter on the registry). Existing guards cover single
# surfaces. This one covers two checks, deterministically, with no model.
#
#   1. EVERY FIGURE IN A PITCH HAS A DERIVATION. Each repo whose README opens
#      with a pitch block (THE PITCH-BLOCK RULE below) has its `facts_fr` and
#      `facts_en` scanned for numbers. A number is derived by a rule in
#      claims-watch.rules.json (a pattern that selects the figure, a read-only
#      command that prints the true value). A figure no rule covers is a
#      finding ("unverified figure"); a mismatch is a finding naming both
#      values; the French and English lines must carry the same figures.
#   2. A REGISTRY PAGE MATCHES ITS REPO. For each package the repo publishes
#      (discovered, never hand-listed): the registry's version against the
#      repo's, and the first non-blank line of the registry README.
#
# WHERE THE LINE FALLS WITH distribution-watch.sh. distribution-watch.sh is
# scheduled, vigie reads its --json, and it answers "is the package there at
# all?" from a hand-written list. This script answers "does what is published
# say what the repo says?" and NEVER re-reports presence: a package that is not
# published here is distribution-watch's finding, and is printed as an INFO
# line, never as a finding. A package one script knows and the other does not
# is printed as a "note" for the owner; distribution-watch's list is not edited
# from here. The Chrome Web Store is deliberately out: it answers 200 for any
# id, and its version and description cannot be read without scraping.
#
# Usage:
#   claims-watch.sh
#
# Environment (all optional; they exist so the tests can use a fixture tree):
#   DEV_DIR                      where the repos live (default ~/Dev)
#   CLAIMS_RULES                 the rule table (default: beside this script)
#   CLAIMS_RULE_TIMEOUT          seconds a rule command may run (default 20);
#                                a value that is not a positive integer is exit 2
#   CLAIMS_CURL_TIMEOUT          seconds a registry request may take (default 20)
#   CLAIMS_DISTRIBUTION_WATCH    the distribution-watch.sh to cross-read
#
# Exit codes (portfolio convention):
#   0  every figure is derived or a label, every registry page matches
#   1  at least one finding
#   2  could not run, so UNKNOWN, never "in step": a missing, unparseable or
#      empty rule table, a rule whose command is refused or fails or times
#      out, a malformed pitch block, no pitch repo found at all, a registry
#      that timed out, answered 5xx or returned a body that does not parse.
#      Exit 2 outranks exit 1; findings are still printed.
#
# Output: one line per item, prefixed FINDING, UNKNOWN, INFO or note, then a
# summary line. Only FINDING (exit 1) and UNKNOWN (exit 2) change the exit code.
#
# THE RULE TABLE. claims-watch.rules.json: {"rules":[{...}]}. Each rule:
#   repo     the folder name under DEV_DIR
#   pattern  a Perl regular expression; the first capture group (else the
#            whole match) selects the figure in facts_fr and facts_en. One
#            pattern may cover both languages by alternation.
#   command  a shell command that prints the true value; run in the jail
#            above, cwd = the repo, stdin closed, under a timeout this script owns.
#   kind     optional; "label" marks a number that names something rather
#            than counts it (a version, a confidence level): exempt from
#            derivation, still compared French against English. No command.
#   note     optional free text for the owner; never read.
# Rules are READ-ONLY AND OFFLINE, and that is enforced by the ENVIRONMENT a rule
# runs in, never by reading its text. Every rule runs under `env -i` with
# PATH set to a private directory (the jail) that holds symlinks to the
# allowlisted binaries only (jq grep find wc git cat head tail cut tr ls sort
# uniq expr test printf echo), under restricted bash (`/bin/bash -r -c`):
# no output redirection, no command name containing a slash, no change to PATH,
# no `exec`. A binary that is not in the jail cannot be found, whatever the
# quoting or the substitution used. `find`, `git`, `sort` and `uniq` in the
# jail are guards, not the real binaries: they inspect their own arguments
# AFTER the shell has expanded them (so `-\delete` is seen as `-delete`) and
# refuse the options that write or execute, then exec the real binary. The
# builtins that bypass PATH or run code (command builtin kill eval source . trap
# enable) are switched off with `enable -n` before the rule starts.
# A short textual refusal is applied to every rule BEFORE the first one runs, as
# a clear exit 2 for the obvious cases: `find` actions that write or execute,
# `git` with anything but ls-files/rev-list/rev-parse/cat-file/ls-tree (and
# --exec-path, --ext-diff, --textconv, --filters, --output), `sort -o`/--output,
# those builtins in command position, and backticks. It is not the containment:
# the jail is. No rule is refused for NAMING a word such as source, open or
# .env as an argument, and a rule that reads a secret-looking path is not
# refused either: the text of a rule cannot tell a quoted search pattern from a
# file argument, and a rule's output is never echoed, only a number is used. A
# refused rule is exit 2, not a finding. A test count is derived by counting
# call sites statically, or left unverified. It is never derived by running a
# suite.
#
# PUBLIC MIRROR. sync.py maps scripts/*.sh and scripts/*.py to the public
# mirror, so this script goes public and the rule table does not: the rules
# name private repos. Do not widen the file map.
#
# THE PITCH-BLOCK RULE (the same rule lives in six copies: {portfolio-site}
# scripts/build-inventory.mjs parsePitch, ~/.claude/scripts/sync-repo-about.sh
# read_frontmatter, ~/Dev/mac-setup/tests/run.sh, my-budget-app and my-fitness-app
# scripts/publish-public.sh strip_pitch, and this file read_pitch; change one,
# change all six):
#   - "Normalised" means: a trailing \r stripped, then surrounding spaces and
#     tabs trimmed. A leading UTF-8 byte-order mark on line 1 is ignored.
#   - Line 1, normalised, is exactly `<!-- portfolio` (comment form) or `---`
#     (legacy frontmatter form). Otherwise: no pitch.
#   - The block closes on the first later line that, normalised, is exactly
#     `-->` (comment) or `---` (legacy).
#   - Every non-blank line inside must match `^[A-Za-z_][A-Za-z0-9_]*:`. In the
#     comment form, any inner line containing `-->` makes the block malformed.
#   - No closing line is malformed too. Here a malformed block is exit 2 for
#     that repo (UNKNOWN); the other repos are still checked.
#   - On a duplicated key the FIRST occurrence wins.
#
# NUMBER FORMATS. Figures are normalised before comparing: in French a space,
# U+00A0 or U+202F between digit groups of three is a thousands separator and
# a comma is the decimal mark; in English a comma between groups of three is
# a thousands separator. A range keeps both ends ("85,5 à 88,7" is 85.5 and
# 88.7). Spelled-out numbers are out of scope; they fall to the manual sweep.
#
# REGISTRY README FIRST LINE. Flagged: a first non-blank line of `---` (front
# matter shows as text). NOT flagged: a leading `<!-- portfolio` comment,
# because that is a finding only if the registry displays it. Measured
# 2026-11-12 for PyPI, with readme_renderer 46.0 (the library PyPI renders
# descriptions with), run locally on a README opening with a portfolio comment:
# the comment is stripped and the body renders, whereas a `---` block renders as
# a rule plus a heading of its own text. The live PyPI page was not fetched.
# npmjs.com answers 403 to curl, so npm's rendering is NOT measured: if it is
# ever measured and shows the comment, flag it here and have the fix be a
# `prepack` step that strips the block, never a hand edit.
#
# NOT SCHEDULED. No LaunchAgent: decide after a few manual runs whether the
# cadence is worth a plist. The network use is read-only GETs to the npm and
# PyPI registries.

set -uo pipefail

DEV_DIR="${DEV_DIR:-$HOME/Dev}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES="${CLAIMS_RULES:-$SELF_DIR/claims-watch.rules.json}"
RULE_TIMEOUT="${CLAIMS_RULE_TIMEOUT-20}"
CURL_TIMEOUT="${CLAIMS_CURL_TIMEOUT:-20}"
DIST_WATCH="${CLAIMS_DISTRIBUTION_WATCH:-$SELF_DIR/distribution-watch.sh}"

for arg in "$@"; do
  case "$arg" in
    *) echo "FATAL: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

case "$RULE_TIMEOUT" in
  ''|*[!0-9]*|0|0[0-9]*) echo "FATAL: CLAIMS_RULE_TIMEOUT must be a positive integer number of seconds, got: $RULE_TIMEOUT" >&2; exit 2 ;;
esac

for tool in jq perl curl awk grep sort; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: $tool not on PATH" >&2; exit 2; }
done
[ -d "$DEV_DIR" ] || { echo "FATAL: DEV_DIR is not a directory: $DEV_DIR" >&2; exit 2; }

W="$(mktemp -d)" || { echo "FATAL: mktemp failed" >&2; exit 2; }
trap 'rm -rf "$W"' EXIT

FINDINGS=0
UNKNOWN=0
N_DERIVED=0
N_LABEL=0
N_UNVERIFIED=0
N_PACKAGES_OK=0
# Repos whose pitch could not be scanned (malformed block, failed scan, no facts
# lines): their rules were never tested against a figure, so they are not stale.
UNSCANNED=" "

finding() { echo "FINDING  $1"; FINDINGS=$((FINDINGS + 1)); }
unknown() { echo "UNKNOWN  $1"; UNKNOWN=$((UNKNOWN + 1)); }
info()    { echo "INFO     $1"; }
note()    { echo "note     $1"; }

# --------------------------------------------------------------- rule table

# Textual refusal: only what the jail cannot stop cleanly, applied to the whole
# command before anything runs. Containment is the jail (see the header); this
# gives the obvious cases a clear exit 2. It looks at command position only, so
# an argument named source, open or git is never refused.
CP='(^|[|&;({!]|\$\()[[:space:]]*'
ALLOWED_GIT=' ls-files rev-list rev-parse cat-file ls-tree '
FIND_ACTION_RE='(^|[[:space:]])-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)([[:space:]]|$)'

refuse_reason() {
  local cmd="$1" flat sub rest
  local git_re='(^|[|&;({!]|\$\()[[:space:]]*git[[:space:]]+([^[:space:]|&;)]*)'
  case "$cmd" in
    *'`'*) echo "uses a backtick"; return ;;
  esac
  flat="$(printf '%s' "$cmd" | tr '\n' ';')"
  if printf '%s' "$flat" | grep -Eq "${CP}(kill|eval|source|\.|enable|command|builtin|trap|cd)([[:space:]|&;)]|\$)"; then
    echo "uses a shell builtin that is not allowed (kill eval source . enable command builtin trap cd)"; return
  fi
  if printf '%s' "$flat" | grep -Eq "${CP}find([[:space:]]|\$)" && printf '%s' "$flat" | grep -Eq "$FIND_ACTION_RE"; then
    echo "find would execute or write (-delete -exec -execdir -ok -okdir -fprint -fprintf -fls)"; return
  fi
  if printf '%s' "$flat" | grep -Eq "${CP}sort([[:space:]]|\$)" && printf '%s' "$flat" | grep -Eq '(^|[[:space:]])(-[A-Za-z]*o|--output|--compress-program)'; then
    echo "sort would write or execute (-o --output --compress-program)"; return
  fi
  if printf '%s' "$flat" | grep -Eq "${CP}git([[:space:]]|\$)"; then
    rest="$flat"
    while [[ $rest =~ $git_re ]]; do
      sub="${BASH_REMATCH[2]}"
      case "$ALLOWED_GIT" in
        *" $sub "*) ;;
        *) echo "uses git '$sub', which is not one of the read subcommands (ls-files rev-list rev-parse cat-file ls-tree)"; return ;;
      esac
      rest="${rest#*"${BASH_REMATCH[0]}"}"
    done
    if printf '%s' "$flat" | grep -Eq '(^|[[:space:]])--(exec-path|ext-diff|textconv|filters|output)'; then
      echo "git option that writes or executes"; return
    fi
  fi
}

# The jail: one private directory per run, holding exactly the allowed binaries.
# find, git, sort and uniq are symlinks to one guard script that checks its own
# arguments (after the shell expanded them) and then execs the real binary,
# which lives in a directory that is on no PATH.
build_jail() {
  local name real
  JAIL="$W/jail"; REAL="$W/real"
  mkdir -p "$JAIL" "$REAL" || return 1
  cat > "$W/guard.sh" <<GUARD
#!/bin/bash
tool="\${0##*/}"
deny() { echo "claims-watch: \$tool: \$1 is not allowed in a rule" >&2; exit 126; }
case "\$tool" in
  find)
    for a in "\$@"; do
      case "\$a" in -exec|-execdir|-ok|-okdir|-delete|-fprint|-fprint0|-fprintf|-fls) deny "\$a" ;; esac
    done ;;
  git)
    case "\${1:-}" in ls-files|rev-list|rev-parse|cat-file|ls-tree) ;; *) deny "git \${1:-}" ;; esac
    for a in "\$@"; do
      case "\$a" in --exec-path|--exec-path=*|--ext-diff|--textconv|--filters|--output|--output=*) deny "\$a" ;; esac
    done ;;
  sort)
    for a in "\$@"; do
      case "\$a" in --output|--output=*|--compress-program|--compress-program=*|-[A-Za-z]*o*) deny "\$a" ;; esac
    done ;;
  uniq)
    operands=0; skip=0
    for a in "\$@"; do
      if [ "\$skip" = 1 ]; then skip=0; continue; fi
      case "\$a" in -f|-s|-w|-n) skip=1 ;; -*) ;; *) operands=\$((operands + 1)) ;; esac
    done
    [ "\$operands" -le 1 ] || deny "an output operand" ;;
  *) deny "\$tool" ;;
esac
exec "$REAL/\$tool" "\$@"
GUARD
  chmod +x "$W/guard.sh"
  for name in jq grep find wc git cat head tail cut tr ls sort uniq expr test '[' printf echo; do
    real="$(type -P "$name" 2>/dev/null)" || continue
    case "$name" in
      find|git|sort|uniq) ln -s "$real" "$REAL/$name"; ln -s "$W/guard.sh" "$JAIL/$name" ;;
      *) ln -s "$real" "$JAIL/$name" ;;
    esac
  done
}

[ -f "$RULES" ] || { echo "FATAL: rule table not found: $RULES" >&2; exit 2; }
jq -e . "$RULES" >/dev/null 2>&1 || { echo "FATAL: rule table does not parse: $RULES" >&2; exit 2; }
jq -e '
  type == "object" and (.rules | type == "array") and (.rules | length > 0)
  and all(.rules[];
        type == "object"
        and (.repo | type == "string" and length > 0)
        and (.pattern | type == "string" and length > 0)
        and ((.kind // "") == "" or .kind == "label")
        and (if .kind == "label" then true else (.command | type == "string" and length > 0) end))
' "$RULES" >/dev/null 2>&1 \
  || { echo "FATAL: rule table is empty or malformed (need a non-empty \"rules\" array of {repo, pattern, command | kind:label}): $RULES" >&2; exit 2; }

N_RULES="$(jq '.rules | length' "$RULES")"
R_REPO=(); R_PAT=(); R_KIND=(); R_CMD=(); R_USED=(); R_DONE=(); R_VAL=()
i=0
while [ "$i" -lt "$N_RULES" ]; do
  R_REPO[i]="$(jq -r --argjson n "$i" '.rules[$n].repo' "$RULES")"
  R_PAT[i]="$(jq -r --argjson n "$i" '.rules[$n].pattern' "$RULES")"
  R_KIND[i]="$(jq -r --argjson n "$i" '.rules[$n].kind // ""' "$RULES")"
  R_CMD[i]="$(jq -r --argjson n "$i" '.rules[$n].command // ""' "$RULES")"
  R_USED[i]=0; R_DONE[i]=0; R_VAL[i]=""
  i=$((i + 1))
done

# The refusal runs over every rule before any rule executes.
refused=0
i=0
while [ "$i" -lt "$N_RULES" ]; do
  if [ -n "${R_CMD[i]}" ]; then
    why="$(refuse_reason "${R_CMD[i]}")"
    if [ -n "$why" ]; then
      echo "FATAL: rule $((i + 1)) (${R_REPO[i]}) refused: $why: ${R_CMD[i]}" >&2
      refused=1
    fi
  fi
  if ! perl -e 'qr/$ARGV[0]/' "${R_PAT[i]}" 2>/dev/null; then
    echo "FATAL: rule $((i + 1)) (${R_REPO[i]}) has a pattern that is not a valid regular expression: ${R_PAT[i]}" >&2
    refused=1
  fi
  i=$((i + 1))
done
[ "$refused" -eq 0 ] || exit 2

build_jail || { echo "FATAL: could not build the rule jail" >&2; exit 2; }

# ---------------------------------------------------------------- helpers

# Canonical text for a number: 85.50 and 85.5 compare equal.
canon() { awk -v v="$1" 'BEGIN { printf "%.10g", v + 0 }'; }

# Runs a rule's command once and caches its value in R_VAL. Sets RULE_OK=1
# when a value is available, 0 after counting an UNKNOWN.
run_rule() {
  local g="$1" repo_dir="$2" out err rc raw
  RULE_OK=0
  if [ "${R_DONE[g]}" = "1" ]; then
    [ -n "${R_VAL[g]}" ] && RULE_OK=1
    return
  fi
  R_DONE[g]=1
  out="$W/rule.$g.out"; err="$W/rule.$g.err"
  (
    cd "$repo_dir" || exit 127
    perl -e '
      my $limit = shift;
      my $pid = fork();
      if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127; }
      $SIG{ALRM} = sub { kill "KILL", -$pid; waitpid($pid, 0); exit 142; };
      alarm $limit;
      waitpid($pid, 0);
      exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
    ' "$RULE_TIMEOUT" /usr/bin/env -i PATH="$JAIL" HOME="$JAIL" LC_ALL="${LC_ALL:-}" LANG="${LANG:-}" \
      GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false \
      /bin/bash -r -c "enable -n command builtin kill eval source . trap enable; ${R_CMD[g]}"
  ) </dev/null >"$out" 2>"$err"
  rc=$?
  if [ "$rc" -eq 142 ]; then
    unknown "rule $((g + 1)) (${R_REPO[g]}): command timed out after ${RULE_TIMEOUT}s: ${R_CMD[g]}"; return
  fi
  if [ "$rc" -ne 0 ]; then
    unknown "rule $((g + 1)) (${R_REPO[g]}): command failed (exit $rc): ${R_CMD[g]}"; return
  fi
  # A stage the jail stopped can hide behind a later stage that succeeds
  # (`missing | wc -l` prints 0), so the shell's own complaints count too.
  if grep -Eq 'command not found|: restricted|claims-watch: [a-z]+: .* is not allowed' "$err"; then
    unknown "rule $((g + 1)) (${R_REPO[g]}): the jail stopped a command ($(grep -E 'command not found|: restricted|claims-watch: ' "$err" | head -1 | cut -c1-100)): ${R_CMD[g]}"; return
  fi
  raw="$(tr -d '[:space:]' < "$out")"
  if ! printf '%s' "$raw" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$'; then
    unknown "rule $((g + 1)) (${R_REPO[g]}): command did not print one number (${#raw} non-blank characters of output, not shown): ${R_CMD[g]}"; return
  fi
  R_VAL[g]="$(canon "$raw")"
  RULE_OK=1
}

# Pitch block parser: the shared rule. Writes the first facts_fr / facts_en to
# the two files given and prints one state line: ok | none | bad <reason>.
read_pitch() {
  LC_ALL=C awk -v frf="$2" -v enf="$3" '
    function norm(s) { sub(/\r$/, "", s); sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function unq(s) {
      if ((substr(s,1,1) == "\"" && substr(s,length(s),1) == "\"") ||
          (substr(s,1,1) == "'"'"'" && substr(s,length(s),1) == "'"'"'"))
        return substr(s, 2, length(s) - 2)
      return s
    }
    NR == 1 {
      if (substr($0, 1, 3) == "\357\273\277") $0 = substr($0, 4)
      first = norm($0)
      if (first == "---") closer = "---"
      else if (first == "<!-- portfolio") closer = "-->"
      else exit
      inblock = 1
      next
    }
    {
      line = $0; sub(/\r$/, "", line)
      if (norm(line) == closer) { closed = 1; exit }
      if (closer == "-->" && index(line, "-->") > 0) { bad = "`-->` inside the block"; exit }
      if (norm(line) == "") next
      if (line !~ /^[A-Za-z_][A-Za-z0-9_]*:/) { bad = "line is not a key: " line; exit }
      if (index(line, "facts_fr:") == 1 && !hasfr) {
        v = line; sub(/^[^:]*:[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v); fr = unq(v); hasfr = 1
      }
      if (index(line, "facts_en:") == 1 && !hasen) {
        v = line; sub(/^[^:]*:[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v); en = unq(v); hasen = 1
      }
    }
    END {
      if (!inblock) { print "none"; exit }
      if (!closed && bad == "") bad = "no closing line"
      if (bad != "") { print "bad " bad; exit }
      if (hasfr) print fr > frf
      if (hasen) print en > enf
      print "ok"
    }
  ' "$1"
}

# Scans one language line for figures and says which rule (if any) covers each.
# stdin: the facts line. args: lang, then the rule patterns in order.
# stdout: value<TAB>start<TAB>end<TAB>rule index or -1<TAB>context
FIGURES_PL='
use strict; use warnings; use utf8;
my ($lang, @pat) = @ARGV;
local $/; my $t = <STDIN>; $t =~ s/\n\z//;
my @caps;
for my $i (0 .. $#pat) {
  my $re = qr/$pat[$i]/;
  while ($t =~ /$re/g) {
    my ($s, $e) = defined $-[1] ? ($-[1], $+[1]) : ($-[0], $+[0]);
    push @caps, [$s, $e, $i];
  }
}
my $int = $lang eq "fr" ? qr/\d{1,3}(?:[ \x{A0}\x{202F}]\d{3}(?!\d))+|\d+/ : qr/\d{1,3}(?:,\d{3}(?!\d))+|\d+/;
my $dec = $lang eq "fr" ? qr/[,.]\d+/ : qr/\.\d+/;
while ($t =~ /(?<![\p{L}\p{N}_.,])($int)($dec)?/g) {
  my ($s, $e, $i, $d) = ($-[0], $+[0], $1, $2);
  $i =~ s/[ \x{A0}\x{202F},]//g;
  $d = defined $d ? $d : "";
  $d =~ s/,/./;
  my $v = sprintf("%.10g", $i . $d);
  my $idx = -1;
  for my $c (@caps) { if ($c->[0] < $e && $s < $c->[1]) { $idx = $c->[2]; last; } }
  my $from = $s > 22 ? $s - 22 : 0;
  my $ctx = substr($t, $from, ($s - $from) + ($e - $s) + 22);
  $ctx =~ s/[\t\n]/ /g;
  print join("\t", $v, $s, $e, $idx, $ctx), "\n";
}
'

# ---------------------------------------------------------- check 1: pitches

echo "== pitch figures =="
N_PITCH=0
for dir in "$DEV_DIR"/*/; do
  dir="${dir%/}"
  readme="$dir/README.md"
  [ -f "$readme" ] || continue
  repo="$(basename "$dir")"
  frf="$W/facts.fr.$repo"; enf="$W/facts.en.$repo"
  state="$(read_pitch "$readme" "$frf" "$enf")"
  case "$state" in
    none|"") continue ;;
    bad*) UNSCANNED="$UNSCANNED$repo "; unknown "$repo: malformed pitch block (${state#bad }); nothing in it was checked"; continue ;;
  esac
  N_PITCH=$((N_PITCH + 1))
  has_fr=0; has_en=0
  [ -f "$frf" ] && has_fr=1
  [ -f "$enf" ] && has_en=1
  if [ "$has_fr$has_en" = "00" ]; then UNSCANNED="$UNSCANNED$repo "; continue; fi
  [ "$has_fr" = "0" ] && finding "$repo: facts_en is present but facts_fr is missing"
  [ "$has_en" = "0" ] && finding "$repo: facts_fr is present but facts_en is missing"

  L2G=(); PATS=()
  g=0
  while [ "$g" -lt "$N_RULES" ]; do
    if [ "${R_REPO[g]}" = "$repo" ]; then
      L2G[${#PATS[@]}]="$g"
      PATS[${#PATS[@]}]="${R_PAT[g]}"
    fi
    g=$((g + 1))
  done

  for lang in fr en; do
    f="$W/facts.$lang.$repo"
    [ -f "$f" ] || continue
    cov="$W/cov.$lang.$repo"
    if ! perl -CSDA -e "$FIGURES_PL" "$lang" ${PATS[@]+"${PATS[@]}"} < "$f" > "$cov" 2>"$W/perl.err"; then
      unknown "$repo: could not scan facts_$lang ($(head -c 120 "$W/perl.err" | tr '\n' ' '))"
      case "$UNSCANNED" in *" $repo "*) ;; *) UNSCANNED="$UNSCANNED$repo " ;; esac
      continue
    fi
    while IFS=$'\t' read -r val _s _e li ctx; do
      if [ "$li" = "-1" ]; then
        finding "$repo: unverified figure $val in facts_$lang (\"…$ctx…\"): no rule derives it"
        N_UNVERIFIED=$((N_UNVERIFIED + 1))
        continue
      fi
      g="${L2G[li]}"
      R_USED[g]=1
      if [ "${R_KIND[g]}" = "label" ]; then
        N_LABEL=$((N_LABEL + 1))
        continue
      fi
      run_rule "$g" "$dir"
      [ "$RULE_OK" = "1" ] || continue
      if [ "${R_VAL[g]}" = "$val" ]; then
        N_DERIVED=$((N_DERIVED + 1))
      else
        finding "$repo: facts_$lang says $val but the repo gives ${R_VAL[g]} (\"…$ctx…\"; rule $((g + 1)): ${R_CMD[g]})"
      fi
    done < "$cov"
  done

  if [ "$has_fr" = "1" ] && [ "$has_en" = "1" ] && [ -f "$W/cov.fr.$repo" ] && [ -f "$W/cov.en.$repo" ]; then
    fr_list="$(cut -f1 "$W/cov.fr.$repo" | sort | tr '\n' ' ')"
    en_list="$(cut -f1 "$W/cov.en.$repo" | sort | tr '\n' ' ')"
    if [ "$fr_list" != "$en_list" ]; then
      finding "$repo: facts_fr and facts_en carry different figures (fr: ${fr_list:-none}; en: ${en_list:-none})"
    fi
  fi
done

if [ "$N_PITCH" -eq 0 ]; then
  unknown "no repo under $DEV_DIR has a pitch block: nothing was checked"
fi

g=0
while [ "$g" -lt "$N_RULES" ]; do
  if [ "${R_USED[g]}" != "1" ]; then
    case "$UNSCANNED" in *" ${R_REPO[g]} "*) g=$((g + 1)); continue ;; esac
    finding "rule $((g + 1)) (${R_REPO[g]}): its pattern matches no figure in that repo's pitch (stale rule, or the pitch changed): ${R_PAT[g]}"
  fi
  g=$((g + 1))
done

# -------------------------------------------------------- check 2: registries

echo "== registries =="
: > "$W/published.txt"

# Fetches a URL into $W/body. Sets HTTP_CODE. Returns 1 on a transport failure.
fetch() {
  : > "$W/body"
  HTTP_CODE="$(curl -s -o "$W/body" -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$1" 2>/dev/null)" || return 1
  return 0
}

# Compares versions and the README first line for one published package.
# args: label, repo version, registry version, registry first line, fix hint
compare_published() {
  local label="$1" repo_v="$2" reg_v="$3" first="$4" top
  if [ -z "$repo_v" ]; then
    info "$label: the repo does not declare a static version, version not compared"
  elif [ "$repo_v" = "$reg_v" ]; then
    :
  else
    top="$(printf '%s\n%s\n' "$repo_v" "$reg_v" | sort -V | tail -1)"
    if [ "$top" = "$repo_v" ]; then
      info "$label: the repo is ahead of the registry ($repo_v in the repo, $reg_v published); normal between releases"
    else
      finding "$label: the registry is ahead of the repo ($reg_v published, $repo_v in the repo)"
    fi
  fi
  if [ "$first" = "---" ]; then
    finding "$label: the registry README opens on '---', so its front matter shows as text; republish from a README without the pitch block (a prepack step that strips it keeps it from returning)"
  fi
  [ "$repo_v" = "$reg_v" ] && [ "$first" != "---" ] && N_PACKAGES_OK=$((N_PACKAGES_OK + 1))
}

first_line_filter='(. // "") | split("\n")
  | map(gsub("\r"; "") | gsub("^﻿"; "") | gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | .[0] // ""'

check_npm() {
  local repo="$1" name="$2" repo_v="$3" url reg_v first label="npm $2"
  url="https://registry.npmjs.org/$(printf '%s' "$name" | sed 's|/|%2f|g')"
  if ! fetch "$url"; then
    unknown "$label: registry unreachable or timed out"; return
  fi
  case "$HTTP_CODE" in
    200) ;;
    404) info "$label: not published here (HTTP 404); presence is distribution-watch's to report"; return ;;
    *) unknown "$label: registry answered HTTP $HTTP_CODE"; return ;;
  esac
  if ! jq -e 'type == "object" and ((.["dist-tags"].latest // "") != "")' "$W/body" >/dev/null 2>&1; then
    unknown "$label: the registry body does not parse or names no latest version"; return
  fi
  if ! jq -e --arg repo "$repo" '
      [ (.repository | if type == "object" then .url else . end), .homepage, (.bugs | if type == "object" then .url else . end) ]
      | map(select(type == "string"))
      | any(test("github\\.com[/:]{github-username}/" + $repo + "(\\.git)?([/#?]|$)"; "i"))' "$W/body" >/dev/null 2>&1; then
    info "$label: the registry package of that name names another repository; not ours, not compared"; return
  fi
  echo "npm $name" >> "$W/published.txt"
  reg_v="$(jq -r '.["dist-tags"].latest' "$W/body")"
  first="$(jq -r ".readme | $first_line_filter" "$W/body")"
  compare_published "$label" "$repo_v" "$reg_v" "$first"
}

check_pypi() {
  local repo="$1" name="$2" repo_v="$3" reg_v first label="PyPI $2"
  if ! fetch "https://pypi.org/pypi/$name/json"; then
    unknown "$label: registry unreachable or timed out"; return
  fi
  case "$HTTP_CODE" in
    200) ;;
    404) info "$label: not published here (HTTP 404); presence is distribution-watch's to report"; return ;;
    *) unknown "$label: registry answered HTTP $HTTP_CODE"; return ;;
  esac
  if ! jq -e 'type == "object" and ((.info.version // "") != "")' "$W/body" >/dev/null 2>&1; then
    unknown "$label: the registry body does not parse or names no version"; return
  fi
  if ! jq -e --arg repo "$repo" '
      [ .info.home_page, (.info.project_urls // {} | to_entries[] | .value) ]
      | map(select(type == "string"))
      | any(test("github\\.com[/:]{github-username}/" + $repo + "(\\.git)?([/#?]|$)"; "i"))' "$W/body" >/dev/null 2>&1; then
    info "$label: the registry package of that name names another repository; not ours, not compared"; return
  fi
  echo "pypi $name" >> "$W/published.txt"
  reg_v="$(jq -r '.info.version' "$W/body")"
  first="$(jq -r ".info.description | $first_line_filter" "$W/body")"
  compare_published "$label" "$repo_v" "$reg_v" "$first"
}

# A string value of a key in the [project] table; TOML allows double or single quotes.
toml_project_string() {
  awk -v key="$1" '
    /^\[project\]/ { p = 1; next }
    /^\[/ { p = 0 }
    p && $0 ~ "^" key "[ \t]*=" {
      v = $0; sub(/^[^=]*=[ \t]*/, "", v)
      q = substr(v, 1, 1)
      if (q != "\"" && q != "\047") exit
      v = substr(v, 2); i = index(v, q)
      if (i == 0) exit
      print substr(v, 1, i - 1); exit
    }' "$2"
}

for dir in "$DEV_DIR"/*/; do
  dir="${dir%/}"
  repo="$(basename "$dir")"

  if [ -f "$dir/package.json" ]; then
    if ! jq -e . "$dir/package.json" >/dev/null 2>&1; then
      unknown "$repo: package.json does not parse"
    elif jq -e '(.private != true) and (.name | type == "string")' "$dir/package.json" >/dev/null 2>&1; then
      check_npm "$repo" "$(jq -r '.name' "$dir/package.json")" "$(jq -r '.version // ""' "$dir/package.json")"
    fi
  fi

  if [ -f "$dir/pyproject.toml" ] && [ -d "$dir/.github/workflows" ] \
     && grep -Eqs 'pypi-publish|twine upload|uv publish|poetry publish|flit publish' "$dir"/.github/workflows/*; then
    py_name="$(toml_project_string name "$dir/pyproject.toml")"
    py_ver="$(toml_project_string version "$dir/pyproject.toml")"
    if [ -z "$py_name" ]; then
      unknown "$repo: pyproject.toml has a publish workflow but no [project] name"
    else
      check_pypi "$repo" "$py_name" "$py_ver"
    fi
  fi
done

# Cross-read of distribution-watch's hand list: notes only, never findings.
if [ -f "$DIST_WATCH" ]; then
  {
    grep -oE '^check_npm [A-Za-z0-9@._/-]+' "$DIST_WATCH" | awk '{ print "npm " $2 }'
    grep -oE 'pypi\.org/pypi/[A-Za-z0-9._-]+/json' "$DIST_WATCH" | sed -E 's|pypi\.org/pypi/||; s|/json$||; s|^|pypi |'
  } | sort -u > "$W/dw.txt"
  sort -u "$W/published.txt" > "$W/pub.txt"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    note "$entry is published from a repo here but is not in distribution-watch's list; tell the owner (that list is not edited from here)"
  done < <(comm -23 "$W/pub.txt" "$W/dw.txt")
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    note "distribution-watch lists $entry but no published package of that name was found here"
  done < <(comm -13 "$W/pub.txt" "$W/dw.txt")
fi

# ------------------------------------------------------------------ summary

echo
echo "pitch figures: $N_DERIVED derived, $N_LABEL label (exempt), $N_UNVERIFIED unverified; published packages in step: $N_PACKAGES_OK; $FINDINGS finding(s), $UNKNOWN unknown."
[ "$UNKNOWN" -eq 0 ] || exit 2
[ "$FINDINGS" -eq 0 ] || exit 1
exit 0
