#!/usr/bin/env python3
"""payload_gate.py — render-mode and prerendered-payload checks for push-build-gate.

Why Python and not bash: this parses UTF-8 box-drawing and marker characters,
reads/writes JSON, and does ratio arithmetic. macOS awk is byte-oriented and
mangles the markers. hook.sh already resolves an interpreter for its own
env-prefix parsing, so this adds no dependency.

This shebang is NOT how it gets launched, deliberately, and it is not a uv
`--script` shebang either. hook.sh invokes it as `"$PYTHON" payload_gate.py`
with a uv-managed interpreter it resolved once. The reason is the exit code:
hook.sh reads 2 as BLOCK THE PUSH and 3 as warn, and CPython's own "cannot open
file" status is also 2 — so any launcher that can emit its own failure codes
into that channel could turn its own malfunction into a verdict. An interpreter
path cannot. The shebang is kept only so the file stays runnable by hand.
"""
import json
import os
import re
import subprocess
import sys

# Markers Next.js uses for routes it prerenders to a file at build time.
# Verified against real build output in Task 2 — do not edit from memory.
PRERENDERED = frozenset({"○", "●", "◐"})
DYNAMIC = "ƒ"

_ROUTE_LINE = re.compile(r"^[┌├└]\s+(\S+)\s+(\S+)")


def parse_route_table(text):
    """Map route path -> raw marker character.

    Only lines prefixed with a box-drawing character are routes. The legend
    lines at the bottom begin with the same markers and must not match.
    """
    routes = {}
    for line in text.splitlines():
        m = _ROUTE_LINE.match(line)
        if not m:
            continue
        marker, route = m.group(1), m.group(2)
        if marker in PRERENDERED or marker == DYNAMIC:
            routes[route] = marker
    return routes


def measure_prerendered(repo_dir):
    """Map prerendered artifact path (relative to .next/server/app) -> raw bytes.

    Only *.html. Dynamic routes have no prerendered file, which is the
    documented blind spot Layer 2 exists to cover.
    """
    root = os.path.join(repo_dir, ".next", "server", "app")
    if not os.path.isdir(root):
        return {}
    sizes = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not name.endswith(".html"):
                continue
            full = os.path.join(dirpath, name)
            sizes[os.path.relpath(full, root)] = os.path.getsize(full)
    return sizes


def measure_rsc_total(repo_dir):
    """Sum the bytes of every *.rsc file under .next/server/app.

    This is a RELATIVE signal, never an absolute byte count: React Server
    Component payloads are duplicated on disk (e.g. a route's
    *.segments/_full.segment.rsc mirrors its parent .rsc exactly), so this
    total double-counts real bytes on purpose. Do not add deduplication —
    the value is only ever compared as a ratio against its own prior
    baseline, and consistent double-counting cancels out in that ratio.
    Deduplicating here would silently change what the ratio means.
    """
    root = os.path.join(repo_dir, ".next", "server", "app")
    if not os.path.isdir(root):
        return 0
    total = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not name.endswith(".rsc"):
                continue
            total += os.path.getsize(os.path.join(dirpath, name))
    return total


BASELINE_DIR = os.path.expanduser("~/.claude/payload-baselines")


