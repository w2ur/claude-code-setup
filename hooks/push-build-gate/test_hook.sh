#!/bin/bash
# test_hook.sh — fixture-driven tests for hook.sh's dispatch and gating logic.
#
# `payload_gate.py` has had tests since it was written; `hook.sh` — the part that
# decides *whether* to gate at all — had none, which is how the `git -C` bypass
# lived from the hook's creation until 2026-08-03 and how the missing test stage
# lived until 2026-08-05. Both are pinned below.
#
# Every fixture is a real (if throwaway) git repo now: `git init -q` plus, for
# any nested package.json, `git add` to stage it. D11's fix-round-1 review made
# this non-optional — the hook now refuses to build or scan anything that
# isn't inside a resolvable git repo (a non-repo cwd is a no-op, not a guess),
# and its nested-package scan is driven by `git ls-files`, which only ever
# lists what git tracks. `git add` needs no identity config (unlike `git
# commit`), so nothing here touches user.name/user.email.
#
# Offline and self-contained beyond that: every fixture's scripts are
# `exit`/`echo`/`sleep`/`touch`, so nothing here touches the network, npm's
# registry, or any real repo. IMPORTANT: never point this hook at a real
# working directory while testing it by hand — every cwd/`-C`/`cd` target
# below is a fixture under $ROOT, a fresh mktemp -d, nothing else.
#
# Run: bash ~/.claude/hooks/push-build-gate/test_hook.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook.sh"
# `cd ... && pwd -P`, not a bare `mktemp -d`: on macOS /var is a symlink to
# /private/var, and the hook now resolves every repo through `git rev-parse
# --show-toplevel`, which reports the PHYSICAL path. Comparing that against
# an unresolved $ROOT/... string would fail every assertion that checks an
# exact path in a message, for a reason that has nothing to do with the hook.
ROOT=$(mktemp -d)
ROOT=$(cd "$ROOT" && pwd -P)
trap 'rm -rf "$ROOT"' EXIT

# The nolib fixture below (D11 fix round 2) must never touch this file — it
# used to `rm` it in place. Hashing it before and after this whole run is the
# falsifiable control: if that regression ever came back, this check is the
# one that would catch it, not a visual diff of the fixture itself.
LIVE_LIB="$(dirname "$HOOK")/../lib/resolve-repo.sh"
LIVE_LIB_HASH_BEFORE=$(shasum -a 256 "$LIVE_LIB" 2>/dev/null | awk '{print $1}')

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

# Same payload construction as run_hook, but stderr is kept — several D11
# fix-round-1 cases below assert on the exact advisory text, not just the
# exit code (Focus #1: a guard must never report green without checking
# anything, which a bare exit code can't distinguish from "didn't check").
run_hook_capture_stderr() {
  local cwd="$1" cmd="$2"
  jq -n --arg cwd "$cwd" --arg cmd "$cmd" \
    '{cwd: $cwd, tool_input: {command: $cmd}}' | bash "$HOOK" 2>&1 >/dev/null
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
# Each fixture is its own tiny git repo (`git init -q`) — see the file header
# for why that's load-bearing now, not cosmetic.
fixture() {
  local name="$1" build="$2" test="$3"
  mkdir -p "$ROOT/$name"
  git -C "$ROOT/$name" init -q
  jq -n --arg name "$name" --arg build "$build" --arg test "$test" \
    '{name: $name, version: "1.0.0", scripts:
        ((if $build != "-" then {build: $build} else {} end)
       + (if $test  != "-" then {test:  $test}  else {} end))}' \
    > "$ROOT/$name/package.json"
  echo "$ROOT/$name"
}

