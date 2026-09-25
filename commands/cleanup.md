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

4. Any `REPORT`-verb lines are owner actions, surfaced verbatim with the
   script's reason field — for a marketplace with no enabled plugin, the
   `run: claude plugin marketplace remove <name> (then delete)` instruction.
   The `# job-logs` comment lines naming logs no plist writes are surfaced
   too; the script never touches those files, and neither does this
   command. Do NOT run `claude plugin marketplace remove` yourself —
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

Per-agent memory is project-scoped by design (see the `memory-and-plans` skill) —
stores are scattered across every repo, not just `~/.claude`. Check every one of
them, not just the `~/.claude` residue. Nested working dirs put stores deep (an
archived snapshot's sits at depth 7), and a store can hold topic files with no
`MEMORY.md`, so list store directories rather than index files:
```bash
find ~/Dev ~/.claude -maxdepth 10 \( -name node_modules -o -name .git \) -prune -o \
  -type d -path '*/.claude/agent-memory/*' ! -path '*/.claude/agent-memory/*/*' -print 2>/dev/null | sort | while read -r d; do
  store=${d%/.claude/agent-memory/*}
  files=$(find "$d" -type f | wc -l | tr -d ' ')
  if [ -f "$d/MEMORY.md" ]; then lines="$(wc -l < "$d/MEMORY.md" | tr -d ' ') lines"; else lines="no MEMORY.md"; fi
  echo "$store [$(basename "$d")]: $lines, $files files"
done
```
Do not propose consolidating these stores upward — that fights the resolver, which
keys each one to the project root of the session that wrote it.

If any MEMORY.md exceeds 200 lines:
1. Read the file
2. Identify sections that can be split into topic files
3. Move detailed content to topic files (e.g., `tailwind-patterns.md`)
4. Keep the top-level MEMORY.md under 200 lines with summaries and cross-references

## Step 4 — Workflow Guide & Strategic Docs Staleness Check

Check if the workflow guide and strategic docs are stale relative to the actual Claude Code config.

**Workflow guide:** its COMMANDS / AGENTS / SKILLS / HOOKS arrays are generated from live config, so ask the generator rather than grepping the HTML:

```bash
g=~/Dev/claude-code-setup/scripts/generate_workflow_guide.py
if [ -x "$g" ]; then "$g" --check; echo "exit=$?"; else echo "exit=2 (no generator at $g)"; fi
```

It is read-only. Bind to the exit code, never to silence:
- `0` — the four arrays match live config and no entry owes prose.
- `1` — a finding: report its `drift in <ARRAY>: <entries>` and `owed prose: …` lines verbatim. The fix is `--live` (rewrites the arrays in place) followed by writing the owed `desc`/`desc_en`/`when`/`when_en` prose in `~/Dev/workflow-guide.html`.
- `2` — could not run (guide missing, an array block missing, unusable `settings.json`, an empty live directory). Report it as **unknown**, never as current.

SCENARIOS and the prose around the arrays are hand-written and outside this check. If a command, agent or skill was retired, grep the SCENARIOS array for its name yourself.

**Strategic docs:**

There is no automated count check here. The charte is expected to state a stale
command/agent count in its dated history lines — that is prose recording what was
true on a given date, not a claim about today (see the global rule against hand-typed
counts). Read `~/Dev/{portfolio-site}/strategy/charte-coherence.md` yourself if
you suspect drift, and flag it to the owner in prose; don't script a comparison
against a "current count" line, since the doc carries more than one count on
purpose.

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

`--dry-run` above is exempt from the hand-edit guard, so this step always reads its counts cleanly. But a hand-edited destination shows up here as `would update`, and the `/sync-setup` you delegate to will then **exit 2 rather than overwrite it**. That is the guard working, not a failure: report the named files and stop. The fix is to move the change into `~/.claude/`, never `--allow-dirty`.

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
- Workflow guide: [OK (--check exit 0) / drift or owed prose (exit 1, its lines) / unknown (exit 2)]
- Charte de cohérence: [OK / stale — command count mismatch, etc.]
- claude-code-setup repo: [OK / stale — synced and committed locally (push manually)]
- Action needed: [list or "all up to date"]
```
