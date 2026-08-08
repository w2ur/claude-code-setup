#!/usr/bin/env python3
"""Portfolio env-var drift check — no model, deterministic.

Compares the env vars each repo's code actually READS against how they are DOCUMENTED.
Documentation has two tiers, and conflating them produces false alarms:

  tier 1  .env.example / .dev.vars.example / env.sample  — the copy-paste surface
  tier 2  README.md / CLAUDE.md prose                    — real documentation, not a template

Findings, most to least serious:
  UNDOCUMENTED        read, and named in neither tier   -> a deploy can silently half-configure
  PROSE-ONLY          read, documented in prose only    -> no .env.example to copy from
  STALE               declared in tier 1, never read    -> sends the owner to set a dead var

Usage:  python3 env-drift-check.py [out.json]
Honours DEV_DIR (default ~/Dev) so it can be run against a fixture tree.
"""
import os, re, sys, json, collections

DEV = os.environ.get("DEV_DIR", os.path.expanduser("~/Dev"))

SRC_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
           ".py", ".astro", ".svelte", ".vue", ".go", ".sh"}
SKIP_DIR = {"node_modules", ".git", "dist", "build", ".next", ".astro", "__pycache__",
            ".venv", "venv", ".wrangler", "out", "coverage", ".vercel", ".netlify",
            ".worktrees", "worktrees"}
ENV_FILES = (".env.example", ".env.sample", ".dev.vars.example", "env.sample",
             ".env.template", "podman/env.sample", "worker/.dev.vars.example")

# Every way this portfolio's code reads an env var. Each entry here exists because
# omitting it produced a false "never read" finding on a real, live secret.
PATTERNS = [
    re.compile(r"process\.env\.([A-Z][A-Z0-9_]{2,})"),
    re.compile(r"process\.env\[['\"]([A-Z][A-Z0-9_]{2,})['\"]\]"),
    re.compile(r"import\.meta\.env\.([A-Z][A-Z0-9_]{2,})"),
    re.compile(r"os\.environ\[['\"]([A-Z][A-Z0-9_]{2,})['\"]\]"),
    re.compile(r"os\.environ\.get\(\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]"),
    re.compile(r"os\.getenv\(\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]"),
    re.compile(r"Deno\.env\.get\(\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]"),
    re.compile(r"\benv\.([A-Z][A-Z0-9_]{2,})\b"),            # Cloudflare Worker binding
    re.compile(r"\benv\(\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]\s*\)"),  # env("X") helper, Prisma
    re.compile(r"\$\{?([A-Z][A-Z0-9_]{2,})\}?"),             # ${VAR} in CI / wrangler yaml
]
WORKER_EXT = {".ts", ".js", ".tsx", ".mts", ".cts", ".mjs", ".cjs"}

# Repos whose env surface is upstream code, not the owner's.
VENDORED = {"analytics"}

# Platform-supplied or non-secret: never expected in a declaration file.
NOISE = {
    "NODE_ENV", "CI", "PORT", "HOME", "PATH", "PWD", "USER", "SHELL", "TERM", "LANG",
    "NODE_VERSION", "TZ", "DEBUG", "FORCE_COLOR", "NO_COLOR", "SSL_CERT_FILE",
    "GITHUB_ACTIONS", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF",
    "GITHUB_WORKSPACE", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_EVENT_NAME", "RUNNER_OS",
    "GITHUB_STEP_SUMMARY", "GITHUB_REF_NAME", "RUNNER_TEMP",
    "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION", "VERCEL_GIT_COMMIT_SHA",
    "NETLIFY", "NETLIFY_DEV", "CONTEXT", "DEPLOY_PRIME_URL", "URL", "BRANCH", "HEAD",
    "COMMIT_REF", "OS", "ARCH", "TMPDIR", "EDITOR", "SHLVL", "OLDPWD", "LC_ALL",
    "LOGNAME", "PYTHONPATH", "PYTHONUNBUFFERED", "VIRTUAL_ENV", "CONDA_PREFIX",
}


