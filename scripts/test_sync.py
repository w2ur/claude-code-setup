#!/usr/bin/env python3
"""Tests for sync.py's guards around the live settings.json and the audit.

The hooks surface (hooks/settings.hooks.json + the guide's HOOKS array) is
derived entirely from the live settings.json. Every failure mode of that one
file used to be silent: a missing `hooks` key published `{"hooks": {}}` and a
guide rendering "0 hooks" while README.md still claimed four, and a malformed
file raised after 23 files had already been written.

Run with: pytest scripts/test_sync.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import generate_workflow_guide as guide
import sync
from sync import audit_files, generate_hooks_settings, read_hooks_config

VALID_HOOKS = {
    "PreToolUse": [
        {
            "matcher": "Bash",
            "hooks": [{"type": "command", "command": "~/.claude/hooks/secret-scan/hook.sh"}],
        }
    ]
}


def _write_settings(tmp_path: Path, body: str) -> Path:
    (tmp_path / "settings.json").write_text(body, encoding="utf-8")
    return tmp_path


# ── read_hooks_config ───────────────────────────────────────────


def test_read_hooks_config_returns_the_hooks_mapping(tmp_path):
    _write_settings(tmp_path, json.dumps({"hooks": VALID_HOOKS, "permissions": {}}))
    assert read_hooks_config(tmp_path) == VALID_HOOKS


@pytest.mark.parametrize(
    ("label", "body"),
    [
        ("no hooks key", '{"permissions": {}}'),
        ("empty hooks", '{"hooks": {}}'),
        ("null hooks", '{"hooks": null}'),
        ("malformed json", "{ not json"),
        ("not an object", "[1, 2, 3]"),
    ],
)
def test_read_hooks_config_reports_every_unusable_shape_as_none(tmp_path, label, body):
    _write_settings(tmp_path, body)
    assert read_hooks_config(tmp_path) is None, label


def test_read_hooks_config_treats_a_missing_file_as_none(tmp_path):
    assert read_hooks_config(tmp_path) is None


# ── The artifacts stay put when the source is unusable ──────────


def test_generate_hooks_settings_leaves_the_snippet_alone(tmp_path, monkeypatch):
    dest = tmp_path / "settings.hooks.json"
    dest.write_text('{"hooks": {"PreToolUse": []}}\n', encoding="utf-8")
    before = dest.read_text(encoding="utf-8")
    monkeypatch.setattr(sync, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(sync, "HOOKS_SETTINGS_DEST", dest)

    source = _write_settings(tmp_path, '{"permissions": {}}')
    assert generate_hooks_settings(source, [], None, dry_run=False) is False
    assert dest.read_text(encoding="utf-8") == before


def test_generate_hooks_settings_writes_when_the_source_is_usable(tmp_path, monkeypatch):
    dest = tmp_path / "settings.hooks.json"
    monkeypatch.setattr(sync, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(sync, "HOOKS_SETTINGS_DEST", dest)

    source = _write_settings(tmp_path, json.dumps({"hooks": VALID_HOOKS}))
    generate_hooks_settings(source, [], None, dry_run=False)
    assert json.loads(dest.read_text(encoding="utf-8"))["hooks"] == VALID_HOOKS


@pytest.mark.parametrize("body", ['{"hooks": {}}', "{ not json"])
def test_generate_guide_leaves_the_published_guide_alone(tmp_path, monkeypatch, body):
    live = tmp_path / "live-guide.html"
    live.write_text("const HOOKS = [\n  { name: \"secret-scan\" },\n];", encoding="utf-8")
    dest = tmp_path / "published-guide.html"
    dest.write_text("PUBLISHED", encoding="utf-8")
    monkeypatch.setattr(guide, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(guide, "LIVE_GUIDE", live)
    monkeypatch.setattr(guide, "DEST_GUIDE", dest)

    source = _write_settings(tmp_path, body)
    todos, stale = guide.generate_guide(source, [], None, dry_run=False)

    assert (todos, stale) == ([], False)
    assert dest.read_text(encoding="utf-8") == "PUBLISHED"


# ── Audit scope ─────────────────────────────────────────────────


def _audit(tmp_path, monkeypatch, visible):
    monkeypatch.setattr(sync, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(sync, "git_visible_files", lambda: visible)
    return audit_files(tmp_path, ["w2ur"])


def test_audit_scans_json_output(tmp_path, monkeypatch):
    (tmp_path / "settings.hooks.json").write_text('{"leak": "w2ur"}', encoding="utf-8")
    warnings = _audit(tmp_path, monkeypatch, {"settings.hooks.json"})
    assert len(warnings) == 1
    assert "settings.hooks.json" in warnings[0]


def test_audit_skips_gitignored_files(tmp_path, monkeypatch):
    (tmp_path / "ignored.md").write_text("w2ur", encoding="utf-8")
    assert _audit(tmp_path, monkeypatch, set()) == []


def test_audit_skips_the_owner_maintained_readme(tmp_path, monkeypatch):
    (tmp_path / "README.md").write_text("w2ur", encoding="utf-8")
    (tmp_path / "LICENSE").write_text("w2ur", encoding="utf-8")
    assert _audit(tmp_path, monkeypatch, {"README.md", "LICENSE"}) == []


def test_audit_still_flags_a_leak_in_a_synced_file(tmp_path, monkeypatch):
    (tmp_path / "commands").mkdir()
    (tmp_path / "commands" / "sync-setup.md").write_text("w2ur", encoding="utf-8")
    warnings = _audit(tmp_path, monkeypatch, {"commands/sync-setup.md"})
    assert len(warnings) == 1


def test_audit_falls_back_to_scanning_everything_outside_a_git_repo(tmp_path, monkeypatch):
    (tmp_path / "orphan.md").write_text("w2ur", encoding="utf-8")
    assert len(_audit(tmp_path, monkeypatch, None)) == 1
