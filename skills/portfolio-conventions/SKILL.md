---
name: portfolio-conventions
description: Portfolio coherence rules — preloaded into troubleshooter and portfolio-sync agents as background knowledge.
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

Required fields: name, slug, tagline, description, audience, visibility, status, surface_type, url, portfolio_card, portfolio_link, badge, icon_emoji, icon_file, stack, sort_order.
Optional: story_slug (required when surface_type implies a hub story or merged story — see below).
- slug = folder name = GitHub repo name (source of truth: repo)
- name = README title (source of truth: README)
- Taglines and descriptions are creative content — never auto-generated.

### surface_type taxonomy

Every manifest MUST declare `surface_type`. Valid values:

| Value | Meaning | story_slug required? |
|---|---|---|
| `flagship` | Promoted live app on its own subdomain | No |
| `personal-live` | Family/personal live app, linked from a merged story | Yes |
| `external-story` | Own subdomain, heavy stack, hub links out | No |
| `internal-story` | Story on the hub at `/stories/<slug>`, original deploy (if any) slated for retirement | Yes |
| `tool-widget` | Small embedded tool on the hub at `/tools/<slug>` | Yes |
| `meta` | GitHub repo referenced from a meta story (infra, tooling) | Optional |
| `hidden` | Not displayed on the hub; may or may not have a deploy | No |
| `archived` | Read-only repo, no active surface (post-retirement) | Yes |
| `hub` | The portfolio hub itself (`{portfolio-site}` only) | No |

Only manifests whose `surface_type` is in `{flagship, personal-live, external-story, internal-story, tool-widget, meta}` appear in the generated `portfolio-apps.json`. `hidden`, `archived`, and `hub` are validated but excluded from the hub index.

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