# add_nested <repo> <relative dir> <build script or -> <test script or ->
# Creates <repo>/<relative dir>/package.json and stages it — untracked, it
# would be invisible to `git ls-files`, which is exactly the point when a
# fixture wants to prove the OPPOSITE (see the .next-style fixtures below,
# which deliberately skip this and leave their manifest untracked).
add_nested() {
  local repo="$1" rel="$2" build="$3" test="$4"
  mkdir -p "$repo/$rel"
  jq -n --arg build "$build" --arg test "$test" \
    '{scripts: ((if $build != "-" then {build: $build} else {} end)
              + (if $test  != "-" then {test:  $test}  else {} end))}' \
    > "$repo/$rel/package.json"
  git -C "$repo" add "$rel/package.json" >/dev/null 2>&1
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
# repo with tests and no build (elenchus-proxy's shape) was gated on nothing.
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
# cannot hang: 1 s budget against a 3007 s sleep.
#
# D11 fix round 1 folded the root's own test timeout into the single shared
# deadline (PUSH_GATE_DEADLINE) — the root build ("echo built") finishes near-
# instantly, leaving the whole 1 s budget for the hanging test. Exported
# rather than written as an env prefix on the function call — the hook runs
# in a child process and only an exported value reaches it.
export PUSH_GATE_DEADLINE=1
START=$(date +%s)
OUT=$(run_hook_capture_stderr "$ROOT/hangtest" "git push")
GOT=$?
ELAPSED=$(( $(date +%s) - START ))
unset PUSH_GATE_DEADLINE
if [ "$GOT" = 1 ] && printf '%s' "$OUT" | grep -qF "push-build-gate: $ROOT/hangtest tests TIMED OUT"; then
  PASS=$((PASS + 1))
  printf '  ok    a suite that never finishes fails open with a TIMED OUT line\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  a suite that never finishes — expected exit 1 and a TIMED OUT line, got exit %s: %s\n' "$GOT" "$OUT"
fi
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

# --- D11: nested manifests must be gated too ---------------------------------
# Until this task the hook only ever looked at $dir/package.json, so a nested
# app — `client/`, `app/`, `wasm-pkg/` — shipped completely ungated.

# nested-one: a nested build failure must still block the push. Root itself has
# no scripts at all — same shape as the `nothing` fixture — so this also pins
# that the root's silent "nothing to gate" behaviour survives nested scanning.
NESTED_ONE=$(fixture nested-one '-' '-')
add_nested "$NESTED_ONE" client 'exit 1' '-'
expect_exit 2 "a failing build in a nested client/ blocks the push" "$NESTED_ONE" "git push"

# nested-two: two nested packages, both actually gated — proven by a marker
# file each build touches, not just by the final exit code (a single early
# failure would otherwise "prove" both ran when only the first one did). Also
# pins the git-tracked-only scan: a package.json under node_modules is left
# UNTRACKED (no `add_nested`, i.e. no `git add`) with a build that would fail
# loudly if it were ever reached.
NESTED_TWO=$(fixture nested-two '-' '-')
add_nested "$NESTED_TWO" app 'touch .built' '-'
add_nested "$NESTED_TWO" wasm-pkg 'touch .built' '-'
mkdir -p "$NESTED_TWO/node_modules/some-dep"
jq -n '{scripts:{build:"exit 1"}}' > "$NESTED_TWO/node_modules/some-dep/package.json"
expect_exit 0 "two nested packages (app/, wasm-pkg/) both pass" "$NESTED_TWO" "git push"
if [ -f "$NESTED_TWO/app/.built" ] && [ -f "$NESTED_TWO/wasm-pkg/.built" ]; then
  PASS=$((PASS + 1))
  printf '  ok    both nested packages actually ran (marker files present)\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  at least one nested package never ran — app:%s wasm-pkg:%s\n' \
    "$([ -f "$NESTED_TWO/app/.built" ] && echo yes || echo no)" \
    "$([ -f "$NESTED_TWO/wasm-pkg/.built" ] && echo yes || echo no)"
fi

