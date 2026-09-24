#!/bin/bash
# hook.sh — PreToolUse hook (Bash matcher)
# Blocking build gate: runs `npm run build` only when the command contains
# `git push`, and blocks the push on build failure or compiler warnings.
# D11 (2026-09-24) extended this to every tracked nested package.json, not
# just the repo root — see the per-section comments below.

input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

# Pure-shell pre-filter: skip any interpreter spawn entirely for the common
# case of a command that doesn't mention git at all.
case "$input" in
  *git*) ;;
  *) exit 0 ;;
esac

# `jq`, not an interpreter: a field lookup needs no interpreter at all, and
# this has to happen before the push match below regardless.
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Match the push BEFORE resolving anything else, uv-managed Python included.
# `uv python find` is cheap (~7ms) but not free, and a command that merely
# mentions git without pushing — `git status`, `git log` — should cost this
# hook nothing beyond the shell prefilter and one jq call above it.
echo "$cmd" | grep -qE "git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push" || exit 0

# ---------------------------------------------------------------- Python (uv)
# Resolved ONCE, here, and only after the command is confirmed to be a push.
#
# Why this hook keeps Python at all, when auto-format dropped it for jq:
# `env_prefix_enabled` below has to split a command on shell separators and
# test that every word of the final segment is a NAME=VALUE assignment. Its own
# comment records why line-oriented tools cannot express that rule, and getting
# it wrong silently converts a blocked push into an accepted one. That needs a
# real language; a field lookup did not.
#
# Why an explicit interpreter path and NOT `uv run --script`: the exit code of
# whatever launches payload_gate.py is load-bearing. This file already records
# that CPython's own "can't open file" status is 2 — byte-identical to the
# gate's block verdict — which is why $GATE is checked with -r up front. A `uv
# run` launcher puts uv's own failure codes into that same channel, where 2
# means BLOCK THE PUSH and 3 means warn. An interpreter path cannot do that.
#
# Failure here is NON-blocking (exit 1), matching this hook's stated doctrine:
# fail closed on the guard's verdict, open on the guard's own malfunction. A
# missing interpreter is the guard malfunctioning, not a bad push. Exit 1 is
# also the only non-blocking code whose stderr the owner actually sees — see
# the surfacing note further down — so it degrades loudly rather than silently.
resolve_uv_python() {
  local candidate
  if command -v uv >/dev/null 2>&1; then
    candidate="$(UV_PYTHON_PREFERENCE=only-managed uv python find 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  fi
  # Sorted on the MINOR field numerically: a lexical sort puts 3.9 above 3.12.
  candidate="$(printf '%s\n' "$HOME"/.local/bin/python3.* 2>/dev/null \
               | grep -E '/python3\.[0-9]+$' | sort -t. -k2,2n | tail -1)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  return 1
}
PYTHON="$(resolve_uv_python || true)"
if [ -z "$PYTHON" ]; then
  echo "push-build-gate: no uv-managed Python found — build/payload gate SKIPPED, this push was NOT checked" >&2
  exit 1
fi

# ---------------------------------------------------------------- Repo resolution
# Shared with stale-readme-guard/hook.sh. Fail loudly (exit 1, non-blocking —
# see the surfacing note further down) rather than silently if the sibling
# lib is missing: a `source` on a nonexistent file only prints to stderr and
# falls through, which at exit 0 is a debug-log-only message nobody sees.
LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/resolve-repo.sh"
if [ ! -r "$LIB" ]; then
  echo "push-build-gate: cannot load $LIB — push NOT GATED" >&2
  exit 1
fi
# shellcheck source=../lib/resolve-repo.sh
source "$LIB"

dir=$(resolve_repo_dir "$cmd" "$input")

# `resolve_repo_dir` deliberately does not resolve or validate a repo — this
# is where that happens, and where a directory that isn't a git repo at all
# becomes a no-op rather than a guess. Before this check existed, a `git
# push` (or any command merely mentioning it) run from a non-repo directory
# holding several child repos triggered a build of every one of them —
# reproduced live on 2026-09-24 (see hooks/lib/resolve-repo.sh's history).
dir=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0

