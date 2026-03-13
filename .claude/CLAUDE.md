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

No build step. To run the sync script:

```bash
pip install -r scripts/requirements.txt
python scripts/sync.py --dry-run
```

## Project-Specific Rules

- NEVER commit files containing personal data (real app names, URLs, paths)
- After any sync, run `python scripts/sync.py --audit-only` before committing
- The README.md and docs/philosophy.md are maintained by the owner, not auto-generated
- This repo does NOT follow the author signature convention (no footer — it's not a web app)