# nested-no-scripts: a nested package.json with neither build nor test must be
# called out loudly, not shipped silently ungated like the root's own
# no-scripts case is — AND the payload gate must still run despite the
# warning (review round 1, Critical #2: an early exit here used to skip
# payload_gate.py entirely on every repo with even one untested nested
# package). Root's own build prints a minimal Next-style route table so
# payload_gate.py has something to act on; PAYLOAD_BASELINE_DIR is scoped to
# a scratch dir so this never touches ~/.claude/payload-baselines.
NESTED_NO_SCRIPTS=$(fixture nested-no-scripts 'printf "Route (app)\n┌ ○ /\n"' '-')
add_nested "$NESTED_NO_SCRIPTS" docs '-' '-'
export PAYLOAD_BASELINE_DIR=$(mktemp -d)
OUT=$(run_hook_capture_stderr "$NESTED_NO_SCRIPTS" "git push")
GOT=$?
unset PAYLOAD_BASELINE_DIR
if [ "$GOT" = 1 ] \
   && printf '%s' "$OUT" | grep -qF "push-build-gate: nested docs NOT GATED (no build/test script)" \
   && printf '%s' "$OUT" | grep -qF "payload-gate: baseline created"; then
  PASS=$((PASS + 1))
  printf '  ok    a nested package with no build/test script is NOT GATED loudly, and the payload gate still ran\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  nested-no-scripts — expected exit 1, the NOT GATED line, AND a payload-gate run, got exit %s: %s\n' "$GOT" "$OUT"
fi

# slow-build: a build that outlives the shared deadline must be killed and
# reported, not silently eat the rest of the hook's 180 s budget. The deadline
# is forced to 1 s (same override pattern as the hangtest fixture above) so
# this test doesn't actually wait out the real 150 s default.
SLOW_BUILD=$(fixture slow-build 'sleep 3007' '-')
export PUSH_GATE_DEADLINE=1
OUT=$(run_hook_capture_stderr "$SLOW_BUILD" "git push")
GOT=$?
unset PUSH_GATE_DEADLINE
if [ "$GOT" = 1 ] && printf '%s' "$OUT" | grep -qF "push-build-gate: $SLOW_BUILD build TIMED OUT"; then
  PASS=$((PASS + 1))
  printf '  ok    a build that outlives the shared deadline is killed and reported\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  a build past the deadline — expected exit 1 and a TIMED OUT line, got exit %s: %s\n' "$GOT" "$OUT"
fi
if pgrep -f "sleep 3007" >/dev/null 2>&1; then
  FAIL=$((FAIL + 1))
  printf '  FAIL  the timed-out build left an orphan `sleep 3007` running\n'
else
  PASS=$((PASS + 1))
  printf '  ok    the timed-out build left no orphan process\n'
fi

# Minor #6 (review round 1): the timeout sentinel must not collide with a
# script that legitimately exits 124 on its own. This is a real failure, not
# a timeout — must block (exit 2, "FAILED"), never read as TIMED OUT.
EXIT124=$(fixture exit124 'exit 124' '-')
OUT=$(run_hook_capture_stderr "$EXIT124" "git push")
GOT=$?
if [ "$GOT" = 2 ] \
   && printf '%s' "$OUT" | grep -qF "build FAILED in $EXIT124 (exit 124)" \
   && ! printf '%s' "$OUT" | grep -q "TIMED OUT"; then
  PASS=$((PASS + 1))
  printf '  ok    a script that legitimately exits 124 is a failure, not a timeout\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  exit-124 sentinel collision — expected exit 2 and FAILED (no TIMED OUT), got exit %s: %s\n' "$GOT" "$OUT"
fi

# git-c: regression pin for the shared resolve_repo_dir helper — `git -C
# <path> push` must still resolve to <path>'s repo, not the caller's cwd.
GIT_C=$(fixture git-c 'echo built' '-')
expect_exit 0 "git -C <path> push still resolves the repo via the shared helper" \
  "$ROOT" "git -C $GIT_C push"

