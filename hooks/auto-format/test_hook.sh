#!/bin/bash
# test_hook.sh — fixture-driven tests for auto-format's ruff/rustfmt dispatch.
#
# Ruff runs only where a repo configures it (D16); the prettier branch is
# gone entirely — no repo in this portfolio ever shipped a prettier config,
# so it never fired. Scratch repos live under a session-scoped scratchpad,
# never under $HOME, so the hook's own directory walk cannot escape them.
#
# Run: bash ~/.claude/hooks/auto-format/test_hook.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook.sh"
SCRATCH="${AUTO_FORMAT_TEST_SCRATCH:-/private/tmp/claude-501/-Users-{username}-Dev/53f55c57-7d22-44ea-925b-557c61a22539/scratchpad/d5}"

PASS=0
FAIL=0

run_write() {
  local path="$1"
  jq -n --arg path "$path" '{tool_name: "Write", tool_input: {file_path: $path}}' | bash "$HOOK"
}

bad_py() {
  # Deliberately mis-formatted: ruff format would rewrite every line.
  printf 'x=1\ndef  foo( a,b ):\n    return a+b\n'
}

bad_js() {
  printf 'const x=1\nfunction foo(a,b){return a+b}\n'
}

fresh_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
}

expect_unchanged() {
  local name="$1" file="$2"
  local before after
  before=$(md5 -q "$file")
  run_write "$file" >/dev/null 2>&1
  after=$(md5 -q "$file")
  if [ "$before" = "$after" ]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s — file was reformatted, expected untouched\n' "$name"
  fi
}

expect_changed() {
  local name="$1" file="$2"
  local before after
  before=$(md5 -q "$file")
  run_write "$file" >/dev/null 2>&1
  after=$(md5 -q "$file")
  if [ "$before" != "$after" ]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s — file untouched, expected ruff to format it\n' "$name"
  fi
}

echo "auto-format — hook.sh"

# --- (a) repo without ruff config: untouched -----------------------------
#
# Regression fixture for the real bug found in review: a pyproject.toml that
# exists but carries no [tool.ruff] table (exactly the my-trading-app/midas-core
# shape) must NOT be treated as "configured".
DIR_A="$SCRATCH/a_no_config"
fresh_repo "$DIR_A"
cat > "$DIR_A/pyproject.toml" <<'EOF'
[project]
name = "a-no-config"
version = "0.1.0"
EOF
bad_py > "$DIR_A/bad.py"
expect_unchanged "pyproject.toml with no [tool.ruff] table is untouched" "$DIR_A/bad.py"

# --- (b) pyproject.toml with [tool.ruff]: formatted -----------------------
DIR_B="$SCRATCH/b_pyproject_ruff"
fresh_repo "$DIR_B"
cat > "$DIR_B/pyproject.toml" <<'EOF'
[tool.ruff]
line-length = 100
EOF
bad_py > "$DIR_B/bad.py"
expect_changed "pyproject.toml with [tool.ruff] is formatted" "$DIR_B/bad.py"

# --- (c) ruff.toml: formatted ---------------------------------------------
DIR_C="$SCRATCH/c_ruff_toml"
fresh_repo "$DIR_C"
cat > "$DIR_C/ruff.toml" <<'EOF'
line-length = 100
EOF
bad_py > "$DIR_C/bad.py"
expect_changed "ruff.toml at repo root is formatted" "$DIR_C/bad.py"

# --- (d) .js/.ts file anywhere: untouched (prettier branch gone) ---------
DIR_D="$SCRATCH/d_js_anywhere"
fresh_repo "$DIR_D"
cat > "$DIR_D/package.json" <<'EOF'
{
  "name": "d-js-anywhere",
  "prettier": {}
}
EOF
bad_js > "$DIR_D/bad.js"
expect_unchanged "a .js file is untouched even with a prettier config present" "$DIR_D/bad.js"

# --- Dispatch: malformed input stays silent ------------------------------

RAW_EXIT=$(printf 'not json' | bash "$HOOK" >/dev/null 2>&1; echo $?)
if [ "$RAW_EXIT" = "0" ]; then
  PASS=$((PASS + 1))
  printf '  ok    malformed input exits 0 (silent)\n'
else
  FAIL=$((FAIL + 1))
  printf '  FAIL  malformed input exited %s, expected 0\n' "$RAW_EXIT"
fi

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
