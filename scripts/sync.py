#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["PyYAML>=6.0"]
# ///
#
# Run this as `./scripts/sync.py`, which needs no setup step at all: uv reads
# the block above and builds the environment on first run.
#
# The dependency is stated in TWO places on purpose — here and in
# scripts/requirements.txt — because this repo is published for people who may
# not use uv, and requirements.txt is their path (see scripts/README.md). Keep
# the two in step; there is exactly one dependency, which is what makes the
# duplication affordable rather than a lockfile problem.
"""Sync script for claude-code-setup.

Copies files from a live ~/.claude/ directory into this repo,
applying anonymization replacements to strip personal data.
"""

from __future__ import annotations

import argparse
import fnmatch
import glob
import json
import logging
import re
import subprocess
import sys
from pathlib import Path

import yaml

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s  %(message)s",
)
log = logging.getLogger("sync")

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path.home() / ".claude"
DEFAULT_CONFIG = Path(__file__).resolve().parent / "anonymization.yaml"


# ── Config loading ──────────────────────────────────────────────


def load_config(config_path: Path) -> dict:
    """Load and validate the anonymization config."""
    if not config_path.exists():
        log.error("Config not found: %s", config_path)
        log.error("Copy anonymization.example.yaml to anonymization.yaml and fill in your data.")
        sys.exit(1)

    with open(config_path, encoding="utf-8") as f:
        try:
            config = yaml.safe_load(f)
        except yaml.YAMLError as exc:
            log.error("Invalid YAML in %s: %s", config_path, exc)
            sys.exit(1)

    for key in ("replacements", "file_map"):
        if key not in config:
            log.error("Missing required key '%s' in config", key)
            sys.exit(1)

    return config


# ── File discovery ──────────────────────────────────────────────


def should_skip(rel_path: str, skip_patterns: list[str]) -> bool:
    """Check if a relative path matches any skip pattern."""
    for pattern in skip_patterns:
        if fnmatch.fnmatch(rel_path, pattern):
            return True
        # Also check if any parent directory matches
        parts = Path(rel_path).parts
        for i in range(len(parts)):
            partial = str(Path(*parts[: i + 1]))
            if fnmatch.fnmatch(partial, pattern.rstrip("/**")):
                return True
    return False


def discover_files(source: Path, file_map: dict, skip_patterns: list[str]) -> list[tuple[Path, Path]]:
    """Discover source files and compute their destination paths.

    Returns a list of (source_path, dest_path) tuples.
    """
    pairs: list[tuple[Path, Path]] = []

    for src_pattern, dest_pattern in file_map.items():
        matched = sorted(glob.glob(str(source / src_pattern), recursive=True))
        for match_str in matched:
            match_path = Path(match_str)
            if not match_path.is_file():
                continue

            rel = match_path.relative_to(source)
            if should_skip(str(rel), skip_patterns):
                continue

            # Determine destination
            if dest_pattern.endswith("/"):
                # Directory target: preserve relative structure under the
                # pattern's base directory. E.g. skills/**/*.md matched
                # skills/code-quality/SKILL.md → dest skills/code-quality/SKILL.md
                pattern_base = src_pattern.split("*")[0].rstrip("/")
                if pattern_base:
                    try:
                        inner_rel = match_path.relative_to(source / pattern_base)
                    except ValueError:
                        inner_rel = Path(match_path.name)
                else:
                    inner_rel = Path(match_path.name)
                dest = REPO_ROOT / dest_pattern / inner_rel
            else:
                # Exact file target
                dest = REPO_ROOT / dest_pattern

            pairs.append((match_path, dest))

    return pairs


# ── Private-region redaction ────────────────────────────────────

# A region between these two markers is DROPPED from the published copy,
# markers included. It exists because the leak this repo has to prevent is no
# longer only a name: whole paragraphs of ~/.claude/ describe the owner's
# writing and job-search pipelines, and those pipelines are out of
# scope for a repo about writing code. `skip` handles a file that is entirely
# private; this handles the far commoner case of a file that is mostly public
# with a private section inside it -- scheduled-jobs/SKILL.md is 60% launchd
# rules anyone can use and 40% a roster of jobs that are not about code.
#
# Why markers in the live source and not a rule list here: a regex list would
# have to be re-tuned every time the owner rewords a paragraph, and it fails
# OPEN when it drifts. A marker moves with the text it wraps.
#
# The token is deliberately comment-syntax-agnostic -- a line merely has to
# CONTAIN it -- so the same pair works in Markdown, shell, Python, HTML and
# inside a JS array literal.
REDACT_BEGIN = "SYNC-PRIVATE:BEGIN"
REDACT_END = "SYNC-PRIVATE:END"

