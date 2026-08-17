#!/bin/bash
# test_hook.sh — fixture-driven tests for hook.sh's dispatch and gating logic.
#
# `payload_gate.py` has had tests since it was written; `hook.sh` — the part that
# decides *whether* to gate at all — had none, which is how the `git -C` bypass
# lived from the hook's creation until 2026-08-03 and how the missing test stage
# lived until 2026-08-05. Both are pinned below.
#
# Offline and self-contained: every fixture is a throwaway package.json whose
# scripts are `exit`/`echo`/`sleep`, so nothing here touches the network, npm's
# registry, or any real repo.
#
# Run: bash ~/.claude/hooks/push-build-gate/test_hook.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0

# Build the PreToolUse payload through a real JSON encoder rather than by hand:
# several cases carry quotes and `&&` in the command, and a hand-rolled printf
# would be testing the harness's escaping instead of the hook. `jq -n --arg`
# encodes each value for us, exactly as json.dumps did before it.
#
# jq rather than python3 so the harness needs no interpreter of its own — the
# hook resolves a uv-managed one internally, and a test rig that quietly
# depended on a *different* Python than the thing under test would be measuring
# the wrong machine.
run_hook() {
  local cwd="$1" cmd="$2"
  jq -n --arg cwd "$cwd" --arg cmd "$cmd" \
    '{cwd: $cwd, tool_input: {command: $cmd}}' | bash "$HOOK" 2>/dev/null
}

expect_exit() {
  local want="$1" name="$2" cwd="$3" cmd="$4"
  run_hook "$cwd" "$cmd" >/dev/null
  local got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s — expected exit %s, got %s\n' "$name" "$want" "$got"
  fi
}

# fixture <name> <build script or -> <test script or ->
fixture() {
  local name="$1" build="$2" test="$3"
  mkdir -p "$ROOT/$name"
  jq -n --arg name "$name" --arg build "$build" --arg test "$test" \
    '{name: $name, version: "1.0.0", scripts:
        ((if $build != "-" then {build: $build} else {} end)
       + (if $test  != "-" then {test:  $test}  else {} end))}' \
    > "$ROOT/$name/package.json"
  echo "$ROOT/$name"
}

fixture failbuild  'exit 1'            '-'                                  >/dev/null
fixture warnbuild  'echo "3 warnings"' '-'                                  >/dev/null
fixture failtest   'echo built'        'exit 1'                             >/dev/null
fixture passtest   'echo built'        'exit 0'                             >/dev/null
fixture notest     'echo built'        '-'                                  >/dev/null
fixture placeholder 'echo built'       'echo "Error: no test specified" && exit 1' >/dev/null
fixture hangtest   'echo built'        'sleep 3007'                         >/dev/null
fixture testonly   '-'                 'exit 1'                             >/dev/null
fixture nothing    '-'                 '-'                                  >/dev/null

echo "push-build-gate — hook.sh"

# --- Dispatch: what the gate declines to look at ----------------------------
expect_exit 0 "a command with no git in it is not gated"        "$ROOT/failbuild" "npm run build"
expect_exit 0 "a git command that is not a push is not gated"   "$ROOT/failbuild" "git -C $ROOT/failbuild status"
expect_exit 0 "a repo with neither build nor test is not gated" "$ROOT/nothing"   "git push"

# --- The build gate ---------------------------------------------------------
expect_exit 2 "a failing build blocks the push"                 "$ROOT/failbuild" "git push"
expect_exit 2 "a build with warnings blocks the push"           "$ROOT/warnbuild" "git push"

# Regression: 2026-08-03 — `git -C <path> push` resolved no package.json and
# exited 0, so a real code change pushed that way skipped the gate silently.
expect_exit 2 "git -C from an unrelated cwd still resolves the repo" \
  "$ROOT" "git -C $ROOT/failbuild push"

# Regression: 2026-08-03 — same hole reached through a leading `cd`.
expect_exit 2 "a leading cd ... && resolves the repo" \
  "$ROOT" "cd $ROOT/failbuild && git push"

# --- The test stage ---------------------------------------------------------
# Regression: 2026-08-05 — the gate ran the build and not the suite, and `c8540ca`
# reached origin/main with two failing assertions and a clean build.
expect_exit 2 "a failing suite blocks a push whose build is green" "$ROOT/failtest" "git push"
expect_exit 0 "a green build and a green suite pass"               "$ROOT/passtest" "git push"
expect_exit 0 "a repo with no test script is not gated on tests"   "$ROOT/notest"   "git push"
expect_exit 0 "npm's 'no test specified' placeholder is not a suite" "$ROOT/placeholder" "git push"

# Regression: 2026-08-05 — a missing `build` script exited the whole gate, so a
# repo with tests and no build (my-socratic-app-proxy's shape) was gated on nothing.
expect_exit 2 "a repo with tests and no build is still gated"     "$ROOT/testonly" "git push"

# --- The escape hatch, and the control that proves it is strict -------------
expect_exit 0 "TEST_GATE_SKIP=1 as an env prefix skips the suite" \
  "$ROOT/failtest" "TEST_GATE_SKIP=1 git push"

# The whole point of parsing the prefix rather than grepping for the name: a
# mention anywhere else in the command must NOT disarm the gate. Without this
# control the case above proves only that *something* matched.
expect_exit 2 "TEST_GATE_SKIP named outside the push's own command does not skip" \
  "$ROOT/failtest" "echo TEST_GATE_SKIP=1 && git push"
expect_exit 2 "TEST_GATE_SKIP=0 does not skip" \
  "$ROOT/failtest" "TEST_GATE_SKIP=0 git push"

# --- Fail open on the gate's own malfunction --------------------------------
# A suite that never finishes must let the push through (exit 1, advisory), not
# wedge it until the harness's 180 s ceiling. Bounded here so the test itself
# cannot hang: 1 s budget against a 3007 s sleep. Exported rather than written as
# an env prefix on the function call — the hook runs in a child process and only
# an exported value reaches it.
export PUSH_GATE_TEST_TIMEOUT=1
START=$(date +%s)
expect_exit 1 "a suite that never finishes fails open" "$ROOT/hangtest" "git push"
ELAPSED=$(( $(date +%s) - START ))
unset PUSH_GATE_TEST_TIMEOUT
if [ "$ELAPSED" -lt 10 ]; then
  PASS=$((PASS + 1))
  printf '  ok    the timeout path returns in %ss, well inside the 3007s sleep\n' "$ELAPSED"
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  the timeout path took %ss — it waited for the suite instead of killing it\n' "$ELAPSED"
fi

# The runner and its children must be gone, not orphaned. The sleep is 3007 s so
# this cannot match an unrelated process on the machine.
if pgrep -f "sleep 3007" >/dev/null 2>&1; then
  FAIL=$((FAIL + 1))
  printf '  FAIL  the killed suite left an orphan `sleep 3007` running\n'
else
  PASS=$((PASS + 1))
  printf '  ok    the killed suite left no orphan process\n'
fi

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
