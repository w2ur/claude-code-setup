#!/usr/bin/env bash
# dev-scanner.sh
#
# Deterministic replacement for the former `dev-scanner` LLM agent.
# Scans ~/Dev (or a single given project) and reports, per project:
# git status, last commit, branch, doc files present, and detected stack.
#
# Read-only: this script must NEVER modify anything under the scanned
# directory. Every git call below is a read-only git subcommand
# (rev-parse, remote get-url, branch --show-current, log, status
# --porcelain, ls-files --others).
#
# Usage:
#   dev-scanner.sh [path] [--json]
#
# Deliberately dropped vs. the original agent (judgment calls, not rules):
#   - Cross-checking against ~/Dev/{portfolio-site}/strategy/inventaire.md
#     (name alignment / orphan / missing-app detection) — requires matching
#     folder names to "official" portfolio names via free-text inference.
#   - GitHub API cross-checks (gh repo view / gh repo list) — deterministic
#     in principle, but introduces a network/auth dependency this script
#     does not want as a hard requirement; left for a separate tool.
#   - Free-text descriptions of orphan directories — explicitly generative.
set -euo pipefail

DEV_DIR="$HOME/Dev"
JSON_OUTPUT="false"
TARGET_PATH=""

for arg in "$@"; do
  case "$arg" in
    --json)
      JSON_OUTPUT="true"
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [path] [--json]"
      exit 0
      ;;
    *)
      TARGET_PATH="$arg"
      ;;
  esac
done

if [ -n "$TARGET_PATH" ]; then
  if [ ! -d "$TARGET_PATH" ]; then
    echo "Error: not a directory: $TARGET_PATH" >&2
    exit 1
  fi
fi

# Emits one JSON object (single line) describing the project at $1.
scan_project() {
  local dir="$1"
  local name
  name="$(basename "$dir")"

  local is_git="false"
  local remote_url=""
  local github_repo_name=""
  local owned_by_user="false"
  local branch=""
  local last_commit_date=""
  local last_commit_message=""
  local dirty="false"
  local untracked_count="0"

  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    is_git="true"

    local remote=""
    remote="$(git -C "$dir" remote get-url origin 2>/dev/null)" || true
    if [ -n "$remote" ]; then
      remote_url="$remote"
      if [[ "$remote" == *"github.com"* ]]; then
        local repo_name
        repo_name="${remote##*/}"
        repo_name="${repo_name%.git}"
        github_repo_name="$repo_name"
        if [[ "$remote" == *"github.com/{github-username}/"* || "$remote" == *"github.com:{github-username}/"* ]]; then
          owned_by_user="true"
        fi
      fi
    fi

    local current_branch=""
    current_branch="$(git -C "$dir" branch --show-current 2>/dev/null)" || true
    branch="$current_branch"

    local log_line=""
    log_line="$(git -C "$dir" log -1 --format='%cI|%s' 2>/dev/null)" || true
    if [ -n "$log_line" ]; then
      last_commit_date="${log_line%%|*}"
      last_commit_message="${log_line#*|}"
    fi

    local status_out=""
    status_out="$(git -C "$dir" status --porcelain 2>/dev/null)" || true
    if [ -n "$status_out" ]; then
      dirty="true"
    fi

    local untracked_out=""
    untracked_out="$(git -C "$dir" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')" || true
    if [ -n "$untracked_out" ]; then
      untracked_count="$untracked_out"
    fi
  fi

  local has_readme="false"
  local has_claude_md="false"
  local has_readme_frontmatter="false"
  local has_license="false"
  [ -f "$dir/README.md" ] && has_readme="true"
  [ -f "$dir/CLAUDE.md" ] && has_claude_md="true"
  # README frontmatter (decision M12, Layer 2 of the portfolio manifest system):
  # a leading `---` line followed by a `name:` key before the closing `---`.
  if [ "$has_readme" = "true" ] && [ "$(head -1 "$dir/README.md" 2>/dev/null)" = "---" ]; then
    if awk 'NR==1{next} /^---$/{exit} /^name:/{found=1} END{exit !found}' "$dir/README.md" 2>/dev/null; then
      has_readme_frontmatter="true"
    fi
  fi
  [ -f "$dir/LICENSE" ] && has_license="true"

  local stack=()
  if [ -f "$dir/package.json" ]; then
    stack+=("node")
    if grep -q '"next"' "$dir/package.json" 2>/dev/null; then
      stack+=("nextjs")
    fi
    if grep -q '"astro"' "$dir/package.json" 2>/dev/null; then
      stack+=("astro")
    fi
    if grep -q '"vite"' "$dir/package.json" 2>/dev/null; then
      stack+=("vite")
    fi
  fi
  [ -f "$dir/requirements.txt" ] && stack+=("python-requirements")
  [ -f "$dir/pyproject.toml" ] && stack+=("python-pyproject")
  [ -f "$dir/setup.py" ] && stack+=("python-setup")
  [ -f "$dir/netlify.toml" ] && stack+=("deploy:netlify")
  [ -f "$dir/vercel.json" ] && stack+=("deploy:vercel")
  [ -f "$dir/wrangler.toml" ] && stack+=("deploy:cloudflare")

  local stack_json="[]"
  if [ "${#stack[@]}" -gt 0 ]; then
    stack_json="$(printf '%s\n' "${stack[@]}" | jq -R . | jq -s -c .)"
  fi

  jq -n -c \
    --arg name "$name" \
    --arg path "$dir" \
    --argjson is_git "$is_git" \
    --arg remote_url "$remote_url" \
    --arg github_repo_name "$github_repo_name" \
    --argjson owned_by_user "$owned_by_user" \
    --arg branch "$branch" \
    --arg last_commit_date "$last_commit_date" \
    --arg last_commit_message "$last_commit_message" \
    --argjson dirty "$dirty" \
    --argjson untracked_count "$untracked_count" \
    --argjson has_readme "$has_readme" \
    --argjson has_claude_md "$has_claude_md" \
    --argjson has_readme_frontmatter "$has_readme_frontmatter" \
    --argjson has_license "$has_license" \
    --argjson stack "$stack_json" \
    '{
      name: $name,
      path: $path,
      is_git: $is_git,
      remote_url: (if $remote_url == "" then null else $remote_url end),
      github_repo_name: (if $github_repo_name == "" then null else $github_repo_name end),
      owned_by_user: $owned_by_user,
      branch: (if $branch == "" then null else $branch end),
      last_commit_date: (if $last_commit_date == "" then null else $last_commit_date end),
      last_commit_message: (if $last_commit_message == "" then null else $last_commit_message end),
      dirty: $dirty,
      untracked_count: $untracked_count,
      has_readme: $has_readme,
      has_claude_md: $has_claude_md,
      has_readme_frontmatter: $has_readme_frontmatter,
      has_license: $has_license,
      stack: $stack
    }'
}

