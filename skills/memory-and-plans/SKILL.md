---
name: memory-and-plans
description: How the two memory systems on this machine resolve on disk, why per-agent stores are project-scoped and must never be consolidated upward or committed, and why claude-mem was removed. Load before creating, moving, consolidating or gitignoring any memory store, or before proposing a third place to keep session knowledge.
user-invocable: true
---

# Memory and plans — the reasons

The rules live in `~/.claude/CLAUDE.md`. This skill holds the mechanics.

## Two systems, one role each

| system | location | holds |
|---|---|---|
| **auto-memory** | `~/.claude/projects/-Users-{username}-Dev/memory/`, indexed by `MEMORY.md` | session handoffs, durable cross-session knowledge — user preferences, project state, feedback |
| **per-agent memory** | `<project root>/.claude/agent-memory/<agent>/` | operational knowledge scoped to ONE agent: patterns, past corrections in that agent's domain |

Do not duplicate across them.

**Do not call auto-memory "agent memory".** The bare phrase collides with the
per-agent system's actual name and has caused real confusion.

Plans are **not** a memory system. They live in `~/.claude/plans/`, never in a repo.

## How the `memory:` frontmatter key resolves

An agent definition's `memory:` key resolves as:

| value | resolves to |
|---|---|
| `user` | `~/.claude/agent-memory/<agent>/` |
| `project` | `<project root>/.claude/agent-memory/<agent>/` |
| `local` | `<project root>/.claude/agent-memory-local/<agent>/` |

**Every agent that declares it declares `project`. None declares `user`.**

## Why per-agent stores are scattered, and why that is correct

Because the key resolves against the *project root of the session that ran*, a store
appears wherever a session's project root happened to be:

- one per repo
- **plus one per nested working directory a session was launched from** (e.g.
  `<repo>/client/`)
- **plus one per worktree**

Anything under `~/.claude/agent-memory/` is **residue from sessions whose project
root *was* `~/.claude`** — not a separate tier.

**Do not "consolidate" them upward. That fights the resolver**, and the agent will
simply not find what you moved.

## Per-agent memory must never be committed

The harness default-ignores only `agent-memory-local/`, **not** `agent-memory/`. So a
repo trusting that default will happily stage its memory files.

Every repo with a store needs `.claude/` — or at minimum `.claude/agent-memory/` —
in `.gitignore`.

**Repos that deliberately track other `.claude/` content are the model here**: a
committed project `CLAUDE.md`, shared commands, or project skills. Ignore
`.claude/agent-memory/` specifically rather than the whole directory. A wholesale
`.claude/` ignore silently makes any project skill written there untracked and lost
on a fresh clone.

Check both directions after narrowing:

```bash
git check-ignore -v .claude/skills/x/SKILL.md   # must report NOTHING
git check-ignore -v .claude/agent-memory/x      # must still report a match
```

`settings.local.json` is already covered globally by `~/.config/git/ignore`.

## claude-mem was removed on 2026-07-25 (decision M13)

It was a **third** system holding session narrative and observation history.

It went unretrieved through a five-hour, 27-repo review while costing ~1.4 GB on disk
and a `$CMEM` injection at every session start.

**Do not reinstall it.** And do not compensate by writing session narrative into the
two systems above — that narrative already lives in the transcripts.
