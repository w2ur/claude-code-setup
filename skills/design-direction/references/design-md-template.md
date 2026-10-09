# DESIGN.md — <project name>

<!-- Written by the design-direction skill, at the repo root. Every value below
is a decision; delete the guidance comments, keep the headings. This file is
the project's documented identity: design-tells and design-critique read it,
and what it names is sanctioned there. -->

## Read

Reading this as: <page kind> for <audience>, with a <vibe> language.

## Domain

<!-- At least 5 concepts, objects or gestures from the subject itself, written
before any visual decision. They are the raw material for the colour world,
the type and the signature. -->

- <concept>
- <concept>
- <concept>
- <concept>
- <concept>

## Colour world

<!-- First at least 5 colours that exist in the subject (a material, a place,
an object), each with where it comes from. Then the tokens drawn from them. -->

Found in the subject:

- <colour> — <where it is seen in the subject>
- <colour> — <where>
- <colour> — <where>
- <colour> — <where>
- <colour> — <where>

Tokens:

| token | role | light | dark |
|---|---|---|---|
| `--ground` | page ground | `#______` | `#______` |
| `--ink` | body text | `#______` | `#______` |
| `--muted` | secondary text (full strength, not opacity) | `#______` | `#______` |
| `--rule` | borders, rules | `#______` | `#______` |
| `--accent` | its one meaningful use: <say which> | `#______` | `#______` |

<!-- Light/dark: say how the dark ground was obtained, and why this scheme is
the default for the use scene (design-tells R7). -->

## Type

| role | family | why it fits the Read |
|---|---|---|
| display | <family> | <reason> |
| body | <family> | <reason> |
| <data / code / notes> | <family, or "none"> | <reason> |

Scale (px): <e.g. a list of sizes, smallest to largest, with the role of each>.

Tracking: <letter-spacing per role; say where it is not the font's default>.

## Space & shape

Spacing scale (px): <steps>, with what each step separates.

| role | radius |
|---|---|
| controls | <px> |
| surfaces / cards | <px> |
| media | <px> |

## Motion

<!-- Standards: read ~/.claude/skills/review-animations/SKILL.md (do not load
it as a skill; it is not model-invocable). Duration follows how often a
visitor sees the motion: the more often, the shorter, down to none. -->

| motion | how often a visitor sees it | duration | easing |
|---|---|---|---|
| <e.g. hover, page arrival, a disclosure> | <every interaction / once per visit / rare> | <ms> | <curve> |

Reduced motion: <what replaces each motion>.

## Signature

<!-- One device this project owns, derived from the domain. Used once, in one
place (design-tells C18); say where. -->

<device> — used at <place>, because <reason from the domain>.

## Refused defaults

<!-- At least 3 design-tells ids this design refuses, each with what stands
in its place. -->

- <id> — refused; instead <what this design does>
- <id> — refused; instead <...>
- <id> — refused; instead <...>

## References

<!-- 2-4 sites studied in the reference step (screenshot + dna.js), with what
was taken and what was refused. -->

| site | taken | refused |
|---|---|---|
| <url> | <one thing> | <one thing> |
| <url> | <one thing> | <one thing> |

## Differs from

<!-- Every other portfolio DESIGN.md and CLAUDE.md design entry found by the
convergence check, and the named axis this design differs on: ground, type
family, layout structure, or signature. -->

| neighbour | its direction in one line | axis this one differs on |
|---|---|---|
| <repo> | <...> | <ground / type family / layout structure / signature> |
