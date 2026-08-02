#!/usr/bin/env python3
"""Generate the DATA arrays of docs/workflow-guide.html from live config.

The workflow guide (~/Dev/workflow-guide.html) hand-maintains four JS array
literals — COMMANDS, AGENTS, SKILLS, HOOKS — that drift out of sync with the
real ~/.claude/ configuration. This module rebuilds those four arrays from the
live frontmatter / settings.json and rewrites ONLY those arrays inside
docs/workflow-guide.html, leaving the renderer, the SCENARIOS array and
everything else byte-for-byte untouched.

Field policy per array:
  * Verifiable, drift-prone fields are DERIVED from live config:
      - commands: agents list (from allowed-tools Agent(...))
      - agents:   model, skills, memory
      - skills:   file path, preloaded (which agents declare the skill)
      - hooks:    event (settings.json), mode (exit 2 => Blocking)
  * Hand-written prose that cannot be derived is PRESERVED verbatim from the
    current guide for entries that already exist. The guide is bilingual, so
    every prose field has an `_en` sibling (desc/desc_en, when/when_en,
    args/args_en, agents/agents_en) and both are preserved the same way.
  * A genuinely new entry with no prior hand-written prose gets a
    "TODO: write desc" / "TODO: write desc_en" placeholder, reported back to
    the caller.

The whole rewritten HTML is anonymized with sync.py's anonymize() before it
lands in the repo, since ~/Dev/workflow-guide.html is the live/private source.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path

import yaml

# Reuse constants and the anonymizer from sync.py. sync.py is imported lazily
# from run_sync() to avoid a circular import at module load time; when this
# module is imported standalone the import below runs fine.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync import (  # noqa: E402
    DEFAULT_SOURCE,
    REPO_ROOT,
    anonymize,
    build_replacements,
    load_config,
)

log = logging.getLogger("sync.workflow")

LIVE_GUIDE = Path.home() / "Dev" / "workflow-guide.html"
DEST_GUIDE = REPO_ROOT / "docs" / "workflow-guide.html"

ARROW = "→"  # → used in hook event labels


# ── Frontmatter / JS helpers ────────────────────────────────────


def read_frontmatter(path: Path) -> dict:
    """Return the YAML frontmatter of a markdown file as a dict."""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    return yaml.safe_load(m.group(1)) or {}


def js_str(value: str) -> str:
    """Encode a Python string as a JS double-quoted literal."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def js_arr(items: list[str]) -> str:
    return "[" + ", ".join(js_str(i) for i in items) + "]"


# ── Parsing the existing guide arrays ───────────────────────────


# A field key must start at a delimiter and end at its colon, so that `desc`
# never matches `desc_en` (or a hypothetical `en_desc`) and vice versa.
_KEY_BOUNDARY = r"(?:^|[\s{,])"


def _field_str(line: str, key: str) -> str | None:
    """Return the RAW (still-escaped) contents of a `key: "..."` field."""
    m = re.search(_KEY_BOUNDARY + re.escape(key) + r':\s*"((?:[^"\\]|\\.)*)"', line)
    return m.group(1) if m else None


def _field_arr(line: str, key: str) -> str | None:
    """Return the raw `key: [ ... ]` array text (single-line arrays only)."""
    m = re.search(_KEY_BOUNDARY + re.escape(key) + r":\s*(\[[^\]]*\])", line)
    return m.group(1) if m else None


def _arr_elements(arr_text: str) -> list[str]:
    """Decode the string elements of a raw JS array literal."""
    return re.findall(r'"((?:[^"\\]|\\.)*)"', arr_text or "")


def extract_block(html: str, name: str) -> re.Match | None:
    """Match `const NAME = [\\n ... \\n];` (body captured as group 1)."""
    return re.search(r"const " + name + r" = \[\n(.*?)\n\];", html, re.DOTALL)


def parse_existing(html: str, name: str, key_field: str) -> tuple[dict, list[str]]:
    """Parse an existing array into {entry_name: raw_line} and the name order."""
    block = extract_block(html, name)
    by_name: dict[str, str] = {}
    order: list[str] = []
    if not block:
        return by_name, order
    for line in block.group(1).splitlines():
        if "{" not in line:
            continue
        entry_name = _field_str(line, key_field)
        if entry_name is None:
            continue
        by_name[entry_name] = line
        order.append(entry_name)
    return by_name, order


