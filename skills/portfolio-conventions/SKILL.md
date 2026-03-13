---
name: portfolio-conventions
description: Portfolio coherence rules — preloaded into architect and portfolio-sync agents as background knowledge.
user-invocable: false
---

# Portfolio Conventions

These are the active portfolio-wide rules. This skill is preloaded — do not invoke it manually.

## Identity

- Each app has its own visual identity, name, and universe. No shared design system.
- Coherence comes from: author signature, quality standards, portfolio site, and automated sync.
- Portfolio site: {portfolio-site-url} — data-driven from portfolio-apps.json.
- GitHub username: {github-username}. Dev directory: ~/Dev.

## Naming

- All repos use kebab-case matching the folder name in ~/Dev.
- No unintentional naming patterns (the "-or" suffix issue prompted Unbiasor → Untilt).
- New projects default to sort_order: 99.

## Signature

- Footer: "Made with care by {author-first-name}" with link to https://{portfolio-site-url}.
- Present by default on all apps. Opt-out must be explicit in project CLAUDE.md.

## Dark/Light Mode

- All user-facing apps support dark and light mode via prefers-color-scheme.
- Manual toggle is optional per project. Opt-out requires justification in CLAUDE.md.

## Documentation

- README: description, stack, local dev, deployment. Created at project init, never boilerplate.
- CLAUDE.md: project-specific only, never duplicates global rules. Written in English.
- .portfolio.yml: machine-readable manifest at repo root. Updated in same commit as any field change.

## Manifest (.portfolio.yml)

Required fields: name, slug, tagline, description, audience, visibility, status, url, portfolio_card, portfolio_link, badge, icon_emoji, icon_file, stack, sort_order.
- slug = folder name = GitHub repo name (source of truth: repo)
- name = README title (source of truth: README)
- Taglines and descriptions are creative content — never auto-generated.

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

## App Display Order (fixed)

My Tsundoku → Untilt → I P Yeah! → Conversations → My Fitness App → My Budget App → My Roadmap App → My Editor App → Christianity → Sttew → Kairos → Birdie
