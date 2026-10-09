---
name: design-critique
description: Load before reviewing any rendered UI — a live site, a local build, or a page you just changed — and before claiming a visual change is done.
user-invocable: true
---

# Design critique — a rendered, bounded review loop

Code review cannot see a page. This skill reviews what the browser actually drew:
screenshots and a deterministic detector first, judgment against a written rubric
second, and a fix loop that stops after one re-check.

Two modes. **Audit**: report only, change nothing. **Fix**: the same review, then
step 6. The caller says which; when unsaid, it is audit.

## 1. Evidence first

**Evidence already captured.** When the caller says the evidence is already in
`<dir>` with a design-detect exit code `N` (the `design-audit` command does,
after its sequential capture), do **not** run the script: `<dir>` is `<outdir>`
and `N` is the exit code read below — `N = 2` still means unknown. Otherwise:

```
~/.claude/scripts/design-detect.sh <url|file> <outdir>
```

The script is the source of truth for its widths and the detector version — do
not restate them. Exit `0` = captured, no detector hit; `1` = captured, hits;
**`2` = unknown** (capture failed, blank or error page, detector crashed). On
`2`, write `unknown` and the script's stderr (the caller's saved stderr file,
when the evidence was already captured) as the whole report, and stop: a page
that was not captured is never "clean".

In `<outdir>`, for each width and scheme the script captured:
`shots/<width>-<scheme>-fold.png` (first screen) and `shots/<width>-<scheme>.png`
(full page); then `shots/1440-light-focus.png` (keyboard focus), one
`detect-<width>.json` per detect width, `capture.json` (including the HTTP
`status` and `hasDarkScheme`) and `console.json` (console errors and uncaught
page errors during the load). A local **file** target yields one detect file —
say so; do not invent the other widths.

## 2. Context — what the project sanctions

Read the project's root `DESIGN.md`, and the design section or design entries of
its `CLAUDE.md`, and every design document either of them names — the hub's
`CLAUDE.md` points to `design-and-themes.md` (in its `wrp-architecture` skill)
for the rules its identity still obeys. List what they sanction, **mapped to
detector ids**, before looking at any finding. Reference case: the hub
(`~/Dev/{portfolio-site}`) documents its ground in the `CLAUDE.md` entry
**"Deliberate identity: the paper palette"**, so `cream-palette` is sanctioned
there — and per `design-tells` A0, the companions it did not ask for (italic
accent word, terracotta, numbered eyebrows) are still findings.

- Sanction only what a document names. "It looks intentional" sanctions nothing.
- **No repo** (target with no checkout, or the caller passes repo `-`): write
  `no repo context: DESIGN.md/CLAUDE.md not read` in the report and sanction
  nothing.
- **`capture.json.redirectedPath` is `true`**: the report's first line says which
  page was actually audited (`finalUrl`, e.g. a sign-in page). Never present it as
  a full-site audit.

## 3. Blind pass, then merge

Judgment comes **before** the detector output, so the detector cannot anchor it.

1. Read the `*-fold.png` frames first. Judge every first-screen check on them:
   full pages are downscaled when read, so their first screen is not evidence.
2. Then the full pages, then `1440-light-focus.png`.
3. Then `console.json`: each entry is a finding (rubric check "console clean"),
   `seen in` `console.json`; severity follows its visible effect, `minor` when
   nothing on the page breaks.
4. Write findings against `references/rubric.md`, each tied to the screenshot
   (or `console.json`) it was seen in. Do not open `detect-*.json` yet.
5. **Only then** read `detect-*.json` and merge:
   - a hit that matches a blind finding → one finding, note the rule id;
   - a hit the blind pass missed → look again at the named screenshot, then add
     it or record why it is a false positive;
   - a hit matching a sanctioned identity (step 2) → listed under **Sanctioned**,
     never as a finding;
   - the same `antipattern` + `snippet` at more than one width → one finding.

## 3b. Benchmark against references (audit mode)

After the merge, never before: a reference seen first anchors the blind pass the
same way the detector would. Fix mode skips this step unless the caller asks for it,
and the fix loop's re-check never repeats it.

