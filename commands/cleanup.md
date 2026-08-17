---
description: Sweep ~/.claude disk hygiene to stated retentions, clean up stale plans from repos, audit plugin health, and compact agent memory files.
argument-hint: [optional: disk-only | plans-only | plugins-only | memory-only]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Run housekeeping tasks across the development environment.

## Scope

- If `$0` is `disk-only`: run only Step 0 (disk hygiene).
- If `$0` is `plans-only`: run only the plans cleanup.
- If `$0` is `plugins-only`: run only the plugin audit.
- If `$0` is `memory-only`: run only the memory compaction.
- If `$0` is empty: run all steps.

## Step 0 — Disk Hygiene

Run the deterministic disk-hygiene sweep. It is the source of truth for all
retention numbers (AUTO tier days/keep-counts, CONFIRM tier rules) — do not
restate those numbers here, they will drift out of sync with the script.

1. Show the owner every action the sweep would take:
   ```bash
   ~/.claude/scripts/disk-hygiene.sh plan
   ```
   Present the grouped, per-category report as-is.

2. Apply the AUTO tier without asking (it never touches anything outside
   the retention rules encoded in the script, and plans are archived, never
   deleted):
   ```bash
   ~/.claude/scripts/disk-hygiene.sh apply
   ```

3. For the CONFIRM tier — stale `projects/` transcript dirs and plugin
   temp/whitespace dirs reported by the `plan` run above — present the
   owner with the specific paths and their sizes (e.g. `du -sh <path>`
   for each) and ask for explicit confirmation. Only on an explicit yes,
   re-run with the corresponding flag(s):
   ```bash
   ~/.claude/scripts/disk-hygiene.sh apply --yes-projects
   ~/.claude/scripts/disk-hygiene.sh apply --yes-plugins
   ```
   (both flags can be combined in one `apply` call if the owner confirms both.)

4. Any `REPORT`-verb lines (currently: marketplaces with no enabled plugin)
   are owner actions, surfaced verbatim with the `run: claude plugin
   marketplace remove <name> (then delete)` instruction from the script's
   reason field. Do NOT run `claude plugin marketplace remove` yourself —
   deregistering a marketplace is a decision for the owner, not something
   this command automates.

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

## Step 2 — Plugin Audit

List all installed plugins and their agents (`ls ~/.claude/plugins/` only lists cache/data directories, not the enabled registry — use the CLI):
```bash
claude plugin list 2>/dev/null
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
- Plugins whose agents overlap with your custom agents (troubleshooter, implementer, etc.)
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

Do the same for agents (the guide's `AGENTS` array uses unquoted keys, e.g. `{ name: "implementer", ... }` — scope the extraction to that array so skill/hook `name:` fields scattered elsewhere in the file aren't picked up):
```bash
ls ~/.claude/agents/*.md 2>/dev/null | xargs -I{} basename {} .md | sort > /tmp/cc-agents-actual
sed -n '/^const AGENTS = \[/,/^\];/p' ~/Dev/workflow-guide.html 2>/dev/null | grep -oP 'name:\s*"[^"]*"' | grep -oP '"[^"]*"$' | tr -d '"' | sort -u > /tmp/cc-agents-guide
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
**Do NOT compare live and repo file hashes.** The repo copy is deliberately anonymized by `sync.py` (personal paths, usernames and app names are rewritten), so its bytes can never equal the live bytes. A hash comparison reports "stale" on every run, for ever, and is therefore no signal at all.

The real question is whether the repo is a faithful *anonymized image* of live. `sync.py --dry-run` answers it directly — it is read-only and writes nothing:

```bash
cd ~/Dev/claude-code-setup && ./scripts/sync.py --dry-run
```

Read two counts from its summary — both are machine-checkable, so this is an assertion, not a judgement:
- `Stale: N (would write)` — mapped files plus the generated workflow guide whose anonymized output differs from what is in the repo (or is missing). **N > 0 means stale.**
- `Orphans: N` — files in the repo whose live source is gone. **N > 0 means stale.**

Both `0`, and an untracked-file check on the repo comes back empty → in sync.

**Do not read the per-file replacement counts as a staleness signal.** `(4 replacements)` describes the anonymization pass, not whether the destination is current — a file can be fully rewritten by the anonymizer and still be byte-identical to what the repo already has. Each per-file line now carries its own verdict (`up to date` / `would update` / `would create`) alongside the count, but the `Stale:` total is the one to bind to.

If claude-code-setup is stale, delegate to the `/sync-setup` command rather than duplicating its logic here — it already handles copying, anonymizing, stale-file cleanup, README counts, and the leak audit. Do NOT push — `/sync-setup` commits locally only; the owner pushes manually.

Report any staleness found for workflow guide and strategic docs. Do NOT fix those — just flag them for the owner.

## Report

```
## Cleanup Report

### Disk hygiene
- AUTO tier actions applied: [count] (breakdown per category from the script's SUMMARY line)
- Space freed: [size, e.g. via `du -sh` before/after or summed deleted file sizes]
- Awaiting owner confirmation: [count] stale projects/ dirs, [count] plugin temp/whitespace dirs
- Marketplace REPORT items (owner action needed): [list or "none"]

### Plans
- Found in repos: [count] files across [count] projects
- Untracked from git: [count]
- .gitignore updated: [count] projects

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
