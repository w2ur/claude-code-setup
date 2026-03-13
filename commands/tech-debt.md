---
description: |
  Monthly technical health review in two phases.
  Phase 1: fast triage across ALL portfolio apps — scores each app on commit activity,
  portfolio prominence, time since last scan, and detected issues. Proposes a priority order.
  Phase 2: deep review on the apps the owner selects.
  Run without args for the full flow, or skip to phase 2 with app names.
argument-hint: [app1 app2 ... | --triage-only]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent(implementer), Agent(architect)
---

Monthly technical health review. Two phases: triage everything, then deep-dive on your picks.

## Mode Selection

- If `$0` is empty: run Phase 1 (triage all) → present priority list → ask owner to pick → run Phase 2 (deep review).
- If `$0` is `--triage-only`: run Phase 1 only, no fixes.
- If `$0` is app names (e.g., `my-budget-app untilt`): skip Phase 1, run Phase 2 directly on those apps.

---

## Phase 1 — Fast Triage (~2 min for all apps)

Scan every project in ~/Dev that has a `.portfolio.yml`. For each app, collect 4 scoring signals:

### Signal A: Commit Activity (proxy for change velocity → more changes = more risk)
```bash
cd ~/Dev/{slug}
COMMITS_30D=$(git log --since="30 days ago" --oneline 2>/dev/null | wc -l | tr -d ' ')
```

### Signal B: Portfolio Prominence (higher = more visible = higher stakes)
```bash
# Read sort_order from .portfolio.yml — lower sort_order = more prominent
SORT_ORDER=$(grep "sort_order:" .portfolio.yml 2>/dev/null | awk '{print $2}')
# Also check portfolio_card: true/false
PORTFOLIO_CARD=$(grep "portfolio_card:" .portfolio.yml 2>/dev/null | awk '{print $2}')
```

### Signal C: Time Since Last Scan
```bash
# Read from rotation tracker
LAST_SCAN=$(python3 -c "import json; d=json.load(open('$HOME/Dev/.tech-debt-rotation.json')); print(d.get('${slug}','never'))" 2>/dev/null || echo "never")
```

### Signal D: Quick Issue Detection (lightweight, no install/build)
```bash
cd ~/Dev/{slug}

# Outdated deps count (fast — reads lock file, no network)
OUTDATED=$(npm outdated --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "?")

# Security vulnerabilities (fast — reads local audit cache)
VULNS=$(npm audit --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); m=d.get('metadata',{}); print(m.get('vulnerabilities',{}).get('high',0)+m.get('vulnerabilities',{}).get('critical',0))" 2>/dev/null || echo "?")

# Console.log count (instant grep)
CONSOLE_LOGS=$(grep -rn "console\.log" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" . 2>/dev/null | grep -v node_modules | grep -v dist | grep -v ".test." | wc -l | tr -d ' ')

# Node version check (if .nvmrc exists)
NODE_FILE=$(cat .nvmrc .node-version 2>/dev/null | head -1)
```

### Scoring

Compute a priority score for each app (higher = more urgent):

| Signal | Weight | Score |
|--------|--------|-------|
| Commits in last 30 days | ×2 if >10, ×1 if 1-10, ×0 if 0 | 0-2 |
| Portfolio prominence | ×2 if sort_order ≤ 6 and portfolio_card: true, ×1 if card true, ×0 if card false | 0-2 |
| Time since last scan | ×3 if never, ×2 if >60 days, ×1 if 30-60 days, ×0 if <30 days | 0-3 |
| Quick issues | ×1 per critical/high vuln, +1 if >5 outdated, +1 if >3 console.logs | 0-3+ |

### Present Triage Results

Sort by priority score (descending) and present as a table:

```
## Tech Debt Triage — {date}

| # | App | Score | Commits (30d) | Last Scan | Vulns | Outdated | Issues |
|---|-----|-------|---------------|-----------|-------|----------|--------|
| 1 | untilt | 8 | 23 | never | 2 high | 14 | 3 console.log |
| 2 | my-budget-app | 6 | 12 | 2026-01-15 | 0 | 8 | Node 18 (.nvmrc) |
| 3 | birdie | 5 | 0 | never | 1 high | 22 | — |
| 4 | my-tsundoku | 4 | 5 | 2026-02-20 | 0 | 3 | — |
| ... | ... | ... | ... | ... | ... | ... | ... |
| 12 | kairos | 0 | 0 | 2026-03-01 | 0 | 1 | — |

💡 Recommended: review the top 3-4 (untilt, my-budget-app, birdie, my-tsundoku)
```

