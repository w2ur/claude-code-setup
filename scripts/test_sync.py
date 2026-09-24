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
import subprocess
from pathlib import Path

import pytest

import generate_workflow_guide as guide
import sync
from sync import anonymize, audit_files, discover_files, generate_hooks_settings, read_hooks_config, redact

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


# ── File discovery ──────────────────────────────────────────────


def test_discover_files_skips_account_synced_skills(tmp_path):
    # skills/synced/ holds account-synced third-party skills (never ours to
    # publish); a real one nests deeper, e.g. skills/synced/some-vendor/skill/SKILL.md.
    # Uses the shipped example config's own `skip` list, not a hand-written
    # one here, so this test fails until anonymization.example.yaml actually
    # excludes the directory.
    config = sync.load_config(Path(__file__).resolve().parent / "anonymization.example.yaml")

    source = tmp_path / "live"
    synced = source / "skills" / "synced" / "x" / "y"
    synced.mkdir(parents=True)
    (synced / "SKILL.md").write_text("# vendor skill\n", encoding="utf-8")
    # Positive control: a sibling skill that is NOT under skills/synced/ must
    # still be discovered. Without this, a `skip` pattern broad enough to
    # exclude all of skills/** would pass the assertion above for the wrong
    # reason — nothing would be discovered either way.
    real = source / "skills" / "real" / "skill"
    real.mkdir(parents=True)
    (real / "SKILL.md").write_text("# our skill\n", encoding="utf-8")

    pairs = discover_files(source, config["file_map"], config["skip"])

    assert pairs == [(real / "SKILL.md", sync.REPO_ROOT / "skills" / "real" / "skill" / "SKILL.md")]


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


# ── Hand-edit guard ─────────────────────────────────────────────
#
# The trap: every file under a synced root is generated, so editing the repo's
# copy feels like it works and the next sync silently reverts it. These pin the
# three-way comparison that catches it without breaking the normal workflow,
# where a real sync leaves every destination dirty until the owner commits.


def _repo(tmp_path, monkeypatch):
    """A tiny git repo standing in for the real one, plus a live source."""
    source = tmp_path / "live"
    (source / "commands").mkdir(parents=True)
    repo = tmp_path / "repo"
    (repo / "commands").mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    monkeypatch.setattr(sync, "REPO_ROOT", repo)
    # These destinations are module-level constants derived from REPO_ROOT at
    # import time, so moving REPO_ROOT alone leaves them pointing at the real
    # repo and prune/relative_to blow up on a path outside the fixture tree.
    monkeypatch.setattr(sync, "HOOKS_SETTINGS_DEST", repo / "hooks" / "settings.hooks.json")
    monkeypatch.setattr(sync, "HOOKS_README_DEST", repo / "hooks" / "README.md")
    monkeypatch.setattr(sync, "CLAUDE_SCRIPTS_README_DEST", repo / "claude-scripts" / "README.md")
    monkeypatch.setattr(guide, "REPO_ROOT", repo)
    monkeypatch.setattr(guide, "DEST_GUIDE", repo / "docs" / "workflow-guide.html")
    return source, repo


def _commit(repo):
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "x"], cwd=repo, check=True)


def _sync(source, repo, **kw):
    sync.run_sync(source, {"replacements": {}, "file_map": {"commands/*.md": "commands/"}}, **kw)


def test_sync_blocks_when_a_destination_was_hand_edited(tmp_path, monkeypatch):
    source, repo = _repo(tmp_path, monkeypatch)
    (source / "commands" / "a.md").write_text("from live\n", encoding="utf-8")
    _sync(source, repo)
    _commit(repo)

    (repo / "commands" / "a.md").write_text("typed by hand\n", encoding="utf-8")
    with pytest.raises(sync.HandEditError, match="commands/a.md"):
        _sync(source, repo)
    # The edit survives: destroying it silently is the bug being fixed.
    assert (repo / "commands" / "a.md").read_text(encoding="utf-8") == "typed by hand\n"


def test_allow_dirty_overrides_the_guard(tmp_path, monkeypatch):
    source, repo = _repo(tmp_path, monkeypatch)
    (source / "commands" / "a.md").write_text("from live\n", encoding="utf-8")
    _sync(source, repo)
    _commit(repo)

    (repo / "commands" / "a.md").write_text("typed by hand\n", encoding="utf-8")
    _sync(source, repo, allow_dirty=True)
    assert (repo / "commands" / "a.md").read_text(encoding="utf-8") == "from live\n"