# A pair that opens AND closes on one line redacts just that span, leaving the
# rest of the line intact. Without it the only way to drop a clause from the
# middle of a paragraph is to reflow the paragraph around it, which makes the
# live file worse to read every time something is marked -- and a mechanism
# that degrades the source is one the owner stops using. Non-greedy so two
# pairs on one line stay two pairs.
#
# Each marker may be wrapped in an HTML comment, and the wrapper is consumed
# with it. Marking a clause inside a Markdown paragraph means writing
# `<!-- BEGIN -->clause<!-- END -->` — the only form that stays invisible when
# the live file is read as Markdown — and matching the bare tokens alone would
# publish the leftover `<!--` and `-->`. That exact residue appeared in
# CLAUDE.md on the first run of this feature.
_MARKER = r"(?:<!--\s*)?{}(?:\s*-->)?"
_INLINE_PAIR = re.compile(
    _MARKER.format(re.escape(REDACT_BEGIN)) + ".*?" + _MARKER.format(re.escape(REDACT_END))
)


class RedactionError(RuntimeError):
    """A file's private-region markers are unbalanced.

    Fatal on purpose. An unclosed BEGIN would silently truncate a file to its
    first private section, and a stray END would publish everything above it:
    both failure modes are invisible in the output, and one of them leaks. The
    guard fails CLOSED on its own malfunction -- the sync aborts rather than
    guessing which reading was intended.
    """


def redact(content: str, origin: str = "<content>") -> tuple[str, int]:
    """Strip every SYNC-PRIVATE region from content.

    Returns (redacted_content, regions_removed). A file with no markers is
    returned byte-identical, so this is a no-op for the vast majority of
    synced files.
    """
    if REDACT_BEGIN not in content and REDACT_END not in content:
        return content, 0

    kept: list[str] = []
    depth = 0
    regions = 0
    open_line = 0

    for lineno, raw_line in enumerate(content.splitlines(keepends=True), 1):
        # Inline pairs go first, so a line carrying a complete pair never
        # reaches the block logic below and cannot open a phantom region.
        line, inline_hits = _INLINE_PAIR.subn("", raw_line)
        if inline_hits and not depth:
            regions += inline_hits
            if not line.strip():
                # The markers wrapped the entire line: treat it as a one-line
                # block region rather than leaving a blank behind.
                continue
            # A marked clause usually sits mid-sentence, so removing it leaves
            # a doubled space or a space before punctuation. Tidy only what the
            # removal itself created.
            line = re.sub(r"  +", " ", line)
            line = re.sub(r" +([,.;:)])", r"\1", line)
            kept.append(line)
            continue

        if REDACT_BEGIN in line:
            if depth:
                raise RedactionError(
                    f"{origin}:{lineno}: nested {REDACT_BEGIN} "
                    f"(region opened at line {open_line} is still open)"
                )
            depth = 1
            open_line = lineno
            # Collapse the blank line that preceded the region: without this a
            # section removed from the middle of a Markdown file leaves a
            # double blank behind, and the published file stops being a clean
            # document with a hole in it.
            if kept and not kept[-1].strip():
                kept.pop()
            continue
        if REDACT_END in line:
            if not depth:
                raise RedactionError(f"{origin}:{lineno}: {REDACT_END} with no matching {REDACT_BEGIN}")
            depth = 0
            regions += 1
            continue
        if not depth:
            kept.append(line)

    if depth:
        raise RedactionError(f"{origin}:{open_line}: {REDACT_BEGIN} with no matching {REDACT_END}")

    return "".join(kept), regions


# ── Anonymization ───────────────────────────────────────────────


def build_replacements(raw: dict) -> list[tuple[str, str]]:
    """Sort replacements longest-first to prevent partial matches."""
    return sorted(raw.items(), key=lambda kv: len(kv[0]), reverse=True)


