#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
#
# icloud-host.py — run a scheduled job as a child of this Python process, so
# the job can reach iCloud Drive.
#
# Why it exists (measured 2026-11-07 with one-shot LaunchAgents): under launchd,
# macOS lets a job LIST a directory in iCloud Drive only when the binary
# itself, or the process launchd started, holds the privacy grant. /bin/bash
# holds none, so in a bash script launched directly, `ls` and `rsync` get
# "Operation not permitted" on iCloud directories — dev-snapshot failed every
# night from 2026-10-15 that way. (Writing to a known path still works: the
# same night db-backup's `mv` into iCloud succeeded.) uv's Python holds the
# grant; started through this file, the same script and the same tools list
# iCloud Drive. The control: the identical probe launched without this host
# was refused in the same minute.
#
# If a uv Python upgrade loses the grant, the hosted job fails loudly with its
# own exit code again; it does not go silent.
#
# Contract: argv[1:] is the command. Its stdout/stderr are inherited, its exit
# status is returned as-is (128+n when a signal killed it), SIGTERM/SIGINT/
# SIGHUP sent to the host are forwarded to it — launchd stops a job by
# signalling the process it started, which is this one. No command, or a
# command that cannot be launched, is exit 2: could not run.
import signal
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("icloud-host: usage: icloud-host.py <command> [args...]", file=sys.stderr)
        return 2
    # Handlers go in BEFORE the child exists: a signal landing between Popen
    # and their installation would kill the host and orphan the child. One
    # that arrives first is held and delivered as soon as the child exists.
    child = None
    pending = []

    def forward(signum, _frame):
        if child is None:
            pending.append(signum)
        else:
            child.send_signal(signum)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)

    try:
        child = subprocess.Popen(sys.argv[1:])
    except OSError as exc:
        print(f"icloud-host: cannot launch {sys.argv[1]}: {exc}", file=sys.stderr)
        return 2
    for signum in pending:
        child.send_signal(signum)

    rc = child.wait()
    return 128 - rc if rc < 0 else rc


if __name__ == "__main__":
    sys.exit(main())
