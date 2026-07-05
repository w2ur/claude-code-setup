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
  * Hand-written French prose that cannot be derived is PRESERVED verbatim
    from the current guide for entries that already exist (desc, when, args).
  * A genuinely new entry with no prior hand-written desc gets a
    "TODO: write desc" placeholder, reported back to the caller.

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


def _field_str(line: str, key: str) -> str | None:
    """Return the RAW (still-escaped) contents of a `key: "..."` field."""
    m = re.search(key + r':\s*"((?:[^"\\]|\\.)*)"', line)
    return m.group(1) if m else None


def _field_arr(line: str, key: str) -> str | None:
    """Return the raw `key: [ ... ]` array text (single-line arrays only)."""
    m = re.search(key + r":\s*(\[[^\]]*\])", line)
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
        # args / desc / when: preserve French prose; derive/placeholder if new.
        if prev:
            args_val = '"' + (_field_str(prev, "args") or "") + '"'
            desc_val = '"' + (_field_str(prev, "desc") or "") + '"'
            when_val = '"' + (_field_str(prev, "when") or "") + '"'
        else:
            args_val = js_str(info["arg_hint"])
            desc_val = js_str("TODO: write desc")
            when_val = js_str("TODO: write when")
            todos.append(f"command {name} (new — needs desc + when)")
        # agents: derive; keep existing annotated list if the name-set matches.
        derived = info["agents"]
        prev_arr = _field_arr(prev, "agents") if prev else None
        if prev_arr is not None and {
            _strip_annotation(e) for e in _arr_elements(prev_arr)
        } == set(derived):
            agents_val = prev_arr
        else:
            agents_val = js_arr(derived)
        line = (
            f"  {{ name: {js_str(name)}, args: {args_val}, desc: {desc_val}, "
            f"agents: {agents_val}, when: {when_val} }},"
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
        # model: keep an existing annotated value when its base matches live.
        if prev:
            prev_model = _field_str(prev, "model") or ""
            if _strip_annotation(prev_model) == info["model"]:
                model_val = js_str(prev_model)
            else:
                model_val = js_str(info["model"])
            desc_val = '"' + (_field_str(prev, "desc") or "") + '"'
        else:
            model_val = js_str(info["model"])
            desc_val = js_str("TODO: write desc")
            todos.append(f"agent {name} (new — needs desc)")
        skills_val = js_arr(info["skills"])
        memory_val = "true" if info["memory"] else "false"
        line = (
            f"  {{ name: {js_str(name)}, model: {model_val}, skills: {skills_val}, "
            f"memory: {memory_val}, desc: {desc_val} }},"
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
        if prev:
            desc_val = '"' + (_field_str(prev, "desc") or "") + '"'
        else:
            desc_val = js_str("TODO: write desc")
            todos.append(f"skill {name} (new — needs desc)")
        line = (
            f"  {{ name: {js_str(name)}, file: {js_str(info['file'])}, "
            f"preloaded: {preloaded_val}, desc: {desc_val} }},"
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
        if prev:
            desc_val = '"' + (_field_str(prev, "desc") or "") + '"'
        else:
            desc_val = js_str("TODO: write desc")
            todos.append(f"hook {name} (new — needs desc)")
        line = (
            f"  {{ name: {js_str(name)}, event: {js_str(info['event'])}, "
            f"desc: {desc_val}, mode: {js_str(info['mode'])} }},"
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


def generate_guide(source: Path, replacements, patterns, dry_run: bool) -> list[str]:
    """Rewrite docs/workflow-guide.html DATA arrays from live config.

    Returns the list of TODO notes for genuinely new entries.
    """
    if not LIVE_GUIDE.exists():
        log.warning("Workflow guide source not found: %s (skipping)", LIVE_GUIDE)
        return []

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
    if dry_run:
        current = DEST_GUIDE.read_text(encoding="utf-8") if DEST_GUIDE.exists() else ""
        status = "would update" if anonymized != current else "up to date"
        log.info("  workflow-guide.html %s (%s)", ARROW, status)
    else:
        DEST_GUIDE.parent.mkdir(parents=True, exist_ok=True)
        DEST_GUIDE.write_text(anonymized, encoding="utf-8")
        log.info("  generated %s", rel)

    return all_todos


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
    todos = generate_guide(args.source, replacements, patterns, args.dry_run)
    if todos:
        log.info("New entries needing a hand-written desc:")
        for t in todos:
            log.info("  - %s", t)


if __name__ == "__main__":
    main()
