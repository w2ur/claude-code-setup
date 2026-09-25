---
name: design-tells
description: Load before any frontend or visual design work in a project with no stated direction
user-invocable: true
---

# Design tells — the patterns that read as model-generated

The short rule lives in `~/.claude/CLAUDE.md` (Design defaults). This skill holds
the full trap list behind it, each pattern with why it reads as a model
default and what to do instead.

**Why a named list and not "avoid the AI look".** Without a direction, Opus 5.5
falls back on a few default styles. A generic "avoid the AI look" only swaps one
default for another; naming the pattern is what works.

Source: the three research strands of workflow `wf_10b4186b-05c` (2026-09-18, the
hub's `the-portfolio` redesign): **A** state of the art, **B** a site without
images, **C** what the visitor actually needs. The `A0`-style ids point back to
`.result.recherches[<strand>].pieges[<n>]` in that run; a row carrying several ids
(`A7 · B10 · C6`) is one pattern the strands found independently. `G`-ids are
rules drawn from the Opus 5.5 migration guide, not from that run.

## The carve-out: a documented identity overrides this list

A project whose own `CLAUDE.md` has a design section (palette, type, motifs) has a
**direction**, and that section wins over every entry below. The hub
(`{portfolio-site}`) is the reference case: its cream paper ground, serif and
handwritten notes are a deliberate, documented identity, not a default to remove.

Without such a section, a cream or off-white ground **is** the tell on its own
(G1), whatever accent and type come with it. Only a documented identity makes it
legitimate, and even then what still applies is **the companions** (A0): cream
plus an italic accent word plus a terracotta accent plus numbered eyebrows. Keep
the identity, refuse the companions it did not ask for.

No design section and no brief → propose 2-3 directions from subject, mood and
audience, and wait for approval. Never pick one silently.

## 1. Opus 5.5 defaults — named by the migration guide, plus the pairing that comes with them

| id | trap | why it reads as a default | instead |
|---|---|---|---|
| G1 | A cream / off-white page ground: any near-white tinted warm — ivory, flour, paper, parchment, linen, sand, bone (`#F4F1EA`, `#F6F1E4`, `#FAF7F0`…). The trap on its own, whatever the accent or type; renaming the shade or dropping the terracotta does not leave the family | The first ground Opus 5.5 reaches for when nothing is specified; the migration guide names it by itself, not only inside a cluster | A neutral or cool white, a dark ground, or a saturated field taken from the subject. If a warm light ground seems right, say so in the proposal and let the owner choose it — never land on it by default |
| A0 | The "warm AI" cluster: cream ground near `#F4F1EA`, large display serif often italic for emphasis, terracotta / rust accent | Named verbatim by 2025-26 criticism (Chayka: "beige- and cream-colored backgrounds, rusty orange-hued accents", "large serif typefaces, italicized and highlighted") | A ground chosen from the subject. If cream is the project's identity, drop the companions (italic emphasis, rust accent) — the cluster is what gets recognised, not one colour |
| A2 | One serif italic word carrying all the emotion of the headline; its corollaries: the three-word tagline, the noun fragment, "Not X. Just Y.", em-dashes everywhere | The signature writing tic of generated pages | A headline that states something specific, set in one style. Emphasis through wording, not a switched face |
| A3 | Tracked-out capital eyebrow above every section ("01 — ABOUT", "SELECTED WORK") | Named by Chayka as a tell; the numbering implies an order the content does not have | Section heads that say what the section is. Number only a real sequence (steps, chapters) |
| A4 | Card grid with a monospace label in the top corner; pill badges ("Preview", "Coming Soon", "Available for work"); bento grid; one border radius everywhere (16px); uniform spacing everywhere | These four together are enough to date a page | Status as text in the flow; a radius and spacing scale that varies with the element's role; square or plain buttons unless the brief asks for pills |
| A1 | The over-read pairing: a "characterful" display serif (Fraunces, Instrument Serif, Playfair, Cormorant) + Inter for body | Among the most-deployed Google Fonts; it promises refinement everyone already delivers | Pick type for the content's register and check it against the pairing; one family used well beats a fashionable pair |

## 2. Look and layout (strands A and B)

| id | trap | why it reads as a default | instead |
|---|---|---|---|
| A5 | Decorative fake dashboard: stacked rounded rectangles, neon glow under the edge, unitless numbers, a chart of nothing | Filler that imitates data | Show a real number with its unit and source, or nothing |
| A6 | Scrolling news-ticker / marquee text bands | One of the most specific tells criticism names; tempting on an image-less site hunting for motion | Motion only where it carries information |
| A7 · B10 · C6 | The same scroll fade-in on every element or block, hover states absent or identical | A scroll-linked motion system that moves everything 20px up with the same opacity is the generic fade-in with more code: a theme effect, not writing. It also delays content in the first two screens, where most attention is spent | Motion that differs by role; distinct hover states; most content simply present |
| A8 | The canonical template order: hero bio → about → selected work → now → contact, one column, all revealed on scroll | It is everyone's sequence, whatever the styling | Order sections by what this visitor needs first — usually proof |
| A9 | Grain / noise overlay, blurred aurora blobs, purple→blue gradient, default Inter, oversized hero | The previous generation of the same default, still circulating | A ground and hero sized for the content; no decorative texture |
| A10 | Body text at 50-60 % opacity on cream as "refinement" | Where the aesthetic trap and the accessibility trap coincide; a contrast test that checks declared colours, not applied opacity, misses it | Full-strength text colours tested as rendered |
| A11 | Conformist indieweb vocabulary: `/now`, seedling/budding/evergreen, webring badge, `/uses`, "digital garden" | A signature in 2018, a membership card in 2026 | Use a convention only for its function, never as personality |
| A12 | Borrowed personality ornaments: custom cursor, "↓ scroll" hint, all-lowercase, emoji section heads, console easter egg | Each was distinctive once | Let personality come from content and one owned device |
| A13 | Sobriety as alibi: competent, contrasted, well composed, no rough edge | The well-executed median is now the marker of automatic generation | A device that costs its author something: an errors list, a refusal catalogue, a number that can go down, a published constraint |
| B0 | Invisible sobriety: the site pays for its constraints (no images, one ink, static) without anyone perceiving them | Faultless and indistinguishable | Make the constraint visible and stated |
| B1 | Giant type as the only idea (huge serif capitals on screen one) | The 2018-24 portfolio wave; now degree zero | Large type only when it sets a datum (a verifiable number), not a slogan |
| B2 | Decorative generative noise: flow field, blob, Perlin, connected dots | Derived from nothing, so it could decorate any site. Substitution test: if random data changes nothing, it is wallpaper | Generate from the project's real data, or omit |
| B3 | Symmetric 5×5 identicon grid | Reads "default avatar" or "crypto token" | A mark derived from the work itself |
| B4 | Numbers animated counting up from 0 | Adds an emotion the datum lacks; unreadable while it moves | The number set still, composed and sourced |
| B5 | Chart with no unit, no source, no date | The surest sign of a decorative figure | Every chart carries unit, source and date |
| B6 | Encoding a quantity by area, radius or volume (bubbles, concentric circles, donut) | Lie factor above 1: the eye reads area, the data is linear | Position or length on a common scale |
| B7 · C7 | Terminal costume — `> whoami` prompt, typewriter effect, Unicode rules, ASCII art, monospace, blinking cursor — over a non-terminal design | Two incompatible registers glued together; reads pastiche, not "system", and the developer-portfolio cliché pulls toward junior | One register, held |
| B8 | Three equal cards, soft shadows, rounded corners, one icon each | Every site generator's default since 2020 and a model's first reflex; equal weight claims nothing matters more | Hierarchy: one item leads, the rest follow |
| B9 · C5 | Gradient, frosted glass, glow, blurred blobs, animated gradient text, any purple/indigo | The generative template's visual signature since 2023; where any unsupervised proposal drifts, often sneaking back as an "accent touch" or a coloured shadow | Flat colour from the chosen palette |
| B11 | A hand-drawn figure that never changes on a site claiming everything is derived at build | An internal contradiction attentive readers spot | Derive the figure from build data, or drop the claim |
| B12 | Small caps and old-style figures faked by the browser (`font-variant` without a font that carries them) | Scaled capitals are not small caps; the strokes do not follow | Use a font with the OpenType features, or do without |
| B13 | A "how this site is built" page with hand-typed numbers | Stale on the first deploy, and it discredits every real derived number | Derive every number at build |

## 3. Content and credibility (strand C)

| id | trap | why it reads as a default | instead |
|---|---|---|---|
| C0 | First screen asks before it proves: bio + signup box, zero project | The 2015 personal-site template; spends the most expensive seconds soliciting | Proof on the first screen |
| C1 | Superlatives without a number: "passionate about", "I build tools", "at the intersection of X and Y" | Unverifiable self-assessment, infinitely costly to evaluate | A traceable number or a named artefact |
| C2 | Grid of identical tiles, title + two lines, no result or number | The template effect even without images; nothing ranks a flagship above a weekend project | Vary weight by importance; give each item a result |
| C3 | Tech-logo wall, shields.io badges, percentage skill bars | Junior-portfolio codes | Show the work; the stack belongs in the project |
| C4 | Job-application vocabulary: "Hire me", "Available for work", "Download my CV" | The costliest framing for an established author building in public | Describe what is built and how to follow it |
| C8 | Emoji as list bullets or section icons | The most immediately recognisable marker of AI-produced text | Plain bullets and words |
| C9 | LLM sentence rhythm: systematic tricolon, "not X but Y", "it's not just… it's…", "in the age of…", em-dash bursts, equal three-sentence paragraphs | Fatal on a site whose argument is its writing | Varied sentences; for the owner's own text, load the voice skill the global CLAUDE.md names |
| C10 | Round, unverifiable numbers: "thousands of users", "20+ years of experience" alone | Nothing to check | Dated, traceable numbers ("116 days in public", "131 references verified via Crossref") |
| C11 | An imported SEO-blog statistic ("73 % of recruiters…") | Contradicts the traceability that gives the site its credibility | Cite primary sources or say nothing |
| C12 | `llms.txt`, "AI-friendly" tags, "agent-optimised" mentions | Ignored by search and by providers in production; the illusion of having acted | Well-structured, citable HTML |
| C13 | A `/now` page and a light/dark toggle presented as the site's personality | Community conventions, no longer differentiators | Ship them if useful; never pitch them |
| C14 | A manifesto with no artefact: principles with no repo, licence or live URL beside them | Reads as posture | Put the artefact next to every principle |
| C15 | Retirement stories filed in a dated archive | The rarest material, stripped of its role as proof of judgement | Surface them as evidence |
| C16 | The accent used for hierarchy: a second filled button, coloured body links, a coloured active state | Once the colour signals two things it signals none | One meaningful use of the accent |
| C17 | Seeking distinction in layout: broken grid, horizontal scroll, invented nav, custom cursor | Prototypicality predicts liking within 17 ms (Tuch et al.); novelty pays only where it costs no typicality (Hekkert) | Novelty on ONE element, never on the structure |
| C18 | Spreading the original figure everywhere | Its value is rarity; repeated on each section it becomes decorative noise | Use the signature device once |
| C19 | A page that cannot be cited alone: title with no named subject, numbers in a table with no carrying sentence, no link back to the identity | Invisible to answer engines, illegible for a deep-link visitor | Every page names its subject and states its point in a sentence |
