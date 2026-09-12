# CLAUDE.md — claude-code-setup

## Project Overview

Public repo publishing an anonymized Claude Code configuration.
Not an app — a collection of markdown files (commands, agents, skills, hooks)
with a Python sync script for maintenance.

## Tech Stack

Markdown (content), Python 3.10+ (sync script), YAML (anonymization config).

## User-Facing Language

English.

## Development

No build step and no dependency step. `sync.py` carries PEP 723 inline metadata
and a `uv run --script` shebang, so it builds its own environment:

```bash
./scripts/sync.py --dry-run
uv run --with pytest --with PyYAML pytest scripts/ -q   # tests
```

Never invoke it as `python3 scripts/sync.py` here — see the global CLAUDE.md's
uv rules for why that bypasses the shebang. The `pip install -r
scripts/requirements.txt` path stays documented in `scripts/README.md`, for
people cloning this public repo without uv.

## Project-Specific Rules

- NEVER commit files containing personal data (real app names, URLs, paths)
- After any sync, run `./scripts/sync.py --audit-only` before committing
- Everything under `commands/`, `agents/`, `skills/`, `hooks/`, `claude-scripts/` **and the root `CLAUDE.md`** is generated from `~/.claude/` by `scripts/sync.py`: make the change in the live file and re-run the sync, never in the copy here (the sync exits 2 when a destination matches neither HEAD nor the content it is about to write — that is what a hand edit looks like). `README.md`, `docs/`, `hooks/README.md`, `claude-scripts/README.md` and this file are the owner-maintained exceptions.
- This repo does NOT follow the author signature convention (no footer — it's not a web app)
