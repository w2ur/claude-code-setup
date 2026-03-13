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

## Pre-flight

Before launching the agent, check context usage with a quick self-assessment. If context is above 50%, run /compact first to ensure the sync agent has room to work.

## Execution

Use the Agent tool to invoke `portfolio-sync` with the appropriate mode:

- **Full sync**: "Run full portfolio-sync: discover, cross-check, fix, dispatch sub-agents, generate portfolio-apps.json, report."
- **Single project**: "Run portfolio-sync on project $0 only: cross-check manifest, fix divergences, regenerate portfolio-apps.json, report."
- **Report only**: "Run portfolio-sync in report-only mode: discover, cross-check, dispatch sub-agents for reports, but make no changes."

## Post-sync

After the agent completes, summarize:
1. How many divergences were found and fixed
2. Any manual actions needed
3. Whether portfolio-apps.json was updated
4. Reminder: `git push` is manual — review changes first
