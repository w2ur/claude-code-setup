---
description: What needs you today across every tracked source — a queue, not a dashboard. Names the commands that would clear the top items; runs none of them.
argument-hint: (no arguments)
model: haiku
allowed-tools: Bash(~/.claude/scripts/intendant.sh:*)
---

Print the queue, then name what would clear it. **Do not run any of the commands you name.**

## Step 1 — run the aggregator

```bash
~/.claude/scripts/intendant.sh
```

It is deterministic and no-model; you are only reading and routing its output.

## Step 2 — read the exit code, and say what it means

| exit | meaning | what to say |
|---|---|---|
| 0 | nothing needs the owner | "Nothing needs you." Stop there. |
| 1 | the queue is non-empty, every source answered | present the queue |
| 2 | **at least one source could not be read** | present the queue **and lead with what is unknown** |

**Exit 2 is the one that matters.** It means part of the sweep did not run, so the
queue is incomplete by an unknown amount. Any `SIGNAL LOST:` line must be repeated at
the top of your reply, in the owner's language, and the queue below it explicitly
described as partial. **Never summarise an exit-2 run as "not much to do today"** —
a short queue and a dead input look identical, which is the exact failure this script
exists to prevent.

## Step 3 — offer the one or two commands that clear the top items

Map, name at most two, and let the owner choose:

| queue source | command to offer |
|---|---|
| `vigie` — CI gate missing, env drift | `/tech-debt` |
| `vigie` — plans past the archive cutoff | `/cleanup` |
| `jobs` — an agent exited 2 | read its log; the path is in `jobs-inventory.sh --json` |

## Rules

- **Report state. Never act.** This command opens nothing, edits nothing, dispatches
  nothing. Naming a command is the whole job; the owner decides.
- **Do not re-derive the counts.** The script owns them. Restating a number you did
  not read from its output is how prose drifts away from the artifact.
- Keep it short. This is a queue you read in ten seconds, not a report.
