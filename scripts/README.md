# Sync Script

Copies your live `~/.claude/` configuration into this repo, applying anonymization rules to strip personal data before committing.

## Setup

```bash
cp scripts/anonymization.example.yaml scripts/anonymization.yaml
```

That is the whole setup **if you have [uv](https://docs.astral.sh/uv/)**.
`sync.py` carries [PEP 723](https://peps.python.org/pep-0723/) inline metadata
and a `#!/usr/bin/env -S uv run --script` shebang, so running it as
`./scripts/sync.py` builds its own environment on first run and reuses it
afterwards. There is no dependency step to forget and nothing installed into a
system Python.

### Without uv

`scripts/requirements.txt` is still maintained for this case:

```bash
pip install -r scripts/requirements.txt
python3 scripts/sync.py --dry-run    # invoke through python3, bypassing the shebang
```

**If that `pip install` is refused with `externally-managed-environment`**, your
Python is PEP 668-managed — Homebrew's is, and so are most distro packages.
Install into the user site instead, which leaves the managed installation
untouched:

```bash
python3 -m pip install --user --break-system-packages -r scripts/requirements.txt
```

Do not skip the step and hope. `sync.py` imports `yaml` at module scope, so a
missing PyYAML is an immediate `ModuleNotFoundError` and **the sync does not run
at all** — which also disables the sync step inside `/cleanup`, where nobody is
watching the output. That failure mode is the reason the uv path is preferred:
it has no step to skip.

The dependency is therefore declared twice — in `requirements.txt` and in
`sync.py`'s inline block. Keep them in step. There is exactly one, which is what
makes that affordable.

Edit `scripts/anonymization.yaml` with your real data — app names, URLs, domains, people. The file is gitignored and never committed.

## Usage

```bash
# Preview what would happen (no files written)
./scripts/sync.py --dry-run

# Run the sync
./scripts/sync.py

# Audit existing repo files for personal data leaks
./scripts/sync.py --audit-only

# Use a different source directory
./scripts/sync.py --source /path/to/claude-config
```

These read `python scripts/sync.py` until 2026-08-17. That form was already
broken on the machine this repo is synced from — there is no bare `python` on
it, only `python3` — and it bypasses the shebang, which is now what selects the
interpreter.

## Tests

```bash
uv run --with pytest --with PyYAML pytest scripts/ -q
```

`pytest` is deliberately absent from `requirements.txt`: that file is the
runtime dependency list for people running the sync, and adding a test-only
package would make every such person install it.

## How it works

1. Reads `anonymization.yaml` for replacement rules
2. Copies files from `~/.claude/` matching the `file_map` patterns
3. Applies exact string replacements (longest first, to avoid partial matches)
4. Applies regex patterns for catch-all rules (paths, emails)
5. Regenerates the `docs/workflow-guide.html` DATA arrays (commands, agents,
   skills, hooks) from live config via `generate_workflow_guide.py`, preserving
   the hand-written French and English descriptions and flagging genuinely new
   entries
6. Prunes orphaned repo files under synced roots (`commands/`, `agents/`,
   `skills/`, `hooks/`, `claude-scripts/`) whose live source has disappeared
7. Runs an audit: greps all output files (`.md`, `.html`, `.yml`, `.yaml`,
   `.sh`, `.json`) for patterns that should not survive. Gitignored paths are
   skipped — they can never be pushed — and so are the owner-maintained
   `README.md` and `LICENSE`, whose real name and links are deliberate. Without
   those two exclusions the gate is red on a clean tree, which makes it useless
8. Prints a summary and `git diff --stat` — you review and commit manually

## Adapting to your setup

The `anonymization.yaml` has four sections:

- **`replacements`**: Exact string replacements. Add your real app names, URLs, domains, and people here. Longer strings are applied first automatically.
- **`patterns`**: Regex patterns for catch-all rules (e.g., home directory paths).
- **`audit_patterns`**: Patterns to grep for after sync — anything matching is a potential leak.
- **`skip`**: Directories/files in `~/.claude/` to ignore entirely. Also the place to protect an owner-maintained repo file that happens to sit under a synced root (`hooks/README.md`), since a `file_map` glob would otherwise make it a sync destination and overwrite it.
- **`file_map`**: What to copy and where to put it.

### Option B: Public vs Private apps

The example config uses "Option B" — public apps (already on GitHub) keep their real names, while private apps get descriptive placeholders like `my-budget-app`. This makes the repo more readable for public apps while protecting private projects.
