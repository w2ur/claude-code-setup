#!/bin/bash
# Run this portfolio's CI gates locally under `act`, while the GitHub Actions
# quota is out (2026-08-18 → 2026-09-17).
#
# Exit codes follow the convention of gate-watch.sh / model-watch.sh:
#   0 = every selected gate passed
#   1 = a gate FAILED — a real finding
#   2 = something could not run, and must be read as UNKNOWN, never as healthy
#
# 2 outranks 1 deliberately. A gate that FAILED told you something; a gate that
# never executed told you nothing, and is the more dangerous of the two because
# it is the one that can masquerade as green. Any NORUN forces the whole sweep
# to 2 even when every other gate passed.
#
# WHY THIS IS ONLY HALF THE ANSWER. The expensive workflows are not these; they
# are the scheduled my-trading-app data jobs, which run repo Python and push to main.
# Those get gha-bridge.sh, not act: under act they gain a container boundary
# that puts the git credential and the venv out of reach, and act cannot
# schedule itself, so a LaunchAgent is needed regardless. act earns its place
# for the push/PR gates, where faithful reproduction of the hosted run is the
# entire point.
#
# REPOS AND WORKFLOWS ARE DISCOVERED, NEVER HAND-LISTED. The set is read out of
# the tree via `act --list` — act's own parser, so this cannot disagree with
# what act will actually run. A hand-written list silently omits repos; that is
# how the 2026-08-15 gate scope decision missed my-boardgame-app and my-bias-app.
# Exclusions are explicit and carry a reason (see SKIP below).

set -uo pipefail

DEV="${DEV_DIR:-$HOME/Dev}"
SHARED_GATE_REPO="{github-username}/.github"
SHARED_GATE_PATH="$DEV/.github"
EVENT="pull_request"
ARCH_FLAG=()
LIST_ONLY=false
declare -a WANT=()

# --- exclusions, each with the reason it is excluded ------------------------
# Matched as "<repo>/<workflow-file>". Anything push/PR-triggered and NOT here
# is run.
skip_reason() {
  case "$1" in
    my-trading-app/auto-merge-session.yml)
      echo "auto-merges claude/** branches — running it locally would merge for real" ;;
    */deploy.yml|*/cd.yml|*/cd-cloud.yml|*/publish.yml)
      echo "deploy/publish — out of scope, carries deploy credentials" ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF
usage: act-local.sh [--event push|pull_request] [--amd64] [--list] [repo...]

  --event   which event to simulate (default: pull_request — the gate case)
  --amd64   force linux/amd64. This host is arm64, so that means qemu
            emulation: far slower, but matches GitHub's x86 runners. Reach for
            it only when a result differs from CI and you suspect the arch.
  --list    show what would run, run nothing
  repo...   limit to these repo names (default: every repo with a CI gate)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --event) EVENT="${2:-}"; shift 2 ;;
    --amd64) ARCH_FLAG=(--container-architecture linux/amd64); shift ;;
    --list)  LIST_ONLY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage; exit 2 ;;
    *) WANT+=("$1"); shift ;;
  esac
done

# --- guards: FATAL, never a skip -------------------------------------------
# A CI runner that quietly does nothing is indistinguishable from one that
# passed. That is the failure this whole exercise exists to avoid, so every
# missing precondition is exit 2 (unknown) and never a silent continue.
for tool in act docker git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: $tool not on PATH"; exit 2; }
done

if ! docker info >/dev/null 2>&1; then
  echo "Docker unreachable — starting colima..."
  command -v colima >/dev/null 2>&1 || { echo "FATAL: no colima and no docker daemon"; exit 2; }
  colima start >/dev/null 2>&1 || { echo "FATAL: colima start failed"; exit 2; }
  docker info >/dev/null 2>&1 || { echo "FATAL: docker still unreachable after colima start"; exit 2; }
fi

TOKEN="$(gh auth token 2>/dev/null)"
[[ -n "$TOKEN" ]] || { echo "FATAL: gh has no token — run 'gh auth login'"; exit 2; }