# --- D11 fix round 1: Critical #1 — a non-repo cwd must never become a build
# of everything underneath it -------------------------------------------------
# Reproduced live on 2026-09-24: a `git push` (or any command merely mentioning
# it) run from a non-repo directory holding several child repos built every
# one of them. $ROOT itself is never `git init`ed, so it stands in for exactly
# that shape: several real child repos, but no repo of its own.
NONREPO_A=$(fixture nonrepo-child-a 'touch .built' '-')
NONREPO_B=$(fixture nonrepo-child-b 'touch .built' '-')
rm -f "$NONREPO_A/.built" "$NONREPO_B/.built"
expect_exit 0 "a non-repo cwd holding child repos triggers no build at all" "$ROOT" "git push"
if [ -f "$NONREPO_A/.built" ] || [ -f "$NONREPO_B/.built" ]; then
  FAIL=$((FAIL + 1))
  printf '  FAIL  a non-repo cwd built at least one child repo underneath it\n'
else
  PASS=$((PASS + 1))
  printf '  ok    a non-repo cwd never touched either child repo\n'
fi

# --- D11 fix round 1: Critical #2 — a gitignored nested manifest (Next's own
# .next/package.json) must not be scanned at all, must not print NOT GATED,
# and must not disable the payload gate -------------------------------------
# `git ls-files` (not `find`) is the fix: it only lists what git tracks, so a
# manifest that's never `git add`ed — exactly `.next/package.json`'s shape in
# a real Next.js repo — is invisible to the scan. PAYLOAD_BASELINE_DIR is
# scoped to a scratch dir, same reasoning as nested-no-scripts above.
NEXTISH=$(fixture nextish 'printf "Route (app)\n┌ ○ /\n"' '-')
mkdir -p "$NEXTISH/.next"
jq -n '{type:"commonjs"}' > "$NEXTISH/.next/package.json"   # deliberately untracked
export PAYLOAD_BASELINE_DIR=$(mktemp -d)
OUT=$(run_hook_capture_stderr "$NEXTISH" "git push")
GOT=$?
unset PAYLOAD_BASELINE_DIR
if [ "$GOT" = 0 ] \
   && ! printf '%s' "$OUT" | grep -q "NOT GATED" \
   && printf '%s' "$OUT" | grep -qF "payload-gate: baseline created"; then
  PASS=$((PASS + 1))
  printf '  ok    an untracked .next/package.json is never scanned, and the payload gate still ran\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  Next-style repo — expected exit 0, no NOT GATED line, and a payload-gate run, got exit %s: %s\n' "$GOT" "$OUT"
fi

# --- D11 fix round 2: Important #1 — a bare `*/package.json` pathspec also
# matches deeper paths and TRACKED node_modules content, because in git's
# default pathspec dialect `*` matches `/` too ------------------------------
# Probed directly against `git ls-files`: the bare form returned a depth-4
# fixture path and a tracked node_modules path in the same list; adding
# `:(glob)` magic (shell-glob semantics, `*` never matches `/`) plus
# `:(exclude,glob)**/node_modules/**` fixed both. These two fixtures pin the
# actual hook, not just the pathspec in isolation: both manifests are
# genuinely TRACKED (`git add`ed), so a bare-pathspec regression would build
# them and touch their marker files.
DEPTH_LIMIT=$(fixture depth-limit '-' '-')
add_nested "$DEPTH_LIMIT" a 'touch .built' '-'                       # depth 1 — must run
add_nested "$DEPTH_LIMIT" b/c 'touch .built' '-'                     # depth 2 — must run
add_nested "$DEPTH_LIMIT" d/e/f/g 'touch .built' '-'                 # depth 4 — must NOT run
expect_exit 0 "depth 1 and 2 nested packages pass" "$DEPTH_LIMIT" "git push"
if [ -f "$DEPTH_LIMIT/a/.built" ] && [ -f "$DEPTH_LIMIT/b/c/.built" ]; then
  PASS=$((PASS + 1))
  printf '  ok    depth 1 and depth 2 nested packages both actually ran\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  a nested package within the scanned depth never ran — a:%s b/c:%s\n' \
    "$([ -f "$DEPTH_LIMIT/a/.built" ] && echo yes || echo no)" \
    "$([ -f "$DEPTH_LIMIT/b/c/.built" ] && echo yes || echo no)"
