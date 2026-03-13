---
description: Escalate to the architect agent for structural diagnosis or upfront design decisions.
argument-hint: [problem description or feature to design]
model: opus
allowed-tools: Read, Bash, Glob, Grep, Agent(architect)
---

Invoke the architect agent with full context for: $0

## Context Assembly

Before dispatching to the architect, gather:

1. **Project CLAUDE.md**: read `./CLAUDE.md` or `./.claude/CLAUDE.md`
2. **Agent memory**: the architect's memory is auto-loaded via `memory: project` — contains past architecture decisions for this project
3. **Recent failures** (if this is an escalation): summarize what was tried and why it failed — extract from conversation history
4. **Current stack**: read `package.json` or equivalent to know what we're working with

## Dispatch

Invoke the `architect` agent with:
- **Context**: what triggered this (escalation after N failed attempts, or upfront design for a new feature)
- **Problem/Goal**: $0
- **What was tried**: if escalation, list previous attempts and their failure modes
- **Constraints**: zero cost policy, deploy continuity, portfolio conventions

## Post-architect

When the architect returns a plan:
1. Present the plan to the owner for approval
2. Once approved, break the plan into implementer tasks
3. Each subtask gets dispatched to the implementer with the appropriate model (sonnet for simple, opus for complex)