# --- the shared reusable gate ----------------------------------------------
# my-fitness-app and {portfolio-site} both call
# {github-username}/.github/.github/workflows/pr-gate.yml@main, which is PRIVATE. Mapping it
# to the local clone avoids a network clone per run — but a stale clone would
# test yesterday's gate and report today's verdict, so its freshness is checked
# rather than assumed.
LOCAL_REPO_FLAG=()
if [[ -d "$SHARED_GATE_PATH/.git" ]]; then
  LOCAL_REPO_FLAG=(--local-repository "${SHARED_GATE_REPO}@main=${SHARED_GATE_PATH}")
  ( cd "$SHARED_GATE_PATH" && git fetch -q origin 2>/dev/null
    l="$(git rev-parse HEAD)"; r="$(git rev-parse origin/main 2>/dev/null || echo "$l")"
    [[ "$l" == "$r" ]] || echo "WARN: $SHARED_GATE_PATH is behind origin/main ($(git rev-parse --short HEAD) vs $(git rev-parse --short origin/main)) — the gate under test is stale." )
else
  echo "WARN: no local clone at $SHARED_GATE_PATH; act will clone the private shared gate over the network."
fi

# --- per-repo extra env ------------------------------------------------------
extra_env_for() {
  case "$1" in
    # Mirrors the caller's own `extra-env: CI=false`. Without it,
    # build-inventory.mjs's shouldWriteInventory() is true whenever CI is set,
    # so prebuild crawls the GitHub API across ~26 repos unauthenticated
    # against a 60/hour limit, then throws the result away.
    {portfolio-site}) echo "CI=false" ;;
    *) return 0 ;;
  esac
}

