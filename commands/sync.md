---
description: Run portfolio-sync — validate stories collection frontmatter and report.
argument-hint: (no arguments)
model: sonnet
allowed-tools: Read, Agent(portfolio-sync)
---

Run the portfolio-sync agent to validate the stories collection frontmatter in `~/Dev/{portfolio-site}`.

## Execution

Use the Agent tool to invoke `portfolio-sync`: "Validate every story's frontmatter under stories-fr/ and stories-en/, report violations."

## Post-sync summary

After the agent completes, summarize:
1. How many stories were scanned and how many violations were found
2. Any stories needing attention, by slug and language
