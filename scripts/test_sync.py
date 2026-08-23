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
from sync import anonymize, audit_files, generate_hooks_settings, read_hooks_config, redact

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


# ── Private-region redaction ────────────────────────────────────
#
# The guard these cover is a scope rule, not a formatting nicety: ~/.claude/
# documents two automation pipelines — writing and job search — that
# this repo is not about, and several of the files carrying them are otherwise
# publishable. `skip` handles the all-private file; these markers handle the
# private section inside a public one.


def test_redact_is_byte_identical_when_there_are_no_markers():
    content = "line one\nline two\n"
    assert redact(content) == (content, 0)


def test_redact_drops_a_block_region_and_its_markers():
    out, regions = redact("keep\n<!-- SYNC-PRIVATE:BEGIN -->\nsecret\n<!-- SYNC-PRIVATE:END -->\ntail\n")
    assert out == "keep\ntail\n"
    assert regions == 1


def test_redact_collapses_the_blank_line_that_preceded_a_removed_section():
    # A section cut from the middle of a Markdown file must not leave a double
    # blank behind: the published file has to read as a document, not as one
    # with a visible hole in it.
    out, _ = redact("# One\n\ntext\n\n<!-- SYNC-PRIVATE:BEGIN -->\n## Private\n<!-- SYNC-PRIVATE:END -->\n\n# Two\n")
    assert out == "# One\n\ntext\n\n# Two\n"


def test_redact_removes_only_the_marked_span_when_a_pair_closes_on_one_line():
    # The CLAUDE.md case: one clause inside a sentence that must survive.
    out, regions = redact("Ten plugins (SYNC-PRIVATE:BEGINnames, SYNC-PRIVATE:ENDthe roster).\n")
    assert out == "Ten plugins (the roster).\n"
    assert regions == 1


def test_redact_tidies_the_space_a_removed_clause_leaves_behind():
    out, _ = redact("kept SYNC-PRIVATE:BEGIN private SYNC-PRIVATE:END , tail\n")
    assert out == "kept, tail\n"


def test_redact_handles_two_inline_pairs_on_the_same_line():
    out, regions = redact("a SYNC-PRIVATE:BEGINxSYNC-PRIVATE:END b SYNC-PRIVATE:BEGINySYNC-PRIVATE:END c\n")
    assert out == "a b c\n"
    assert regions == 2


def test_redact_drops_an_inline_pair_that_wraps_the_whole_line():
    out, _ = redact("keep\nSYNC-PRIVATE:BEGIN all of it SYNC-PRIVATE:END\ntail\n")
    assert out == "keep\ntail\n"


def test_redact_ignores_an_inline_pair_inside_a_block_region():
    out, regions = redact(
        "keep\n"
        "<!-- SYNC-PRIVATE:BEGIN -->\n"
        "x SYNC-PRIVATE:BEGIN y SYNC-PRIVATE:END z\n"
        "<!-- SYNC-PRIVATE:END -->\n"
        "tail\n"
    )
    assert out == "keep\ntail\n"
    assert regions == 1


def test_redact_rejects_an_unclosed_region():
    # Fails CLOSED. Left to guess, this would truncate the file at the marker
    # and the loss would be invisible in the output.
    with pytest.raises(sync.RedactionError, match="no matching SYNC-PRIVATE:END"):
        redact("keep\n<!-- SYNC-PRIVATE:BEGIN -->\nsecret\n", origin="a.md")


def test_redact_rejects_a_stray_end():
    # The dangerous direction: read leniently, everything above the stray END
    # would be published.
    with pytest.raises(sync.RedactionError, match="no matching SYNC-PRIVATE:BEGIN"):
        redact("secret\n<!-- SYNC-PRIVATE:END -->\n", origin="a.md")


def test_redact_rejects_a_nested_region():
    with pytest.raises(sync.RedactionError, match="nested"):
        redact("<!-- SYNC-PRIVATE:BEGIN -->\n<!-- SYNC-PRIVATE:BEGIN -->\n<!-- SYNC-PRIVATE:END -->\n")


def test_redaction_error_names_the_file_and_line():
    with pytest.raises(sync.RedactionError, match=r"live/CLAUDE\.md:2"):
        redact("keep\n<!-- SYNC-PRIVATE:BEGIN -->\n", origin="live/CLAUDE.md")


def test_anonymize_redacts_before_replacing():
    # Order matters: a private paragraph must not be able to survive by being
    # laundered into something that looks publishable.
    out, count = anonymize(
        "public w2ur\nSYNC-PRIVATE:BEGIN private w2ur SYNC-PRIVATE:END\n",
        [("w2ur", "{user}")],
        None,
    )
    assert out == "public {user}\n"
    assert count == 1  # the redacted occurrence was never counted


def test_sync_writes_nothing_when_a_source_has_unbalanced_markers(tmp_path, monkeypatch):
    # The preflight is the point: a half-applied sync — some destinations
    # rewritten, the malformed one truncated — is worse than no sync at all.
    source = tmp_path / "live"
    (source / "commands").mkdir(parents=True)
    (source / "commands" / "good.md").write_text("fine\n", encoding="utf-8")
    (source / "commands" / "bad.md").write_text("x\n<!-- SYNC-PRIVATE:BEGIN -->\n", encoding="utf-8")

    repo = tmp_path / "repo"
    (repo / "commands").mkdir(parents=True)
    monkeypatch.setattr(sync, "REPO_ROOT", repo)

    config = {"replacements": {}, "file_map": {"commands/*.md": "commands/"}}
    with pytest.raises(sync.RedactionError):
        sync.run_sync(source, config, dry_run=False)
    assert not (repo / "commands" / "good.md").exists()


def test_redact_consumes_the_html_comment_wrapper_around_an_inline_pair():
    # Regression: marking a clause inside a Markdown paragraph means hiding the
    # markers in HTML comments, and matching only the bare tokens left the
    # `<!--` and `-->` fragments behind in the published CLAUDE.md.
    out, _ = redact("Ten plugins (<!-- SYNC-PRIVATE:BEGIN -->names, <!-- SYNC-PRIVATE:END -->the roster).\n")
    assert out == "Ten plugins (the roster).\n"
