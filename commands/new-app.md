---
description: Scaffold a new app in ~/Dev with full portfolio compliance from day one.
argument-hint: [app-name-in-kebab-case]
model: sonnet
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent(implementer)
---

Create a new portfolio app named `$0` in `~/Dev/$0`.

## Validation

1. **Name format**: `$0` must be kebab-case. If it contains uppercase, spaces, or underscores, reject and ask for a corrected name.
2. **Name collision**: check if `~/Dev/$0` already exists. If yes, abort.
3. **GitHub collision**: run `gh repo view {github-username}/$0 2>/dev/null` — if the repo already exists, warn.

## Information Gathering

Before scaffolding, ask the owner:
1. **What does this app do?** (one paragraph)
2. **Who is it for?** (public / family / personal)
3. **Preferred stack?** (or "you choose")
4. **User-facing language?** (French / English / Bilingual)
5. **Deploy target?** (Netlify / Vercel / Cloudflare / local-only for now)
6. **Should it get a tile on the hub ({portfolio-site-url})?** If yes, get a one-line French tagline, one-line English tagline, and (if it's a real project the hub would feature, not a personal-only tool) a facts line for each language.

## Scaffold

Using the answers above, create:

### Repository setup
```bash
mkdir -p ~/Dev/$0
cd ~/Dev/$0
git init
```

### CLAUDE.md
Create covering: project overview, tech stack, dev/build commands, deployment, and any conventions that override or extend the global CLAUDE.md. Include:
- Project overview from the owner's description
- Tech stack from chosen stack
- User-facing language
- Development commands (npm install && npm run dev, or equivalent)
- Deployment info

### README.md
Write a real README (not boilerplate) with:
- Project description
- Tech stack
- How to run locally
- Deployment setup
- **Layer 2 frontmatter** (per `portfolio-conventions`) at the very top of the file:
  ```yaml
  ---
  name: [Display Name]
  tagline_fr: "[one-line FR tagline]"
  tagline_en: "[one-line EN tagline]"
  facts_fr: "[facts line, only if the app will get a hub tile]"
  facts_en: "[facts line, only if the app will get a hub tile]"
  ---
  ```
  If the owner only gave one language's tagline (question 6), write only that `tagline_*` key — do not invent a translation nobody asked for. Omit `facts_*` entirely for apps that won't get a hub tile.

### .gitignore
Appropriate for the chosen stack, including all standard exclusions.

### Initial project files
Use the `implementer` agent to create the minimal project skeleton:
- Package.json (or equivalent) with project name and scripts
- Basic app entry point with "Hello World" or equivalent
- Author signature footer already present
- Dark/light mode support via `prefers-color-scheme`
- Basic test setup (empty test file with framework configured)

### First commit
```bash
git add -A
git commit -m "feat: initial scaffold for $0"
```

### GitHub repo
```bash
gh repo create {github-username}/$0 --private --source=. --push
```
Note: created as private by default. The owner decides when to make it public.

### editorial.ts entry (only if the owner said yes to a hub tile)
Read `~/Dev/{portfolio-site}/src/data/editorial.ts` and append one `EditorialEntry` for `$0`: `slug: "$0"`, `repo: "$0"`, an `accent` that doesn't collide with existing entries, the app's `liveUrl` once deployed (or omit/placeholder if not deployed yet), and `liveHost`. Append at the end of the array — array order is the canonical order, and the owner reorders manually when ready. Do not invent a `story` or `date` unless the owner specified one; leave it for the owner to add when the app has a story written. This is the only write this command makes inside `~/Dev/{portfolio-site}/` — do not touch anything else in that repo.

## Report

After scaffolding:
```
## New App Created: $0

- Location: ~/Dev/$0
- GitHub: https://github.com/{github-username}/$0 (private)
- Stack: [chosen stack]
- Deploy: [not deployed yet / configured for X]
- Portfolio: README frontmatter added (name/tagline_fr/tagline_en[/facts_fr/facts_en]); editorial.ts entry [added / skipped — no hub tile requested]

### Next steps:
1. Deploy when the app has enough content
2. If it wasn't given a hub tile yet and should get one later, add an entry to `~/Dev/{portfolio-site}/src/data/editorial.ts`
3. Run /sync to validate the hub's stories collection frontmatter (unrelated to this app unless it ships a story)

### Documents to update:
- Inventaire: add $0 entry
- Pipeline: update if this was a pipeline item
```
