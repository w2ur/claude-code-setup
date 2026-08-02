# Hooks

Four `hook.sh` scripts, each dropped in its own `~/.claude/hooks/<name>/hook.sh` directory. Two are advisory — they print a note and let the tool call through. Two are blocking — they `exit 2` and Claude Code refuses the write or the push.

| Hook | Event | Blocks? | What it does |
|------|-------|---------|--------------|
| `auto-format` | PostToolUse → `Write\|Edit` | Advisory | Runs Prettier / `ruff format` / `rustfmt` on the file Claude just wrote, if the project already has a formatter config. Silent no-op otherwise — it never invents a style for a project that hasn't picked one. |
| `stale-readme-guard` | PreToolUse → `Bash` (`git push`) | Advisory | Diffs the unpushed range against upstream. If a deploy/dependency file changed (`package.json`, `Cargo.toml`, `netlify.toml`, ...) but `README.md` didn't, it surfaces a note — the push still goes through. |
| `secret-scan` | PreToolUse → `Write\|Edit\|NotebookEdit` | **Blocking** | Greps the content about to be written for API-key-shaped strings (OpenAI/Anthropic `sk-`, AWS `AKIA`, GitHub `ghp_`/`gho_`/`ghs_`, GitLab `glpat-`, Stripe `pk_`/`sk_live`/`sk_test`, hardcoded `password:`/`secret:`/`token:` assignments...). On a match it prints the pattern to stderr and `exit 2`s — the write never happens. Skips `.env.example` and `~/.claude/plans/`. |
| `push-build-gate` | PreToolUse → `Bash` (`git push`) | **Blocking** | If the target repo has an npm `build` script, runs it before the push goes out. Non-zero exit, or any `N warning(s)` in the output, blocks the push with `exit 2`. |

## Copying the scripts is not enough

Claude Code doesn't discover `~/.claude/hooks/` on its own. A hook only fires if it's registered under the `hooks` key of `~/.claude/settings.json` — event type, matcher, and the exact command to run. Drop the four directories in place and skip this step, and all four scripts sit there dead: no formatting, no secret scan, nothing. This repo ships [`hooks/settings.hooks.json`](settings.hooks.json), generated from the live registration on every `/sync-setup` run (see [`scripts/sync.py`](../scripts/sync.py)), so it can't drift from what's actually wired up.

## Registering

`hooks/settings.hooks.json` looks like this:

```json
{
  "hooks": {
    "PostToolUse": [ ... ],
    "PreToolUse": [ ... ]
  }
}
```

It has to end up merged into your `~/.claude/settings.json`'s own `hooks` key.

**If you have no `hooks` key yet** — a plain `jq` merge works:

```bash
jq -s '.[0] * .[1]' ~/.claude/settings.json claude-code-setup/hooks/settings.hooks.json > /tmp/settings.merged.json \
  && mv /tmp/settings.merged.json ~/.claude/settings.json
```

**If you already have a `hooks` key** — `jq`'s `*` merges objects recursively but *replaces* arrays wholesale, so an existing `PreToolUse` array would get clobbered instead of extended. Don't run the one-liner above in that case. Open both files side by side and paste the event blocks in by hand:

```jsonc
// ~/.claude/settings.json, inside the top-level "hooks" object
"PreToolUse": [
  // ...your existing entries...
  {
    "matcher": "Write|Edit|NotebookEdit",
    "hooks": [
      { "type": "command", "command": "bash ~/.claude/hooks/secret-scan/hook.sh", "timeout": 5, "statusMessage": "Scanning for secrets..." }
    ]
  }
  // repeat per event/matcher block from hooks/settings.hooks.json
]
```

Either way, the registration assumes the path convention `~/.claude/hooks/<name>/hook.sh` — if you copied the scripts somewhere else, the `command` fields need updating to match.

## Requirements

Every hook shells out to `python3` to parse the tool-call JSON on stdin (matching keys out of it in bash is not worth the pain). It has to be on `PATH` — no `python3`, no hook. `push-build-gate` also shells out to `node` to read `package.json`'s `scripts.build`.

## Verifying a hook actually fired

Registering the snippet is not the same as watching it work. The check that matters is a deliberate trigger with a control — if you can't make the hook fail, its silence proves nothing.

1. **Trigger it.** Ask Claude Code to write a file containing something that looks like a hardcoded AWS access key — the four-letter AWS prefix immediately followed by sixteen uppercase letters/digits, assigned to a variable like `AWS_SECRET_ACCESS_KEY`. With `secret-scan` registered, the write is refused: Claude Code reports the tool call failed, and `hook.sh` printed `SECRET SCAN: Blocked write to ...` to stderr before exiting 2.
2. **Prove the control.** Temporarily remove the hook's entry from `settings.json` (or point `CLAUDE_CONFIG_DIR` at a config dir where the scripts are copied but unregistered) and repeat the exact same request. The write should now succeed silently. If it does, you've confirmed the block in step 1 came from the hook, not from something else refusing the write.

Same idea applies to the other three: `push-build-gate` on a `git push` in a repo with a failing build, `stale-readme-guard` on a push that touches `package.json` without `README.md`, `auto-format` on an edit to a file in a project with a `.prettierrc`.