def test_guard_does_not_fire_on_an_uncommitted_previous_sync(tmp_path, monkeypatch):
    # The workflow that must keep working: sync, look at the diff, sync again
    # before committing. Every destination is dirty and none of it is an edit.
    source, repo = _repo(tmp_path, monkeypatch)
    (source / "commands" / "a.md").write_text("v1\n", encoding="utf-8")
    _sync(source, repo)
    _commit(repo)

    (source / "commands" / "a.md").write_text("v2\n", encoding="utf-8")
    _sync(source, repo)          # destination now dirty, matches incoming
    _sync(source, repo)          # must not raise
    assert (repo / "commands" / "a.md").read_text(encoding="utf-8") == "v2\n"


def test_guard_does_not_fire_when_only_the_live_source_moved(tmp_path, monkeypatch):
    source, repo = _repo(tmp_path, monkeypatch)
    (source / "commands" / "a.md").write_text("v1\n", encoding="utf-8")
    _sync(source, repo)
    _commit(repo)

    (source / "commands" / "a.md").write_text("v2\n", encoding="utf-8")
    _sync(source, repo)  # destination == HEAD, incoming differs: an ordinary sync
    assert (repo / "commands" / "a.md").read_text(encoding="utf-8") == "v2\n"


def test_guard_is_skipped_on_a_dry_run(tmp_path, monkeypatch):
    source, repo = _repo(tmp_path, monkeypatch)
    (source / "commands" / "a.md").write_text("from live\n", encoding="utf-8")
    _sync(source, repo)
    _commit(repo)
    (repo / "commands" / "a.md").write_text("typed by hand\n", encoding="utf-8")
    _sync(source, repo, dry_run=True)  # a preview writes nothing, so it destroys nothing


# ── argument-hint drift ─────────────────────────────────────────
#
# args/args_en are translations of one `argument-hint`, so they cannot be
# derived without overwriting whichever of the two was actually translated.
# They stay preserved; what was missing is any report that the hint moved.


def _entry(args, args_en):
    return f'  {{ name: "/c", args: "{args}", args_en: "{args_en}", desc: "d", desc_en: "d" }},'


def test_arg_hint_drift_is_reported(tmp_path, monkeypatch):
    source = tmp_path / "live"
    (source / "commands").mkdir(parents=True)
    (source / "commands" / "c.md").write_text(
        "---\nargument-hint: [--a | --b | --c]\n---\nbody\n", encoding="utf-8"
    )
    todos: list[str] = []
    prev = _entry("[--a | --b]", "[--a | --b]")
    args, args_en = guide._args_with_drift_check(prev, "[--a | --b | --c]", "command /c", todos)
    # Preserved, not overwritten...
    assert args == '"[--a | --b]"'
    assert args_en == '"[--a | --b]"'
    # ...but the drift is named.
    assert any("--c" in t for t in todos)


def test_no_drift_reported_when_one_side_matches_the_hint():
    # /sync's real shape: an English-written hint, a translated French args.
    todos: list[str] = []
    guide._args_with_drift_check(
        _entry("(aucun argument)", "(no arguments)"), "(no arguments)", "command /c", todos
    )
    assert todos == []


def test_arg_hint_renders_a_yaml_flow_sequence_back_to_brackets():
    # `argument-hint: [--dry-run | --audit-only]` is a flow SEQUENCE — the pipes
    # are not separators — so safe_load returns a one-element list and str() on
    # it leaked the Python repr, brackets and quotes included, into the guide.
    assert guide._arg_hint(["--dry-run | --audit-only"]) == "[--dry-run | --audit-only]"


def test_arg_hint_renders_a_flow_map():
    # `[optional: canonical URL]` — the colon makes YAML read a key/value.
    assert guide._arg_hint([{"optional": "canonical URL"}]) == "[optional: canonical URL]"


def test_arg_hint_of_a_plain_string_is_unchanged():
    assert guide._arg_hint("A | B | a task id") == "A | B | a task id"
    assert guide._arg_hint(None) == ""
