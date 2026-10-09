# Rubric — yes/no checks for the blind pass

Each check is answered **yes** (passes), **no** (a finding) or **n/a** (with the
reason). Name the screenshot that answers it; a check no screenshot can answer
goes under `Not verified`. First-screen checks are judged on the `*-fold.png`
frames only.

## Hierarchy

- [ ] **One thing leads per screen.** On each fold frame, a single element is
  clearly first; nothing competes with it at the same weight. (Three equal cards
  or two equal CTAs is a no.)
- [ ] **The accent carries one meaning.** The accent colour marks one kind of
  thing (e.g. the primary action) — not also links, active states, decoration.
  (`design-tells` C16.)
- [ ] **The type scale has at least three distinct steps** visible on the page
  (e.g. display, body, small), and the steps are far enough apart to read as
  steps. Detector support: `flat-type-hierarchy`.

## Craft floor

- [ ] **The focus ring is visible** in `shots/1440-light-focus.png`: the
  focused element is identifiable without guessing.
- [ ] **The dark screenshot is a designed scheme.** Check
  `capture.json.hasDarkScheme` first: `false` means the dark frames show the
  light page — no (missing dark mode, unless the project documents an opt-out).
  When `true`, the dark frames must read as designed, not as an inverted light
  page or one with stray light surfaces.
- [ ] **Mobile has no horizontal scroll.** In the narrow-width full pages,
  nothing runs past the right edge and the page is not wider than the frame.
- [ ] **Mobile targets are at least 44px.** Buttons, links in nav, and controls
  in the narrow-width frames are thumb-sized and not crowded together.
- [ ] **Body text is full-strength**, not faded with opacity or a pale grey.
  (`design-tells` A10; detector support: `low-contrast`, which measures rendered
  pixels, opacity included.)
- [ ] **Console clean.** `console.json` is `[]`: no console error and no
  uncaught page error during the load. Each entry is a finding, `seen in`
  `console.json`.

## Slop

Every row of `~/.claude/skills/design-tells/SKILL.md` (sections 1-4) is one
check, answered by its id: is this pattern present? Read the ids from that file —
never from a copy here — so a row added there is checked here.

- [ ] For each id: absent → yes; present → a finding citing the id; present but
  sanctioned by the project's documented identity (critique step 2) → listed
  under **Sanctioned**, not as a finding.
- [ ] Rows whose `detector` column names a rule id are confirmed or contested
  in the merge step; rows marked `—` rest on the screenshots alone.

## Content

- [ ] **Proof on the first screen.** A fold frame shows something checkable —
  a named artefact, a real number, a result — not only a claim or a signup ask.
  (`design-tells` C0.)
- [ ] **Numbers carry a unit and a source.** Every figure shown says what it
  counts and where it comes from (or is plainly derived from the page itself).
  (`design-tells` B5, C10.)
