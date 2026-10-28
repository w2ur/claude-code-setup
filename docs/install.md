# Install and adapt

[Back to the README](../README.md)

> [!NOTE]
> The setup is fully modular — you can copy everything, cherry-pick individual pieces, or just read and adapt the patterns to your own system.

## Requirements

- **`jq`**: the settings merge below and the hooks read JSON with it (macOS 15 and later ship it as `/usr/bin/jq`; otherwise `brew install jq`).
- **`uv`**: `push-build-gate` resolves its Python through `uv python find`. Install uv, then run `uv python install` to get a managed interpreter; without one the hook fails open and says so (see [`hooks/README.md`](../hooks/README.md#requirements)).
- **`gh`** (GitHub CLI, authenticated): only for the helper scripts in `claude-scripts/` that query GitHub (`gate-watch.sh`, `dev-scanner.sh`, and others). The hooks do not need it.
- **`git`** and **Node with `npm`**: the build gate runs your project's `npm run build` before a push.

## Option A: Copy the whole system

The commands are the same as in the README's [Quick start](../README.md#quick-start).

The helper scripts land in `~/.claude/scripts/` (published here as [`claude-scripts/`](../claude-scripts/)); the commands and the global `CLAUDE.md` call them there. An existing `~/.claude/CLAUDE.md` is saved as `CLAUDE.md.bak` before it is overwritten, and an empty `settings.json` is created when you have none, so the merge below has a file to read.

Copying the scripts is not enough — hooks don't run until they're registered in `~/.claude/settings.json`. Merge `hooks/settings.hooks.json` into your own settings file (`jq -s '.[0] * .[1]' ~/.claude/settings.json claude-code-setup/hooks/settings.hooks.json > /tmp/settings.merged.json && mv /tmp/settings.merged.json ~/.claude/settings.json` if you don't already have a `hooks` key — see [`hooks/README.md`](../hooks/README.md) for the manual-merge path if you do, plus how to verify a hook actually fired).

Mods are the same: copying `mods/` loads nothing. List each mod folder in `CLAUDE_CODE_PLUGIN_DIRS`, colon-separated, in the `env` block of `~/.claude/settings.json` (for example `"CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/context-bar:~/.claude/mods/usage-forecast:~/.claude/mods/agent-fleet:~/.claude/mods/portrait:~/.claude/mods/graphe:~/.claude/mods/panel"`), then start a new session.

Then edit `CLAUDE.md` and the agent files to replace `{github-username}`, `{portfolio-site}`, and other placeholders with your own values.

## Option B: Cherry-pick what you need

The setup is modular. Want just the escalation system? Copy the global `CLAUDE.md`'s bug-handling cascade, the `implementer` agent, and the `troubleshooter` agent. Want just the maintenance workflow? Copy `/cleanup` and `/tech-debt`. Each piece works independently — the full system is better, but partial adoption works fine.

## Option C: Read and adapt

Browse the files, understand the patterns, and build your own version. The [philosophy doc](philosophy.md) explains the "why" behind each choice — that's often more valuable than the "what."

## Adapting to your setup

This system was built for a very specific situation — here's how to adapt it to yours.

**If you have 1-3 apps:** You don't need half of this. Drop `portfolio-audit` — it exists because I have 10+ repos to keep in sync. Keep the `implementer` and `troubleshooter` agents, the escalation cascade in the global `CLAUDE.md`, and the two blocking hooks. That alone is a massive upgrade over bare Claude Code.

**If you work in a team:** The escalation rules still apply — they're about AI behavior, not team size. The `implementer`/`troubleshooter` split actually maps well to teams where juniors implement and seniors review. The memory system needs thought, though — per-developer or shared? I haven't solved that one.

**If you have a different stack:** My skills are specific to my projects. Throw them out and write your own. The architecture (commands → agents → skills + hooks) doesn't care what language you write in.

**If you use a monorepo:** The `portfolio-audit` agent and `/tech-debt` assume separate repos. You'd need monorepo-aware versions. Everything else works as-is.
