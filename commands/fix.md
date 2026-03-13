---
description: Fix a bug or implement a small task with full project context. Loads agent memory and CLAUDE.md automatically.
argument-hint: [description of the issue]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent(implementer), Agent(architect)
---

Fix the issue described: $0

## Context Loading

Before starting any work:

1. **Read the project CLAUDE.md** (if it exists at `./CLAUDE.md` or `./.claude/CLAUDE.md`)
2. **Check agent memory**: the implementer agent's memory is auto-loaded via `memory: project` in its frontmatter. It contains past patterns and lessons for this project.
3. **If dispatching to architect**: its memory is also auto-loaded and contains past architecture decisions.

## Bug Triage (if this looks like a bug)

Before touching code, assess whether this could be an environment issue:
- If the issue involves UI not updating, visual stale state, or "it works on refresh": ask about service worker cache first.
- If the issue is clearly a code logic bug (wrong output, missing feature, error in source): skip triage and fix directly.

## Execution

Assess task complexity:
- **Simple** (single file, clear fix): execute directly as the main agent.
- **Medium** (2-3 files, clear scope): dispatch to `implementer` agent with sonnet.
- **Complex** (4+ files, cross-layer, or unclear root cause): dispatch to `implementer` agent with opus.

Always include the "done when" criterion when dispatching.

## Escalation

If the fix fails after 2 attempts: STOP. Do not try a third time.
Invoke the `architect` agent with:
- What the problem is
- What was tried (both attempts)
- Why each attempt failed

## Post-fix

After the fix is verified:
1. Ensure build passes with zero warnings
2. The implementer agent auto-updates its memory if this fix revealed a new pattern — no action needed
3. Provide a handoff summary
