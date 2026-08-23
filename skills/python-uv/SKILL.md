---
name: python-uv
description: Why uv is the only Python manager on this machine, where the enforcement actually lives, and which plausible "fixes" are wrong. Load before writing any Python here, before touching a hook or scheduled job that runs Python, and before diagnosing a wrong-interpreter symptom.
user-invocable: true
---

# Python on this machine — the reasons

The hard rules live in `~/.claude/CLAUDE.md`. This skill holds the measurements
behind them, so that a future session does not re-derive the wrong belief from the
same evidence and "fix" something that is already correct.

Decided 2026-08-17.

No pyenv — `~/.pyenv` does not exist and must not come back. No development
Python from Homebrew. No `pip install` into a system interpreter.

## The enforcement lives in `uv.toml`, and that is the whole point

`~/.config/uv/uv.toml` sets `python-preference = "only-managed"`. That is what
actually enforces uv-only Python: uv then refuses a system interpreter outright.

It is deliberately **not** in `~/.zshrc`. A shell export reaches interactive shells
only — **a LaunchAgent and a cron entry never source `.zshrc`** — so setting it there
leaves it unset in exactly the place a wrong interpreter would be invisible.

uv's default *without* the setting is "prefer managed, but fall back to a system
Python if no managed one is installed", so the gap is real rather than theoretical.
`env-drift-check.py`'s `uv run --script` shebang runs under the my-monitoring-app LaunchAgent and
picks correctly today only because managed 3.11/3.12/3.13 happen to be installed.

**The falsifying control that was actually run.** uv discovers
`~/.config/uv/uv.toml` on every invocation regardless of shell. Verified with a
probe file set to `only-system`: that flipped `uv python find` to Homebrew's 3.14
with no env var set, and the same run without the file did not. The check was made
to produce the opposite answer before its silence was trusted.

Note `UV_PYTHON_PREFERENCE` is absent from uv 0.12.5's `--help`, which documents
`UV_MANAGED_PYTHON` instead. The old var is still parsed, but **the config key is
the stable form** — write the config key.

## Homebrew's `python@3.14` stays installed, and that is not a loophole

It is `installed_on_request=false` — a dependency of `gcloud-cli`, `mpv`, `yt-dlp`,
`vapoursynth` and `peon-ping`. `brew uninstall python@3.14` takes those with it.

So the rule is *"Homebrew Python is a library dependency of Homebrew formulae, never
a development interpreter"*, **not** *"no Homebrew Python exists"*. Do not try to
remove it. Do not file its presence as a finding.

## Why a bare `python3` is dangerous rather than merely untidy

There is no bare `python` and no bare `pip` on PATH at all. Any doc or script saying
`python -m venv` / `pip install -e .` is already broken, not merely unfashionable.
Several were, and were fixed in the same change.

A bare `python3` resolves to `/opt/homebrew/bin/python3` — the dependency
interpreter above — with Apple's `/usr/bin/python3` (3.9.6) behind it.

**Measured:** 3.9 runs a stdlib-only snippet fine. So an interpreter swap under a
scheduled job would be **invisible** until something used 3.10+ syntax. That is the
reason nothing in `~/.claude/scripts/` or `~/.claude/hooks/` calls a bare `python3`
any more — not tidiness, a silent-failure mode.

## In a hook, the answer is usually `jq`, not uv

All four hooks were reading JSON fields with `python3`; `secret-scan` alone spawned
an interpreter three times per invocation, on every Write and every Edit.

A field lookup needs no interpreter at all, and `/usr/bin/jq` ships with macOS, so it
resolves under any PATH a hook can inherit. Routing a per-keystroke hook through
`uv run` would have been strictly worse than the problem it solved.

Keep Python only where a real language is required — `push-build-gate`'s env-prefix
parser and `payload_gate.py` — and there resolve the interpreter **once**, after the
hook's cheap pre-filter, with the same resolver the scripts use.

**Never launch `payload_gate.py` via `uv run`.** `hook.sh` reads exit 2 as *block the
push* and exit 3 as *warn*. A launcher that can emit its own failure codes into that
channel can manufacture a verdict.

**A hook that cannot resolve its interpreter fails OPEN, loudly** — exit 1, the only
non-blocking code whose stderr the owner actually sees. Fail closed on the guard's
verdict; fail open on the guard's own malfunction.

## The three invocation patterns

- **Per-project: `uv sync`.** Creates `.venv`, installs from `uv.lock`, installs the
  project. Commit the lockfile.
- **One-off tooling with a requirements file: `uv run --with-requirements`.** No venv,
  no install step, cached after first use.
- **A standalone script: a PEP 723 header and a `#!/usr/bin/env -S uv run --script`
  shebang**, then executed *directly*. Never invoke such a script as
  `python3 script.py` — that bypasses the shebang, which is the single place its
  interpreter and dependencies are declared. That exact bug was live in my-monitoring-app's
  env-drift collector until 2026-08-17.

## The editable-install trap

`uv sync` installs the project **editable by default**. That is the configuration
behind the `MultiplexedPath` / `NotADirectoryError` break in `midas-core`:
`importlib.resources.files()` on a package with no `__init__.py` dies once any
editable install exists, and the wheel path hides it.

Re-run the single-directory assertion after any move to `uv sync` — the editable
finder's tables are frozen at install time.

## A public repo keeps its `pip` path

`claude-code-setup` documents both: uv for the owner, `requirements.txt` for anyone
cloning it. Do not force uv on readers of a published repo.
