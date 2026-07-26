---
description: Execute the next unblocked task from a master plan track, then stop. Pass A or B.
argument-hint: "A | B | a task id (e.g. A1.2, B0)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill
---

You are executing an approved multi-phase plan. **Work one phase, verify it, update the ledger, stop.**

## Which track

`$0` selects the track: `A` = portfolio (`~/Dev`), `B` = setup (`~/.claude`). A task id like `A1.2` or `B0` selects that track and that task. **If `$0` is empty, ask which track — do not guess.**

- Track A ledger: `~/.claude/plans/2026-07-25-progress-A.md`
- Track B ledger: `~/.claude/plans/2026-07-25-progress-B.md`

**Before doing anything, read your ledger's *Cross-track rules* section and obey it.** In particular: a Track B task marked `EXCLUSIVE` mutates the tooling a Track A session would be using — agents, skills, hooks, plugins, memory. Before starting one, check whether a Track A session is open (ask the owner if you cannot tell). If one is, pick a non-`EXCLUSIVE` task instead, or stop and say so.

## Read in this order — and stop reading when you have what you need

1. Your track's ledger. Check the **Gates** and **Cross-track rules**, then find the first task that is `todo` and not gated. If `$0` named a task id, do that one — but still check its gates and refuse if one is unmet.
2. `~/.claude/plans/2026-07-25-portfolio-and-setup-master-plan.md` — **only the section for that one task.** The file is ~700 lines; reading it whole wastes the context you need for the work.
3. Nothing else, unless a task explicitly points you at a file.

If a task says "execute the fresh-eyes plan", read that plan's phase — not all of it.

## Context discipline — this is the actual job

The plan is far larger than one context window. Treat context as the scarce resource:

- **Do the work in subagents, not in your own context.** Dispatch each atomic task to the `implementer` agent with the spec and its done-when criteria. Read the subagent's summary; do not pull its full output or the files it touched into your reasoning.
- **Never read a whole repo.** Every task names its files. Go to them.
- **Never read Track C.** It is a backlog, deliberately unscheduled. Pulling from it is the failure mode this plan exists to prevent.
- **Stop early rather than late.** End the session when the phase is verified, or when context is roughly two-thirds consumed, or when you hit an owner-only blocker. A clean handover beats a half-finished phase.

## Execute

- Follow the **done-when** criteria literally. They are checks, not descriptions. If a criterion cannot be run, the task is not done.
- **Verify against reality, not against the diff.** Where a done-when names a `curl`, run it after deploy. A fix that was never confirmed live is not a fix.
- Where a task changes behaviour with a runtime surface, pair it with a regression test written *before* the fix, and watch it fail first.
- Zero build warnings. Conventional Commits. One logical change per commit. `/code-review` before merging anything nontrivial.

## Model tiers — locked, do not re-litigate

Plan with **Opus**. Implement with **Sonnet** — that is the default and it is sufficient for most code. Opus for implementation only when a task genuinely spans 4+ files across layers, or on retry after Sonnet failed. Haiku for basic mechanical passes. **If work is fully deterministic, write a script — no model.** Fable is manual escalation for the hardest planning only, never assumed.

## Owner-only — prepare, never attempt

DNS changes, hosting teardown (Cloudflare / Netlify / Vercel), `gh repo archive`, domain purchases, paid-account actions, and anything irreversible touching production data. Stage everything up to the click, then append a line to the ledger's **Owner-only checklist** describing exactly what the owner must do.

## Never

- Re-review the portfolio, re-plan, or propose alternatives to decisions **M1–M15**. Fifteen decisions are locked with the owner and the analysis phase is over. If you believe one is wrong, say so in one sentence and proceed anyway unless the owner replies.
- Expand scope, add tasks, or "improve" something adjacent to the one you were asked to fix.
- Mark a task `done` on the strength of a merge. `done` means **verified**.
- Skip a salvage step before an archive or teardown. Those are irreversible and the salvaged artifacts are named in the plan.

## Before you stop — always

1. Update **your track's ledger only** — never the other track's file. Task statuses, any new owner-only items, and one line in the **Session log** saying what shipped and where the next session should start.
2. Report to the owner: what shipped, what was verified and how, what is blocked and on whom.
3. Do **not** roll into the next phase. Each phase gets a fresh context.

## Background

A 21-agent review of all 27 repos in `~/Dev`, merged with an existing hub remediation plan and a `~/.claude` audit. The headline finding, which orders the whole plan: **the bottleneck is distribution, not marketing copy** — 27 projects, 4 public repos, 2 GitHub stars, 0 community posts. Building has repeatedly won the tiebreak over shipping. When a task could be read as either "polish something" or "publish something already finished", it means publish.

If you need to defend a finding rather than act on it, the full review is at `https://claude.ai/code/artifact/0ea3ac19-6bf4-44ff-b8e3-0aa1cfd94144` and per-agent returns are in `~/.claude/projects/-Users-{username}-Dev/f332727f-0926-47d8-97f7-58b4aa735a1e/subagents/workflows/wf_53d6b100-783/journal.jsonl`. Do not read these to start work — only to settle a dispute.
