# CLAUDE.md — Global Instructions

These instructions apply to all projects unless overridden by a project-level CLAUDE.md.

## Language

- All code, comments, variable names, function names, and commit messages MUST be in English.
- User-facing content (UI text, labels, documentation shown to users) follows the project's target language, defined in the project-level CLAUDE.md.
- This file and all project-level CLAUDE.md files are written in English.

## Planning and Execution

- For small, well-scoped tasks (single file edit, bug fix, simple refactor): execute directly.
- For tasks that touch multiple files, change architecture, or add features: propose a plan first and wait for approval before executing.
- When in doubt, bias toward proposing a plan.
- Plans must break work into atomic subtasks, each with a clear "done when…" criterion (e.g., "done when the test passes", "done when the route returns 200"). This makes plans actionable regardless of which model executes them.
- Each subtask should be self-contained enough to be delegated to a sub-agent: task description, affected files, and "done when…" criterion — with no dependency on the surrounding plan context.
- When proposing a plan, give an opinionated recommendation for each decision point — don't just list options. Justify the recommendation, then ask for approval.
- Plan files are working artifacts — NEVER create them inside the project repository. They go in `~/.claude/plans/` only.
- If you find plan files inside a repo (e.g., `docs/plans/`, `docs/superpowers/`, `PLAN.md`, `.superpowers/`), remove them from git tracking immediately: `git rm -r --cached <path>` then add the path to `.gitignore`.
- Plugins that create plans inside repos (e.g., Superpowers' `writing-plans`) must be configured to write to `~/.claude/plans/` instead. If the plugin cannot be configured, add its output directory to `.gitignore`.
- Run `/cleanup plans-only` periodically to catch plans that slipped through.

## Bug Triage

When the owner reports a bug, do NOT start fixing immediately. First, rule out environment issues.

Ask about the most likely culprit — typically a stale cache or service worker (especially for PWAs). Common causes to eliminate:

- **Stale cache / service worker**: has the browser cache been cleared? Has the service worker been unregistered and the page hard-refreshed?
- **Stale build**: is the user running the latest deployed version? (hard refresh, redeploy, `npm run build`)
- **Local state**: could localStorage, IndexedDB, or cookies contain outdated data causing the issue?
- **Network**: is the issue reproducible on different connections?
- **Device-specific**: does it happen on all devices or just one?

Ask one concise question targeting the most probable cause — don't send a full checklist every time. Use judgment: if the bug is clearly a code issue (e.g., "the button does X instead of Y and I can see it in the source code"), skip triage and fix directly.

Only start investigating the code once environment causes are ruled out.

## Task Execution

- **Default to sub-agents** for any task with 2+ independent parts. Sequential execution of independent work is a waste of time — parallelize.
- The bar for "should I use a sub-agent?" is low: if two things don't depend on each other, they run in parallel.
- Examples: auditing .gitignore + adding footer + checking for secrets; running backend + frontend tests; updating README + CLAUDE.md + .portfolio.yml; checking multiple APIs' free tier limits; running docs-checker + portfolio-audit simultaneously.
- Keep sequential what has dependencies: understand the project → create/update CLAUDE.md → set up tests → verify build.
- When dispatching sub-agents, always specify the model (haiku/sonnet/opus) based on task complexity — see "Agent Model Selection" section.

## Agent Model Selection

When dispatching work to sub-agents, choose the model that matches the task complexity:

- **haiku**: passive audits, compliance checks, linting, format verification (e.g., portfolio-audit, docs-checker).
- **sonnet**: standard implementation tasks with clear scope — single-file changes, new components following existing patterns, straightforward bug fixes, tests, documentation.
- **opus**: complex implementation spanning 4+ files across layers, migration execution, subtle multi-module bugs, tasks where a previous sonnet attempt failed, and all architecture analysis.

When in doubt, start with sonnet. If it fails to meet the "done when" criterion, retry with opus before escalating to the architect.

## Escalation to Architect

**Hard rule: after 2 failed attempts at the same fix, STOP. Do not try a third time with the same approach.** This is the single most important workflow rule. The worst time sink is iterating without stepping back.

When a fix fails twice:

1. **Stop and count**: you have tried 2 different approaches to solve the same problem and neither worked. You MUST escalate. No exceptions, no "let me just try one more thing."
2. **Diagnose before acting**: is the failure caused by a bug in your implementation, or by a structural problem in the existing code?
3. **If structural**: invoke the `architect` agent (opus) with: what the problem is, what was tried, and why each attempt failed. The architect analyzes the root cause and may recommend rearchitecture, library swaps, stack changes, or data model redesigns.
4. **If implementational**: retry with opus-level implementer, providing the specific failure context. This counts as attempt 3 — if it also fails, escalate to architect immediately.

Signs that a problem is structural (not just a bug):
- The fix works in isolation but breaks something else
- The same type of bug keeps reappearing in different forms
- The task requires fighting against the current architecture (e.g., passing data through 5 layers, working around a library's limitations)
- Multiple files need coordinated changes with no clear single source of truth

**Self-check: if you catch yourself thinking "let me just try one more thing" after 2 failures — that is the signal to stop.** The architect agent produces a plan — it does not write production code. Once the plan is approved, dispatch subtasks to the implementer.

## Skill and Plugin Usage

Before starting non-trivial work, check if a skill or plugin applies. Using the right skill at the right time prevents rework and catches problems early.

### Mandatory triggers

| Situation | Skill / Plugin | When |
|-----------|---------------|------|
| Plan written or modified in `~/.claude/plans/` | `/review-plan` (plan-reviewer plugin) | Before executing any plan |
| Bug report or test failure | systematic-debugging | Before proposing any fix |
| Documentation changes (README, CLAUDE.md) | docs-checker agent | After changes, before commit |
| Pre-release or compliance sweep | portfolio-audit agent | Before pushing to production |
| New project created | portfolio-sync agent (single project mode) | After initial scaffold |

### How skills interact with existing rules

- **systematic-debugging + escalation rule:** The debugging skill enforces root-cause investigation (Phases 1-3). If root cause is found but the fix fails twice, the escalation rule kicks in (→ architect). They're sequential, not overlapping. Note: the debugging skill's default threshold is 3 failures, but our escalation rule overrides this to 2.
- **systematic-debugging + bug triage:** Bug triage (environment causes first) runs BEFORE systematic-debugging. Triage eliminates cache/service worker/stale build. If the bug survives triage, systematic-debugging takes over for code investigation.
- **plan-reviewer + architect:** Plan-reviewer catches problems before implementation. The architect catches problems after implementation fails. One is preventive, the other reactive.

## Session Handoff

- At the end of a significant block of work (feature complete, sprint done, or when asked), produce a structured handoff summary:
  - **Done**: what was completed (with commit refs if relevant)
  - **In progress**: what was started but not finished
  - **Remaining**: what still needs to be done
  - **Decisions made**: any choices that affect future work
- This summary helps resume work cleanly in a new session, especially after a `/compact` or context reset.
- **Write to agent memory**: after producing the handoff summary, write a condensed version to your agent memory. Include: key decisions made, patterns discovered, and any unfinished work with context needed to resume. This happens automatically — do not ask the owner for permission.
- If no significant work was done in the session, skip the memory write.

## Context Management

- Monitor context usage. When context reaches ~50%, run `/compact` proactively — do not wait for degradation.
- After a `/compact`, re-read the project CLAUDE.md and any loaded skills — they may have been summarized away.
- When switching to a completely different task mid-session, prefer `/clear` over continuing in a polluted context.
- When dispatching to sub-agents, send focused prompts — not conversation history dumps.

## Agent Memory

- Agents with `memory: project` in their frontmatter learn across sessions. They read MEMORY.md at startup and write to it at session end.
- Memory files live in `~/.claude/agent-memory/{agent-name}/`. The first 200 lines of MEMORY.md are injected into the agent's system prompt.
- If MEMORY.md exceeds 200 lines, the agent splits detailed content into topic files and keeps MEMORY.md as a summary with cross-references.
- Memory is for patterns, decisions, and project-specific quirks — not for task tracking or TODO lists.
- After any correction from the owner, the agent writes a memory entry capturing the lesson — without asking.
- This replaces the previous `~/.claude/lessons/{project-slug}.md` convention. Do NOT read from or write to `~/.claude/lessons/` — that directory no longer exists.

## Portfolio-Wide Artifacts

When modifying commands, agents, skills, or hooks in ~/.claude/:
1. Update the DATA section of ~/Dev/workflow-guide.html to reflect the change.
2. If the change affects the architecture (new agent, new command, changed escalation rules): flag that ~/Dev/{portfolio-site}/strategy/charte-coherence.md needs updating (section "Workflow Claude Code") and include it in the session handoff.

When a new app is created, an app changes visibility, or a domain changes:
- Flag that strategy/strategie-visibilite.md needs updating.

When a new project idea is evaluated or an idea changes status:
- Flag that strategy/pipeline.md needs updating.

These flags go in the session handoff and agent memory. The owner handles the commits in {portfolio-site} separately. The /cleanup command verifies staleness of these artifacts weekly.
- Run /tech-debt monthly. Phase 1 triages all apps automatically; the owner picks which to review in depth. Items flagged 2+ months without action are escalated to /architect. Scan dates tracked in ~/Dev/.tech-debt-rotation.json.

## Documentation Updates

- README.md, CLAUDE.md, and .portfolio.yml updates are part of the implementation, not a separate step.
- When a task changes the stack, adds a feature, modifies routes, or alters the deployment setup: update the README.md, the project-level CLAUDE.md, AND the .portfolio.yml (if affected) in the **same commit** as the code change.
- Never commit a feature without verifying that the README still accurately describes the project.
- Every project MUST have a README.md at the root. Never leave a boilerplate/template README in place.
- When creating a new project, write the README as part of the initial setup — not as an afterthought.
- README structure should include at minimum: project description (one paragraph), tech stack, how to run locally, and deployment info. Adapt depth to the project's complexity.

## Project-Level CLAUDE.md

- If a project has a CLAUDE.md at its root, keep it up to date when making significant changes (new dependencies, new testing conventions, new deployment setup, new environment variables).
- If a project does NOT have a CLAUDE.md, create one when starting significant work on the project.
- The project-level CLAUDE.md only contains project-specific information. Never duplicate rules from the global CLAUDE.md.
- Expected sections (include only those that are relevant):
  - **Project Overview**: one paragraph — what the app does, who it's for, current status.
  - **Tech Stack**: main technologies and frameworks.
  - **User-Facing Language**: the language shown to end users (e.g., French, English, Bilingual FR/EN).
  - **Development**: how to install and run locally.
  - **Project Structure**: key directories and their purpose (only non-obvious ones).
  - **Testing**: framework used, project-specific conventions or priorities.
  - **Build Warning Exceptions**: any known warnings that cannot be fixed, with justification.
  - **Deployment**: where and how it's deployed, required environment variables.
  - **Project-Specific Rules**: anything that overrides or extends the global CLAUDE.md.

## Portfolio Manifest (.portfolio.yml)

- Every project in the portfolio MUST have a `.portfolio.yml` file at the root.
- This file is machine-readable metadata used by the portfolio-sync agent and the apps page on {portfolio-site-url}.
- When a task changes any field described in the manifest (app name, stack, deployment platform, URL, domain, visibility, status), update `.portfolio.yml` in the **same commit** as the code change.
- The `tagline` field is the app's one-liner for the portfolio page. If you come up with a better tagline while working on the project — funnier, more personal, more memorable — propose updating it. Good taglines are personal and witty, not corporate-descriptive.
- The `icon_file` field should point to the best available icon in the repo (PWA icon, favicon SVG/PNG). If you add or change an app icon, update this field.
- The `sort_order` field controls display order on the portfolio apps page. Lower numbers appear first. When adding a new project, set `sort_order: 99` — the owner will assign the final position.
- When creating a new project, generate the `.portfolio.yml` as part of the initial setup alongside the README and CLAUDE.md.
- Do NOT duplicate the full README content into the manifest. The `description` field is 2-3 sentences max.

## Strategic Documents

The portfolio's strategic documents live in `~/Dev/{portfolio-site}/strategy/`:
- `inventaire.md` — App inventory (the reference for all apps in the portfolio)
- `charte-coherence.md` — Coherence charter (cross-app decisions and standards)
- `pipeline.md` — Ideas pipeline (evaluation and prioritization of future apps)
- `strategie-visibilite.md` — Visibility strategy (domains, branding, promotion)

### When to read
- At the start of a session involving a new project, portfolio-level decisions, or naming/branding.
- When the owner references "the inventory", "the charter", "the pipeline", or "the visibility strategy".

### When to update
- **Minor updates (do directly):** adding a new app to the inventory after creating it, updating a status, adding a deployment entry to the charter, moving an idea from pipeline to inventory.
- **Structural decisions (discuss with owner first):** changing visibility tiers, adding new principles to the charter, re-prioritizing the pipeline, changing naming conventions.
- Update in the same commit as the related code change when possible. If the change is in a different repo, commit separately in `{portfolio-site}`.

## Naming Convention

- The local folder name in `~/Dev/` MUST match the GitHub repo name exactly.
- Both MUST be in **kebab-case** (lowercase, hyphens as separators).
- Examples: `my-budget-app`, `my-tsundoku`, `my-roadmap-app`, `{portfolio-site}`.
- When renaming a project, rename BOTH the GitHub repo (`gh repo rename`) and the local folder in the same operation. Update the git remote URL after renaming.
- The `slug` field in `.portfolio.yml` must also match.

## Commits

- Use Conventional Commits format: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `style:`, `perf:`, `ci:`, `build:`.
- Commit messages must be concise and descriptive. One line, imperative mood, no period.
- Scope is optional but encouraged for multi-module projects: `feat(auth): add email OTP flow`.
- One logical change per commit. Don't bundle unrelated changes.

## Build Quality

- Zero warnings policy: builds must produce zero warnings. Fix warnings before considering a task done.
- If a warning cannot be fixed (e.g., upstream dependency issue), document it as an exception in the project-level CLAUDE.md with a justification and a tracking note (issue link or TODO).
- This applies to all build tools: TypeScript compiler, ESLint, Vite, Next.js, Astro, Python linters, etc.
- FutureWarning, DeprecationWarning, and similar: fix proactively. If the fix requires a major version bump that is out of scope, document the exception.

## Code Quality

- For non-trivial changes (new features, refactors, multi-file edits): before presenting the result, pause and ask yourself "is there a more elegant way to do this?"
- If the implementation feels hacky or like a workaround, step back and implement the clean solution — as if you knew from the start what you know now.
- Skip this for simple, obvious fixes — don't over-engineer a one-line bug fix.
- Challenge your own work before presenting it. The owner does not review code, so the quality bar is entirely on you.

## Generalization Check

Before implementing a specific request, consider whether it's a special case of a
more general pattern. If the general solution is roughly the same effort as the
specific one, implement the general version with the specific case as the default.

Apply this when:
- The pattern already appears elsewhere in the project or portfolio
- The request involves hardcoded values that could be configuration
- A utility function would serve multiple callers

Skip this when:
- The general version requires significantly more code or complexity
- There's only one known use case and no evidence of others
- Adding configurability would slow down the immediate task without clear future benefit

This is a design judgment call, not a mandatory abstraction step. When in doubt,
implement the specific case cleanly — it's easier to generalize clean code later
than to simplify over-engineered code.

## Testing

- Every feature or bug fix should include relevant unit tests.
- Write tests alongside the implementation, not as a separate step after the fact.
- When modifying existing code, verify that existing tests still pass. Fix any broken tests before committing.
- Use the testing framework already present in the project. If none exists, propose one that fits the stack (e.g., Vitest for Vite projects, Jest for Next.js, pytest for Python).
- Test files live next to the code they test (e.g., `utils.ts` → `utils.test.ts`) unless the project has an established `__tests__/` or `tests/` convention.
- At minimum, test: utility functions, data transformations, API endpoints, and any logic with branching conditions. UI components are lower priority unless the project-level CLAUDE.md specifies otherwise.

## Error Handling

- Never silently swallow errors. Log them or surface them to the user.
- Prefer explicit error handling over try/catch-all patterns.
- In user-facing apps, show meaningful error messages — not raw stack traces.

## Dependencies

- Don't add dependencies without a clear reason. Prefer standard library or existing project dependencies when possible.
- When adding a dependency, verify it is actively maintained and widely used.
- Pin dependency versions in lock files. Don't use `latest` or loose ranges in package.json for production dependencies.

## Code Style

- Follow the existing code style of the project. Don't introduce new patterns or conventions without discussing it first.
- If the project has a linter/formatter config (ESLint, Prettier, Ruff, Black), respect it.
- If no linter/formatter is configured, follow standard community conventions for the language.

## Security and Privacy

### Secrets
- Never commit secrets, API keys, tokens, or passwords. Use environment variables.
- If a `.env.example` or `.env.local.example` exists, keep it up to date when adding new environment variables (with placeholder values, not real ones).
- Never log sensitive data (tokens, passwords, personal information).

### Private Data
- Never commit files containing personal or private user data: fitness logs, financial records, health data, personal notes, user exports, etc.
- Data fixtures for tests must use synthetic/fake data, never real user data.
- If a project uses JSON data files (e.g., content databases), verify they contain only public/editorial content before committing.
- Backup files, export files, and database dumps must be in `.gitignore`.

### Images and Media
- Never commit images or media files without explicit license verification.
- Images sourced from external APIs or websites must have their license and attribution tracked (e.g., in an `attributions.json` or similar file).
- AI-generated images: note the generation tool and any applicable terms in the project documentation.
- When in doubt about an image's license, ask before committing.

### .gitignore
- Every project must have a `.gitignore` appropriate for its stack.
- At minimum, it must exclude: build artifacts, `node_modules`/`__pycache__`, `.env*` (except `.env.example`), OS files (`.DS_Store`, `Thumbs.db`), editor configs, backup/export files, `docs/plans/`, and any data files containing personal information.
- Verify `.gitignore` coverage when adding new file types to a project.

## Git Hygiene

- Don't commit generated files or build artifacts. Verify `.gitignore` covers them.
- Don't commit commented-out code. Remove it or put it behind a feature flag.
- Don't commit plan files, scratch notes, or task artifacts.
- Before staging, review `git status` for any files that shouldn't be tracked (plans, backups, exports).

## Author Signature

- Every app MUST include a footer: **"Made with care by {author-first-name}"** with a link to `https://{portfolio-site-url}`.
- This is the default. To opt out, the project-level CLAUDE.md must explicitly state it.

## Dark/Light Mode

- Every user-facing app MUST support dark and light mode, following the user's system preference (`prefers-color-scheme`).
- The system preference is the default. A manual toggle in the UI is optional — up to each project.
- This is the default. To opt out, the project-level CLAUDE.md must explicitly state it with a justification (e.g., "This app has its own theme system", "The artistic direction requires a fixed palette").

## Design Defaults

- Never default to purple, violet, or indigo as a primary color. This is a known model bias from overexposure to Tailwind/shadcn defaults.
- When no color palette is specified for a new project, propose 2-3 palette directions based on the app's subject, mood, and audience. Wait for approval before implementing.
- When a project-level CLAUDE.md already defines a palette or design direction, follow it strictly.

## Tech Stack Choices

- No stack is imposed globally. Choose the best tools for each project.
- The owner does not review code — optimize for correctness, maintainability, and the best fit for the project's needs.
- What matters at the portfolio level: zero cost (free tiers only), automatic deploys on push to main, zero warnings, tests, and documentation.

## Plugins

- Plugins add agents, skills, hooks, and commands to the context. Each one has a cost: startup time, context consumption, and potential conflicts with custom agents.
- Before installing a plugin, evaluate: does it solve a problem that your custom agents/commands don't already handle? If there's overlap, prefer your custom setup — it's tailored to your portfolio.
- Audit installed plugins periodically with `/cleanup plugins-only`. Uninstall plugins you don't actively use — they cost context on every session start.
- If a plugin's agent conflicts with a custom agent (same name or overlapping scope), the custom agent takes priority. Disable the plugin's agent in `.claude/settings.json` if needed.
- If a plugin injects a SessionStart hook, be aware it consumes context in every session — even when you don't use that plugin's features.
