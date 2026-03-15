---
description: Clean up stale plans from repos, audit plugin health, and compact agent memory files.
argument-hint: [optional: plans-only | plugins-only | memory-only]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Run housekeeping tasks across the development environment.

## Scope

- If `$0` is `plans-only`: run only the plans cleanup.
- If `$0` is `plugins-only`: run only the plugin audit.
- If `$0` is `memory-only`: run only the memory compaction.
- If `$0` is empty: run all three.

## Step 1 — Plans Cleanup

Find and remove plan files that ended up inside project repos:

```bash
# Find plan files inside ~/Dev projects (they should be in ~/.claude/plans/)
find ~/Dev -maxdepth 4 \( \
  -path "*/docs/plans/*" -o \
  -path "*/docs/superpowers/*" -o \
  -path "*/.superpowers/*" -o \
  -name "PLAN.md" -o \
  -name "plan.md" -o \
  -name "*.plan.md" \
\) -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null
```

For each file found:
1. Check if it's tracked by git: `git ls-files --error-unmatch <file> 2>/dev/null`
2. If tracked: `git rm --cached <file>` (untrack but keep on disk)
3. Check if the parent directory pattern is in `.gitignore`. If not, add it.
4. Commit: `chore: remove plan files from git tracking`

Also clean up stale plans in `~/.claude/plans/`:
```bash
# Show plans older than 30 days
find ~/.claude/plans/ -name "*.md" -mtime +30 -type f 2>/dev/null
```
Report how many stale plans exist. Ask before deleting.

## Step 2 — Plugin Audit

List all installed plugins and their agents:
```bash
ls ~/.claude/plugins/ 2>/dev/null
```

For each plugin, check:
1. Does it register agents? List them.
2. Does it inject SessionStart hooks? List them.
3. Does it create files inside project directories? (Check hook scripts for write patterns)

Report a summary:
```
## Installed Plugins

| Plugin | Agents | SessionStart Hook | Writes to Project |
|--------|--------|-------------------|-------------------|
| superpowers | code-reviewer, ... | Yes | Yes (plans) |
| pr-review-toolkit | 5 reviewers | No | No |
| ... | ... | ... | ... |

Total context cost at startup: ~X lines injected by SessionStart hooks
```

Flag any conflicts:
- Plugins whose agents overlap with your custom agents (architect, implementer, etc.)
- Plugins that write plans or files inside project repos
- Plugins you haven't used in the last 30 days (check ~/.claude command history if available)

## Step 3 — Memory Compaction

Check agent memory files:
```bash
for dir in ~/.claude/agent-memory/*/; do
  agent=$(basename "$dir")
  if [ -f "$dir/MEMORY.md" ]; then
    lines=$(wc -l < "$dir/MEMORY.md")
    echo "$agent: $lines lines"
  fi
done
```

If any MEMORY.md exceeds 200 lines:
1. Read the file
2. Identify sections that can be split into topic files
3. Move detailed content to topic files (e.g., `tailwind-patterns.md`)
4. Keep the top-level MEMORY.md under 200 lines with summaries and cross-references

## Step 4 — Workflow Guide & Strategic Docs Staleness Check

Check if the workflow guide and strategic docs are stale relative to the actual Claude Code config.

**Workflow guide:**
```bash
# Compare commands in ~/.claude/commands/ with commands listed in workflow-guide.html DATA section
ls ~/.claude/commands/*.md 2>/dev/null | xargs -I{} basename {} .md | sort > /tmp/cc-commands-actual
grep -o '"\/[a-z-]*"' ~/Dev/workflow-guide.html 2>/dev/null | tr -d '"/' | sort -u > /tmp/cc-commands-guide
diff /tmp/cc-commands-actual /tmp/cc-commands-guide
```

If there's a diff, report which commands are missing from or extra in the guide.

Do the same for agents:
```bash
ls ~/.claude/agents/*.md 2>/dev/null | xargs -I{} basename {} .md | sort > /tmp/cc-agents-actual
grep -oP '"name":\s*"[^"]*"' ~/Dev/workflow-guide.html 2>/dev/null | grep -oP '"[^"]*"$' | tr -d '"' | sort -u > /tmp/cc-agents-guide
diff /tmp/cc-agents-actual /tmp/cc-agents-guide
```

**Strategic docs:**
```bash
# Check if charte mentions the current number of commands
ACTUAL_CMD_COUNT=$(ls ~/.claude/commands/*.md 2>/dev/null | wc -l | tr -d ' ')
CHARTE_CMD_COUNT=$(grep -oP '\d+ commandes' ~/Dev/{portfolio-site}/strategy/charte-coherence.md 2>/dev/null | grep -oP '\d+')
if [ "$ACTUAL_CMD_COUNT" != "$CHARTE_CMD_COUNT" ] 2>/dev/null; then
  echo "⚠️  Charte says $CHARTE_CMD_COUNT commands, actual is $ACTUAL_CMD_COUNT"
fi
```

**claude-code-setup repo:**
```bash
# Check if claude-code-setup is stale vs live config
LIVE_HASH=$(find ~/.claude/commands ~/.claude/agents ~/.claude/skills ~/.claude/hooks ~/.claude/rules ~/.claude/CLAUDE.md -type f 2>/dev/null | sort | xargs md5sum 2>/dev/null | md5sum | cut -d' ' -f1)
REPO_HASH=$(find ~/Dev/claude-code-setup/commands ~/Dev/claude-code-setup/agents ~/Dev/claude-code-setup/skills ~/Dev/claude-code-setup/hooks ~/Dev/claude-code-setup/rules ~/Dev/claude-code-setup/CLAUDE.md -type f 2>/dev/null | sort | xargs md5sum 2>/dev/null | md5sum | cut -d' ' -f1)
if [ "$LIVE_HASH" != "$REPO_HASH" ]; then
  echo "⚠️  claude-code-setup is stale — running sync.py..."
fi
```

If claude-code-setup is stale, **auto-run the sync**:
```bash
cd ~/Dev/claude-code-setup && python scripts/sync.py
```

After the sync completes:
1. Run `git status` to see what changed.
2. If there are changes, commit them: `chore: sync with live ~/.claude/ config`
3. Do NOT push — just commit locally. The owner pushes manually.

Report any staleness found for workflow guide and strategic docs. Do NOT fix those — just flag them for the owner.

## Report

```
## Cleanup Report

### Plans
- Found in repos: [count] files across [count] projects
- Untracked from git: [count]
- .gitignore updated: [count] projects
- Stale plans in ~/.claude/plans/: [count] (older than 30 days)

### Plugins
- Installed: [count]
- With SessionStart hooks: [count]
- Writing to project dirs: [list]
- Potential conflicts: [list or "none"]

### Memory
- Agent memory files checked: [count]
- Over 200 lines: [list or "none"]
- Compacted: [list or "none needed"]

### Staleness
- Workflow guide: [OK / stale — missing commands: X, Y]
- Charte de cohérence: [OK / stale — command count mismatch, etc.]
- claude-code-setup repo: [OK / stale — synced and committed locally (push manually)]
- Action needed: [list or "all up to date"]
```
