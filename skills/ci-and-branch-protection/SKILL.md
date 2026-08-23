---
name: ci-and-branch-protection
description: How CI gates and GitHub branch protection actually behave on this solo free-tier account — the zero-coverage hole in aggregate jobs, the 403 on private repos, and the three traps that permanently deadlock a solo merge. Load before writing or changing a CI gate, adding a pr-gate caller, or setting/checking branch protection.
user-invocable: true
---

# CI gates and branch protection — the reasons

The rules live in `~/.claude/CLAUDE.md`. This skill holds the measurements.

## A check that did not run must never look like a check that passed

GitHub Actions does not give you this for free:

- a job excluded by `if:` reports `skipped`
- a job dropped from a `needs:` list reports **nothing at all**
- `jq 'all(.[]; .result=="success")'` over an **empty set returns `true`**

So the obvious aggregating job reports **success on zero coverage**. Measured, not
assumed.

**Therefore:** an aggregate gate must assert a **named list of expected checks
computed up front**, and must **refuse an empty list**. Never "did anything fail?".

That aggregate gate is the only check a branch protection rule should require.
Requiring the individual jobs reintroduces the hole, because a protection rule can
only require a name it already knows.

This is the same family as the falsifiable-control rule in the global CLAUDE.md, one
layer out.

### Where the implementation lives

- `{github-username}/.github`'s reusable `pr-gate.yml` — stack detected from the tree, same
  signals as `dev-scanner.sh`.
- `my-trading-app` keeps its own `tests.yml` and carries the same gate **inline**.

### Callers are chosen on measured PR traffic, not coverage for its own sake

A gate on a repo that never sees a PR is decoration. Derive the traffic before
adding a caller — `gh search prs --owner <user>` enumerates every repo in one call.
A hand-picked loop silently omits repos.

## Branch protection needs a **public** repo on this account

`gh api .../branches/main/protection` and `.../rulesets` **both** return
`403 Upgrade to GitHub Pro or make this repository public` on a private repo.

**Consequence: every gate on a private repo here is advisory — a red X, not a blocked
merge.** Never write docs claiming enforcement. Do not "fix" it by upgrading to Pro;
the zero-cost policy stands.

### The control you must run when checking whether a repo is protected

`[]` from a rulesets query is equally the answer from a protectable-but-unprotected
repo. Run a **known-unprotected control alongside**, or the empty result tells you
nothing.

### `my-trading-app` is public and IS protected

Its exact configuration, so a future session does not "improve" it:

- required check: **`gate` alone**, bound to **app_id 15368** so another app's
  same-named status cannot satisfy it
- `strict: false`
- `enforce_admins: false`
- no required reviews
- force-push and deletion off

### Three traps on a solo account

1. **Never require PR reviews.** The author cannot approve their own PR, and the
   merge deadlocks **permanently**.
2. **Keep `enforce_admins` false.** Otherwise required checks also block the direct
   pushes to `main` this repo deliberately makes.
3. **Require only the aggregate `gate` job**, never the individual jobs. (See the
   zero-coverage hole above.)

Setting protection goes through the repo-settings API, which auto mode's classifier
refuses. **The owner runs the `gh api -X PUT`** — do not attempt it.

## Actions billing shapes what can be scheduled

Actions bills **every job rounded up to a whole minute**. A `*/15` cron cannot fit in
the free 2,000 minutes however lean the job is. The `/timing` API reports `0 ms`
billable — use job-level deltas instead, and beware queued-then-cancelled runs.