# --- discovery ---------------------------------------------------------------
declare -a TARGETS=()
declare -a SEEN_SKIP=()
for repodir in "$DEV"/*/; do
  repo="$(basename "$repodir")"
  [[ -d "$repodir/.github/workflows" ]] || continue
  if [[ ${#WANT[@]} -gt 0 ]]; then
    match=false
    for w in "${WANT[@]}"; do [[ "$w" == "$repo" ]] && match=true; done
    $match || continue
  fi
  # act --list is act's own parser: this cannot disagree with what act runs.
  while IFS= read -r line; do
    # Blank lines carry no fields, and awk errors on NF-1 rather than returning
    # empty — so they are dropped before any field is touched.
    [[ -z "${line// /}" ]] && continue
    read -r -a cols <<<"$line"
    (( ${#cols[@]} >= 2 )) || continue
    wf="${cols[-2]}"
    ev="${cols[-1]}"
    [[ "$wf" == "Workflow" ]] && continue
    grep -qE '(^|,)(push|pull_request)(,|$)' <<<"$ev" || continue
    key="$repo/$wf"
    if reason="$(skip_reason "$key")"; then
      # act --list prints one row per JOB, so a multi-job workflow would print
      # its skip notice once per job.
      if $LIST_ONLY && [[ " ${SEEN_SKIP[*]-} " != *" $key "* ]]; then
        SEEN_SKIP+=("$key")
        printf "  SKIP  %-46s %s\n" "$key" "$reason"
      fi
      continue
    fi
    TARGETS+=("$repo|$wf|$ev")
  done < <(cd "$repodir" && act --list 2>/dev/null)
done

# Deduplicate: act --list prints one row PER JOB, so a workflow with five jobs
# appears five times. Running it once runs all of them.
IFS=$'\n' TARGETS=($(printf '%s\n' "${TARGETS[@]}" | sort -u)); unset IFS

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "FATAL: discovered no push/PR workflows. Expected several — refusing to"
  echo "       report success on an empty set."
  exit 2
fi

# Pick the event PER WORKFLOW. Running a push-only workflow with
# `pull_request` makes act report "Could not find any stages to run" — it
# executes nothing. That surfaced as a FAIL for analytics/ci.yml and
# my-trading-app/session-integrity.yml (both `on: push` only) and it is the more
# dangerous shape of the same bug the shared pr-gate exists to close: a check
# that did not run must never be mistaken for one that did. So the requested
# event is used only when the workflow actually declares it.
event_for() {
  local declared="$1"
  if grep -qE "(^|,)${EVENT}(,|$)" <<<"$declared"; then echo "$EVENT"; return; fi
  for fallback in pull_request push; do
    grep -qE "(^|,)${fallback}(,|$)" <<<"$declared" && { echo "$fallback"; return; }
  done
  echo ""   # caller treats empty as "cannot run this workflow"
}

if $LIST_ONLY; then
  for t in "${TARGETS[@]}"; do
    IFS='|' read -r r w e <<<"$t"
    use="$(event_for "$e")"
    if [[ "$use" == "$EVENT" ]]; then
      printf "  RUN   %-46s %s\n" "$r/$w" "$use"
    else
      printf "  RUN   %-46s %s  (does not declare '%s')\n" "$r/$w" "$use" "$EVENT"
    fi
  done
  echo; echo "${#TARGETS[@]} workflow(s) would run."
  exit 0
fi

# --- run ---------------------------------------------------------------------
declare -a RESULTS=()
fail=0
LOGDIR="${TMPDIR:-/tmp}/act-local-$$"; mkdir -p "$LOGDIR"

for t in "${TARGETS[@]}"; do
  IFS='|' read -r repo wf declared <<<"$t"
  use_event="$(event_for "$declared")"
  log="$LOGDIR/${repo}__${wf}.log"

  if [[ -z "$use_event" ]]; then
    printf '\n\033[1m▶ %s / %s\033[0m\n' "$repo" "$wf"
    printf '  \033[33m⚠ NORUN\033[0m declares only "%s" — no runnable event\n' "$declared"
    RESULTS+=("NORUN|$repo/$wf|(not run)")
    fail=2
    continue
  fi

  printf '\n\033[1m▶ %s / %s\033[0m (event=%s)\n' "$repo" "$wf" "$use_event"

  env_flag=()
  if ee="$(extra_env_for "$repo")" && [[ -n "$ee" ]]; then env_flag=(--env "$ee"); fi

  ( cd "$DEV/$repo" && act "$use_event" \
      -W ".github/workflows/$wf" \
      -s GITHUB_TOKEN="$TOKEN" \
      "${LOCAL_REPO_FLAG[@]}" "${ARCH_FLAG[@]}" "${env_flag[@]}" \
  ) >"$log" 2>&1
  rc=$?

  # Two ways act can execute NOTHING and still not be a failing gate. Neither
  # may be filed as a pass; both are unknown coverage, and escalate to exit 2.
  #
  #   1. "Could not find any stages to run" — the event does not match.
  #   2. Every job filtered out by an `if:`, which act reports by printing NO
  #      job output whatsoever and exiting 0.
  #
  # (2) is not hypothetical: analytics/ci.yml carried upstream umami's
  # `if: github.repository == 'umami-software/umami'`, so on this account the
  # job was skipped on every push — GitHub called it "skipped", act printed
  # nothing, and THIS SCRIPT CALLED IT PASS. A gate that has never executed
  # once was reporting green. So a run is only believed when the log carries
  # at least one job outcome line.
  if grep -q "Could not find any stages to run" "$log"; then
    RESULTS+=("NORUN|$repo/$wf|$log")
    fail=2
    printf '  \033[33m⚠ NORUN\033[0m act executed no jobs — coverage is UNKNOWN, not green\n'
    continue
  fi

  if ! grep -qE "Job succeeded|Job failed" "$log"; then
    RESULTS+=("NORUN|$repo/$wf|$log")
    fail=2
    printf '  \033[33m⚠ NORUN\033[0m no job outcome in the log — every job was skipped\n'
    printf '           (an `if:` guard, or a matrix that expanded to nothing)\n'
    continue
  fi

  if [[ $rc -eq 0 ]]; then
    RESULTS+=("PASS|$repo/$wf|$log")
    printf '  \033[32m✓ PASS\033[0m\n'
  else
    RESULTS+=("FAIL|$repo/$wf|$log")
    [[ $fail -eq 2 ]] || fail=1
    printf '  \033[31m✗ FAIL\033[0m (rc=%s)\n' "$rc"
    tail -15 "$log" | sed 's/^/    /'
  fi
done

# --- summary -----------------------------------------------------------------
echo; echo "──────── act-local summary (requested event=$EVENT) ────────"
for r in "${RESULTS[@]}"; do
  st="${r%%|*}"; rest="${r#*|}"; name="${rest%%|*}"; log="${rest##*|}"
  case "$st" in
    PASS)  printf '  \033[32m%-5s\033[0m %-46s\n' "$st" "$name" ;;
    NORUN) printf '  \033[33m%-5s\033[0m %-46s %s\n' "$st" "$name" "$log" ;;
    *)     printf '  \033[31m%-5s\033[0m %-46s %s\n' "$st" "$name" "$log" ;;
  esac
done
echo "  logs: $LOGDIR"

exit $fail
