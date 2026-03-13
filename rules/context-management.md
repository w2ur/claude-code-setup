# Context Management

- Monitor context usage. When context reaches ~50%, run `/compact` proactively — do not wait for degradation.
- The "agent dumb zone" (>70% context) produces lower-quality output. Prevent it, don't diagnose it.
- When switching to a completely different task mid-session, consider `/clear` to start fresh.
- After a `/compact`, re-read the project CLAUDE.md and any loaded skills — they may have been summarized away.
- Use `/context` to check current usage before starting complex tasks.
- When dispatching to sub-agents, prefer focused prompts over conversation history dumps.
