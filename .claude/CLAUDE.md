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

Never invoke it as `python3 scripts/sync.py` here — that bypasses the shebang
and runs it against whatever interpreter is on PATH, which on this machine is a
Homebrew Python that exists only as another formula's dependency. uv is the sole
Python manager here. The `pip install -r scripts/requirements.txt` path is kept
in `scripts/README.md` for people cloning this public repo without uv.

## Project-Specific Rules

- NEVER commit files containing personal data (real app names, URLs, paths)
- After any sync, run `python scripts/sync.py --audit-only` before committing
- The README.md and docs/philosophy.md are maintained by the owner, not auto-generated
- This repo does NOT follow the author signature convention (no footer — it's not a web app)
