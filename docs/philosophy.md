# Philosophy & Design Decisions

How this setup came to be — and why it works the way it does.

## First, a confession

I'm not a developer.

I mean, I can write code — I've done Python for data science, some Ruby, I understand architecture. But I don't review pull requests. I don't read diffs. I haven't looked at a line of code in my projects for months.

What I do is build things. I have ideas, I describe what I want, and Claude Code makes it happen. When something breaks, I describe the symptom. When I want a feature, I describe the behavior. The system you're looking at in this repo exists because of one realization: **if I'm never going to read the code, the AI needs a framework that makes it reliably good without my review.**

This isn't a developer's dotfiles. This is an orchestration system for someone who thinks in products, not in code.

If that sounds like the ultimate agile mindset — iterate fast, ship constantly, never get blocked by implementation details — that's because it is. I just didn't plan it that way. I got there by fixing problems one at a time.

## How I build this system

There's no grand design moment. Every rule in this setup exists because Claude Code did something I didn't expect, and I went to fix the instruction.

The pattern is always the same:

1. Claude Code does something wrong (or doesn't do something I assumed it would)
2. I open a conversation to figure out: "How do I make sure this never happens again?"
3. We write or adjust a rule in the CLAUDE.md, an agent instruction, or a hook
4. Back to building

This happened dozens of times. The system you see is the accumulated scar tissue of real problems. Nothing in here is theoretical — everything was added because something went wrong without it.

As Boris Cherny, who created Claude Code, [put it](https://x.com/bcherny/status/2021699851499798911): "Every engineer uses their tools differently." This is my way. Copy what resonates, ignore what doesn't.

---

## The Stories Behind the Decisions

### The My Tsundoku meltdown (or: why the 2-attempt rule exists)

My Tsundoku is a reading list app — nothing exotic. One day, I reported a bug. Claude Code fixed it confidently. "Done, the issue is resolved." Except it wasn't — the fix broke something else. So Claude Code fixed that. Which broke a third thing. Which got fixed. Which reintroduced the original bug.

This went on for a while. Each time, Claude Code announced with full confidence that the issue was resolved. Each time, I tested and found a new problem. It wasn't lying — it genuinely believed it had fixed the issue. But it was patching symptoms without understanding the structure.

Eventually, frustrated, I said: **"OK, stop everything. If you were starting from scratch, what would you actually do?"**

And just like that, Claude Code produced a clean analysis of the real problem — a structural issue it had been working around for the past hour. The fix took minutes.

That's when I understood: the problem isn't that Claude Code can't diagnose. It's that once it starts fixing, it's psychologically committed to its approach. Each attempt deepens the commitment. By attempt 3, it's defending a strategy, not solving a problem.

The rule became: **after 2 failed attempts, stop. Escalate to a fresh context (the architect agent) that has no emotional investment in any approach.** Not 3 attempts — 2. The third attempt is almost always the same approach with minor variations.

The self-check I added to the CLAUDE.md: *"If you catch yourself thinking 'let me just try one more thing' — that is the signal to stop."*

### The architect doesn't code (same story, different lesson)

The My Tsundoku meltdown taught me a second thing: diagnosis and implementation need to be separate agents.

When the same agent diagnoses a problem and then fixes it, it's biased. It gravitates toward solutions it can implement quickly, not toward the right solution. It might see that the real fix requires restructuring a data model, but since it's also the one who has to do the restructuring, it unconsciously favors the patch.

The architect agent is Opus-only, and its instructions are explicit: **"You do NOT write production code. You produce a plan."** It reads the codebase, identifies the root cause, evaluates options (including scary ones like "rewrite this module" or "swap this library"), and recommends one path with justification.

Then the implementer executes the plan. Different agent, different context, no sunk cost from the diagnosis phase.

This separation is the single most impactful architectural decision in the whole setup. It mirrors how good engineering teams work — the person who identifies the problem isn't always the person who should fix it, and they definitely shouldn't feel pressure to fix it fast because they're in the same conversation.

### The Opus wall (or: how I learned model selection)

My first week using this system, I had everything running on Opus. Best model, best results, right?

I kept hitting the rate limit. Multiple times a day. Even on the max plan. I was essentially locked out of my development environment for 20-minute stretches throughout the day. For someone who iterates fast and builds in short bursts, this was a dealbreaker.

So I started asking: does a compliance audit really need Opus? Does checking if a README matches the actual dependencies require the most powerful model? Obviously not.

The current split:
- **Haiku** for audits and compliance checks (portfolio-audit) — it's reading files and comparing against a checklist
- **Sonnet** for standard implementation — single-file changes, writing tests, docs updates, straightforward bugs
- **Opus** for two things only: architecture decisions (the architect agent) and complex implementation that touches many files or that Sonnet failed at

Since making this change: I've never hit the rate limit again. Not once. And the quality didn't drop — if anything, it improved, because Opus now has full capacity when I actually need it for hard problems.

This isn't just a cost decision. It's a quality decision. A model that's rate-limited when you need it most is worse than a cheaper model that's always available.

### Advisory hooks, not blocking (a design choice, not a lesson)

I never used blocking hooks. This was a deliberate choice from the start, not something I learned the hard way.

My reasoning: in a system where I don't review code, I need Claude Code to exercise judgment, not follow gates mechanically. A blocking hook that prevents a commit without a README update sounds rigorous — but what about a one-character typo fix? Should that really trigger a docs review?

Advisory hooks maintain the signal. They say: "Hey, you changed 4 files but didn't touch the docs — is that intentional?" Claude Code sees the nudge and decides. Sometimes the answer is "yes, this change doesn't affect docs." Sometimes it's "oh right, I should update the deployment section." Both are valid.

The goal is an AI that thinks about quality, not one that passes a checklist.

### Lost handovers (or: why agent memory replaced lesson files)

Early on, I used a simple system: each project had a `lessons.md` file where Claude Code wrote down what it learned after mistakes. At the start of each session, it would read the file.

The problems emerged gradually:
- The files had no structure — just a growing list of bullet points
- Nothing was automatically injected at startup. Claude Code had to be told to read the file, and sometimes it forgot (or the instruction got lost after a `/compact`)
- There was no compaction — files grew until they were too long to be useful
- Most critically: **handovers between sessions weren't being saved.** I'd finish a session with complex context, and the next session started from zero

The agent memory system fixes all of this. Agents with `memory: project` get their MEMORY.md auto-injected at startup — no instruction needed. They write to memory automatically after corrections and at session end. When memory exceeds 200 lines, it splits into topic files with a summary index.

The difference is night and day. Sessions now resume with context. Patterns discovered in January still inform work in March. And I didn't have to build a database — it's just structured markdown with auto-injection.

### Plans live outside repos (a strong opinion)

Every plan file in this system lives in `~/.claude/plans/`, never inside a project repository. This is a strong opinion, and I'll defend it.

Plans are working documents. They're messy, they change constantly, they contain step-by-step implementation details that are irrelevant once the work is done. Committing them to a repo is like committing your scratch paper.

For a solo developer, this is especially true. I don't need a historical record of "how we decided to restructure the auth flow" — I need the auth flow to work. If I need the history, it's in the commit messages (Conventional Commits, so they're readable) and in the agent memory (which captures patterns, not plans).

I even have a cleanup command that hunts for plan files that accidentally ended up in repos and removes them from git tracking. Plugins that create plans inside project directories get their output redirected to `~/.claude/plans/`.

The repo is for code, docs, and configuration. Plans are ephemeral.

---

## The Meta-Pattern

If there's one thing to take from all of this, it's the meta-pattern: **every rule is a response to a real problem.**

Don't adopt rules you don't need yet. Don't build a 6-agent system on day one. Start with Claude Code, a CLAUDE.md, and maybe the escalation rule (that one is universally useful). When something goes wrong — and it will — fix the system, not just the symptom.

That's how this setup grew from a blank CLAUDE.md to what you see in this repo. And it's still growing.

---

*The setup described here manages 10+ personal projects across different stacks (Next.js, React, Astro, Three.js, Python, Cloudflare Workers), deployed on Netlify, Vercel, and Cloudflare. It runs daily.*