def order_entries(existing_order: list[str], live_names: list[str]) -> list[str]:
    """Existing entries in their current order, then new entries sorted."""
    kept = [n for n in existing_order if n in live_names]
    new = sorted(n for n in live_names if n not in existing_order)
    return kept + new


def _strip_annotation(name: str) -> str:
    """Drop a trailing ' (…)' annotation, e.g. 'troubleshooter (si L3)'."""
    return re.sub(r"\s*\(.*\)\s*$", "", name).strip()


def _preserved(prev: str | None, key: str, entry: str, todos: list[str]) -> str:
    """Return the JS literal for a hand-written prose field of an existing entry.

    The raw (still-escaped) value is kept verbatim. When the field is absent —
    typically an `_en` sibling that has never been written — report a TODO to
    the caller so the owner knows to write it, and fall back to the French
    value rather than a placeholder: the guide's renderer already falls back to
    French for a null/empty `_en`, and writing a non-empty "TODO: write
    desc_en" defeated that test, showing the literal placeholder to English
    readers instead of the perfectly good French prose.
    """
    raw = _field_str(prev, key) if prev else None
    if raw is not None:
        return '"' + raw + '"'

    todos.append(f"{entry} (needs {key})")
    if key.endswith("_en"):
        fallback = _field_str(prev, key[: -len("_en")]) if prev else None
        if fallback is not None:
            return '"' + fallback + '"'
    return js_str(f"TODO: write {key}")


def _preserved_arr(prev: str | None, key: str, derived: list[str]) -> str:
    """Return the JS literal for a derived name array.

    Keep the existing annotated list (e.g. 'troubleshooter (auto-fix)') when its
    stripped name-set still matches the derived one; otherwise re-derive.
    """
    prev_arr = _field_arr(prev, key) if prev else None
    if prev_arr is not None and {
        _strip_annotation(e) for e in _arr_elements(prev_arr)
    } == set(derived):
        return prev_arr
    return js_arr(derived)


# ── Building each array from live config ────────────────────────


def build_commands(source: Path, existing: dict, existing_order: list[str]) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    todos: list[str] = []
    live: dict[str, dict] = {}
    for f in sorted((source / "commands").glob("*.md")):
        fm = read_frontmatter(f)
        name = "/" + f.stem
        allowed = str(fm.get("allowed-tools", "") or "")
        agents = re.findall(r"Agent\(([^)]+)\)", allowed)
        live[name] = {
            "arg_hint": str(fm.get("argument-hint", "") or ""),
            "agents": agents,
        }

    order = order_entries(existing_order, list(live.keys()))
    for name in order:
        info = live[name]
        prev = existing.get(name)
        entry = f"command {name}"
        # args / desc / when (+ _en siblings): preserve prose, or placeholder.
        if prev:
            args_val = _preserved(prev, "args", entry, todos)
            args_en_val = _preserved(prev, "args_en", entry, todos)
            desc_val = _preserved(prev, "desc", entry, todos)
            desc_en_val = _preserved(prev, "desc_en", entry, todos)
            when_val = _preserved(prev, "when", entry, todos)
            when_en_val = _preserved(prev, "when_en", entry, todos)
        else:
            # args_en is seeded with the French `argument-hint` — the only
            # value available — so it must be reported too, or a new command
            # ships an untranslated hint to English readers with nothing
            # flagging it.
            args_val = js_str(info["arg_hint"])
            args_en_val = js_str(info["arg_hint"])
            desc_val = js_str("TODO: write desc")
            desc_en_val = js_str("TODO: write desc_en")
            when_val = js_str("TODO: write when")
            when_en_val = js_str("TODO: write when_en")
            todos.append(f"{entry} (new — needs desc/desc_en + when/when_en + args_en)")
        # agents: derive; keep existing annotated lists if the name-set matches.
        agents_val = _preserved_arr(prev, "agents", info["agents"])
        agents_en_val = _preserved_arr(prev, "agents_en", info["agents"])
        line = (
            f"  {{ name: {js_str(name)}, args: {args_val}, args_en: {args_en_val}, "
            f"desc: {desc_val}, desc_en: {desc_en_val}, "
            f"agents: {agents_val}, agents_en: {agents_en_val}, "
            f"when: {when_val}, when_en: {when_en_val} }},"
        )
        lines.append(line)
    return lines, todos