1. **Pick 2-3 references.** The project's `DESIGN.md` references section, when it
   has one, comes first. Otherwise choose live sites that do **the same job for the
   same audience** (a finance dashboard against finance dashboards, a reading tool
   against reading tools), and are among the best of that kind. Never a site behind
   a login, never a paid source.
   **At least one comes from a gallery actually read**, not from memory: sites you
   already know are the same few for every audit, and the galleries are where
   current work is. Pick the gallery and the category page from the table in
   `~/.claude/skills/design-direction/references/inspiration.md` ("how to read
   it" gives each one's category URLs), then read it with its own Chrome:
   ```
   node ~/.claude/scripts/design/gallery.mjs <gallery-category-url>
   ```
   It prints the page's headings and links as JSON; exit `2` means a wall or an
   error page, so try another gallery. Open a detail page the same way when the
   listing does not give the live site's URL, and strip `?ref=<gallery>` from it.
   The Benchmark table's `source` column names the gallery page for each such
   reference, or `known` for one picked from memory. When every gallery tried
   exits `2`, say so under `Not verified` and go on with known sites.
2. **Capture each** into its own directory under the evidence dir, never into the
   evidence dir itself (the script clears its output dir first):
   ```
   node ~/.claude/scripts/design/capture.mjs <ref-url> <outdir>/refs/<ref-host>
   node ~/.claude/scripts/design/dna-harness.mjs <ref-url> light
   ```
   Do not use the Playwright MCP browser for this: parallel audit agents share it.
   A reference that exits `2` is dropped and named under `Not verified`; with none
   left, write `Benchmark: no reference captured` and go on.
3. **Compare on craft, never on identity.** Read each reference's fold frames
   next to the target's, on these axes: what the first screen proves, type
   hierarchy and scale steps, spacing rhythm and density, how many jobs the accent
   has, mobile navigation and tap targets, empty and error states if visible. A
   reference's palette, fonts or style are never a finding: the project's identity
   is its own, and copying the reference is the convergence `design-direction`
   exists to avoid.
4. **Gaps become findings.** Where a reference clearly does better on an axis, add a
   row: `Why` reads `benchmark: <ref-host> <what it does>`, `seen in` names both
   frames. A benchmark finding is never a `blocker`, and is `major` only when the
   gap is on the first screen. A gap already found in step 3 gets the benchmark
   appended to its `Why` rather than a second row.

## 4. Motion and interaction

When the target animates or responds to gestures, read
`~/.claude/skills/review-animations/SKILL.md` and apply its standards to what moves.
For a component, optionally run `break-ui` (worst-case data). Screenshots do not
show motion: a motion finding taken from the code is marked `Not verified`
unless it was observed rendered.

## 5. Report

Audit mode returns the full report, in this shape, as the final message and writes no file: a subagent cannot write report files, and the orchestrating caller saves the returned text to `<outdir>/report.md`. When the caller is the main session, it may write `<outdir>/report.md` itself. Fix mode puts the same shape in the reply.

```
<first line: audited page, if redirectedPath — else the target URL or file>
Detector exit: <0|1|2>   Repo context: <path, or "no repo context: DESIGN.md/CLAUDE.md not read">
Blockers: <n>  Majors: <n>  Minors: <n>  Sanctioned: <n>

## Findings
| severity | Before | After | Why | seen in |
|---|---|---|---|---|
| blocker | <what is there> | <the change> | <rubric check or design-tells id; rule id if any> | shots/<width>-dark-fold.png |

## Sanctioned
| rule id | sanctioned by |

## Benchmark
| reference | source | why chosen | does better on |
|---|---|---|---|
| <ref-host> | <gallery page URL, or "known"> | <same job, same audience> | <axes, or "nothing the target lacks"> |

## Not verified
- <each claim not seen in a screenshot>
```

- **Severity.** `blocker`: content unreadable or unreachable — failed contrast on
  body text, horizontal scroll on mobile, no visible focus, dark scheme broken.
  `major`: a rubric or `design-tells` failure a visitor notices on the first
  screen. `minor`: everything else that is still worth a line.
- Rows sorted blocker → minor. `After` is concrete (a value, a property, a
  sentence), never "improve".
- **Any claim not seen in a screenshot (or read in `console.json`) goes under
  `Not verified`**, not in the table — including everything read only from
  code or from detector JSON you could not confirm in a frame.
- Zero findings is a result only when the screenshots were read; say which.

## 6. Fix loop (fix mode only)

1. Fix **all** findings in one batch.
2. Re-run step 1 **once** on the same target — running the script, since the
   evidence-already-captured path never applies to a re-check — and redo
   steps 3-5 on the new evidence, without step 3b.
3. Stop. Report what is fixed, what remains, and what the fix introduced. **Never
   a third round without the owner** — a loop that keeps finding something is
   chasing taste, not defects.

Before claiming a visual change is done, the fix loop's re-check is the evidence:
"done" without a post-change capture is not done.
