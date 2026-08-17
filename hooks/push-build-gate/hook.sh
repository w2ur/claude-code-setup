#!/bin/bash
# hook.sh — PreToolUse hook (Bash matcher)
# Blocking build gate: runs `npm run build` only when the command contains
# `git push`, and blocks the push on build failure or compiler warnings.

input=$(cat 2>/dev/null || echo "")
[ -z "$input" ] && exit 0

# Pure-shell pre-filter: skip the interpreter spawn entirely for the common
# case of a command that doesn't mention git at all.
case "$input" in
  *git*) ;;
  *) exit 0 ;;
esac

# ---------------------------------------------------------------- Python (uv)
# Resolved ONCE, here, and deliberately *after* the pre-filter above so a
# command that never mentions git still costs nothing.
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

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

echo "$cmd" | grep -qE "git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push" || exit 0

# Resolve target repo, in priority order:
#   1. `git -C <path> push`   — the form that bypassed this gate until 2026-08-03
#   2. leading `cd <path> &&` — at PreToolUse time the cd hasn't executed yet
#   3. stdin cwd
dir=$(echo "$cmd" | sed -E -n 's/.*git[[:space:]]+-C[[:space:]]+([^[:space:]]+).*/\1/p' | head -1 | sed -E -e "s/^['\"]//" -e "s/['\"]\$//")
if [ -z "$dir" ]; then
  dir=$(echo "$cmd" | sed -E -n 's/^[[:space:]]*cd[[:space:]]+([^&]*)&&.*/\1/p' | sed -E -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]\$//")
fi
dir="${dir/#\~/$HOME}"
if [ -z "$dir" ]; then
  dir=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -z "$dir" ] && dir="$PWD"

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

[ -f "$dir/package.json" ] || exit 0

BUILD_CMD=$(node -e "const p=require('$dir/package.json'); console.log(p.scripts && p.scripts.build || '')" 2>/dev/null)
TEST_CMD=$(node -e "const p=require('$dir/package.json'); console.log(p.scripts && p.scripts.test || '')" 2>/dev/null)

# npm scaffolds a `test` script that only fails. Gating on it would block every
# push in a repo that has simply never written a test.
case "$TEST_CMD" in
  *'no test specified'*) TEST_CMD='' ;;
esac

# Nothing to gate on at all.
[ -z "$BUILD_CMD" ] && [ -z "$TEST_CMD" ] && exit 0

# The build is now conditional rather than mandatory. Until 2026-08-05 a missing
# `build` script exited the whole gate at this point, so a repo with tests and no
# build — `my-socratic-app-proxy` is exactly that shape — was never gated on anything.
OUTPUT=""
if [ -n "$BUILD_CMD" ]; then
  OUTPUT=$(cd "$dir" && npm run build --if-present 2>&1)
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "push-build-gate: build FAILED in $dir (exit $EXIT_CODE)" >&2
    echo "$OUTPUT" >&2
    exit 2
  fi

  # Compiler-style warning counts only — avoid matching "0 warnings"/"no warnings".
  WARNING_LINES=$(echo "$OUTPUT" | grep -E "[1-9][0-9]* warning")
  if [ -n "$WARNING_LINES" ]; then
    echo "push-build-gate: build succeeded in $dir but found warnings (zero-warning policy):" >&2
    echo "$WARNING_LINES" >&2
    exit 2
  fi
fi

# Test stage. A green build is not a green repo: `c8540ca` reached origin/main
# with two failing `projects.test.ts` assertions while `npm run check` and
# `npm run build` were both clean and this hook passed. Running the suite is what
# closes that gap; it sits before the payload gate so a red suite blocks without
# paying for payload analysis first.
#
# `CI=1` defends the next repo, not the current ones: every portfolio `test`
# script today is `vitest run` or `node --test`, but a bare `vitest` would enter
# watch mode and wedge the push until the hook's own 180 s ceiling killed it.
#
# Blocking policy is the payload gate's, for the same reason: fail CLOSED on the
# gate's intended verdict (a red suite, exit 2) and OPEN on the gate's own
# malfunction (a suite that never finishes, exit 1). A guard that wedges every
# push on infrastructure trouble gets switched off, and a switched-off guard
# catches nothing.
if [ -n "$TEST_CMD" ] \
   && ! env_prefix_enabled TEST_GATE_SKIP \
   && [ "${TEST_GATE_SKIP:-}" != "1" ]; then
  TEST_TIMEOUT=${PUSH_GATE_TEST_TIMEOUT:-90}
  TEST_LOG=$(mktemp)

  # `set -m` puts the background job in its own process group, so the timeout
  # path can signal the whole group. Without it the job shares this shell's
  # group and a killed runner leaves its children orphaned and still running.
  set -m
  ( cd "$dir" && CI=1 npm test ) >"$TEST_LOG" 2>&1 &
  TEST_PID=$!
  set +m

  # Poll in fifths of a second: a 1 s granularity would add up to a full second
  # to every push, and the hub's whole suite finishes in 1.2 s.
  TICKS=0
  DEADLINE=$((TEST_TIMEOUT * 5))
  while kill -0 "$TEST_PID" 2>/dev/null && [ "$TICKS" -lt "$DEADLINE" ]; do
    sleep 0.2
    TICKS=$((TICKS + 1))
  done

  if kill -0 "$TEST_PID" 2>/dev/null; then
    kill -TERM -"$TEST_PID" 2>/dev/null || kill -TERM "$TEST_PID" 2>/dev/null
    sleep 0.5
    kill -KILL -"$TEST_PID" 2>/dev/null || kill -KILL "$TEST_PID" 2>/dev/null
    wait "$TEST_PID" 2>/dev/null
    rm -f "$TEST_LOG"
    # Non-blocking, so only this FIRST line is surfaced — it has to stand alone.
    echo "push-build-gate: tests SKIPPED — suite exceeded ${TEST_TIMEOUT}s in $dir, push allowed" >&2
    exit 1
  fi

  wait "$TEST_PID"
  TEST_EXIT=$?
  if [ $TEST_EXIT -ne 0 ]; then
    echo "push-build-gate: tests FAILED in $dir (exit $TEST_EXIT)" >&2
    cat "$TEST_LOG" >&2
    rm -f "$TEST_LOG"
    exit 2
  fi
  rm -f "$TEST_LOG"
fi

# No build ran, so there is no build output for the payload gate to analyse.
[ -z "$BUILD_CMD" ] && exit 0

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
    exit 2
  elif [ $GATE_EXIT -eq 3 ]; then
    # Payload warnings, no flip. payload_gate.py already led with its summary.
    cat "$TMP_ERR" >&2
    rm -f "$TMP_ERR"
    exit 1
  elif [ $GATE_EXIT -ne 0 ]; then
    # Malfunction. Our line goes first because a Python traceback would
    # otherwise take the single surfaced line and say nothing about the guard.
    echo "payload-gate: guard SKIPPED — gate malfunctioned (exit $GATE_EXIT), push allowed" >&2
    cat "$TMP_ERR" >&2
    rm -f "$TMP_ERR"
    exit 1
  fi
  cat "$TMP_ERR" >&2
  rm -f "$TMP_ERR"
else
  echo "payload-gate: guard SKIPPED — $GATE missing or unreadable, push allowed" >&2
  exit 1
fi

exit 0
