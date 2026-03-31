---
description: Sync the claude-code-setup repo from live ~/.claude/ config. Copies + anonymizes files, cleans stale files, updates README counts, updates workflow guide, audits for leaks.
argument-hint: [--dry-run | --audit-only]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Sync the claude-code-setup repo from the live ~/.claude/ configuration.

## Step 1: Run sync.py

```bash
cd ~/Dev/claude-code-setup && python3 scripts/sync.py $0
```

If `$0` is `--dry-run` or `--audit-only`, stop after this step.

## Step 2: Clean stale files

Compare what exists in the repo against what exists in `~/.claude/`:

```bash
# Commands: repo commands/ vs ~/.claude/commands/
# Agents: repo agents/ vs ~/.claude/agents/
# Skills: repo skills/ vs ~/.claude/skills/
# Hooks: repo hooks/ vs ~/.claude/hooks/
```

For each file in the repo that has no corresponding source in `~/.claude/`, delete it and note it. Common cases: renamed agents (e.g., old `architect.md` after rename to `troubleshooter.md`), deleted commands, removed skills.

## Step 3: Update README.md counts and names

Read `~/Dev/claude-code-setup/README.md` and verify these match reality:

1. **Commands count** in `<summary><strong>Commands (N)</strong>` — count files in `~/.claude/commands/*.md`
2. **Agents count** in `<summary><strong>Agents (N)</strong>` — count files in `~/.claude/agents/*.md`
3. **Skills count** in `<summary><strong>Skills (N)</strong>` — count directories in `~/.claude/skills/*/`
4. **Hooks count** in `<summary><strong>Hooks (N)</strong>` — count hook scripts (`~/.claude/hooks/**/*.sh`)
5. **Commands table** — verify each command in the table exists in `~/.claude/commands/`, and each command file has a row. Add missing rows, remove stale rows.
6. **Agents table** — same check against `~/.claude/agents/`
7. **Skills list** — same check against `~/.claude/skills/*/SKILL.md`
8. **Hooks list** — same check against `~/.claude/hooks/**/*.sh` (exclude hooks/scripts/ legacy directory if it exists only in the repo)
9. **Architecture diagram** — verify command names, agent names, skill names, and hook names in the ASCII art match the tables

Fix any discrepancies by editing README.md directly. Apply the anonymization rules from `scripts/anonymization.yaml` to any new content (private app names → placeholders, personal URLs → example.com, etc.).

## Step 4: Update workflow-guide.html

The sync.py `extra_files` already copies `~/Dev/workflow-guide.html` → `docs/workflow-guide.html`. Verify the copy happened. If the workflow guide has new commands/agents/skills/hooks not yet in its DATA section, flag them (but don't edit the source — the source `~/Dev/workflow-guide.html` should be updated before running sync).

## Step 5: Final audit

```bash
cd ~/Dev/claude-code-setup && python3 scripts/sync.py --audit-only
```

If any audit warnings appear on synced files (not README.md or .portfolio.yml which are owner-maintained), fix the anonymization before committing.

## Step 6: Present results

Show:
- Files synced (from sync.py output)
- Stale files removed
- README updates made
- Audit status
- `git diff --stat`

Propose a commit message following Conventional Commits. Do NOT push — the owner reviews and pushes.