def anonymize(
    content: str,
    replacements: list[tuple[str, str]],
    patterns: dict | None,
    origin: str = "<content>",
) -> tuple[str, int]:
    """Apply all anonymization rules to content.

    Redaction runs FIRST, before any replacement or regex: a private region is
    content that must not exist in the published file at all, so there is no
    point anonymizing text that is about to be deleted -- and running it first
    means a private paragraph can never be "saved" by a replacement rule that
    happens to launder it into something that looks publishable.

    Returns (anonymized_content, replacement_count). Redacted regions are NOT
    counted as replacements: the two are different operations and the caller
    reports the replacement count per file.
    """
    content, _regions = redact(content, origin)
    count = 0

    # Exact replacements (longest first)
    for old, new in replacements:
        occurrences = content.count(old)
        if occurrences:
            content = content.replace(old, new)
            count += occurrences

    # Regex patterns
    if patterns:
        for pattern, replacement in patterns.items():
            matches = re.findall(pattern, content)
            if matches:
                content = re.sub(pattern, replacement, content)
                count += len(matches)

    return content, count


# ── Hooks registration snippet ──────────────────────────────────

HOOKS_SETTINGS_DEST = REPO_ROOT / "hooks" / "settings.hooks.json"

# hooks/README.md is owner-maintained (documents registration + verification,
# like docs/philosophy.md), not sourced from live ~/.claude/hooks/. It still
# lives under the hooks/ synced root, so it needs the same orphan-pruning
# exemption as HOOKS_SETTINGS_DEST or a real sync would delete it. Pruning is
# only half the protection: the config's 'hooks/*.md' mapping also makes it a
# possible sync DESTINATION, which is why 'hooks/README.md' is in `skip`.
HOOKS_README_DEST = REPO_ROOT / "hooks" / "README.md"

# claude-scripts/README.md is owner-maintained for the same reason: it lives
# under the claude-scripts/ synced root (file_map's 'scripts/*.sh' and
# 'scripts/*.py' target) but isn't itself sourced from a live script, so it
# needs the same orphan-pruning exemption. It needs no `skip` counterpart:
# those are the only mappings targeting claude-scripts/ and neither can match
# a .md file.
CLAUDE_SCRIPTS_README_DEST = REPO_ROOT / "claude-scripts" / "README.md"


def read_hooks_config(source: Path) -> dict | None:
    """Return the `hooks` mapping of the live settings.json, or None if unusable.

    None means the file is missing, unparseable, or carries no hooks at all.
    Every caller must then leave its artifact alone: writing `{"hooks": {}}`
    and rendering a "0 hooks" guide is silent, looks deliberate, and
    contradicts a README that still claims four. A malformed file is treated
    as missing rather than raising, so a typo in a private config cannot
    abort a sync halfway through with 23 files already written.
    """
    settings_path = source / "settings.json"
    if not settings_path.exists():
        log.warning("Live settings.json not found: %s", settings_path)
        return None

    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        log.warning("Live settings.json is unreadable (%s) — treating it as missing", exc)
        return None

    hooks = data.get("hooks") if isinstance(data, dict) else None
    if not hooks:
        log.warning("Live settings.json registers no hooks — leaving the hooks surface as-is")
        return None
    return hooks


def generate_hooks_settings(
    source: Path, replacements: list[tuple[str, str]], patterns: dict | None, dry_run: bool
) -> bool:
    """Derive hooks/settings.hooks.json from live settings.json's `hooks` key.

    settings.json itself is skipped entirely (permissions/plugins/personal
    config must stay private), but a hand-copied registration snippet would
    drift the moment a hook is added or removed. Extract only the `hooks`
    key, run it through the same anonymize() path as every other synced
    file, and write it out. Returns whether the destination is stale
    (dry-run only).
    """
    rel = HOOKS_SETTINGS_DEST.relative_to(REPO_ROOT)
    hooks = read_hooks_config(source)
    if hooks is None:
        log.warning("Skipping %s (existing file left untouched)", rel)
        return False

    content = json.dumps({"hooks": hooks}, indent=2) + "\n"
    anonymized, _count = anonymize(content, replacements, patterns, origin=str(source / "settings.json"))

    is_stale = False
    if dry_run:
        current = HOOKS_SETTINGS_DEST.read_text(encoding="utf-8") if HOOKS_SETTINGS_DEST.exists() else None
        if current is None:
            status = "would create"
            is_stale = True
        elif anonymized != current:
            status = "would update"
            is_stale = True
        else:
            status = "up to date"
        log.info("  settings.json[hooks] → %s (%s)", rel, status)
    else:
        HOOKS_SETTINGS_DEST.parent.mkdir(parents=True, exist_ok=True)
        HOOKS_SETTINGS_DEST.write_text(anonymized, encoding="utf-8")
        log.info("  generated %s", rel)

    return is_stale


