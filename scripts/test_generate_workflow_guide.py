#!/usr/bin/env python3
"""Tests for the workflow-guide generator's field parsing.

The guide is bilingual: every prose field sits next to an `_en` sibling on the
same raw array line. The field matchers must therefore be exact — an
unanchored `desc` matcher happily captures a neighbouring key that merely ends
in `desc`, which would silently swap the two languages.

Run with: pytest scripts/test_generate_workflow_guide.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from generate_workflow_guide import (
    _field_arr,
    _field_str,
    _preserved,
    build_agents,
    build_commands,
    build_hooks,
    check_live,
    parse_existing,
    write_live,
)

COMMAND_LINE = (
    '  { name: "/audit", args: "[URL]", args_en: "[URL]", '
    'desc: "Lance les agents.", desc_en: "Runs the agents.", '
    'agents: ["docs-checker"], agents_en: ["docs-checker"], '
    'when: "Avant un release", when_en: "Before a release" },'
)


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("desc", "Lance les agents."),
        ("desc_en", "Runs the agents."),
        ("when", "Avant un release"),
        ("when_en", "Before a release"),
        ("args", "[URL]"),
        ("args_en", "[URL]"),
        ("name", "/audit"),
    ],
)
def test_field_str_disambiguates_a_key_from_its_en_sibling(key, expected):
    assert _field_str(COMMAND_LINE, key) == expected


def test_field_str_requires_the_key_to_start_at_a_delimiter():
    """Regression guard: an unanchored matcher captures any key ending in `desc`."""
    line = '  { name: "x", en_desc: "WRONG", desc: "RIGHT" },'
    assert _field_str(line, "desc") == "RIGHT"


def test_field_arr_disambiguates_a_key_from_its_en_sibling():
    line = '  { agents: ["fr-one"], agents_en: ["en-one"] },'
    assert _field_arr(line, "agents") == '["fr-one"]'
    assert _field_arr(line, "agents_en") == '["en-one"]'


def test_field_arr_requires_the_key_to_start_at_a_delimiter():
    line = '  { prev_agents: ["WRONG"], agents: ["RIGHT"] },'
    assert _field_arr(line, "agents") == '["RIGHT"]'


def test_missing_en_sibling_falls_back_to_french_and_is_reported():
    """The guide documents `_en` falling back to French; a non-empty placeholder
    defeated the renderer's null/empty test and shipped 'TODO: write desc_en'
    to English readers."""
    todos: list[str] = []
    line = '  { name: "/x", desc: "Prose FR" },'
    assert _preserved(line, "desc", "command /x", todos) == '"Prose FR"'
    assert todos == []
    assert _preserved(line, "desc_en", "command /x", todos) == '"Prose FR"'
    assert todos == ["command /x (needs desc_en)"]


def test_missing_field_with_no_french_sibling_still_gets_a_placeholder():
    todos: list[str] = []
    line = '  { name: "/x", desc: "Prose FR" },'
    assert _preserved(line, "when_en", "command /x", todos) == '"TODO: write when_en"'
    assert _preserved(line, "when", "command /x", todos) == '"TODO: write when"'
    assert todos == ["command /x (needs when_en)", "command /x (needs when)"]


def _write_command(tmp_path: Path, stem: str, body: str) -> Path:
    (tmp_path / "commands").mkdir(exist_ok=True)
    path = tmp_path / "commands" / f"{stem}.md"
    path.write_text(body, encoding="utf-8")
    return path


def test_build_commands_preserves_both_languages(tmp_path):
    _write_command(
        tmp_path,
        "audit",
        "---\nargument-hint: '[URL]'\nallowed-tools: Agent(docs-checker)\n---\nbody\n",
    )
    html = f"const COMMANDS = [\n{COMMAND_LINE}\n];"
    existing, order = parse_existing(html, "COMMANDS", "name")
    lines, todos = build_commands(tmp_path, existing, order)

    assert todos == []
    assert len(lines) == 1
    assert _field_str(lines[0], "desc") == "Lance les agents."
    assert _field_str(lines[0], "desc_en") == "Runs the agents."
    assert _field_str(lines[0], "when_en") == "Before a release"
    assert _field_arr(lines[0], "agents_en") == '["docs-checker"]'


def test_build_commands_flags_a_new_entry_in_both_languages(tmp_path):
    _write_command(tmp_path, "brand-new", "---\nargument-hint: '[x]'\n---\nbody\n")
    lines, todos = build_commands(tmp_path, {}, [])

    assert _field_str(lines[0], "desc") == "TODO: write desc"
    assert _field_str(lines[0], "desc_en") == "TODO: write desc_en"
    # args_en is seeded from the French argument-hint, so it needs reporting too.
    assert _field_str(lines[0], "args_en") == "[x]"
    assert todos == [
        "command /brand-new (new — needs desc/desc_en + when/when_en + args_en)"
    ]


# ── Model/effort pins and the live guide (--live / --check) ─────

GUIDE_TEMPLATE = """<html><head><title>guide</title></head>
<!-- prose header the generator must never touch -->
<script id="workflow-data">
const COMMANDS = [
{commands}
];