fi
if [ -f "$DEPTH_LIMIT/d/e/f/g/.built" ]; then
  FAIL=$((FAIL + 1))
  printf '  FAIL  a tracked depth-4 manifest was built — the scan is not depth-limited\n'
else
  PASS=$((PASS + 1))
  printf '  ok    a tracked depth-4 manifest was never scanned\n'
fi

NODE_MODULES_TRACKED=$(fixture node-modules-tracked '-' '-')
add_nested "$NODE_MODULES_TRACKED" node_modules/x 'touch .built' '-'
expect_exit 0 "a repo with only a tracked node_modules manifest is not gated" \
  "$NODE_MODULES_TRACKED" "git push"
if [ -f "$NODE_MODULES_TRACKED/node_modules/x/.built" ]; then
  FAIL=$((FAIL + 1))
  printf '  FAIL  a TRACKED node_modules/x/package.json was built — the node_modules exclusion is lost\n'
else
  PASS=$((PASS + 1))
  printf '  ok    a tracked node_modules/x/package.json was never scanned\n'
fi

# --- D11 fix round 1: Critical #3 — the root package must be built exactly
# once (the nested scan's own pathspecs can never match a zero-slash root
# manifest, but this is the end-to-end pin) ----------------------------------
ROOT_ONCE=$(fixture root-once 'true' '-')
COUNTER="$ROOT/root-once-counter.txt"
: > "$COUNTER"
jq -n --arg counter "$COUNTER" '{name:"root-once", version:"1.0.0", scripts:{build:("echo x >> " + $counter)}}' \
  > "$ROOT_ONCE/package.json"
expect_exit 0 "root build succeeds" "$ROOT_ONCE" "git push"
LINES=$(wc -l < "$COUNTER" | tr -d ' ')
if [ "$LINES" = "1" ]; then
  PASS=$((PASS + 1))
  printf '  ok    the root package was built exactly once\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  the root package was built %s times, expected 1\n' "$LINES"
fi


# --- Merge-gate fix: a nested package whose dependencies were never installed
# is the guard's ENVIRONMENT failing, not a build verdict ---------------------
# my-boardgame-app/app and my-art-tool/editor are exactly this shape: a tracked depth-1
# manifest declaring dependencies, a build script, and no node_modules in the
# package dir nor at the repo root. Their build dies on `vite: command not
# found`, which used to read as "build FAILED" and block the push (exit 2).
# The build here is `exit 1` so the fixture fails the same way whether or not
# some `vite` happens to be on PATH.
# nested_with_deps <repo> <relative dir> <build script>
nested_with_deps() {
  local repo="$1" rel="$2" build="$3"
  mkdir -p "$repo/$rel"
  jq -n --arg build "$build" \
    '{scripts: {build: $build}, devDependencies: {vite: "^5.0.0"}}' \
    > "$repo/$rel/package.json"
  git -C "$repo" add "$rel/package.json" >/dev/null 2>&1
}
NO_DEPS=$(fixture nested-deps-missing '-' '-')
nested_with_deps "$NO_DEPS" app 'exit 1'
OUT=$(run_hook_capture_stderr "$NO_DEPS" "git push")
GOT=$?
if [ "$GOT" = 1 ] \
   && printf '%s' "$OUT" | grep -qF "push-build-gate: nested app NOT GATED (dependencies not installed)" \
   && ! printf '%s' "$OUT" | grep -q "build FAILED"; then
  PASS=$((PASS + 1))
  printf '  ok    a nested package with uninstalled dependencies is NOT GATED (exit 1), never blocked\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  nested deps missing — expected exit 1 and a "dependencies not installed" line, got exit %s: %s\n' "$GOT" "$OUT"
fi

