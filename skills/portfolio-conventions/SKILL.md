---
name: portfolio-conventions
description: Portfolio coherence rules — preloaded into troubleshooter and portfolio-sync agents as background knowledge.
user-invocable: false
---

# Portfolio Conventions

These are the active portfolio-wide rules. This skill is preloaded — do not invoke it manually.

## Identity

- Each app has its own visual identity, name, and universe. No shared design system.
- Coherence comes from: author signature, quality standards, portfolio site, and the three-layer data system below.
- Portfolio site: {portfolio-site-url} — built from the three layers (see "Portfolio Manifest System" below), not from a hand-maintained JSON export.
- GitHub username: {github-username}. Dev directory: ~/Dev.

## Naming

- All repos use kebab-case matching the folder name in ~/Dev.
- No unintentional naming patterns (the "-or" suffix issue prompted My Bias App → My Bias App).
- New projects that get a hub tile are appended to `editorial.ts` (see below) — there is no numeric sort field to default.

## Signature

- Footer: "Made with care by {author-first-name}" with link to https://{portfolio-site-url}.
- Present by default on all apps. Opt-out must be explicit in project CLAUDE.md.

## Dark/Light Mode

- All user-facing apps support dark and light mode via prefers-color-scheme.
- Manual toggle is optional per project. Opt-out requires justification in CLAUDE.md.

## Documentation

- README: description, stack, local dev, deployment, plus the Layer 2 frontmatter block (below). Created at project init, never boilerplate.
- CLAUDE.md: project-specific only, never duplicates global rules. Written in English.
- No per-repo manifest file. Decision M12 (2026-07) retired `.portfolio.yml` — 26 files × ~18 fields that nothing but the tooling policing them ever read. Three layers replace it.

## Portfolio Manifest System (three layers, decision M12)

### Layer 1 — Derived inventory. Nothing hand-typed.

`~/Dev/{portfolio-site}/scripts/build-inventory.mjs`, run from `prebuild`, writes `~/Dev/{portfolio-site}/src/data/inventory.json`. Per repo it observes, via the GitHub API and the repo's own file tree — never declared by a human:

| field | source |
|---|---|
| `visibility`, `archived`, `description`, `homepage`, `license`, `pushed_at`, `stars` | `GET /repos/{github-username}/<repo>` |
| `stack` | presence of `package.json` / `pyproject.toml` / `Cargo.toml` / `requirements.txt` in the root tree |
| `deploy` | presence of `vercel.json` / `netlify.toml` / `wrangler.toml` |
| `pitch` | Layer 2 frontmatter parsed out of the repo's `README.md` |

Plus URL liveness for every `liveUrl` declared in Layer 3. On any network/auth failure the build falls back to the committed `inventory.json` snapshot rather than failing — the snapshot is a cache, not a source of truth.

### Layer 2 — The pitch. Lives in each repo's README.md frontmatter.

```yaml
---
name: My Bias App
tagline_fr: "Parce que votre cerveau vous ment, et qu'il vaut mieux le savoir."
tagline_en: "Because your brain lies to you, and it's better to know."
facts_fr: "51 biais, 510 stratégies de prévention, 131 références vérifiées via Crossref."
facts_en: "51 biases, 510 prevention strategies, 131 references checked against Crossref."
---
```

- `name`, `tagline_fr`, `tagline_en` are required for any repo `editorial.ts` tiles. `facts_*` are required there too — every tile carries a facts line.
- For repos the hub does not render, a single `tagline` in whichever language it was written is enough; skip translating a tagline nobody will render.
- Taglines and descriptions are creative content — never auto-generated, never batch-translated without review.
- `name` is the deliberately chosen display name (source of truth: the README frontmatter — never overwrite it with a different README heading/title).

### Layer 3 — Editorial. One file in the hub.

`~/Dev/{portfolio-site}/src/data/editorial.ts` decides which projects get a hub tile and in what order. Presentation only — array order IS the canonical order, no numeric sort field. Each entry names a `repo` (drawing Layer 1 + Layer 2 from it) or `repo: null` for a tile with no repo of its own (e.g. a hub tool page over another project's engine), plus `accent`, `liveUrl`, and optional story/date fields. See the file itself for the current interface.

## Visibility Tiers

1. Fully public + promoted (LinkedIn, newsletter)
2. Public but not actively promoted
3. Private (portfolio description only, no access link)

## Infrastructure

- Zero cost: free tiers only (Netlify, Vercel, Cloudflare, Neon, etc.)
- Automatic deploys on push to main
- Databases: Neon PostgreSQL (per-project isolation), Cloudflare D1 (lightweight)
- Domain: example.com as root, subdomains for family apps, dedicated domains for main apps

## Quality Standards

- Zero build warnings. Exceptions documented in project CLAUDE.md.
- Conventional Commits. One logical change per commit.
- Tests alongside implementation. No console.log in production.
- No secrets in repos. No personal data in repos.
- .gitignore covers: build artifacts, node_modules, .env*, OS files, backups.

