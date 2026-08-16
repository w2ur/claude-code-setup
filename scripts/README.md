# Sync Script

Copies your live `~/.claude/` configuration into this repo, applying anonymization rules to strip personal data before committing.

## Setup

```bash
pip install -r scripts/requirements.txt
cp scripts/anonymization.example.yaml scripts/anonymization.yaml
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
watching the output. A virtualenv works too, but then every documented
`python3 scripts/sync.py` invocation has to be run from it, including the one
`/cleanup` makes.

Edit `scripts/anonymization.yaml` with your real data — app names, URLs, domains, people. The file is gitignored and never committed.

## Usage

```bash
# Preview what would happen (no files written)
python scripts/sync.py --dry-run

# Run the sync
python scripts/sync.py

# Audit existing repo files for personal data leaks
python scripts/sync.py --audit-only

# Use a different source directory
python scripts/sync.py --source /path/to/claude-config
```

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
