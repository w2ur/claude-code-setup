# notify-on-exit.sh — sourced (not executed) by watch scripts whose exit 1 is a
# finding nobody would otherwise read: vigie drops exit 1 on the assumption the
# job already reported it, so a watcher that never pushes is a silent one.
#
# Opt-in through WATCH_NOTIFY=1, set in the job's plist only. Manual runs and
# vigie's daily --json collectors call the same scripts and must not push.
#
# The notifier topic is PUBLIC: the body carries the job name and exit code
# only, never a path, a repo or a finding's text.
#
# Usage, right after the script's `set` line:
#   . "$(dirname "$0")/notify-on-exit.sh"; watch_notify_on_exit <job-name>
# NOTIFIER_BIN overrides the notifier (tests).

. "$(dirname "${BASH_SOURCE[0]}")/push-text.sh"

watch_notify_on_exit() {
  [ "${WATCH_NOTIFY:-0}" = 1 ] || return 0
  WATCH_NOTIFY_JOB="$1"
  trap '_watch_notify "$?"' EXIT
}

_watch_notify() {
  local rc="$1" what
  [ "$rc" -eq 0 ] && return 0
  # 1 is the only "finding". 2, a set -e crash (jq 5, curl 6, 127) or a
  # signal all mean the run did not complete: state unknown.
  what="could not run, state unknown"
  [ "$rc" -eq 1 ] && what="a finding"
  push_text "$WATCH_NOTIFY_JOB: exit $rc" "$WATCH_NOTIFY_JOB exited $rc: $what. Detail in its log."
}
