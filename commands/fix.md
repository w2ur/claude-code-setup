---
description: Fix a bug or implement a small task with full project context. Loads agent memory and CLAUDE.md automatically.
argument-hint: [description of the issue]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent(implementer), Agent(troubleshooter)
---

Fix the issue described: $0

## Context Loading

1. **Read the project CLAUDE.md** (if it exists at `./CLAUDE.md` or `./.claude/CLAUDE.md`)
2. Agent memory is auto-loaded via `memory: project` for both implementer and troubleshooter.

## Bug Triage

- If the issue involves UI not updating, visual stale state, or "it works on refresh": ask about service worker cache first.
- If clearly a code logic bug: skip triage and fix directly.

## Execution

Assess complexity and dispatch:
- **Simple** (single file, clear fix): execute directly.
- **Medium** (2-3 files, clear scope): dispatch to `implementer` with sonnet.
- **Complex** (4+ files, cross-layer, unclear root cause): dispatch to `implementer` with opus.

Always include the "done when" criterion when dispatching.

## Escalation

Follow the Bug Fix Escalation cascade in the global CLAUDE.md (Level 1 → 2 → 3). This command enters at Level 1.

## Post-fix

1. Ensure build passes with zero warnings
2. Provide a handoff summary
