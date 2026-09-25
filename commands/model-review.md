---
description: New-model setup review — derive every model pin and headless job from the tree, add the new model's effort entry, re-test prompts and design scaffolding tuned for the previous model. Proposes; commits nothing without the owner.
argument-hint: "<new model id> [previous model id]  (e.g. claude-opus-5-5 claude-opus-5)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill
---

A new model has shipped and the owner wants the setup checked against it. The checklist
below is fixed; your judgment goes into what each hit means, not into which files to look at.

`$0` is the new model id. `$1`, if given, is the model it replaces. **If `$0` is empty, ask
for it — do not guess from the session model.**

## Step 0 — the standing decisions are not re-opened

Read the **Sub-agents** section of `~/.claude/CLAUDE.md`: the tier lattice, which tier does
what, and that effort lives per model in `settings.json` `modelSettings`. Apply it; do not
copy it into your report and do not propose changing it. A new release changes which model
an alias resolves to, not the lattice.

## Step 1 — derive the targets. Never hand-list them

Run this block **exactly, as one single Bash call**: shell state does not survive between
calls, so a grep split into its own call runs with no targets. It works under zsh and bash.
The target set is whatever it prints today:

```bash
targets=("$HOME/.claude/scripts")
while IFS= read -r f; do targets+=("$f"); done \
  < <(find "$HOME/Library/LaunchAgents" -maxdepth 1 -name 'com.example.*.plist')
for d in "$HOME"/Dev/*/; do
  case "$(basename "$d")" in my-encyclopedia-app|my-bible-app|my-facilitation-app) continue ;; esac
  for s in scripts src options docs/triggers .claude/agents; do
    [ -e "$d$s" ] && targets+=("$d$s")
  done
done
ex=(--exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.git
    --exclude-dir=.next --exclude-dir=dist)

printf '%s\n' '--- 1. model pins'
grep -rnE 'claude-(opus|sonnet|haiku|fable)-[0-9]|--model|^model: *(opus|sonnet|haiku|fable)' \
  "${ex[@]}" "${targets[@]}"

printf '%s\n' '--- 2. failing control'
real=$(grep -rhE 'claude-(opus|sonnet|haiku|fable)-[0-9]' "${ex[@]}" "${targets[@]}" | wc -l)
typo=$(grep -rhE 'claude-(opsu|sonet|haiky|fabel)-[0-9]' "${ex[@]}" "${targets[@]}" | wc -l)
if [ "$real" -gt 0 ] && [ "$typo" -eq 0 ]; then
  printf 'control ok: real=%d misspelled=%d\n' $real $typo
else
  printf 'CONTROL FAILED: real=%d misspelled=%d — the probe proves nothing\n' $real $typo
fi

printf '%s\n' '--- 3. headless claude -p calls'
grep -rnE '(claude|CLAUDE_BIN\}?"?) +-p( |$)' "${ex[@]}" "${targets[@]}"
```

my-encyclopedia-app, my-bible-app and my-facilitation-app are out of scope; never open them.

Section 2 is the probe made to fail once: the same model alternation, misspelled, must print
nothing while the real one prints hits. If it prints `CONTROL FAILED`, stop and say so. An
empty section 1 is a finding to explain, not a clean bill.

Section 3 lists the headless jobs: section 1 cannot see a `claude -p` that names no model,
and such a call inherits the session model silently.

For each hit, read the whole invocation (it may continue over `\` lines) before flagging it.

Classify every hit into one table — file:line, what it pins, verdict:

- **dated id of the previous model** → propose the new id, or say why it stays;
- **floating alias** (`opus`, `sonnet`, `haiku`, `fable`) → not a pin; it follows the release
  by design (my-trading-app keeps one on purpose). Leave it;
- **headless `claude -p` without `--model` or without `--effort`** → a finding: propose the
  pin;
- **test fixture or doc example** → note it, change it only with the code it mirrors.

Load the `scheduled-jobs` skill before editing any script or plist the table touches.

## Step 2 — the new model's `modelSettings` entry

```bash
jq '.modelSettings' ~/.claude/settings.json
```

If `$0` has no entry, add one and choose its `effortLevel`. State the choice and the reason in
one line — the entry of the model it replaces is the starting point, not the answer. If an
entry exists, confirm its effort still fits and say so.

## Step 3 — re-test instructions tuned for the previous model

Load the `claude-api` skill and run its prompt audit (`prompt-audit`) over the instruction
files the new model reads every session: `~/.claude/CLAUDE.md`, `~/.claude/agents/*.md`,
`~/.claude/commands/*.md`, `~/.claude/skills/*/SKILL.md`. Report what reads as
compensation for the previous model's habits and what the new model now does unprompted.

Propose changes; do not apply them. Before editing any CLAUDE.md, load the
`claude-md-hygiene` skill.

## Step 4 — re-test design and visual scaffolding

Load the `ui-ux-pro-max:ui-ux-pro-max` skill and have the new model propose a palette and
one screen for a throwaway subject. Check the result against the **Design defaults**
section of `~/.claude/CLAUDE.md` (the colour bias it names, dark + light mode, the author
signature). Report whether each default still has to be enforced or is now met unprompted.
Write nothing into a repo for this step.

## Report

One reply, in this order: the Step 1 table, the Step 2 entry and its reason, Step 3
findings, Step 4 findings, then the list of edits you propose. **Commit nothing and push
nothing until the owner approves the list.**