# Accept opt-out: `PAYLOAD_GATE_ACCEPT=1 git push`.
# A PreToolUse hook receives the command as a JSON *string* and never executes
# it, so an env prefix on that command never reaches this process — the accept
# path payload_gate.py documents is unreachable unless we read the assignment
# out of the command text ourselves. A genuinely exported value is still
# honoured: this only ever sets the variable, never clears it.
#
# The rule is shell semantics for an environment prefix, and nothing looser: the
# assignment must sit in the SAME SIMPLE COMMAND as the push — the text between
# the last separator (&& || ; | newline) preceding the `git ... push` construct
# and the `git` token — and that text must consist only of NAME=VALUE words,
# since an assignment after a command word is an argument, not a prefix. Line-
# oriented tools cannot express that: `grep`/`sed` scan per line, so a mention
# on any other line of a multi-line command leaks through and silently converts
# a block into an accept. Collapsing to one line does not fix it either — it
# just moves `echo PAYLOAD_GATE_ACCEPT=1` in front of the push.
#
# Parameterised because two stages need it now: PAYLOAD_GATE_ACCEPT here and
# TEST_GATE_SKIP further down. One implementation means the looser rule can
# never drift back in through the second caller.
env_prefix_enabled() {
  printf '%s' "$cmd" | "$PYTHON" -c '
import re, sys
wanted = sys.argv[1]
cmd = sys.stdin.read()
m = re.search(r"git(?:\s+-C\s+\S+)?\s+push", cmd)
segment = re.split(r"&&|\|\||;|\||\n", cmd[:m.start()])[-1] if m else ""
words = segment.split()
if words and all(re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w) for w in words):
    for word in words:
        name, _, value = word.partition("=")
        if (name == wanted
                and value.strip("\"" + chr(39)).lower() in ("1", "true")):
            sys.exit(0)
sys.exit(1)' "$1" 2>/dev/null
}

if env_prefix_enabled PAYLOAD_GATE_ACCEPT; then
  export PAYLOAD_GATE_ACCEPT=1
fi

# ---------------------------------------------------------------- Packages
# D11: gate every TRACKED nested manifest with a build or test script, not
# just the repo root. Until this task the hook only ever looked at
# $dir/package.json, so a nested app — `client/`, `app/`, `wasm-pkg/` —
# shipped completely ungated.
#
# `git ls-files`, not `find`: it only ever lists what git already tracks (or
# has staged), so gitignored build output — `.next/package.json`,
# `.netlify/plugins/package.json` — is never a candidate in the first place.
# A `find`-based first pass on this same task scanned the filesystem directly
# and reported every Next.js repo's own `.next/package.json` as an ungated
# nested package, permanently disabling that repo's payload gate (fixed in
# review round 1).
#
# The pathspecs need `:(glob)` magic, or the depth bound is fiction: in git's
# DEFAULT pathspec dialect, `*` also matches `/` — so a bare `*/package.json`
# matches `client/package.json` (depth 1) but ALSO `d/e/f/g/package.json`
# (depth 4) and a tracked `node_modules/x/package.json`, silently reaching
# past the "excluding node_modules" requirement and any depth bound at all
# (review round 2 caught this by probing `ls-files` directly: the bare form
# returned a depth-4 fixture path and a tracked node_modules path in the same
# list). `:(glob)` switches `*` back to shell-glob semantics — one directory
# level per pattern, `/` never matched — and `:(exclude,glob)**/node_modules/**`
# drops anything under node_modules regardless of depth, covering the rare
# repo that vendors and tracks it. One directory level (`:(glob)*/package.json`,
# e.g. `client/package.json`) and two (`:(glob)*/*/package.json`, e.g.
# `packages/foo/package.json`) — deep enough for a monorepo layout, shallow
# enough to stay a repo-shape scan. The bare `package.json` pathspec is
# deliberately absent: the root manifest is added once, below, directly —
# neither glob pattern can match it (no `/` in "package.json"), so the root
# is never double-counted.
#
# `-c core.quotePath=false`: at git's default, a path with a non-ASCII byte is
# printed C-quoted — `café/package.json` comes back as `"caf\303\251/package.json"`,
# quotes included — so `dirname` named a directory that does not exist, both
# scripts read back empty, and a failing nested build was reported as "no
# build/test script" (exit 1) instead of blocking.
declare -a PKG_DIRS=()
[ -f "$dir/package.json" ] && PKG_DIRS+=("$dir")
while IFS= read -r manifest; do
  [ -n "$manifest" ] && PKG_DIRS+=("$dir/$(dirname "$manifest")")
done < <(git -C "$dir" -c core.quotePath=false ls-files -- ':(glob)*/package.json' ':(glob)*/*/package.json' ':(exclude,glob)**/node_modules/**' 2>/dev/null)

