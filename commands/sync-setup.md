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

## Step 2: Verify stale-file cleanup

`sync.py` now prunes orphans automatically: any file under a synced root
(`commands/`, `agents/`, `skills/`, `hooks/`, `rules/`) whose live source has
disappeared is deleted on a real run (reported on `--dry-run`) and listed under
the `── Orphans ──` section of the output. Common cases: renamed agents (e.g.,
old `architect.md` after rename to `troubleshooter.md`), deleted commands,
removed skills, retired hooks.

Just confirm the reported orphans look intentional. Owner-maintained trees
(`docs/`, `README.md`, root-level files) are never pruned.

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

`sync.py` regenerates the `docs/workflow-guide.html` DATA arrays (COMMANDS,
AGENTS, SKILLS, HOOKS) directly from live config via
`scripts/generate_workflow_guide.py`. It derives the verifiable fields (agents
lists, models, skills, memory, hook events/modes, preloaded), preserves the
hand-written French `desc`/`when`/`args` for existing entries, and flags any
genuinely new entry with a `TODO: write desc` placeholder (listed under
`Guide TODOs` in the output).

The renderer and the `SCENARIOS` array are preserved byte-for-byte — they are
NOT auto-derived. If a new command/agent/skill/hook needs a French description,
or if SCENARIOS prose references a retired hook, edit
`~/Dev/workflow-guide.html` by hand (that live file supplies the preserved
prose and the renderer), then re-run sync.

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
