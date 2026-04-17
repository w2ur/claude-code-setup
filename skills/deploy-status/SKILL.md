---
name: deploy-status
description: Check HTTP status + latest CI run for every production app in the portfolio. User-only slash command.
disable-model-invocation: true
---

# Portfolio Deploy Status

Run the bundled script to audit every production app in `~/Dev`:

```bash
bash ~/.claude/skills/deploy-status/check.sh
```

Output columns: status emoji · slug · HTTP code · CI status · URL.

Only scans projects whose `.portfolio.yml` has `status: production` and a defined `url`.
Results: ✅ 200/301/302 · ⚠️ 3xx or unusual · ❌ 4xx/5xx/network error.