# Prints one project block in human-readable form, given its JSON object.
print_readable() {
  local json="$1"
  local name path is_git remote_url github_repo_name owned_by_user branch
  local last_commit_date last_commit_message dirty untracked_count
  local has_readme has_claude_md has_readme_frontmatter has_license stack

  name="$(jq -r '.name' <<<"$json")"
  path="$(jq -r '.path' <<<"$json")"
  is_git="$(jq -r '.is_git' <<<"$json")"
  remote_url="$(jq -r '.remote_url // "none"' <<<"$json")"
  github_repo_name="$(jq -r '.github_repo_name // "n/a"' <<<"$json")"
  owned_by_user="$(jq -r '.owned_by_user' <<<"$json")"
  branch="$(jq -r '.branch // "n/a"' <<<"$json")"
  last_commit_date="$(jq -r '.last_commit_date // "n/a"' <<<"$json")"
  last_commit_message="$(jq -r '.last_commit_message // "n/a"' <<<"$json")"
  dirty="$(jq -r '.dirty' <<<"$json")"
  untracked_count="$(jq -r '.untracked_count' <<<"$json")"
  has_readme="$(jq -r '.has_readme' <<<"$json")"
  has_claude_md="$(jq -r '.has_claude_md' <<<"$json")"
  has_readme_frontmatter="$(jq -r '.has_readme_frontmatter' <<<"$json")"
  has_license="$(jq -r '.has_license' <<<"$json")"
  stack="$(jq -r '.stack | join(", ")' <<<"$json")"
  [ -z "$stack" ] && stack="none"

  echo "## $name"
  echo "  path: $path"
  if [ "$is_git" = "true" ]; then
    echo "  git: yes (branch: $branch, $( [ "$dirty" = "true" ] && echo dirty || echo clean ), untracked: $untracked_count)"
    echo "  remote: $remote_url (github repo: $github_repo_name, owned by {github-username}: $owned_by_user)"
    echo "  last commit: $last_commit_date | $last_commit_message"
  else
    echo "  git: no"
  fi
  echo "  docs: README=$has_readme CLAUDE.md=$has_claude_md README-frontmatter=$has_readme_frontmatter LICENSE=$has_license"
  echo "  stack: $stack"
  echo ""
}

main() {
  local project_dirs=()

  if [ -n "$TARGET_PATH" ]; then
    project_dirs=("$TARGET_PATH")
  else
    while IFS= read -r -d '' dir; do
      project_dirs+=("$dir")
    done < <(find "$DEV_DIR" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -print0 | sort -z)
  fi

  local results=()
  local dir
  for dir in "${project_dirs[@]}"; do
    results+=("$(scan_project "$dir")")
  done

  if [ "$JSON_OUTPUT" = "true" ]; then
    local scanned_at
    scanned_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    printf '%s\n' "${results[@]}" | jq -s \
      --arg scanned_at "$scanned_at" \
      --arg dev_directory "$DEV_DIR" \
      '{scanned_at: $scanned_at, dev_directory: $dev_directory, project_count: length, projects: .}'
  else
    echo "Dev Scanner Report"
    echo "Scan date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "Scanned: ${TARGET_PATH:-$DEV_DIR}"
    echo "Total projects: ${#results[@]}"
    echo ""
    for json in "${results[@]}"; do
      print_readable "$json"
    done
  fi
}

main
