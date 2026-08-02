# FAQ

## Can I use this with a team?

Yes. The setup is designed for a solo developer managing multiple apps, but the underlying patterns — agents, commands, skills — work for teams too. See the Adapting section in the README. The main thing to adjust is `anonymization.yaml`: extend it to cover team members' names, emails, and any shared infrastructure details you want to keep out of the public repo.

## Do I need all the agents?

No. The setup is modular by design. Start with the global `CLAUDE.md` — that alone changes how Claude approaches planning, commits, and quality. Add agents and commands incrementally as you identify the pain points they solve. Each agent is independent; removing one has no effect on the others.

## How do you handle secrets in the agents?

Environment variables, never in files. Agent files reference placeholders like `{email}` and `{github-username}` — these are substituted by the anonymization layer during sync, not stored in the repo. Nothing sensitive ever touches a file that gets committed.

## What if I use a monorepo?

Adapt `portfolio-sync` to scan workspace packages instead of `~/Dev/*`. The rest of the setup — commands, skills, hooks — is path-agnostic and works unchanged. The sync script accepts a configurable root directory for exactly this reason.

## How often do you update this?

The sync script is run roughly monthly to pull changes from the live config into this public repo. The live config itself evolves daily as new patterns emerge or existing ones get refined. The monthly cadence is a deliberate choice: it smooths out short-lived experiments and only publishes patterns that have proven stable.

## What is the context cost of this setup?

Rough estimates per session:

- Global `CLAUDE.md`: ~2–3K tokens (always loaded, every session)
- Agents, commands, skills: loaded on demand, not at startup — cost is per invocation, not per session
- No SessionStart hook in this setup, so there's nothing beyond `CLAUDE.md` charged at session start

Total baseline overhead is low. The main variable is how many agents you invoke in a session.

## Why YAML for `anonymization.yaml`?

Human readability and inline comments. It's hand-edited, not machine-generated, so the ability to document choices directly in the file matters — `scripts/anonymization.example.yaml` groups its `replacements` by category (GitHub, portfolio site, app URLs, people, private slugs) with a comment on each. JSON offers no equivalent.
