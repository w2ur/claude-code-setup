# push-text.sh — sourced (not executed): the one wrapper that turns a text into
# a notifier.sh call. notifier.sh reads its body from a file; every job used to
# carry its own mktemp → notifier → rm copy of this.
#
# The topic is PUBLIC: callers pass counts and job names, never a path, a repo,
# an employer or a finding's text.
#
#   push_text <title> <body text> [priority]   # no priority: notifier's default
#
# NOTIFIER_BIN overrides the notifier (tests). A missing notifier or a failed
# push never fails the caller: a notification is a report, not the job. It is
# not silent either: one stderr line ("push_text: notifier missing", "push_text:
# mktemp failed", "push_text: notifier failed rc=N") lands in the job's log.

# The notifier push_text calls. An unattended job that must not run with every
# alert lost checks this path (exists and executable) instead of re-deriving it.
push_text_notifier() { printf '%s' "${NOTIFIER_BIN:-${HOME:-}/.claude/scripts/notifier.sh}"; }

push_text() {
  local notifier body rc=0
  notifier="$(push_text_notifier)"
  [ -x "$notifier" ] || { echo "push_text: notifier missing" >&2 || true; return 0; }
  body="$(mktemp 2>/dev/null)" || { echo "push_text: mktemp failed" >&2 || true; return 0; }
  printf '%s\n' "$2" > "$body" 2>/dev/null || true
  if [ -n "${3:-}" ]; then
    "$notifier" "$1" "$body" --priorite "$3" >/dev/null 2>&1 || rc=$?
  else
    "$notifier" "$1" "$body" >/dev/null 2>&1 || rc=$?
  fi
  [ "$rc" -eq 0 ] || echo "push_text: notifier failed rc=$rc" >&2 || true
  rm -f "$body"
  return 0
}