# ── Audit ───────────────────────────────────────────────────────

# Owner-maintained files whose real name, links and handles are deliberate:
# they are written by hand, never synced, and are the one place the repo is
# supposed to say who published it. commands/sync-setup.md Step 5 already
# carves README.md out in prose; encode it here so the gate can go green.
# A gate that has never once passed cannot signal anything.
AUDIT_ALLOWLIST = frozenset({"README.md", "LICENSE"})


def git_visible_files() -> set[str] | None:
    """Repo-relative paths git does NOT ignore (tracked + untracked-not-ignored).

    Returns None when the question can't be answered (not a git repo, no git
    binary), in which case callers audit everything rather than skip silently.
    """
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return {ln for ln in result.stdout.splitlines() if ln.strip()}


def audit_files(target_dir: Path, audit_patterns: list[str]) -> list[str]:
    """Check all synced files for patterns that should not survive anonymization.

    Returns a list of warning strings.
    """
    warnings: list[str] = []

    # JSON belongs here: hooks/settings.hooks.json is a synced output too, and
    # scripts/README.md advertises the audit as covering all output files.
    audit_extensions = ("*.md", "*.html", "*.yml", "*.yaml", "*.sh", "*.json")
    all_files: list[Path] = []
    for ext in audit_extensions:
        all_files.extend(target_dir.rglob(ext))

    visible = git_visible_files()

    for audit_file in sorted(set(all_files)):
        # Skip files not tracked (e.g., the scripts/ directory)
        rel = audit_file.relative_to(REPO_ROOT)
        if str(rel).startswith("scripts/"):
            continue
        if str(rel) in AUDIT_ALLOWLIST:
            continue
        # Gitignored files (e.g. .claude/agent-memory/) can never be pushed,
        # so a match there is not a leak — only noise that reddens the gate.
        if visible is not None and str(rel) not in visible:
            continue

        try:
            content = audit_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        for i, line in enumerate(content.splitlines(), 1):
            for pattern in audit_patterns:
                if re.search(pattern, line, re.IGNORECASE):
                    warnings.append(f"  {rel}:{i}  matches '{pattern}': {line.strip()[:120]}")

    return warnings


# ── Orphan pruning ──────────────────────────────────────────────


def synced_roots(file_map: dict) -> list[str]:
    """Top-level repo directories that are fully owned by the sync.

    These are the directory destinations in file_map (e.g. 'commands/',
    'agents/'). Root-level file destinations (e.g. 'CLAUDE.md') are NOT
    roots — the sync never prunes outside a directory root it owns.
    """
    roots: set[str] = set()
    for dest in file_map.values():
        if dest.endswith("/"):
            roots.add(dest.split("/")[0])
    return sorted(roots)


