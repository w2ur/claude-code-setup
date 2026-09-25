---
description: Take a plan from review to reviewed code — review, fold findings, stop for owner approval, execute, code-review, stop before push. Owns the sequencing and the approval stop only.
argument-hint: "<plan-path>  (a .md file in ~/.claude/plans/)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, Workflow, WebSearch
---

This command adds **only the sequencing and the approval stop**. It owns no review logic and
no execution logic: each step hands off to the skill named below, which does that work its
own way. The model of each step is named here so routing does not depend on the prompt; the
tiers themselves come from the **Sub-agents** section of `~/.claude/CLAUDE.md`.

`$0` is the plan path. **If it is empty, or not a `.md` file under `~/.claude/plans/`, stop
and ask** — plans never live in a repo, and a `*-review.md` file is not a plan.

## Step 1 — review (opus)

Invoke the `plan-reviewer:plan-review` skill on `$0`. **`$0` overrides the skill's
"most recently modified plan" default** — name the path explicitly. It writes
`~/.claude/plans/<plan-name>-review.md` with MUST / SHOULD / CONSIDER sections.

Before going on, confirm that review file exists and is newer than the plan. A missing or
stale review file means the review did not run; stop and say so.

## Step 2 — fold MUST and SHOULD (opus)

Snapshot the plan first, so Step 3 can show exactly what changed:

```bash
p="$0"; p="${p/#\~/$HOME}"
cp "$p" "${TMPDIR:-/tmp}/ship-plan-$(basename "$p" .md).before.md"
```

Then fold every MUST and SHOULD item into the plan, on opus: deciding the replacement text is
judgment, not execution. **Owner decisions are not re-litigated.** When a finding contradicts
a decision the plan records, do not fold it — list it for the owner instead. CONSIDER items
are the owner's call; list them, fold none.

## Step 3 — STOP: show the plan diff and wait for approval

```bash
p="$0"; p="${p/#\~/$HOME}"
diff -u "${TMPDIR:-/tmp}/ship-plan-$(basename "$p" .md).before.md" "$p"
```

Show that diff, then the unfolded items from Step 2 (decision conflicts and CONSIDER). **Stop
here and wait for the owner's explicit approval.** Do not start Step 4 in the same turn. If
the owner amends the plan, re-show the diff and wait again.

## Step 4 — execute (per the tier table)

- **Three or more independent targets** → a Workflow; load the `workflow-authoring` skill
  first.
- **Otherwise** → the `superpowers:subagent-driven-development` skill.

Either way every Agent call names its model from the tier table: implementers against a
spec with done-when criteria on sonnet, judgment on opus, list-shaped lookups on haiku.
Nothing is pushed or deployed in this step.

## Step 5 — code review

Run `/code-review high` on the resulting diff. When the diff touches a money path, auth or
secrets, a data migration or a public API contract, the `ultra` rule and the review-round
rule in the **Quality** section of `~/.claude/CLAUDE.md` decide the level and the number of
rounds — follow them there.

## Step 6 — stop before push

Report: the commits created, the code-review findings and how each was resolved, and any
plan requirement not met. **Do not push, merge or deploy.** That is the owner's go, given in
the session.
