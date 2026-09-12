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
| 1 | the queue is non-empty, every source answered in full | present the queue |
| 2 | **a source could not be read, or answered with a caveat** | present the queue **and lead with what is unknown** |

**Exit 2 is the one that matters.** It means part of the sweep did not run, or cannot
be vouched for, so the queue is incomplete or mis-sorted by an unknown amount. It
comes in two shapes, and both must be repeated at the top of your reply, in the
owner's language, with the queue below explicitly described as partial:

- `SIGNAL LOST: <source>` — that source produced nothing this run can vouch for:
  it could not be read, or it answered with something frozen (a vigie snapshot whose
  `generated_at` is older than a day — nothing wrote it, so its counts are withheld
  rather than printed stale, because a dead collector otherwise reads as an empty band).
- `DEGRADED: <source>` — it produced items, but something about them is unknown: a
  fetch hit its ceiling (whatever is past it is absent from the queue), a classifier
  ran against a stale input, in which case an automated failure issue may be sitting
  unmarked in the low-priority tier reading like a stranger's feature request, or the
  source it derives from is itself partial (vigie with a dead collector: that band's
  counts come back as zeros, so its items are missing from the queue rather than
  absent from the world). The line names the remedy; pass it on rather than
  paraphrasing it.

**Never summarise an exit-2 run as "not much to do today"** — a short queue and a
dead input look identical, which is the exact failure this script exists to prevent.

## Step 3 — offer the one or two commands that clear the top items

Map, name at most two, and let the owner choose:

| queue source | command to offer |
|---|---|
| `vigie` — CI gate missing, env drift | `/tech-debt` |
| `vigie` — plans past the archive cutoff | `/cleanup` |
| `jobs` — an agent exited 2 | read its log; the path is in `jobs-inventory.sh --json` |
| `midas-issues` — an automated writer's failure issue | `gh issue view <n> -R {github-username}/my-trading-app` |

## Rules

- **Report state. Never act.** This command opens nothing, edits nothing, dispatches
  nothing. Naming a command is the whole job; the owner decides.
- **Do not re-derive the counts.** The script owns them. Restating a number you did
  not read from its output is how prose drifts away from the artifact.
- Keep it short. This is a queue you read in ten seconds, not a report.
