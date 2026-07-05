---
description: Run portfolio-sync — full scan, fix, and report. Optionally target a single project.
argument-hint: [project-name or --report-only]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent(portfolio-sync), Agent(docs-checker), Agent(portfolio-audit)
---

Run the portfolio-sync agent to synchronize all projects in ~/Dev.

## Mode Selection

- If `$0` is a project name (e.g., `my-editor-app`, `my-budget-app`): run portfolio-sync on that single project only.
- If `$0` is `--report-only`: run portfolio-sync in report-only mode (no writes, no commits).
- If `$0` is empty: run full portfolio-sync across all projects.

## Execution

Use the Agent tool to invoke `portfolio-sync` with the appropriate mode:

- **Full sync**: "Run full portfolio-sync: discover, cross-check, fix, generate portfolio-apps.json, report."
- **Single project**: "Run portfolio-sync on project $0 only: cross-check manifest, fix divergences, regenerate portfolio-apps.json, report."
- **Report only**: "Run portfolio-sync in report-only mode: discover, cross-check, report, but make no changes."

## Post-sync fan-out

Sub-agents can't dispatch sub-agents, so this command owns the fan-out portfolio-sync itself no longer does:

1. From the portfolio-sync report's "Changes Made" table, collect the list of projects that had commits this run.
2. For each changed project, dispatch in parallel (one Agent call per project, per CLAUDE.md's parallel-dispatch rule):
   - **docs-checker** (sonnet): audit README and CLAUDE.md accuracy
   - **portfolio-audit** (haiku): compliance check (signature, secrets, gitignore, tests)
3. Skip this fan-out entirely in `--report-only` mode (no changes were made, nothing to audit).

## Post-sync summary

After the agent and any fan-out complete, summarize:
1. How many divergences were found and fixed
2. docs-checker / portfolio-audit findings per project (from the fan-out, if run)
3. Any manual actions needed
4. Whether portfolio-apps.json was updated
5. Reminder: `git push` is manual — review changes first