def build_agents(source: Path, existing: dict, existing_order: list[str]) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    todos: list[str] = []
    live: dict[str, dict] = {}
    for f in sorted((source / "agents").glob("*.md")):
        fm = read_frontmatter(f)
        name = str(fm.get("name") or f.stem)
        live[name] = {
            "model": str(fm.get("model", "") or ""),
            "skills": list(fm.get("skills") or []),
            "memory": bool(fm.get("memory")),
        }

    order = order_entries(existing_order, list(live.keys()))
    for name in order:
        info = live[name]
        prev = existing.get(name)
        entry = f"agent {name}"
        # model: keep an existing annotated value when its base matches live.
        if prev:
            prev_model = _field_str(prev, "model") or ""
            if _strip_annotation(prev_model) == info["model"]:
                model_val = js_str(prev_model)
            else:
                model_val = js_str(info["model"])
            desc_val = _preserved(prev, "desc", entry, todos)
            desc_en_val = _preserved(prev, "desc_en", entry, todos)
        else:
            model_val = js_str(info["model"])
            desc_val = js_str("TODO: write desc")
            desc_en_val = js_str("TODO: write desc_en")
            todos.append(f"{entry} (new — needs desc/desc_en)")
        skills_val = js_arr(info["skills"])
        memory_val = "true" if info["memory"] else "false"
        line = (
            f"  {{ name: {js_str(name)}, model: {model_val}, skills: {skills_val}, "
            f"memory: {memory_val}, desc: {desc_val}, desc_en: {desc_en_val} }},"
        )
        lines.append(line)
    return lines, todos


def build_skills(source: Path, existing: dict, existing_order: list[str]) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    todos: list[str] = []

    # Which agents declare each skill (for the `preloaded` field).
    preload_map: dict[str, list[str]] = {}
    for f in sorted((source / "agents").glob("*.md")):
        fm = read_frontmatter(f)
        agent_name = str(fm.get("name") or f.stem)
        for sk in fm.get("skills") or []:
            preload_map.setdefault(str(sk), []).append(agent_name)

    live: dict[str, dict] = {}
    for skill_md in sorted((source / "skills").glob("*/SKILL.md")):
        fm = read_frontmatter(skill_md)
        dir_name = skill_md.parent.name
        name = str(fm.get("name") or dir_name)
        live[name] = {
            "file": f"~/.claude/skills/{dir_name}/SKILL.md",
            "preloaded": sorted(preload_map.get(name, [])),
        }

    order = order_entries(existing_order, list(live.keys()))
    for name in order:
        info = live[name]
        prev = existing.get(name)
        # preloaded: keep existing order when the name-set is unchanged.
        prev_arr = _field_arr(prev, "preloaded") if prev else None
        if prev_arr is not None and set(_arr_elements(prev_arr)) == set(info["preloaded"]):
            preloaded_val = prev_arr
        else:
            preloaded_val = js_arr(info["preloaded"])
        entry = f"skill {name}"
        if prev:
            desc_val = _preserved(prev, "desc", entry, todos)
            desc_en_val = _preserved(prev, "desc_en", entry, todos)
        else:
            desc_val = js_str("TODO: write desc")
            desc_en_val = js_str("TODO: write desc_en")
            todos.append(f"{entry} (new — needs desc/desc_en)")
        line = (
            f"  {{ name: {js_str(name)}, file: {js_str(info['file'])}, "
            f"preloaded: {preloaded_val}, desc: {desc_val}, desc_en: {desc_en_val} }},"
        )
        lines.append(line)
    return lines, todos


def _hook_event_map(source: Path) -> dict[str, tuple[str, str]]:
    """Map hook name -> (event_type, matcher) from settings.json."""
    settings_path = source / "settings.json"
    mapping: dict[str, tuple[str, str]] = {}
    if not settings_path.exists():
        return mapping
    data = json.loads(settings_path.read_text(encoding="utf-8"))
    for event_type, groups in (data.get("hooks") or {}).items():
        for group in groups:
            matcher = group.get("matcher", "")
            for hook in group.get("hooks", []):
                cmd = hook.get("command", "")
                m = re.search(r"hooks/([^/]+)/hook\.sh", cmd)
                if m:
                    mapping[m.group(1)] = (event_type, matcher)
    return mapping


