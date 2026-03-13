#!/usr/bin/env python3
"""Sync script for claude-code-setup.

Copies files from a live ~/.claude/ directory into this repo,
applying anonymization replacements to strip personal data.
"""

from __future__ import annotations

import argparse
import fnmatch
import glob
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


# ── Anonymization ───────────────────────────────────────────────


def build_replacements(raw: dict) -> list[tuple[str, str]]:
    """Sort replacements longest-first to prevent partial matches."""
    return sorted(raw.items(), key=lambda kv: len(kv[0]), reverse=True)


def anonymize(content: str, replacements: list[tuple[str, str]], patterns: dict | None) -> tuple[str, int]:
    """Apply all anonymization rules to content.

    Returns (anonymized_content, replacement_count).
    """
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


# ── Audit ───────────────────────────────────────────────────────


def audit_files(target_dir: Path, audit_patterns: list[str]) -> list[str]:
    """Check all synced files for patterns that should not survive anonymization.

    Returns a list of warning strings.
    """
    warnings: list[str] = []

    audit_extensions = ("*.md", "*.html", "*.yml", "*.yaml")
    all_files: list[Path] = []
    for ext in audit_extensions:
        all_files.extend(target_dir.rglob(ext))

    for audit_file in sorted(set(all_files)):
        # Skip files not tracked (e.g., the scripts/ directory)
        rel = audit_file.relative_to(REPO_ROOT)
        if str(rel).startswith("scripts/"):
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

    total_replacements = 0
    copied = 0

    for src, dest in pairs:
        try:
            rel_src = src.relative_to(source)
        except ValueError:
            # Extra file outside source directory
            rel_src = src
        rel_dest = dest.relative_to(REPO_ROOT)

        content = src.read_text(encoding="utf-8")
        anonymized, count = anonymize(content, replacements, patterns)
        total_replacements += count

        if dry_run:
            status = f"({count} replacements)" if count else "(no changes)"
            log.info("  %s → %s %s", rel_src, rel_dest, status)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(anonymized, encoding="utf-8")
            copied += 1
            log.info("  %s → %s (%d replacements)", rel_src, rel_dest, count)

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
        run_sync(args.source, config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
