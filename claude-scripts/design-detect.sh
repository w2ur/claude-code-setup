#!/usr/bin/env bash
# Evidence for one page: Playwright capture (capture.mjs) + Impeccable's
# deterministic anti-pattern detector at two widths.
#
# Impeccable's own exit codes are INVERTED relative to the portfolio
# convention (measured 2026-10-09 on 4.1.0: clean 0, findings 2, unreachable
# 1). Never call it bare from anything that reads exit codes; call this.
# It also applies the CALLER'S cwd .impeccable/config.json and DESIGN.md to
# whatever it scans, so it always runs with --no-config: sanctioning a
# documented identity is design-critique's job, not the detector's.
#
# THIS SCRIPT IS THE SOURCE OF TRUTH for the detect widths; the detector
# version is pinned in design/package.json.
#
# Exit 0 = captured, no detector finding. 1 = captured, >=1 finding.
# 2 = could not run (capture failed, blank or error page, detector crashed,
# output empty or not a JSON array, or a "findings" exit with no finding) —
# UNKNOWN, never "clean". Evidence from an earlier run in <outdir> is removed
# first, so a failed run never leaves stale files that read as current.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMPECCABLE_BIN="${IMPECCABLE_BIN:-$HERE/design/node_modules/.bin/impeccable}"   # pinned in design/package.json
DETECT_VIEWPORTS=("1440x900" "390x844")
NODE_BIN="${NODE_BIN:-node}"

target="${1:-}"; outdir="${2:-}"
[[ -n "$target" && -n "$outdir" ]] || { echo "usage: design-detect.sh <url|file> <outdir>" >&2; exit 2; }
mkdir -p "$outdir"
rm -rf "$outdir/capture.json" "$outdir/console.json" "$outdir/shots" "$outdir"/detect-*.json "$outdir"/detect-*.json.err

"$NODE_BIN" "$HERE/design/capture.mjs" "$target" "$outdir" || { echo "capture failed: $target" >&2; exit 2; }

total=0
for vp in "${DETECT_VIEWPORTS[@]}"; do
  out="$outdir/detect-${vp%%x*}.json"
  args=(detect --json --no-advisory --no-config)
  [[ "$target" =~ ^https?: ]] && args+=(--viewport "$vp")
  "$IMPECCABLE_BIN" "${args[@]}" "$target" >"$out" 2>"$out.err"
  rc=$?
  case $rc in
    0|2) ;;                                   # 0 clean, 2 findings (Impeccable's codes)
    *) echo "detector could not run ($rc): $(tail -1 "$out.err")" >&2; exit 2 ;;
  esac
  # An empty file makes `jq length` print nothing with exit 0, and an empty
  # operand is 0 in $(( )), so an empty output would read as CLEAN. Require
  # a JSON array and a numeric count.
  n=$(jq -e 'if type == "array" then length else error("not an array") end' "$out" 2>/dev/null)
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "detector output is not a JSON array: $out" >&2; exit 2; }
  # Impeccable exits 2 only when it found something: 2 with an empty array is
  # a contradiction, so the run is unknown rather than clean.
  (( rc == 2 && n == 0 )) && { echo "detector exit 2 with no finding: $out" >&2; exit 2; }
  total=$((total + n))
  [[ "$target" =~ ^https?: ]] || break        # files have no viewport: one pass
done

echo "findings=$total outdir=$outdir"
(( total > 0 )) && exit 1
exit 0
