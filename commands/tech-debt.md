---
description: |
  Monthly technical health review in two phases.
  Phase 1: fast triage across ALL portfolio apps — scores each app on commit activity,
  portfolio prominence, time since last scan, and detected issues. Proposes a priority order.
  Phase 2: deep review on the apps the owner selects.
  Run without args for the full flow, or skip to phase 2 with app names.
argument-hint: [app1 app2 ... | --triage-only]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent(implementer), Agent(troubleshooter)
---

Monthly technical health review. Two phases: triage everything, then deep-dive on your picks.

## Mode Selection

- If `$0` is empty: run Phase 1 (triage all) → present priority list → ask owner to pick → run Phase 2 (deep review).
- If `$0` is `--triage-only`: run Phase 1 only, no fixes.
- If `$0` is app names (e.g., `my-budget-app my-bias-app`): skip Phase 1, run Phase 2 directly on those apps.

---

## Phase 1 — Fast Triage (~1 min for all apps)

**Phase 1 is fully deterministic, so it is a script and not model work** (CLAUDE.md: deterministic work gets a script, no model). Run it and present its output:

```bash
bash ~/.claude/scripts/tech-debt-triage.sh
```

It scans every git repo in `~/Dev` (via `dev-scanner.sh --json`), scores each on the four signals below, and prints a ranked markdown table ready to show the owner. `--json` gives the same data machine-readable. It is **read-only** — it never writes the rotation tracker, because "last scan" means last *deep review*, not last triage.

| Signal | Source | Weight |
|---|---|---|
| A — commit activity | `git log --since="30 days ago"` | 2 if >10, 1 if 1–10, 0 if none |
| B — portfolio prominence | position of `repo: '<name>'` in `editorial.ts` (Layer 3, M12) | 2 if in the first 6, 1 if present later, 0 if absent |
| C — time since last deep review | `~/Dev/.tech-debt-rotation.json` | 3 never, 2 if >60d, 1 if 30–60d, 0 if <30d |
| D — quick issues | `npm outdated`, `npm audit`, `console.log` count, `.nvmrc` | +1 per high/critical vuln, +1 if >5 outdated, +1 if >3 `console.log` |

**Do not re-implement these signals inline.** The script is the single source of truth for the scoring; restating the weights here in runnable form is exactly how the two drift apart.

Exit codes: `0` clean · `2` ran but **degraded** (a required tool was missing, so the numbers are incomplete — say so before presenting them) · `1` hard error.

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
2. Needs review: Next.js 15→16 migration (dispatch the `troubleshooter` agent)
3. Escalate: localStorage migration (3 months unfixed → `troubleshooter` agent)
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
- Major upgrades → note for a dedicated follow-up session
- Performance regressions → note for investigation
- Escalated items → create a concrete plan, or escalate to the `troubleshooter` agent (cascade L3)

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
2. Dispatch the `troubleshooter` agent for: {list of major migrations}
3. Escalated items requiring decision: {list}
```
