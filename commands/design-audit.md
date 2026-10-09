---
description: Audit the rendered design of live sites. Evidence capture first, then one critique per site. Argument is a URL, a repo name, or all.
argument-hint: [URL | repo name | all (default)]
model: opus
allowed-tools: Read, Write, Bash, Glob, Grep, Workflow
---

Audit the live design of the portfolio. Audit only: nothing is fixed here. This command orchestrates scripts and a skill that already exist; it holds no site list, no viewport and no count. Each script is the source of truth for its own numbers.

Definitions used below: `<date>` is today as `YYYY-MM-DD`. `<host>` is the URL host. `<slug>` is `<host>` when the URL path is `/` or empty; otherwise `<host>-<path>`, the path lowercased with every run of characters outside `a-z0-9` turned into one `-` and leading or trailing `-` trimmed (`https://elenchus.my-bias-app.example.com/fr/` → `elenchus.my-bias-app.example.com-fr`), so two rows on one host never share a directory. `<dir>` is `~/.claude/state/design-audit/<date>/<slug>/`.

## 1. Targets

`$ARGUMENTS` empty or `all`:

```
~/.claude/scripts/design-sites.sh
```

stdout is `<repo>\t<url>` per site (`-` in the repo column means no repo context). stderr is `gap\t<repo>` for each deployed repo with no homepage. Exit `0` complete, `1` gaps (the list is still printed), `2` unknown.

- Exit `2`: stop. Say the site list is unknown and quote stderr. Never read it as "no sites".
- Exit `1`: continue, and list every gap at the top of the summary as a coverage hole.

`$ARGUMENTS` is a URL (starts with `http`): that single site, repo `-`, unless `design-sites.sh` prints that host with a repo.
`$ARGUMENTS` is a repo name: run `design-sites.sh` and keep that repo's row. No row means unknown for that repo; say so and stop.

## 2. Evidence phase, sequential

One Chrome at a time. Run this loop yourself, in the foreground, before any agent exists:

```
mkdir -p <dir> && rm -f <dir>/report.md
~/.claude/scripts/design-detect.sh <url> <dir> 2><dir>/detect.stderr
```

The `rm` clears a report left by an earlier run of the same day, so step 4 can only find a report this run wrote. `detect.stderr` keeps the script's explanation; the summary quotes it. Record each site's exit code. Exit `0` captured and clean, `1` captured with hits, `2` unknown (capture failed, blank or error page, detector crash). Do not parallelize this phase.

## 3. Judgment phase

Load the `workflow-authoring` skill before writing the Workflow script. Use the Workflow tool (CLAUDE.md opts in multi-target fan-outs).

- One agent per site whose exit code is not `2`. **Name a model on every agent: `opus`** (per-site critique is judgment work).
- Keep each run under 10 agents. With more sites, batch into successive runs.
- Agent prompt, per site: "Load design-critique; audit mode (no fixes); evidence already captured in `<dir>`, design-detect exit `<N>` — do not re-run design-detect.sh; return the full report as your final message, write no file; repo is `~/Dev/<repo>`." When the repo column is `-`, replace the last clause with "no repo context". `<N>` is that site's exit code from step 2. Agents run in parallel, and a re-run would launch one Chrome per agent and overwrite the evidence the others read. Each agent runs design-critique's benchmark step (3b), which reads galleries with `gallery.mjs` and captures 2-3 reference sites into `<dir>/refs/`, each with its own Chrome: those are the only browser runs allowed in this phase, because they write nowhere another agent reads.
- Sites with exit `2` get no agent. They appear in the summary as `unknown`, quoting `<dir>/detect.stderr`.

## 4. Coverage check

Each agent returns its full report as its final message (design-critique's audit mode writes no file; a subagent cannot). Write each returned report, unchanged, to `<dir>/report.md` yourself. A missing or empty returned report is a **coverage failure**, never a clean site: zero findings plus no report means the review did not happen. Re-dispatch once for that site or mark it `coverage failure` in the summary.

## 5. Summary

Write `~/.claude/state/design-audit/<date>/summary.md`:

- Top: the gaps from step 1, then any `unknown` and `coverage failure` sites.
- One row per site: detector exit code, blockers, majors, minors, top finding, sanctioned count. Take the counts from each `report.md` header. Sort by blockers, descending.
- Detector findings are deduped across widths on `antipattern` + `snippet`; the per-width JSON in `<dir>` keeps everything.
- A site whose `capture.json` has `redirectedPath: true` is flagged "audited `<final path>` only" (use `finalUrl`). It is not a full-site audit.
- Sanctioned findings are counted as sanctioned, never as defects.
- A `Benchmark` column names the references each report used (from its `## Benchmark` table) and how many came from a gallery (its `source` column), or `none` when it wrote "no reference captured".

Then offer to publish the summary as an artifact. Never publish automatically.

## Report

Reply with the summary path, the count of sites by outcome (derived from the rows, not typed), and the worst blocker.
