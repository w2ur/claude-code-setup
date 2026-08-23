---
name: claude-md-hygiene
description: How to cut a CLAUDE.md without losing a fact — the four-bucket taxonomy, the trigger-line shape that makes an extracted skill actually load, the gitignore prerequisite, and the line-coverage check that must be made to fail once. Load before editing, restructuring or pruning any CLAUDE.md, or when claude-md-weight.sh reports a file over threshold.
user-invocable: true
---

# Cutting a CLAUDE.md without losing a fact

A `CLAUDE.md` is loaded **in full** into every session started under it, so its size
is a recurring tax, not a one-off cost. `~/.claude/scripts/claude-md-weight.sh`
measures every file on the machine and **owns the size threshold** — read the number
there, never re-type it in prose. (Restated numbers are exactly what that script
measures.)

## The four buckets

Sort every paragraph. This is the whole method.

| bucket | test | action |
|---|---|---|
| **guard** | prevents a wrong action a session would otherwise take | KEEP, compressed to the rule |
| **instruction** | a task that will eventually be finished | DELETE when done |
| **domain knowledge** | true, but only needed once you are already in that subsystem | MOVE to a skill |
| **archaeology** | how we found out, or what we used to believe | DELETE — git log holds it |

Refinements that decide the hard cases:

- **A measured-wrong rule stays.** "This looks like an obvious improvement but was
  measured to be wrong" is a guard, because without it a session re-derives the wrong
  belief from the same evidence. State it **as a rule**, never as a story.
- **Money-path, auth and secrets rules stay**, always.
- **The measurement itself goes to the skill.** The rule is the guard; the
  falsifying control, the numbers and the retraction narrative are domain knowledge.
- **When a belief here turns out wrong, delete the wrong sentence.** Do not strike it
  through and explain. Keep a retraction only where a future session would
  independently re-derive the wrong belief from the same evidence.
- **Never hand-type a count, an inventory or a file list.** Derive it, or omit it.
  This construction has drifted repeatedly — "eighteen scripts" when there were
  nineteen, "Eight plugins" when there were ten, a plist count written from memory.
- **Each script is the source of truth for its own numbers** (retentions, weights,
  thresholds, tiers). Prose describes them and must never restate them.

## An extracted skill only helps if something loads it

A skill loads when the model decides to invoke it. So the line that survives in
CLAUDE.md must name **the skill AND the situation**. Copy this shape:

> **Scheduled jobs and `~/.claude/scripts/`: load the `scheduled-jobs` skill** before
> creating, editing, moving or diagnosing any of them. It holds the reasons;
> `jobs-inventory.sh` derives the current state.

A bare "see the X skill" is not a trigger and will not fire.

Skill frontmatter: `name` kebab-case (prefix with the repo name for a project skill);
`description` naming the **situation** that should trigger it, not just the topic.

## Prerequisite 1 — a wholesale `.claude/` gitignore silently voids the work

A project skill written under a repo that ignores `.claude/` wholesale is
**untracked and lost on a fresh clone.** Narrow first to
`.claude/agent-memory/`, `agent-memory-local/`, `worktrees/`, then prove **both**
directions:

```bash
git check-ignore -v .claude/skills/x/SKILL.md   # must report NOTHING
git check-ignore -v .claude/agent-memory/x      # must STILL report a match
```

Per-agent memory must never become tracked. See `memory-and-plans`.

## Prerequisite 2 — a CLAUDE.md can be a load-bearing input to a check

Documentation here is sometimes parsed. Before moving or deleting a section:

```bash
grep -rn "CLAUDE\.md" scripts src bin tools .github 2>/dev/null
```

Split the hits into *comments that mention it* (repoint the prose) and *code that
reads it* (repoint the path). After repointing, **corrupt the moved artifact on
purpose and confirm the verifier goes red** — a check that now reads a file with no
matching section can throw, pass vacuously, or match nothing, and only the deliberate
failure tells you which.

Measured in `my-monitoring-app`: `scripts/verify-strata.mjs` parses a CLAUDE.md section and pins
its bolded rows against the `@keyframes` in `tokens.css`. Moving the section made
`npm run verify` throw, while `npm test` and `astro build` both stayed green.

## Verification — line coverage, and make it fail once first

Every substantive original line must appear in the new CLAUDE.md or in a skill.

```bash
git show HEAD:CLAUDE.md > /tmp/before.txt   # BEFORE editing
# after:
while IFS= read -r line; do
  [ ${#line} -lt 40 ] && continue
  grep -qF -- "$line" CLAUDE.md .claude/skills/*/SKILL.md 2>/dev/null \
    || printf 'UNCOVERED: %s\n' "$line"
done < /tmp/before.txt
```

**`-F` and `--` are not optional.** Without them `grep` silently mis-parses any line
starting with `-` and reports garbage — that bug produced a fake clean pass once.

Then **delete a known sentence and confirm it is reported**. A check that has never
produced the opposite answer is not evidence.

An uncovered line is not automatically a bug — a deleted count or a deleted
retraction story is a *correct* uncovered line. But you must be able to name the
bucket for every one.

## The method that has worked twice

Move the *reasoning* into skills; keep only what a session must see **unprompted**.
Nothing is deleted except hand-typed counts and archaeology. Project skills live at
`<repo>/.claude/skills/<name>/SKILL.md`; machine-wide ones at
`~/.claude/skills/<name>/SKILL.md`.