const AGENTS = [
{agents}
];

const SKILLS = [
{skills}
];

const HOOKS = [
{hooks}
];

const SCENARIOS = [
  {{ id:"x", tool:"/code-review high" }}
];
</script>
<!-- renderer below, also untouched -->
</html>
"""


def _live_source(tmp_path: Path) -> Path:
    """A minimal live ~/.claude: one command, agent, skill and hook each."""
    src = tmp_path / "claude"
    (src / "commands").mkdir(parents=True)
    (src / "commands" / "audit.md").write_text(
        "---\nmodel: sonnet\nargument-hint: '[URL]'\nallowed-tools: Agent(docs-checker)\n---\n",
        encoding="utf-8",
    )
    (src / "agents").mkdir()
    (src / "agents" / "troubleshooter.md").write_text(
        "---\nname: troubleshooter\nmodel: inherit\neffort: high\nskills: [conv]\nmemory: project\n---\n",
        encoding="utf-8",
    )
    (src / "skills" / "conv").mkdir(parents=True)
    (src / "skills" / "conv" / "SKILL.md").write_text("---\nname: conv\n---\n", encoding="utf-8")
    (src / "hooks" / "secret-scan").mkdir(parents=True)
    (src / "hooks" / "secret-scan" / "hook.sh").write_text("exit 2\n", encoding="utf-8")
    (src / "settings.json").write_text(
        json.dumps({"hooks": {"PreToolUse": [{"matcher": "Write|Edit", "hooks": [
            {"command": "~/.claude/hooks/secret-scan/hook.sh"}]}]}}),
        encoding="utf-8",
    )
    return src


def _live_guide(tmp_path: Path) -> Path:
    """A guide whose arrays hold hand-written prose and are stale on purpose."""
    guide = tmp_path / "workflow-guide.html"
    guide.write_text(
        GUIDE_TEMPLATE.format(
            commands=COMMAND_LINE,
            agents='  { name: "troubleshooter", model: "inherit", skills: [], memory: true, '
            'desc: "Diagnostique.", desc_en: "Diagnoses." },',
            skills='  { name: "conv", file: "x", preloaded: [], desc: "Charte.", desc_en: "Charter." },',
            hooks='  { name: "secret-scan", event: "old", desc: "Bloque.", desc_en: "Blocks.", mode: "Advisory" },',
        ),
        encoding="utf-8",
    )
    return guide


def test_build_commands_shows_the_model_pin_and_session_when_unpinned(tmp_path):
    _write_command(tmp_path, "pinned", "---\nmodel: haiku\neffort: low\n---\n")
    _write_command(tmp_path, "unpinned", "---\ndescription: x\n---\n")
    lines, _todos = build_commands(tmp_path, {}, [])
    by_name = {_field_str(line, "name"): line for line in lines}

    assert _field_str(by_name["/pinned"], "model") == "haiku"
    assert _field_str(by_name["/pinned"], "effort") == "low"
    assert _field_str(by_name["/unpinned"], "model") == "session"
    assert _field_str(by_name["/unpinned"], "effort") == ""


def test_build_agents_carries_the_effort_pin(tmp_path):
    src = _live_source(tmp_path)
    lines, _todos = build_agents(src, {}, [])
    assert _field_str(lines[0], "model") == "inherit"
    assert _field_str(lines[0], "effort") == "high"


def test_check_reports_drift_before_a_write_and_none_right_after(tmp_path):
    src, guide = _live_source(tmp_path), _live_guide(tmp_path)

    code, report = check_live(src, guide)
    assert code == 1
    assert any(line.startswith("drift in HOOKS: secret-scan") for line in report)

    assert write_live(src, guide) == []
    assert check_live(src, guide) == (0, [])


def test_write_live_touches_only_the_four_arrays_and_keeps_the_prose(tmp_path):
    src, guide = _live_source(tmp_path), _live_guide(tmp_path)
    before = guide.read_text(encoding="utf-8")
    write_live(src, guide)
    after = guide.read_text(encoding="utf-8")

    outside = lambda html: re.sub(r"const (COMMANDS|AGENTS|SKILLS|HOOKS) = \[\n.*?\n\];", "", html, flags=re.S)  # noqa: E731
    assert outside(after) == outside(before)
    assert '"Diagnoses."' in after and '"Charter."' in after
    assert 'mode: "Blocking"' in after


def test_check_fails_on_a_hand_edited_array_entry(tmp_path):
    src, guide = _live_source(tmp_path), _live_guide(tmp_path)
    write_live(src, guide)
    html = guide.read_text(encoding="utf-8")
    guide.write_text(html.replace('model: "sonnet"', 'model: "opus"', 1), encoding="utf-8")

    assert check_live(src, guide) == (1, ["drift in COMMANDS: /audit"])


def test_check_reports_placeholder_prose_left_by_a_previous_write(tmp_path):
    """_preserved() keeps a written placeholder verbatim, so without a scan for
    it a new entry's owed prose is reported once and then never again."""
    src, guide = _live_source(tmp_path), _live_guide(tmp_path)
    _write_command(src, "brand-new", "---\n---\n")
    assert write_live(src, guide)  # the first write reports it...
    code, report = check_live(src, guide)  # ...and the check keeps reporting it
    assert code == 1
    assert "owed prose: command /brand-new (placeholder prose still in the guide)" in report