# No package.json anywhere in the shape this hook understands — nothing to gate.
[ ${#PKG_DIRS[@]} -eq 0 ] && exit 0

# ONE global deadline, covering the root's build AND test AND every nested
# package's build/test — not a fresh budget per stage. There's no `timeout`
# binary on macOS, and this hook itself has a 180s external ceiling
# (settings.json): a hook killed by that ceiling is a non-blocking error to
# Claude Code, so the push would go through with NO VERDICT AT ALL — worse
# than any answer this hook could give on its own. The default leaves
# comfortable headroom under 180s for the payload-gate stage that runs after
# every package here has finished. Overridable so the test suite can force a
# tiny deadline without actually waiting out the default.
GATE_DEADLINE=${PUSH_GATE_DEADLINE:-150}
GATE_START=$(date +%s)

# run_deadline <workdir> <shell command>
# Runs `<shell command>` in `<workdir>`, bounded by whatever time is LEFT on
# the global deadline — not a fresh budget per call, which is what makes the
# deadline shared. Reuses the `set -m` background + poll-and-kill pattern
# this hook has used for its test stage since before D11.
#
# Sets DEADLINE_LOG (combined stdout/stderr, caller's job to read and rm) and
# DEADLINE_TIMED_OUT (1 on timeout, 0 otherwise) rather than overloading the
# return code with a sentinel: 124 looks exactly like a real script exiting
# 124 on its own (`exit 124`), which a first draft of this reported as a
# timeout instead of a failure — a flag the caller checks first removes the
# collision.
run_deadline() {
  local workdir="$1" runcmd="$2" now remaining ticks tick_deadline pid
  DEADLINE_LOG=$(mktemp)
  DEADLINE_TIMED_OUT=0

  now=$(date +%s)
  remaining=$((GATE_DEADLINE - (now - GATE_START)))
  if [ "$remaining" -le 0 ]; then
    DEADLINE_TIMED_OUT=1
    return 1
  fi

  # `set -m` puts the background job in its own process group, so the timeout
  # path can signal the whole group. Without it the job shares this shell's
  # group and a killed runner leaves its children orphaned and still running.
  set -m
  ( cd "$workdir" && eval "$runcmd" ) >"$DEADLINE_LOG" 2>&1 &
  pid=$!
  set +m

  # Poll in fifths of a second: a 1 s granularity would add up to a full second
  # to every push, and the hub's whole suite finishes in 1.2 s.
  ticks=0
  tick_deadline=$((remaining * 5))
  while kill -0 "$pid" 2>/dev/null && [ "$ticks" -lt "$tick_deadline" ]; do
    sleep 0.2
    ticks=$((ticks + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 0.5
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    DEADLINE_TIMED_OUT=1
    return 1
  fi

  wait "$pid"
  return $?
}

ROOT_BUILD_CMD=""
ROOT_OUTPUT=""
NOT_GATED=0
NOT_GATED_MSGS=""

# flush_not_gated
# Prints any accumulated NOT-GATED advisories, deliberately AFTER whatever
# message the caller already printed for the exit actually in progress. A
# NOT-GATED line is informational and often permanent for a given repo (a
# scriptless nested package doesn't grow scripts on its own — see the
# my-boardgame-app note below), while a build/test failure or a payload-gate warning
# is the reason THIS push is stopping or being flagged. Since only the FIRST
# stderr line survives to a non-blocking exit's surfaced notice, the more
# actionable message has to be first; NOT-GATED goes second everywhere,
# still fully present in the buffered stderr for anyone reading the whole
# thing (always true on a block, exit 2).
flush_not_gated() {
  [ -n "$NOT_GATED_MSGS" ] && printf '%s' "$NOT_GATED_MSGS" >&2
}

for pkgdir in "${PKG_DIRS[@]}"; do
  if [ "$pkgdir" = "$dir" ]; then
    label="$dir"
  else
    label="${pkgdir#"$dir"/}"
  fi

  BUILD_CMD=$(node -e "const p=require('$pkgdir/package.json'); console.log(p.scripts && p.scripts.build || '')" 2>/dev/null)
  TEST_CMD=$(node -e "const p=require('$pkgdir/package.json'); console.log(p.scripts && p.scripts.test || '')" 2>/dev/null)

  # npm scaffolds a `test` script that only fails. Gating on it would block
  # every push in a package that has simply never written a test.
  case "$TEST_CMD" in
    *'no test specified'*) TEST_CMD='' ;;
  esac

  if [ -z "$BUILD_CMD" ] && [ -z "$TEST_CMD" ]; then
    # Plan Review Focus #1: a guard must never report green without checking
    # anything. A nested package with neither script would otherwise ship
    # silently ungated exactly like the root did before D11 — say so out
    # loud. This is a non-blocking advisory (exit 1 at the very end, after
    # the payload gate has had its chance to run and block) — a warning
    # about an untested package must never suppress the one check that
    # actually catches something. The root itself keeps its old, silent
    # behaviour: a repo with no build/test at all was never this hook's
    # business, and warning about the root on every push in every untested
    # repo would be noise, not a finding.
    if [ "$pkgdir" != "$dir" ]; then
      NOT_GATED_MSGS="${NOT_GATED_MSGS}push-build-gate: nested $label NOT GATED (no build/test script)
"
      NOT_GATED=1
    fi
    continue
  fi

  # A nested package that declares dependencies but has none installed — no
  # node_modules in its own dir, none hoisted at the repo root — cannot be
  # built HERE, whatever its code says: `vite: command not found` (exit 127) or
  # `tsc -b` failing on missing types is the guard's environment, not a build
  # verdict. Blocking on it would stop every push from my-boardgame-app (app/) and
  # my-art-tool (editor/), whose nested apps have never had `npm install` run.
  # Fail open on the guard's own malfunction, loudly: NOT GATED, exit 1. The
  # root is exempt, as for the no-scripts case above: a root that was never
  # installed fails the same way it always has.
  if [ "$pkgdir" != "$dir" ] \
     && [ ! -d "$pkgdir/node_modules" ] && [ ! -d "$dir/node_modules" ]; then
    DEP_COUNT=$(node -e "const p=require('$pkgdir/package.json'); console.log(Object.keys(Object.assign({}, p.dependencies, p.devDependencies)).length)" 2>/dev/null)
    if [ "${DEP_COUNT:-0}" -gt 0 ] 2>/dev/null; then
      NOT_GATED_MSGS="${NOT_GATED_MSGS}push-build-gate: nested $label NOT GATED (dependencies not installed)
"
      NOT_GATED=1
      continue
    fi
  fi

  # The build is conditional rather than mandatory. Until 2026-08-05 a missing
  # `build` script exited the whole gate at this point, so a repo with tests
  # and no build — `elenchus-proxy` is exactly that shape — was never gated on
  # anything.
  OUTPUT=""
  if [ -n "$BUILD_CMD" ]; then
    run_deadline "$pkgdir" "npm run build --if-present"
    EXIT_CODE=$?
    OUTPUT=$(cat "$DEADLINE_LOG" 2>/dev/null)
    rm -f "$DEADLINE_LOG"

    if [ "$DEADLINE_TIMED_OUT" -eq 1 ]; then
      echo "push-build-gate: $label build TIMED OUT, push allowed" >&2
      flush_not_gated
      exit 1
    fi

    if [ "$EXIT_CODE" -ne 0 ]; then
      echo "push-build-gate: build FAILED in $label (exit $EXIT_CODE)" >&2
      echo "$OUTPUT" >&2
      flush_not_gated
      exit 2
    fi

    # Compiler-style warning counts only — avoid matching "0 warnings"/"no warnings".
    WARNING_LINES=$(echo "$OUTPUT" | grep -E "[1-9][0-9]* warning")
    if [ -n "$WARNING_LINES" ]; then
      echo "push-build-gate: build succeeded in $label but found warnings (zero-warning policy):" >&2
      echo "$WARNING_LINES" >&2
      flush_not_gated
      exit 2
    fi
  fi

  if [ "$pkgdir" = "$dir" ]; then
    ROOT_BUILD_CMD="$BUILD_CMD"
    ROOT_OUTPUT="$OUTPUT"
  fi

  # Test stage. A green build is not a green repo: `c8540ca` reached origin/main
  # with two failing `projects.test.ts` assertions while `npm run check` and
  # `npm run build` were both clean and this hook passed. Running the suite is
  # what closes that gap; it sits before the payload gate so a red suite blocks
  # without paying for payload analysis first.
  #
  # `CI=1` defends the next repo, not the current ones: every portfolio `test`
  # script today is `vitest run` or `node --test`, but a bare `vitest` would
  # enter watch mode and wedge the push until the deadline killed it.
  #
  # Blocking policy is the payload gate's, for the same reason: fail CLOSED on
  # the gate's intended verdict (a red suite, exit 2) and OPEN on the gate's own
  # malfunction (a suite that never finishes, exit 1). A guard that wedges every
  # push on infrastructure trouble gets switched off, and a switched-off guard
  # catches nothing.
  if [ -n "$TEST_CMD" ] \
     && ! env_prefix_enabled TEST_GATE_SKIP \
     && [ "${TEST_GATE_SKIP:-}" != "1" ]; then
    run_deadline "$pkgdir" "CI=1 npm test"
    TEST_EXIT=$?
    TEST_OUTPUT=$(cat "$DEADLINE_LOG" 2>/dev/null)
    rm -f "$DEADLINE_LOG"

    if [ "$DEADLINE_TIMED_OUT" -eq 1 ]; then
      echo "push-build-gate: $label tests TIMED OUT, push allowed" >&2
      flush_not_gated
      exit 1
    fi

    if [ "$TEST_EXIT" -ne 0 ]; then
      echo "push-build-gate: tests FAILED in $label (exit $TEST_EXIT)" >&2
      echo "$TEST_OUTPUT" >&2
      flush_not_gated
      exit 2
    fi
  fi
done

BUILD_CMD="$ROOT_BUILD_CMD"
OUTPUT="$ROOT_OUTPUT"

# No build ran at the root, so there is no build output for the payload gate
# to analyse. Nested packages never reach the payload gate — it analyses the
# root app's own render/bundle output, not a nested package's.
if [ -z "$BUILD_CMD" ]; then
  if [ "$NOT_GATED" -eq 1 ]; then
    flush_not_gated
    exit 1
  fi
  exit 0
fi

# Payload gate: render-mode flips block, payload growth warns.
# Reuses the build output already captured above — no second build.
# Fail OPEN on the gate's own malfunction (missing script, unreadable file,
# Python crash) and fail CLOSED only on the gate's intended block code (2).
# `-r` (not just `-f`) is required: CPython's own "can't open file" exit
# code for an unreadable script is ALSO 2 — byte-identical to the intended
# block code payload_gate.py returns from main(). Checking readability
# up front means an unreadable script never reaches python3 at all, so
# GATE_EXIT's "2" is only ever the gate's own verdict, never a launch
# failure wearing the same exit code.
#
# This runs UNCONDITIONALLY, even when a nested package was NOT GATED above —
# block beats a warning. Before this fix, an untested nested package's
# advisory exited the whole hook before the payload gate ever ran, silently
# disarming the one check that actually catches a Next.js render-mode flip
# (fixed in review round 1).
#
# Exit codes here are a surfacing decision, not just a status. For a PreToolUse
# hook, exit 0 stderr has NO surfacing path — debug log only, never shown to
# the owner and never fed to the model. Only exit 2 (blocking, stderr fed back
# in full) and non-zero-non-2 (NON-blocking, transcript shows a hook-error
# notice carrying the FIRST line of stderr) are visible. So every advisory
# message below exits 1: the tool call still proceeds, and the message is
# actually readable. Warnings must never exit 2 — that would block the push.
# Because only the first stderr line survives, the gate's own output is
# buffered and replayed in order, with a self-contained summary first.
GATE="$(dirname "${BASH_SOURCE[0]}")/payload_gate.py"
if [ -f "$GATE" ] && [ -r "$GATE" ]; then
  TMP_OUT=$(mktemp)
  TMP_ERR=$(mktemp)
  printf '%s' "$OUTPUT" > "$TMP_OUT"
  "$PYTHON" "$GATE" "$dir" "$TMP_OUT" 2>"$TMP_ERR"
  GATE_EXIT=$?
  rm -f "$TMP_OUT"
  if [ $GATE_EXIT -eq 2 ]; then
    cat "$TMP_ERR" >&2
    rm -f "$TMP_ERR"
    flush_not_gated
    exit 2
  elif [ $GATE_EXIT -eq 3 ]; then
    # Payload warnings, no flip. payload_gate.py already led with its summary
    # — that goes first (see flush_not_gated's own comment on why a payload
    # warning outranks a NOT-GATED advisory for the one surfaced line).
    cat "$TMP_ERR" >&2
    rm -f "$TMP_ERR"
    flush_not_gated
    exit 1
  elif [ $GATE_EXIT -ne 0 ]; then
    # Malfunction. Our line goes first because a Python traceback would
    # otherwise take the single surfaced line and say nothing about the guard.
    echo "payload-gate: guard SKIPPED — gate malfunctioned (exit $GATE_EXIT), push allowed" >&2
    cat "$TMP_ERR" >&2
    rm -f "$TMP_ERR"
    flush_not_gated
    exit 1
  fi
  cat "$TMP_ERR" >&2
  rm -f "$TMP_ERR"
  if [ "$NOT_GATED" -eq 1 ]; then
    flush_not_gated
    exit 1
  fi
else
  echo "payload-gate: guard SKIPPED — $GATE missing or unreadable, push allowed" >&2
  flush_not_gated
  exit 1
fi

exit 0