def repo_key(repo_dir):
    """Absolute path identifying the repo a baseline belongs to.

    Keyed on the MAIN worktree, never on the checkout path handed to us: a
    linked worktree (`<repo>/.worktrees/feat-x`) slugs to a different path than
    its main checkout, so it would record a silent first baseline and be
    unguarded on its first push — precisely when a render-mode flip is most
    likely. `--git-common-dir` returns the shared `.git` directory for a main
    checkout and every worktree linked to it, so its parent is a stable key.

    Falls back to the plain absolute path when the directory is not a git
    checkout, when git is missing, or when git is too old for
    `--path-format` (added in 2.31): degrading to per-checkout keys is
    acceptable, crashing or blocking a push is not.
    """
    fallback = os.path.abspath(repo_dir)
    try:
        proc = subprocess.run(
            ["git", "-C", repo_dir, "rev-parse",
             "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return fallback
    if proc.returncode != 0:
        return fallback
    common = proc.stdout.strip()
    if not common:
        return fallback
    return os.path.dirname(os.path.abspath(common))


def baseline_path(repo_dir, base=BASELINE_DIR):
    slug = repo_key(repo_dir).replace("/", "-")
    return os.path.join(base, slug + ".json")


def load_baseline(path):
    """Return a normalized baseline dict, or None if absent or malformed.

    This is the SINGLE validation point for baseline shape. Callers may assume
    `routes` and `prerendered` are dicts, and that `rsc_total` is either a dict
    or absent — so `verdict` carries no shape defences of its own.

    `.get(key, default)` and `or {}` are not type checks: the default only
    fires on a *missing* key and `or {}` only on a *falsy* value, so a
    corrupt-but-truthy value (a list, a string) sails past both and raises
    downstream. Validation is by isinstance, here, once. A JSON `null` for an
    optional key is normalized to "absent" rather than treated as corrupt, so
    a baseline written before a key existed still loads.

    A corrupt baseline must never block a push — it is re-recorded instead.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("prerendered"), dict):
        return None

    routes = data.get("routes")
    if routes is None:
        routes = {}
    if not isinstance(routes, dict):
        return None
    data["routes"] = routes

    rsc = data.get("rsc_total")
    if rsc is None:
        data.pop("rsc_total", None)
    elif not isinstance(rsc, dict):
        return None
    return data


def save_baseline(path, repo_dir, routes, sizes, rsc_total, previous):
    """Write the baseline, carrying `first_seen` forward from `previous`.

    `last` tracks the most recent passing push. `first_seen` is never
    overwritten, so growth that stays under the per-push ratio still trips
    the cumulative comparison. `rsc_total` is tracked as a single aggregate
    (see measure_rsc_total) under the same ratchet semantics as prerendered
    entries.

    Passing `previous=None` resets every `first_seen` to the current reading.
    That is how the accept path clears a warning: without it, a file once past
    the ratio warns on every push forever, and the only cure is deleting the
    baseline by hand.
    """
    prev_pre = (previous or {}).get("prerendered", {})
    prerendered = {}
    for name, size in sizes.items():
        old = prev_pre.get(name)
        first = old.get("first_seen", size) if isinstance(old, dict) else size
        prerendered[name] = {"last": size, "first_seen": first}

    prev_rsc = (previous or {}).get("rsc_total")
    rsc_first = prev_rsc.get("first_seen", rsc_total) if isinstance(prev_rsc, dict) else rsc_total
    rsc_entry = {"last": rsc_total, "first_seen": rsc_first}

    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"repo": os.path.abspath(repo_dir),
                   "routes": routes,
                   "prerendered": prerendered,
                   "rsc_total": rsc_entry}, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


RATIO = 3
ABSOLUTE = 1048576  # 1 MiB raw. Largest real artifact on 2026-08-03 was 271_683.


class PayloadWarning(str):
    """A warning line that also carries the growth multiple behind it.

    A non-blocking hook surfaces only the FIRST line of its stderr, so the gate
    has to lead with a summary naming the worst offender (see
    `warning_summary`). Ranking needs the multiple as a number: re-parsing it
    back out of the formatted text would be fragile, and returning dicts would
    break substring assertions on the warning text. Subclassing `str` keeps the
    value a plain string for every other caller.
    """

    def __new__(cls, text, multiple=0.0, short=""):
        obj = super().__new__(cls, text)
        obj.multiple = multiple
        obj.short = short or text
        return obj


def _ratchet_warning(label, size, old, ratio):
    """One PayloadWarning for `label` if `size` outgrew its baseline, else None.

    Both bases are reported when both trip, largest multiple first. Reporting
    only the first one to fire understates the damage: last=100,
    first_seen=10, size=400 is 4.0x since the last push but 40x cumulative.
    """
    parts = []
    for basis, ref in (("first seen", old.get("first_seen", 0)),
                       ("last push", old.get("last", 0))):
        if isinstance(ref, (int, float)) and ref > 0 and size > ratio * ref:
            parts.append((size / ref, basis, ref))
    if not parts:
        return None
    parts.sort(reverse=True)
    worst = parts[0]
    text = "{}: {} B, {}".format(label, size, ", ".join(
        "{:.1f}x {} ({} B)".format(mult, basis, ref) for mult, basis, ref in parts))
    return PayloadWarning(
        text, multiple=worst[0],
        short="{} {:.1f}x {}".format(label, worst[0], worst[1]))


def verdict(baseline, routes, sizes, rsc_total, ratio=RATIO, absolute=ABSOLUTE):
    """Return (blocks, warnings).

    Blocks: a route that was prerendered in the baseline and is now dynamic.
    New routes never block, however they render — only flips do.
    Warnings never block; they are advisory by design (spec D2).

    `baseline` must have come from `load_baseline`, which is the single point
    where shape is validated; there are deliberately no `or {}` defences here.
    Duplicating the guard in every reader is what let the same
    corrupt-but-truthy bug ship three times.

    The absolute size backstop applies to every prerendered file independently
    of the ratio check — a file can trip the ratio, the backstop, both, or
    neither. It is not exclusive to files with no baseline entry.

    `rsc_total` (owner ruling) is checked only against the ratio ratchet,
    on both the baseline's `last` and `first_seen` readings, exactly like a
    per-file prerendered entry. It never gets the absolute backstop: a fixed
    byte ceiling on a whole-repo aggregate is meaningless across repos of
    different sizes, so only relative growth is meaningful here.
    """
    blocks, warnings = [], []

    base_routes = baseline.get("routes", {})
    for route, marker in sorted(routes.items()):
        was = base_routes.get(route)
        if was in PRERENDERED and marker == DYNAMIC:
            blocks.append(
                "render-mode flip: {} was {} (prerendered), now {} (dynamic)"
                .format(route, was, marker))

    base_pre = baseline.get("prerendered", {})
    for name, size in sorted(sizes.items()):
        old = base_pre.get(name)
        if isinstance(old, dict):
            warn = _ratchet_warning(name, size, old, ratio)
            if warn is not None:
                warnings.append(warn)
        if size > absolute:
            warnings.append(PayloadWarning(
                "{}: {} B exceeds the 1 MiB backstop".format(name, size),
                short="{} over the 1 MiB backstop".format(name)))

    base_rsc = baseline.get("rsc_total")
    if isinstance(base_rsc, dict):
        warn = _ratchet_warning("rsc total", rsc_total, base_rsc, ratio)
        if warn is not None:
            warnings.append(warn)
    return blocks, warnings


def warning_summary(warnings):
    """One self-contained line naming the worst offender.

    A PreToolUse hook exiting non-zero-non-2 gets exactly one line surfaced in
    the transcript — the first line of stderr. Everything after it is detail
    the owner only ever sees in the debug log, so a first line reading merely
    "warnings found" wastes the only channel the warn tier has.
    """
    worst = max(warnings, key=lambda w: getattr(w, "multiple", 0.0))
    short = getattr(worst, "short", None) or str(worst)
    if len(warnings) == 1:
        return "payload-gate: 1 payload warning: {}".format(short)
    return "payload-gate: {} payload warnings (largest: {})".format(
        len(warnings), short)


# Exit codes. 3, not 1, for the warn tier: CPython itself exits 1 on a
# SyntaxError or an unhandled exception, so hook.sh could not tell "the gate
# found warnings" from "the gate crashed". This is the same collision that
# made the block code unusable as a malfunction signal — an interpreter-level
# exit code must never double as an application-level one.
EXIT_OK = 0
EXIT_BLOCK = 2
EXIT_WARN = 3

ACCEPT_VALUES = frozenset({"1", "true"})


def main(argv):
    if len(argv) != 3:
        print("usage: payload_gate.py <repo_dir> <build_output_file>", file=sys.stderr)
        return EXIT_OK  # never block on our own misuse
    repo_dir, out_file = argv[1], argv[2]
    base = os.environ.get("PAYLOAD_BASELINE_DIR", BASELINE_DIR)
    accept = os.environ.get("PAYLOAD_GATE_ACCEPT", "").strip().lower() in ACCEPT_VALUES

    try:
        text = open(out_file, encoding="utf-8", errors="replace").read()
    except OSError:
        return EXIT_OK

    routes = parse_route_table(text)
    sizes = measure_prerendered(repo_dir)
    rsc_total = measure_rsc_total(repo_dir)
    if not routes and not sizes and not rsc_total:
        return EXIT_OK  # not a Next.js build — no-op (e.g. my-trading-app/site, Astro)

    path = baseline_path(repo_dir, base)
    baseline = load_baseline(path)

    if baseline is None:
        save_baseline(path, repo_dir, routes, sizes, rsc_total, None)
        print("payload-gate: baseline created at {}".format(path), file=sys.stderr)
        return EXIT_OK

    blocks, warnings = verdict(baseline, routes, sizes, rsc_total)

    if blocks and not accept:
        # Blocks lead: on exit 2 the whole stderr is fed back, and the flip is
        # why the push stopped. Warnings follow as context.
        for b in blocks:
            print("payload-gate: BLOCKED {}".format(b), file=sys.stderr)
        for w in warnings:
            print("payload-gate: WARN {}".format(w), file=sys.stderr)
        print("payload-gate: re-run as `PAYLOAD_GATE_ACCEPT=1 git push` to accept "
              "and re-record the baseline.", file=sys.stderr)
        return EXIT_BLOCK

    # `previous=None` under accept resets every first_seen to the current
    # reading, so accept clears warnings as well as blocks. Carrying first_seen
    # forward here is what made a tripped warning permanent.
    save_baseline(path, repo_dir, routes, sizes, rsc_total,
                  None if accept else baseline)

    if accept:
        for item in blocks + warnings:
            print("payload-gate: accepted {}".format(item), file=sys.stderr)
        return EXIT_OK

    if warnings:
        print(warning_summary(warnings), file=sys.stderr)
        for w in warnings:
            print("payload-gate: WARN {}".format(w), file=sys.stderr)
        return EXIT_WARN
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv))
