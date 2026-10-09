# Free inspiration sources, probed through the Playwright MCP

Probed 2026-10-09 with `mcp__plugin_playwright_playwright__browser_navigate` plus the snapshot it returns (not claude-in-chrome, not curl). Statuses: `readable` (names, links, text in the snapshot), `screenshot-only`, `login-wall`, `blocked`. Every table row is free to browse without an account; paid or login-walled sources are listed under Excluded. Re-probe before relying on a row; gallery markup and bot defences change.

| source | URL | best for | Playwright status (2026-10-09) | how to read it |
|---|---|---|---|---|
| Godly (now Recent) | https://godly.website | Web, motion and interface inspiration | readable | Redirects to `recent.design`. Post titles are in the snapshot. Detail page: `/i/<id>-<slug>`; browse `/websites`, filter buttons on the home page. |
| Minimal Gallery | https://minimal.gallery | Minimal, type-led sites | readable | Site names come from `img` alt text and slugs. Detail page: `/<slug>/`; browse `/tag/<tag>/` and `/websites/`. |
| Siteinspire | https://www.siteinspire.com | Curated web design by category | readable | curl got 429, Playwright loads it. Detail: `/website/<id>-<slug>`; browse `/websites/category/<slug>` (minimal, typographic, grid-layout...). Live site link carries `?ref=siteinspire`. |
| Land-book | https://land-book.com | Landing pages, sections, portfolios | readable | curl got 403, Playwright loads it. Detail: `/websites/<id>-<slug>`; browse `/design/<category>` (landing-page, pricing-page...). Pro upsell links exist; ignore them. |
| Lapa Ninja | https://www.lapa.ninja | Landing page examples | readable | curl got 403, Playwright loads it. Site names are `h3` headings. Detail: `/post/<slug>/`. Sponsor banners (Mobbin) sit among the items. |
| Awwwards | https://www.awwwards.com/websites/ | Award-winning, experimental sites | readable | Site names are `h3` headings. Detail: `/sites/<slug>`. Skews to WebGL/motion showpieces. |
| Curated | https://curated.design | Sites filed by industry and style | readable | Card headings are empty in the snapshot; identify a site from its outbound domain link. Detail: `/sites/s/<id>/`; browse `/inspiration/`. Contains "rent this card" ad cards; skip them. |
| One Page Love | https://onepagelove.com | One-page sites by genre and style | readable | Name is the link text under each card. Detail: `/<slug>`; browse `/genre/<genre>`, `/style/<style>` (brutalism, minimal, typographic...). |
| SaaS Landing Page | https://saaslandingpage.com | SaaS landing pages | readable | Item links are `/<slug>/` (e.g. `/cleanshot/`); names are in `h2`. Template and deal links are commercial; ignore. |
| Dark Mode Design | https://www.darkmodedesign.com | Dark UI references | readable (domains only) | The snapshot holds only outbound links (`https://<site>/?ref=darkmodedesign`), no names and no detail pages. Take the domain, open it, or use a screenshot for the look. |
| Footer.design | https://www.footer.design | Footer patterns | readable | Names in `h3`. Detail: `/sites/<slug>`; browse `/browse`, `/styles/<style>`. |
| Fonts In Use | https://fontsinuse.com | Real-world typography | readable | Index is faceted: `/in/1/topics/<id>/<slug>`, `/in/2/formats/<id>/<slug>`, `/typefaces/<id>/<slug>`. Entry cards are not labelled in the home snapshot; open a topic or typeface page. |
| Typewolf | https://www.typewolf.com | Font pairings on real sites | readable | Home lists `/site-of-the-day/<slug>` with the fonts used as links (`/<font-slug>`). Also `/recommendations`, `/free-fonts`, `/lookbooks`. |
| interfaces.rauno.me | https://interfaces.rauno.me | Interaction and detail checklist | readable | One long page; full text is in the snapshot (sections as `h2`, rules as list items). |
| Vercel Web Interface Guidelines | https://vercel.com/design/guidelines | Interface rules (accessibility, forms, motion) | readable | Full text in the snapshot; sections as `h2` with anchors. |
| Apple HIG | https://developer.apple.com/design/human-interface-guidelines | Platform conventions, color, type, layout | readable, after a wait | The first snapshot holds only site chrome; the article renders after a few seconds. Navigate, then `browser_wait_for` about 4 s, then snapshot. Topic pages: `/design/human-interface-guidelines/<topic>` (e.g. `/color`). Console shows a harmless 401 session fetch. |
| Radix Colors | https://www.radix-ui.com/colors | 12-step accessible palettes, dark pairs | readable | Docs and scale names are in the snapshot (`/colors/docs/palette-composition/scales`). Swatch values (hex/hsl) are not in it; use a screenshot or the package source. |
| Realtime Colors | https://www.realtimecolors.com | Previewing a palette and fonts on a mock site | readable | The page redirects to a URL that carries the state: `?colors=<bg>-<text>-<primary>-<secondary>-<accent>&fonts=<heading>-<body>`. The marketing text is in the snapshot; the live preview is visual, so take a screenshot. |

## Excluded (login wall / paid)

Probed the same day and refused under the zero-cost rule; never use them.

- **Refero** (https://refero.design) — logged out, only category lists and an "Upgrade plan" prompt; no item content.
- **Mobbin** (https://mobbin.com/browse/web/apps) — redirects to the home page (`?redirect_to=`) with only Log in / Join links.

## Falsification check (2026-10-09)

`https://minimal.gallery/this-page-does-not-exist-zz9/` returned HTTP 404 and a snapshot whose `h1` is "Sorry, we couldn't find what you're looking for.", with none of the gallery items (GRNDWRK STUDIO, Offsuit Games, jarcos) that the home page snapshot lists. So a `readable` verdict reflects real content, not a catch-all page.

## Reading tips

- `browser_navigate` returns a snapshot file path; read the first part of it (grep headings and `/url:` lines) instead of dumping the whole snapshot.
- Client-rendered sites (Apple HIG) need a wait before the snapshot; an early snapshot that holds only navigation is not a verdict.
- Galleries add `?ref=<gallery>` to outbound links; strip it when opening the real site.
