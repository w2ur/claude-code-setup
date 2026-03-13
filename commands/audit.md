---
description: Run docs-checker and portfolio-audit in parallel on the current project. Optionally specify a canonical URL.
argument-hint: [optional: canonical URL like https://app.example.com]
model: sonnet
allowed-tools: Read, Bash, Glob, Grep, Agent(docs-checker), Agent(portfolio-audit)
---

Run a full audit on the current project, dispatching two sub-agents in parallel.

## Dispatch

Launch both agents simultaneously:

1. **docs-checker** (sonnet): full documentation and git hygiene audit.
   - If `$0` looks like a URL (starts with `http`): pass it as the canonical URL for URL verification.
   - Otherwise: run without URL verification.

2. **portfolio-audit** (haiku): compliance check against portfolio standards.

## Consolidation

After both agents complete, produce a single consolidated report:

```
## Audit Report: [project name]

### Documentation (docs-checker)
[summary of docs-checker findings]

### Compliance (portfolio-audit)
[summary of portfolio-audit findings]

### Actions Taken
- [list of automatic fixes made by docs-checker]

### Manual Actions Needed
- [list of issues requiring human intervention]
```

## Post-audit

If any fixes were committed by docs-checker, remind the owner to review before pushing:
```bash
git log --oneline -5
```
