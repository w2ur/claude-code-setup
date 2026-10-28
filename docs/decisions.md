# Key decisions

[Back to the README](../README.md)

These aren't arbitrary choices. Each one came from a specific failure. Read [the philosophy](philosophy.md) for the context behind each decision.

| Decision | Alternative I considered | Why I went this way |
|----------|------------------------|-------------------|
| 3-level escalation cascade | Binary "2 fails → architect" | The old binary rule skipped a crucial step: structured debugging. Level 2 (systematic debugging skill) catches tricky-but-not-architectural bugs before the cascade stops for a structural diagnosis. |
| Troubleshooter never codes | One agent diagnoses and implements | When the same agent diagnoses and codes, it's biased toward solutions it can implement quickly rather than the right solution. |
| Advisory hooks + 2 blockers | All advisory or all blocking | Most hooks should nudge, not gate. The exceptions: secret scanning (an irreversible leak) and the push build gate (an irreversible bad deploy) both block. |
| Property-based tests for invariants | Unit tests only | Unit tests verify examples. Property tests verify *laws* — "transfers preserve totals" catches edge cases no human would write. |
| Model selection per task | Always use the best model | Haiku is perfect for audits. Sonnet takes implementation against a written spec. Opus is for architecture and complex cross-file work. Matching model to task is a quality decision, not just a cost one. |
| Agent memory over lesson files | Flat markdown files per project | Files had no structure, no auto-injection, no compaction. Agent memory is read at startup, written automatically after corrections, and split when it grows too large. |
| Skills preloaded where an agent always needs them, on demand everywhere else | Everything preloaded, or everything left to dynamic loading | A skill an agent needs for its first decision is named in that agent's frontmatter, so it is there before the agent starts thinking. Every other skill is reached from CLAUDE.md by a trigger line naming the situation, so it costs nothing in a session that never meets that situation. |
| Derived inventory + README pitch block + editorial file (no hand-typed manifest) | One manifest per repo (`.portfolio.yml`) | A hand-typed manifest went stale the moment you renamed an app — 26 files × ~18 fields nothing but the tooling policing them ever read. The inventory is built by observing GitHub, stack, and live-URL health at build time, so nothing hand-typed can drift. |