def build_hooks(source: Path, existing: dict, existing_order: list[str]) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    todos: list[str] = []
    event_map = _hook_event_map(source)

    live: dict[str, dict] = {}
    for hook_sh in sorted((source / "hooks").glob("*/hook.sh")):
        name = hook_sh.parent.name
        if name not in event_map:
            continue  # present on disk but not registered in settings.json
        event_type, matcher = event_map[name]
        script = hook_sh.read_text(encoding="utf-8", errors="ignore")
        # Refine a Bash matcher with the git sub-command the hook targets.
        if matcher == "Bash":
            if "git push" in script:
                matcher = "Bash(git push)"
            elif "git commit" in script:
                matcher = "Bash(git commit)"
        event = f"{event_type} {ARROW} {matcher}"
        mode = "Blocking" if "exit 2" in script else "Advisory"
        live[name] = {"event": event, "mode": mode}

    order = order_entries(existing_order, list(live.keys()))
    for name in order:
        info = live[name]
        prev = existing.get(name)
        entry = f"hook {name}"
        if prev:
            desc_val = _preserved(prev, "desc", entry, todos)
            desc_en_val = _preserved(prev, "desc_en", entry, todos)
        else:
            desc_val = js_str("TODO: write desc")
            desc_en_val = js_str("TODO: write desc_en")
            todos.append(f"{entry} (new — needs desc/desc_en)")
        line = (
            f"  {{ name: {js_str(name)}, event: {js_str(info['event'])}, "
            f"desc: {desc_val}, desc_en: {desc_en_val}, mode: {js_str(info['mode'])} }},"
        )
        lines.append(line)
    return lines, todos


# ── Top-level generation ────────────────────────────────────────


def _replace_block(html: str, name: str, body_lines: list[str]) -> str:
    body = "\n".join(body_lines)
    replacement = f"const {name} = [\n{body}\n];"
    return re.sub(
        r"const " + name + r" = \[\n.*?\n\];",
        lambda _m: replacement,
        html,
        count=1,
        flags=re.DOTALL,
    )


def generate_guide(
    source: Path, replacements, patterns, dry_run: bool
) -> tuple[list[str], bool]:
    """Rewrite docs/workflow-guide.html DATA arrays from live config.

    Returns (TODO notes for genuinely new entries, whether the destination is
    stale). The staleness flag is only meaningful under --dry-run; callers fold
    it into a single reported count so there is one staleness signal, not two.
    """
    if not LIVE_GUIDE.exists():
        log.warning("Workflow guide source not found: %s (skipping)", LIVE_GUIDE)
        return [], False

    html = LIVE_GUIDE.read_text(encoding="utf-8")

    all_todos: list[str] = []
    for arr_name, key_field, builder in (
        ("COMMANDS", "name", build_commands),
        ("AGENTS", "name", build_agents),
        ("SKILLS", "name", build_skills),
        ("HOOKS", "name", build_hooks),
    ):
        by_name, order = parse_existing(html, arr_name, key_field)
        body_lines, todos = builder(source, by_name, order)
        all_todos.extend(todos)
        html = _replace_block(html, arr_name, body_lines)

    anonymized, _count = anonymize(html, replacements, patterns)

    rel = DEST_GUIDE.relative_to(REPO_ROOT)
    is_stale = False
    if dry_run:
        exists = DEST_GUIDE.exists()
        current = DEST_GUIDE.read_text(encoding="utf-8") if exists else ""
        if not exists:
            status = "would create"
        elif anonymized != current:
            status = "would update"
        else:
            status = "up to date"
        is_stale = status != "up to date"
        log.info("  workflow-guide.html %s %s (%s)", ARROW, rel, status)
    else:
        DEST_GUIDE.parent.mkdir(parents=True, exist_ok=True)
        DEST_GUIDE.write_text(anonymized, encoding="utf-8")
        log.info("  generated %s", rel)

    return all_todos, is_stale


def main() -> None:
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    args = parser.parse_args()

    config = load_config(Path(__file__).resolve().parent / "anonymization.yaml")
    replacements = build_replacements(config["replacements"])
    patterns = config.get("patterns")
    todos, _stale = generate_guide(args.source, replacements, patterns, args.dry_run)
    if todos:
        log.info("Entries needing hand-written prose:")
        for t in todos:
            log.info("  - %s", t)


if __name__ == "__main__":
    main()
