---
name: design-direction
description: Load before designing a new site or page, or redesigning one, when no DESIGN.md exists yet.
user-invocable: true
---

# Design direction — a written direction before any code

A model with no direction lands on its own defaults, and a portfolio of
projects designed that way converges on one look. This skill makes the
direction a written, reviewable decision: read the subject, study real sites,
check the portfolio for convergence, propose 2-3 directions, and record the
chosen one in `DESIGN.md`.

If the project already has a `DESIGN.md` or a design section in its
`CLAUDE.md`, it has a direction: follow it, and use `design-critique` instead.

## 1. Load the ban list

Load `design-tells`. Its ids are the vocabulary of every step below: read the
ids from `design-tells` itself, never from a copy, and refer to a trap by id,
never by restating it. **With no stated direction, never default to anything
section 1 of `design-tells` names**, nor to B9 — and never pick a direction
silently: step 5 always proposes 2-3 and waits.

## 2. Read the subject before any visual decision

Write these down first, in this order, before a colour, a font or a layout is
considered (the headings match `references/design-md-template.md`):

- **Read** — one line: `Reading this as: <page kind> for <audience>, with a <vibe> language.`
- **Domain** — at least 5 concepts, objects or gestures of the subject.
- **Colour world** — at least 5 colours that exist in the subject, each with
  where it is seen. Tokens come later, from these.

A colour or a font that cannot be traced back to this list is a default
wearing a reason.

## 3. Reference study

Pick 2-4 sources from the table in `references/inspiration.md` that match the
Read (its `best for` column); never one from its Excluded list (zero-cost rule).
For each site studied:

1. Open it with the Playwright MCP (`browser_navigate`; follow the row's
   `how to read it`, including any wait), then `browser_take_screenshot`.
   The MCP writes screenshots only under its allowed roots (`~/Dev` and
   `~/Dev/.playwright-mcp`); with no `filename` they land in
   `~/Dev/.playwright-mcp/`. Do not request a path outside those roots — the
   call is refused.
2. Run `references/dna.js`: pass the file's whole text as the `function`
   argument of `browser_evaluate`. It returns the computed fonts, sizes,
   weights, heading tracking, ground and text colours by area, radii, section
   spacing and content width. For a local file or a build the MCP will not
   open, run `~/.claude/scripts/design/dna-harness.mjs <url|file> [light|dark]`
   (exit `2` = could not run; never read that as an empty DNA).
3. Note **one thing to take** and **one to refuse**, each tied to the
   screenshot or a DNA value.

`fonts` is the computed `font-family` stack, not proof the face loaded; check
the screenshot. A `clip-text:` entry under text colours is gradient text (B9).

## 4. Convergence check

List every direction already in the portfolio — `DESIGN.md` files, and design
or identity **entries** of project `CLAUDE.md` files (a heading, or a bold
bullet such as the hub's "Deliberate identity: the paper palette"):

```bash
find ~/Dev -maxdepth 2 -name DESIGN.md
find ~/Dev -maxdepth 2 -name CLAUDE.md -exec grep -H -n -i -E \
  '^(#+ .*(design|identity|palette)|[-*] \*\*[^*]*(identity|palette|design system|design direction))' {} + || true
```

Both commands print nothing, without error, when there is no match. Read each
hit in its file; skip one that is a rule list rather than a project's own
direction, and say why. Then:

- Every proposed direction must differ from **each** neighbour on at least one
  named axis: **ground**, **type family**, **layout structure**, **signature**.
- Where several neighbours share a value on one axis, differ on that axis
  first: a shared value is the portfolio's convergence, not a safe choice.
- Then ask of each direction: *would a similar prompt for another project land
  here too?* If yes, revise that part — it came from the model, not the
  subject.

## 5. Propose 2-3 directions, then wait

Each direction carries:

- **Tokens** — ground, ink, muted, rule, accent; hex, light and dark.
- **Type** — families with their role, and the scale.
- **First screen** — an ASCII sketch of the layout at desktop width.
- **Signature** — one owned device from the Domain list, used once (C18).
- **Refused defaults** — at least 3 `design-tells` ids it refuses.
- **Convergence** — one line per neighbour from step 4: the axis it differs on.

The directions differ from each other on at least one axis too; three shades
of one idea are one direction. A warm light ground is allowed only as an
explicit, named choice the owner can refuse (G1). **Stop and wait for the
owner's pick.** No code, no `DESIGN.md`, before it.

## 6. Record the direction

Write `DESIGN.md` at the repo root from `references/design-md-template.md`,
filling every section with the chosen direction, the references of step 3 and
the convergence lines of step 4 (`Differs from`). Then load `claude-md-hygiene`
first (it governs every CLAUDE.md edit), and add one line to the design section
of the project `CLAUDE.md` (create the section if there is none) pointing
to `DESIGN.md` as the project's identity. From then on, `design-tells` and
`design-critique` treat what it names as sanctioned.

Motion standards: read `~/.claude/skills/review-animations/SKILL.md` directly;
it is not model-invocable, so do not try to load it as a skill.

## 7. Build, then critique

Build the page, then load `design-critique` in fix mode on the rendered
result: one fix round, one re-check, stop. Report what the critique found,
what was fixed, and what remains.
