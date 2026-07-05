---
name: fresh-session
description: Audit the ~/.claude/ setup for startup-cost drift. Reports CLAUDE.md size, plugin count, registered agent count, and flags the biggest contributor when thresholds are exceeded.
disable-model-invocation: true
---

# Fresh Session Health Check

Run these checks and report the numbers. Flag anything over threshold.

## Measurements

```bash
# CLAUDE.md size (target ≤2,500 tokens ≈ 9,000 chars)
wc -c ~/.claude/CLAUDE.md

# Plugins enabled (target ≤12)
claude plugin list 2>/dev/null | grep -c "Status: ✔ enabled"

# Agents registered (each plugin agent costs 70-700 tok)
ls ~/.claude/agents/*.md | wc -l
```

## Thresholds

| Metric | Target | Warn |
|---|---:|---:|
| CLAUDE.md chars | ≤9,000 | >12,000 |
| Plugins enabled | ≤12 | >15 |
| Custom agent files | ≤10 | >15 |

## Output format

```
CLAUDE.md:          X chars (~Y tok)   [OK/WARN]
Plugins enabled:    N                  [OK/WARN]
Agent files:        N                  [OK/WARN]

Top drift contributor: <name>
Recommendation: <action>
```

If all OK, say so and stop.
