# Hooks

Four `hook.sh` scripts, each dropped in its own `~/.claude/hooks/<name>/hook.sh` directory. Two are advisory — they print a note and let the tool call through. Two are blocking — they `exit 2` and Claude Code refuses the write or the push.

| Hook | Event | Blocks? | What it does |
|------|-------|---------|--------------|
| `auto-format` | PostToolUse → `Write\|Edit` | Advisory | Runs `ruff format` on a `.py` file in a repo that configures ruff (`ruff.toml`, `.ruff.toml`, or a `[tool.ruff]` table in `pyproject.toml`), or `rustfmt` on a `.rs` file inside a Cargo project. Silent no-op otherwise — it never invents a style for a project that hasn't picked one. |
| `stale-readme-guard` | PreToolUse → `Bash` (`git push`) | Advisory | Diffs the unpushed range against upstream. If a deploy/dependency file changed (`package.json`, `Cargo.toml`, `netlify.toml`, ...) but `README.md` didn't, it surfaces a note — the push still goes through. |
| `secret-scan` | PreToolUse → `Write\|Edit\|NotebookEdit` and `Bash` | **Blocking** | Greps the content about to be written, or the shell command about to run, for API-key-shaped strings (OpenAI/Anthropic `sk-`, AWS `AKIA`, GitHub `ghp_`/`gho_`/`ghs_`, GitLab `glpat-`, Stripe `pk_`/`sk_live`/`sk_test`, hardcoded `password:`/`secret:`/`token:` assignments...). On a match it prints the pattern to stderr and `exit 2`s — the write never happens. Skips `.env.example` and `~/.claude/plans/`. Without `jq` it refuses the call and says why, rather than letting it through. |
| `push-build-gate` | PreToolUse → `Bash` (`git push`) | **Blocking** | If the target repo has an npm `build` script, runs it before the push goes out. Non-zero exit, or any `N warning(s)` in the output, blocks the push with `exit 2`. Needs a uv-managed Python (see [Requirements](#requirements)); without one it fails open and says so. |

## These hooks protect a machine, not a repository

Every hook here is **local**. They fire inside Claude Code on one laptop, which
means they see exactly one thing: what Claude is about to do there. A commit
pushed from a git worktree on another machine, or a file created through the
GitHub web editor, or a branch opened by anyone else, meets none of them.

One consequence worth stating plainly, because it was measured rather than
assumed:

- **`push-build-gate` is the strongest hook here and it still only covers pushes
  from this machine.** That is by design — it is a pre-push gate, not a CI
  system — but it does mean "the build is green" is a claim about one laptop.

So the two layers are complements, not duplicates:

| | Local hooks | CI (`<account>/.github`, reusable `pr-gate.yml`) |
|---|---|---|
| Fires on | a tool call in this Claude Code session | a pull request / a push to main |
| Sees | what Claude writes here | every commit, from anywhere |
| Speed | instant → seconds | ~2–4 minutes |
| Catches | the mistake before it is made | the mistake that arrived another way |

The build is deliberately checked in **both** places. The local gate is faster
and stops the push; the CI job covers the pushes the local gate never saw.

### The invariant CI adds, and hooks cannot

A hook either runs or does not, and you are sitting there watching it. CI has a
third state that looks like success:

```console
$ echo '{}' | jq -e 'all(.[]; .result == "success")'
true          # exit 0 — a gate covering nothing reports success
```

A job excluded by `if:` reports `skipped`; a job dropped from a `needs:` list
reports nothing at all; and `all` over an empty collection is vacuously true.
So the aggregating job must assert a **named list of checks computed up front**
and refuse an empty one — never "did anything fail?". That job is the only check
a branch protection rule should require; requiring the individual checks
reintroduces the same hole, since a rule can only require a name it already
knows.

Note that on a **private repository, GitHub Free cannot enforce any of this** —
branch protection and rulesets both return
`403 Upgrade to GitHub Pro or make this repository public`. The gate still runs
and still shows a red X; it just cannot block the merge button. Worth knowing
before you describe it as a gate to anyone.

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

- **`jq`** — all four hooks read the tool-call JSON on stdin with it. It ships as `/usr/bin/jq` on macOS; elsewhere install it from your package manager. `secret-scan` does not guess without it: it prints a reason to stderr and exits 2, so every write is refused until `jq` is found on `PATH`.
- **`node`** — `push-build-gate` reads `package.json`'s `scripts.build` with it.
- **A uv-managed Python** — `push-build-gate` runs its env-prefix parser and `payload_gate.py` with an interpreter it resolves through `uv python find`, never a bare `python3`. Install uv, then `uv python install` to get a managed interpreter. On a machine without one the hook cannot resolve an interpreter, exits 1 (non-blocking, with the reason on stderr) and the push goes through ungated: it fails open on its own malfunction, and only blocks on the verdict of a build it could run.

## Verifying a hook actually fired

Registering the snippet is not the same as watching it work. The check that matters is a deliberate trigger with a control — if you can't make the hook fail, its silence proves nothing.

1. **Trigger it.** Ask Claude Code to write a file containing something that looks like a hardcoded AWS access key — the four-letter AWS prefix immediately followed by sixteen uppercase letters/digits, assigned to a variable like `AWS_SECRET_ACCESS_KEY`. With `secret-scan` registered, the write is refused: Claude Code reports the tool call failed, and `hook.sh` printed `SECRET SCAN: Blocked write to ...` to stderr before exiting 2.
2. **Prove the control.** Temporarily remove the hook's entry from `settings.json` (or point `CLAUDE_CONFIG_DIR` at a config dir where the scripts are copied but unregistered) and repeat the exact same request. The write should now succeed silently. If it does, you've confirmed the block in step 1 came from the hook, not from something else refusing the write.

Same idea applies to the other three: `push-build-gate` on a `git push` in a repo with a failing build, `stale-readme-guard` on a push that touches `package.json` without `README.md`, `auto-format` on an edit to a `.py` file in a repo whose `pyproject.toml` has a `[tool.ruff]` table.
