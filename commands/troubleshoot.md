---
description: Escalate to the troubleshooter agent after 2 failed fix attempts.
argument-hint: [problem description + what was tried]
model: opus
allowed-tools: Read, Bash, Glob, Grep, Agent(troubleshooter)
---

Invoke the troubleshooter agent with full context for: $0

## Context Assembly

Before dispatching to the troubleshooter, gather:

1. **Project CLAUDE.md**: read `./CLAUDE.md` or `./.claude/CLAUDE.md`
2. **Agent memory**: the troubleshooter's memory is auto-loaded via `memory: project` — contains past architecture decisions for this project
3. **Recent failures**: summarize what was tried and why it failed — extract from conversation history
4. **Current stack**: read `package.json` or equivalent to know what we're working with

## Dispatch

Invoke the `troubleshooter` agent with:
- **Context**: escalation after 2 failed fix attempts
- **Problem**: $0
- **What was tried**: list previous attempts and their failure modes
- **Constraints**: zero cost policy, deploy continuity, portfolio conventions

## Post-troubleshooter

When the troubleshooter returns a plan:
1. Present the plan to the owner for approval
2. Once approved, break the plan into implementer tasks
3. Each subtask gets dispatched to the implementer with the appropriate model (sonnet for simple, opus for complex)