# The controls: the same package WITH its dependencies installed — in its own
# dir, or hoisted to the repo root — is built, so its failing build still
# blocks. Without these the case above proves only that nested builds stopped
# running altogether.
DEPS_LOCAL=$(fixture nested-deps-local '-' '-')
nested_with_deps "$DEPS_LOCAL" app 'exit 1'
mkdir -p "$DEPS_LOCAL/app/node_modules"
expect_exit 2 "a nested package with its own node_modules is still gated" "$DEPS_LOCAL" "git push"
DEPS_ROOT=$(fixture nested-deps-root '-' '-')
nested_with_deps "$DEPS_ROOT" app 'exit 1'
mkdir -p "$DEPS_ROOT/node_modules"
expect_exit 2 "a nested package with hoisted root node_modules is still gated" "$DEPS_ROOT" "git push"

# --- Merge-gate fix: non-ASCII directory names --------------------------------
# With core.quotePath at its default, `git ls-files` C-quotes `café/package.json`
# as "caf\303\251/package.json"; dirname then names a directory that does not
# exist, both scripts read back empty, and a failing build was reported as
# "no build/test script" (exit 1) instead of blocking (exit 2).
NON_ASCII=$(fixture non-ascii '-' '-')
add_nested "$NON_ASCII" café 'exit 1' '-'
OUT=$(run_hook_capture_stderr "$NON_ASCII" "git push")
GOT=$?
if [ "$GOT" = 2 ] && printf '%s' "$OUT" | grep -qF "build FAILED in café"; then
  PASS=$((PASS + 1))
  printf '  ok    a nested package in a non-ASCII directory is built, and its failure blocks\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  non-ASCII nested dir — expected exit 2 and "build FAILED in café", got exit %s: %s\n' "$GOT" "$OUT"
fi

# --- D11 fix round 1/2: Important #4 — a missing shared lib must fail
# loudly, not silently fall through at exit 0 ---------------------------------
# Fix round 2: this MUST NOT touch the live, installed
# hooks/lib/resolve-repo.sh — round 1's version `rm`'d it in place with no
# trap, so every real push in every session was ungated for the duration of
# this one test, and a crash between the `rm` and the restoring `cp` would
# have left it permanently deleted. Instead, stage a COPY of hook.sh in a
# fresh temp dir with no `lib/` sibling at all (same pattern as
# `_stage_hook_with_lib` in test_payload_gate.py) — `../lib/resolve-repo.sh`
# resolves relative to the staged hook.sh, one level above a fresh mktemp -d,
# which has nothing named `lib` in it, so this is "missing" without ever
# touching the real file.
NOLIB=$(fixture nolib 'echo built' '-')
NOLIB_STAGE=$(mktemp -d)
cp "$HOOK" "$NOLIB_STAGE/hook.sh"
OUT=$(jq -n --arg cwd "$NOLIB" --arg cmd "git push" \
  '{cwd: $cwd, tool_input: {command: $cmd}}' | bash "$NOLIB_STAGE/hook.sh" 2>&1 >/dev/null)
GOT=$?
rm -rf "$NOLIB_STAGE"
if [ "$GOT" = 1 ] && printf '%s' "$OUT" | grep -qF "push-build-gate: cannot load"; then
  PASS=$((PASS + 1))
  printf '  ok    a missing shared lib fails loudly (exit 1, first line names the guard)\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  missing lib — expected exit 1 and a "cannot load" line, got exit %s: %s\n' "$GOT" "$OUT"
fi

# The falsifiable control for the nolib fixture above: prove the live,
# installed lib is byte-identical to what it was before this entire run, not
# just that the fixture "looked" isolated.
LIVE_LIB_HASH_AFTER=$(shasum -a 256 "$LIVE_LIB" 2>/dev/null | awk '{print $1}')
if [ -n "$LIVE_LIB_HASH_BEFORE" ] && [ "$LIVE_LIB_HASH_BEFORE" = "$LIVE_LIB_HASH_AFTER" ]; then
  PASS=$((PASS + 1))
  printf '  ok    the live hooks/lib/resolve-repo.sh was never touched by this run\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  the live hooks/lib/resolve-repo.sh changed during this run (before=%s after=%s)\n' \
    "$LIVE_LIB_HASH_BEFORE" "$LIVE_LIB_HASH_AFTER"
fi

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
