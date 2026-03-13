# Sync Script

Copies your live `~/.claude/` configuration into this repo, applying anonymization rules to strip personal data before committing.

## Setup

```bash
pip install -r scripts/requirements.txt
cp scripts/anonymization.example.yaml scripts/anonymization.yaml
```

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
5. Runs an audit: greps all output files for patterns that should not survive
6. Prints a summary and `git diff --stat` — you review and commit manually

## Adapting to your setup

The `anonymization.yaml` has four sections:

- **`replacements`**: Exact string replacements. Add your real app names, URLs, domains, and people here. Longer strings are applied first automatically.
- **`patterns`**: Regex patterns for catch-all rules (e.g., home directory paths).
- **`audit_patterns`**: Patterns to grep for after sync — anything matching is a potential leak.
- **`skip`**: Directories/files in `~/.claude/` to ignore entirely.
- **`file_map`**: What to copy and where to put it.

### Option B: Public vs Private apps

The example config uses "Option B" — public apps (already on GitHub) keep their real names, while private apps get descriptive placeholders like `my-budget-app`. This makes the repo more readable for public apps while protecting private projects.