@pytest.mark.parametrize(
    "breakage",
    ["missing guide", "missing array block", "no hooks config", "empty commands dir"],
)
def test_check_is_unknown_never_clean_when_it_cannot_render(tmp_path, breakage):
    src, guide = _live_source(tmp_path), _live_guide(tmp_path)
    write_live(src, guide)
    if breakage == "missing guide":
        guide.unlink()
    elif breakage == "missing array block":
        guide.write_text(guide.read_text(encoding="utf-8").replace("const SKILLS", "const SKILZ"), encoding="utf-8")
    elif breakage == "no hooks config":
        (src / "settings.json").write_text("{}", encoding="utf-8")
    else:
        (src / "commands" / "audit.md").unlink()

    code, report = check_live(src, guide)
    assert code == 2
    assert report[0].startswith("could not run:")


def test_a_hook_registered_under_two_matchers_shows_both(tmp_path):
    """Regression: a42c34d — secret-scan is registered on Write|Edit|NotebookEdit and on
    Bash; the event map kept one pair per hook, so the guide showed only
    whichever registration settings.json listed last ("PreToolUse → Bash")."""
    (tmp_path / "hooks" / "secret-scan").mkdir(parents=True)
    (tmp_path / "hooks" / "secret-scan" / "hook.sh").write_text("exit 2\n", encoding="utf-8")
    cmd = "bash ~/.claude/hooks/secret-scan/hook.sh"
    (tmp_path / "settings.json").write_text(
        json.dumps({"hooks": {"PreToolUse": [
            {"matcher": "Write|Edit|NotebookEdit", "hooks": [{"command": cmd}]},
            {"matcher": "Bash", "hooks": [{"command": cmd}]},
        ]}}),
        encoding="utf-8",
    )
    lines, _todos = build_hooks(tmp_path, {}, [])
    assert _field_str(lines[0], "event") == "PreToolUse → Write|Edit|NotebookEdit · PreToolUse → Bash"
