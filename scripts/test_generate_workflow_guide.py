#!/usr/bin/env python3
"""Tests for the workflow-guide generator's field parsing.

The guide is bilingual: every prose field sits next to an `_en` sibling on the
same raw array line. The field matchers must therefore be exact — an
unanchored `desc` matcher happily captures a neighbouring key that merely ends
in `desc`, which would silently swap the two languages.

Run with: pytest scripts/test_generate_workflow_guide.py
"""

from __future__ import annotations

from pathlib import Path

import pytest

from generate_workflow_guide import (
    _field_arr,
    _field_str,
    _preserved,
    build_commands,
    parse_existing,
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