def prune_orphans(produced_dests: set[Path], file_map: dict, dry_run: bool) -> int:
    """Delete repo files under a synced root whose live source disappeared.

    For each synced root (commands/, agents/, skills/, hooks/, rules/), any
    non-gitignored file that was NOT produced by this run is an orphan
    (e.g. a renamed/deleted agent or a retired hook script). Orphans are
    deleted on a real run, reported on a dry run.

    Owner-maintained trees (docs/, README.md, root-level files) are never
    touched because they are not directory roots in file_map. Gitignored
    files are excluded via `git ls-files --exclude-standard`.
    """
    roots = synced_roots(file_map)
    produced_rel = {str(p.relative_to(REPO_ROOT)) for p in produced_dests}
    removed = 0
    orphans: list[str] = []

    for root in roots:
        root_dir = REPO_ROOT / root
        if not root_dir.exists():
            continue
        # Candidate set = tracked + untracked-but-not-ignored files under root.
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", root],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        candidates = [ln for ln in result.stdout.splitlines() if ln.strip()]
        for rel in candidates:
            # Skip phantoms: files already unlinked this session but still in the
            # git index because the deletion has not been committed yet.
            if rel not in produced_rel and (REPO_ROOT / rel).exists():
                orphans.append(rel)

    if not orphans:
        return 0

    log.info("")
    log.info("── Orphans ─────────────────────────────")
    for rel in sorted(orphans):
        abs_path = REPO_ROOT / rel
        if dry_run:
            log.info("  ORPHAN (would delete): %s", rel)
        else:
            abs_path.unlink(missing_ok=True)
            log.info("  DELETED orphan: %s", rel)
        removed += 1

    # Remove now-empty directories left behind by real deletions.
    if not dry_run:
        for root in roots:
            root_dir = REPO_ROOT / root
            if not root_dir.exists():
                continue
            for sub in sorted(root_dir.rglob("*"), reverse=True):
                if sub.is_dir() and not any(sub.iterdir()):
                    sub.rmdir()

    return removed


# ── Main operations ─────────────────────────────────────────────