Then ask: **"Which apps do you want me to review in depth? (names or numbers, or 'top N')"**

Wait for the owner's response before proceeding to Phase 2.

---

## Phase 2 — Deep Review (selected apps only)

For each app the owner selected, run a thorough analysis:

### 2a. Dependencies Health
```bash
npm outdated 2>/dev/null
npm audit 2>/dev/null
# For Python: pip list --outdated, pip-audit
```

Classify:
- **Critical**: security vulns (high/critical severity)
- **Major**: major version bumps available
- **Minor**: minor/patch updates

### 2b. Node & Framework Versions
- Node version vs current LTS
- Main framework version vs latest (Next.js, Astro, Vite, React, etc.)
- TypeScript version vs latest

Flag if more than 1 major behind.

### 2c. Dead Code & Quality
```bash
npx depcheck --json 2>/dev/null          # unused deps
# Console.log (already counted in triage, get file:line details now)
# Commented-out code blocks (3+ consecutive lines)
# Unused TypeScript imports: npx tsc --noEmit 2>&1 | grep "declared but"
```

### 2d. Performance
```bash
npm run build 2>&1 | tail -20            # build output
du -sh dist/ build/ .next/ .astro/ 2>/dev/null  # output size
```

Note deployed URL for manual Lighthouse check if needed.

### 2e. Build Warnings
```bash
npm run build 2>&1 | grep -i "warn"
```

### 2f. Previous Debt

Check agent memory for items flagged in previous /tech-debt sessions for this app.
If an item has been flagged 2+ months without action, mark it as **ESCALATE**.

### Per-App Report

```
## Deep Review: {app-name}

Scanned: {today} | Previous: {last scan date or "never"}

### 🔴 Critical (fix now)
- ...

### 🟡 Major (plan this month)
- ...

### 🟢 Minor (fix when convenient)
- ...

### 📋 Carried Forward
- [flagged {date}] description — {ESCALATE if 2+ months old}

### Recommended Actions
1. Auto-fixable: npm audit fix, remove 2 unused deps, remove 4 console.log
2. Needs review: Next.js 15→16 migration (schedule /architect)
3. Escalate: localStorage migration (3 months unfixed → /architect)
```

## Phase 3 — Fix (if owner approves)

After presenting all deep review reports, ask:
**"Want me to auto-fix the safe items? (security patches, dead code, unused deps)"**

If yes, for each app:

**Auto-fix (safe):**
- `npm audit fix` (non-breaking patches)
- Remove console.log statements
- Remove unused dependencies
- Apply minor/patch updates: `npm update`

Commit each category:
```bash
git add -A && git commit -m "chore(tech-debt): {description}"
```

**Flag for later:**
- Major upgrades → note for next `/architect` session
- Performance regressions → note for investigation
- Escalated items → create a concrete plan or escalate to `/architect`

Do NOT push. The owner reviews and pushes.

## Phase 4 — Update Tracking

Update `~/Dev/.tech-debt-rotation.json` with today's date for each deeply-reviewed app.

Write a summary to agent memory:
- What was found and fixed per app
- What was flagged for later
- What was escalated

## Consolidated Report

```
## Monthly Tech Debt Report — {date}

### Triage Summary
- Apps scanned (triage): {total}
- Apps reviewed (deep): {count} — {list}

### Results
| App | Critical | Major | Minor | Auto-fixed | Needs Manual | Escalated |
|-----|----------|-------|-------|------------|--------------|-----------|
| ... | ... | ... | ... | ... | ... | ... |

### Next Month
Top candidates for next session (based on today's triage):
- {app}: {reason}
- {app}: {reason}

### Manual Actions
1. Review and push commits: {list of apps with commits}
2. Schedule /architect for: {list of major migrations}
3. Escalated items requiring decision: {list}
```
