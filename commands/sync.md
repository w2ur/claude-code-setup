---
description: Run portfolio-sync — validate stories collection frontmatter and report.
argument-hint: (no arguments)
model: sonnet
allowed-tools: Read, Agent(portfolio-sync)
---

Run the portfolio-sync agent to validate the stories collection frontmatter in `~/Dev/{portfolio-site}`.

## Background

Decision M12 (2026-07) retired the `.portfolio.yml` manifest system. This command used to fan out to `docs-checker`/`portfolio-audit` for every project `portfolio-sync` committed a manifest fix to; `portfolio-sync` no longer writes or commits anything, so there is nothing left to fan out on. The command now does exactly one thing.

## Execution

Use the Agent tool to invoke `portfolio-sync`: "Validate every story's frontmatter under stories-fr/ and stories-en/, report violations."

## Post-sync summary

After the agent completes, summarize:
1. How many stories were scanned and how many violations were found
2. Any stories needing attention, by slug and language