def run_sync(source: Path, config: dict, dry_run: bool = False) -> None:
    """Copy files from source to repo, applying anonymization."""
    replacements = build_replacements(config["replacements"])
    patterns = config.get("patterns")
    skip_patterns = config.get("skip", [])
    file_map = config["file_map"]
    audit_patterns = config.get("audit_patterns", [])

    pairs = discover_files(source, file_map, skip_patterns)

    # Extra files from outside the source directory
    extra_files = config.get("extra_files", {})
    for src_path_str, dest_path_str in extra_files.items():
        src_path = Path(src_path_str).expanduser()
        if src_path.exists():
            pairs.append((src_path, REPO_ROOT / dest_path_str))
        else:
            log.warning("Extra file not found: %s", src_path)

    if not pairs:
        log.warning("No files matched the file_map patterns in %s", source)
        return

    # Preflight: validate every source's private-region markers BEFORE writing
    # anything. Letting the copy loop raise instead would abort halfway through
    # — some destinations rewritten, the malformed source either truncated or
    # published whole — and a half-applied sync is the one outcome worse than
    # no sync at all. redact() is a cheap no-op on the files with no markers,
    # which is nearly all of them.
    for src, _dest in pairs:
        redact(src.read_text(encoding="utf-8"), origin=str(src))

    # The two derived outputs are not in `pairs` and are written after the copy
    # loop, so they need the same preflight or they reintroduce the half-sync
    # this guard exists to prevent. Both are optional inputs — generate_guide()
    # and generate_hooks_settings() already tolerate a missing source — so a
    # non-existent file is not an error here either.
    from generate_workflow_guide import LIVE_GUIDE

    for extra in (LIVE_GUIDE, source / "settings.json"):
        if extra.exists():
            redact(extra.read_text(encoding="utf-8"), origin=str(extra))

    total_replacements = 0
    copied = 0
    stale = 0

    for src, dest in pairs:
        try:
            rel_src = src.relative_to(source)
        except ValueError:
            # Extra file outside source directory
            rel_src = src
        rel_dest = dest.relative_to(REPO_ROOT)

        content = src.read_text(encoding="utf-8")
        anonymized, count = anonymize(content, replacements, patterns, origin=str(src))
        total_replacements += count

        if dry_run:
            # Compare against what is actually on disk. A replacement count says
            # nothing about whether the destination is current — reporting it as
            # the status made every mapped file look fine even when stale, so
            # /cleanup's Step 4 could never detect drift. Mirrors the comparison
            # generate_guide() has always done for the workflow guide.
            current = dest.read_text(encoding="utf-8") if dest.exists() else None
            if current is None:
                status = "would create"
                stale += 1
            elif anonymized != current:
                status = "would update"
                stale += 1
            else:
                status = "up to date"
            log.info("  %s → %s (%s, %d replacements)", rel_src, rel_dest, status, count)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(anonymized, encoding="utf-8")
            copied += 1
            log.info("  %s → %s (%d replacements)", rel_src, rel_dest, count)

    # Generate the workflow guide DATA section from live config.
    # Local import to avoid a circular import at module load time.
    from generate_workflow_guide import generate_guide

    guide_todos, guide_stale = generate_guide(source, replacements, patterns, dry_run)
    if guide_stale:
        stale += 1

    # Derive the hooks registration snippet from live settings.json.
    hooks_settings_stale = generate_hooks_settings(source, replacements, patterns, dry_run)
    if hooks_settings_stale:
        stale += 1

    # Prune orphaned repo files under synced roots (renamed/deleted sources).
    # hooks/settings.hooks.json is generated (not file_map-derived) but lives
    # under the hooks/ root, so it must be added explicitly or it reads as an
    # orphan and gets deleted on the very next real run.
    produced_dests = {dest for _, dest in pairs}
    produced_dests.add(HOOKS_SETTINGS_DEST)
    produced_dests.add(HOOKS_README_DEST)
    produced_dests.add(CLAUDE_SCRIPTS_README_DEST)
    orphan_count = prune_orphans(produced_dests, file_map, dry_run)

    # Audit
    if not dry_run and audit_patterns:
        log.info("")
        log.info("Running post-sync audit...")
        warnings = audit_files(REPO_ROOT, audit_patterns)
        if warnings:
            log.warning("AUDIT WARNINGS (%d):", len(warnings))
            for w in warnings:
                log.warning(w)
        else:
            log.info("Audit clean")

    # Summary
    log.info("")
    log.info("── Summary ─────────────────────────────")
    if dry_run:
        log.info("  DRY RUN — no files written")
    log.info("  Files:        %d", len(pairs) if dry_run else copied)
    log.info("  Replacements: %d", total_replacements)
    log.info("  Orphans:      %d %s", orphan_count, "(would delete)" if dry_run else "(deleted)")
    if dry_run:
        # Single staleness signal, covering mapped files and the generated guide.
        # 0 means the repo is a faithful anonymized image of the live config.
        log.info("  Stale:        %d (would write)", stale)
    if guide_todos:
        log.info("  Guide TODOs:  %d (entries need hand-written prose)", len(guide_todos))
        for t in guide_todos:
            log.info("    - %s", t)
    if not dry_run and audit_patterns:
        warning_count = len(warnings) if not dry_run else 0
        log.info("  Audit warns:  %d", warning_count)

    if not dry_run:
        log.info("")
        log.info("── Git diff ────────────────────────────")
        result = subprocess.run(
            ["git", "diff", "--stat"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if result.stdout.strip():
            print(result.stdout)
        else:
            log.info("  (no changes)")

        log.info("")
        log.info("Review changes, then commit manually.")


def run_audit_only(config: dict) -> None:
    """Run audit on existing repo files without syncing."""
    audit_patterns = config.get("audit_patterns", [])
    if not audit_patterns:
        log.warning("No audit_patterns defined in config.")
        return

    log.info("Running audit on existing files...")
    warnings = audit_files(REPO_ROOT, audit_patterns)
    if warnings:
        log.warning("AUDIT WARNINGS (%d):", len(warnings))
        for w in warnings:
            log.warning(w)
        sys.exit(1)
    else:
        log.info("Audit clean")


# ── CLI ─────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sync and anonymize Claude Code config files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without writing files.",
    )
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help="Run audit on existing repo files without syncing.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"Source directory (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help=f"Config file path (default: {DEFAULT_CONFIG})",
    )

    args = parser.parse_args()
    config = load_config(args.config)

    if args.audit_only:
        run_audit_only(config)
    else:
        try:
            run_sync(args.source, config, dry_run=args.dry_run)
        except RedactionError as exc:
            # Exit 2 in the portfolio convention: the sync could NOT run, which
            # is not the same as "nothing to do". Half a sync is the dangerous
            # outcome here — some files rewritten, the malformed one either
            # truncated or published whole — so this aborts rather than
            # skipping the offending file and carrying on.
            log.error("Unbalanced private-region markers: %s", exc)
            log.error("Fix the markers in the live source; nothing was published.")
            sys.exit(2)


if __name__ == "__main__":
    main()
