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

## Scaffold

Using the answers above, create:

### Repository setup
```bash
mkdir -p ~/Dev/$0
cd ~/Dev/$0
git init
```

### .portfolio.yml
Create with all required fields. Set:
- `portfolio_card: false` with comment `# TODO: set to true when ready to publish`
- `sort_order: 99` with comment `# TODO: assign final sort_order`
- `visibility` based on audience answer

### CLAUDE.md
Create from the project template (see global CLAUDE.md instructions for expected sections). Include:
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

## Report

After scaffolding:
```
## New App Created: $0

- Location: ~/Dev/$0
- GitHub: https://github.com/{github-username}/$0 (private)
- Stack: [chosen stack]
- Deploy: [not deployed yet / configured for X]
- Portfolio: .portfolio.yml created (portfolio_card: false)

### Next steps:
1. Review .portfolio.yml and set portfolio_card when ready
2. Assign sort_order in .portfolio.yml
3. Deploy when the app has enough content
4. Run /sync to update portfolio-apps.json

### Documents to update:
- Inventaire: add $0 entry
- Pipeline: update if this was a pipeline item
```