def declared_in_env_files(root):
    """Tier 1: vars with a copy-paste template entry."""
    found = {}
    for cand in ENV_FILES:
        p = os.path.join(root, cand)
        if not os.path.isfile(p):
            continue
        got = set()
        for line in open(p, encoding="utf-8", errors="ignore"):
            line = line.strip()
            if line and not line.startswith("#"):
                m = re.match(r"(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=", line)
                if m:
                    got.add(m.group(1))
        found[cand] = got
    return found


def documented_in_prose(root, names):
    """Tier 2: vars named in README.md / CLAUDE.md and friends."""
    if not names:
        return {}
    blobs = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIR]
        for fn in fns:
            if fn.endswith(".md"):
                try:
                    blobs.append((os.path.relpath(os.path.join(dp, fn), root),
                                  open(os.path.join(dp, fn), encoding="utf-8",
                                       errors="ignore").read()))
                except OSError:
                    pass
    out = {}
    for n in names:
        for rel, txt in blobs:
            if re.search(r"\b" + re.escape(n) + r"\b", txt):
                out[n] = rel
                break
    return out


def scan_repo(root):
    reads = collections.defaultdict(set)
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIR]
        for fn in fns:
            ext = os.path.splitext(fn)[1]
            is_yaml = fn.endswith((".yml", ".yaml", ".toml"))
            if ext not in SRC_EXT and not is_yaml and not fn.endswith(".prisma"):
                continue
            p = os.path.join(dp, fn)
            try:
                txt = open(p, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if len(txt) > 2_000_000:
                continue
            rel = os.path.relpath(p, root)
            for pat in PATTERNS:
                # ${VAR} is indistinguishable from a shell local, so trust it only in
                # yaml/toml, where it really does mean an injected value.
                if pat.pattern.startswith(r"\$\{?") and not is_yaml:
                    continue
                if pat.pattern.startswith(r"\benv\.") and ext not in WORKER_EXT:
                    continue
                for m in pat.finditer(txt):
                    v = m.group(1)
                    if v not in NOISE and not v.startswith("NEXT_PUBLIC_VERCEL"):
                        reads[v].add(rel)
    return reads


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else None
    repos = sorted(d for d in os.listdir(DEV)
                   if os.path.isdir(os.path.join(DEV, d, ".git")))
    result, exit_code = {}, 0
    for r in repos:
        root = os.path.join(DEV, r)
        if r in VENDORED:
            result[r] = {"skipped": "vendored upstream"}
            continue
        reads = scan_repo(root)
        envf = declared_in_env_files(root)
        tier1 = set().union(*envf.values()) if envf else set()
        if not reads and not tier1:
            continue
        unknown = set(reads) - tier1
        prose = documented_in_prose(root, unknown)
        undoc = sorted(unknown - set(prose))
        result[r] = {
            "env_files": sorted(envf),
            "ok": sorted(set(reads) & tier1),
            "prose_only": {k: prose[k] for k in sorted(prose)},
            "undocumented": {k: sorted(reads[k])[:2] for k in undoc},
            "stale": sorted(tier1 - set(reads)),
        }
        if undoc:
            exit_code = 1

    if out_path:
        json.dump(result, open(out_path, "w"), indent=1)

    for r, d in result.items():
        if "skipped" in d:
            print(f"\n### {r}   [skipped — {d['skipped']}]")
            continue
        if not d["env_files"] and not d["undocumented"] and not d["prose_only"]:
            continue
        print(f"\n### {r}   (env files: {', '.join(d['env_files']) or 'NONE'})")
        if d["ok"]:
            print(f"    ok           : {', '.join(d['ok'])}")
        if d["prose_only"]:
            print(f"    PROSE-ONLY   ({len(d['prose_only'])}) — documented, but no .env.example entry:")
            for k, where in d["prose_only"].items():
                print(f"       · {k:32} documented in {where}")
        if d["undocumented"]:
            print(f"    UNDOCUMENTED ({len(d['undocumented'])}) — in no .env.example and no .md:")
            for k, files in d["undocumented"].items():
                print(f"       ! {k:32} read at {files[0]}")
        if d["stale"]:
            print(f"    STALE        : {', '.join(d['stale'])}")
    return exit_code


sys.exit(main())
