---
name: portfolio-conventions
description: Portfolio three-layer data system (inventory, README pitch block, editorial.ts) and coherence rules. Load before changing how any project is described, listed, ordered or given a hub tile.
user-invocable: false
---

# Portfolio Conventions

These are the active portfolio-wide rules.

## Identity

- Each app has its own visual identity, name, and universe. No shared design system.
- Coherence comes from: author signature, quality standards, portfolio site, and the three-layer data system below.
- Portfolio site: {portfolio-site-url} — built from the three layers (see "Portfolio Manifest System" below), not from a hand-maintained JSON export.
- GitHub username: {github-username}. Dev directory: ~/Dev.

## Naming

- All repos use kebab-case matching the folder name in ~/Dev.
- No unintentional naming patterns (an "-or" suffix once read as an agent-noun and forced a rename).
- New projects that get a hub tile are appended to `editorial.ts` (see below) — there is no numeric sort field to default.

## Documentation

- README: plus the Layer 2 pitch block (below). Created at project init, never boilerplate. It is a **landing page, not the manual** — the shape below is checked by `docs-checker`.

### README landing-page shape

GitHub readers decide in the first screen; private READMEs are re-entry docs for the owner and agents. Same shape for both, lighter for private.

1. **Nothing renders above the H1.** Only the pitch comment may precede it.
2. **First screen (about 25 rendered lines):** H1 = the pitch `name`; one-line promise; `**Status:**` line — one of *in use · maintained · frozen · prototype · archived*, plus public/private; the live link; then one picture for a public app.
3. **Why**, 1–3 sentences, taken from the owner's own material (hub stories in `{portfolio-site}/src/content/stories-*`, infolettre and devlog texts — `post.md`/`source.md`, never `*.proposed.md`). Load the owner's voice skill first (named in the global CLAUDE.md). Never invent a reason: without a source, write `<!-- why: owner to write -->`.
4. **Keep:** what, why, status, run locally (commands that work today, env via `.env.example`), deploy in one paragraph, a short Documentation link list, the signature footer. **Move out:** history, incident narratives, rationale, specification rules, structure trees and long env tables go to `docs/*.md`. Only rules an agent must obey go to CLAUDE.md, which is billed every session.
5. **Length:** a public README stays under about 150 lines. Private: no cap, but history still moves out.
6. **No hand-typed counts, versions or file inventories in prose.** Derive them (a badge, a link to the data) or omit them.
7. **Badges only when they report something that changes:** CI, npm version, license, live-site status, store version. No static or vanity badges (last commit, "made with").
8. **Pictures** live in `docs/media/` (never a deployed or bundled path), each with alt text saying what it shows. Use `<picture>` dark/light sources when the UI has both themes, and a GIF for an interactive app (≤ 5 MB, about 10 s, ffmpeg palette). Capture with a standalone headless Playwright process, not the shared MCP browser.
9. **Language:** public README in English. A bilingual public app adds `README.fr.md` with only the landing part (promise, why, status, links) and a switch line atop both. French-native projects stay in French.
10. **On every change, fix what became false; never append the story of the change.**
- CLAUDE.md: project-specific only, never duplicates global rules. Written in English.
- No per-repo manifest file. Project metadata lives in the three layers below (decision M12).

## Portfolio Manifest System (three layers, decision M12)

### Layer 1 — Derived inventory. Nothing hand-typed.

`~/Dev/{portfolio-site}/scripts/build-inventory.mjs`, run from `prebuild`, writes `~/Dev/{portfolio-site}/src/data/inventory.json`. Per repo it observes, via the GitHub API and the repo's own file tree — never declared by a human:

| field | source |
|---|---|
| `visibility`, `archived`, `description`, `homepage`, `license`, `pushed_at`, `stars` | `GET /repos/{github-username}/<repo>` |
| `stack` | presence of `package.json` / `pyproject.toml` / `Cargo.toml` / `requirements.txt` in the root tree |
| `deploy` | presence of `vercel.json` / `netlify.toml` / `wrangler.toml` |
| `pitch` | Layer 2 pitch block parsed out of the repo's `README.md` |

Plus URL liveness for every `liveUrl` declared in Layer 3. On any network/auth failure the build falls back to the committed `inventory.json` snapshot rather than failing — the snapshot is a cache, not a source of truth.

### Layer 2 — The pitch. Lives at the very top of each repo's README.md, as an HTML comment (invisible on GitHub).

```html
<!-- portfolio
name: "My Bias App"
tagline_fr: "Parce que votre cerveau vous ment, et qu'il vaut mieux le savoir."
tagline_en: "Because your brain lies to you, and it's better to know."
facts_fr: "51 biais, 510 stratégies de prévention, 131 références vérifiées via Crossref."
facts_en: "51 biases, 510 prevention strategies, 131 references checked against Crossref."
-->
```

- The block must open the file (line 1 is exactly `<!-- portfolio`) and close with a line that is exactly `-->`. A block anywhere else is ignored. The legacy `---` YAML frontmatter form is still parsed (build-inventory.mjs, sync-repo-about.sh, mac-setup tests) but is no longer emitted: it renders as a table on GitHub.

- `name`, `tagline_fr`, `tagline_en` are required for any repo `editorial.ts` tiles. `facts_*` are required there too — every tile carries a facts line.
- For repos the hub does not render, a single `tagline` in whichever language it was written is enough; skip translating a tagline nobody will render.
- Taglines and descriptions are creative content — never auto-generated, never batch-translated without review.
- `name` is the deliberately chosen display name (source of truth: the README pitch block — never overwrite it with a different README heading/title).

### Layer 3 — Editorial. One file in the hub.

`~/Dev/{portfolio-site}/src/data/editorial.ts` decides which projects get a hub tile and in what order. Presentation only — array order IS the canonical order, no numeric sort field. Each entry names a `repo` (drawing Layer 1 + Layer 2 from it) or `repo: null` for a tile with no repo of its own (e.g. a hub tool page over another project's engine), plus `accent`, `liveUrl`, and optional story/date fields. See the file itself for the current interface.

## Visibility Tiers

1. Fully public + promoted (LinkedIn, newsletter)
2. Public but not actively promoted
3. Private (portfolio description only, no access link)

## Infrastructure

- Databases: Neon PostgreSQL (per-project isolation), Cloudflare D1 (lightweight)
- Domain: example.com as root, subdomains for family apps, dedicated domains for main apps

## Quality Standards

- Tests alongside implementation. No console.log in production.
- .gitignore covers: build artifacts, node_modules, .env*, OS files, backups.

