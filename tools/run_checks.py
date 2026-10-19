#!/usr/bin/env python3
"""Run the release checks and record their results.

The checks are executed one after the other. Every check is recorded with its
command, its exit code, its duration and the tail of its output, so that the
verification report of a release contains the exact commands that were run
instead of a claim that something was tested.

The script exits with a non zero exit code as soon as a check fails.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

TAIL_LINES = 20


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="the json file with the results")
    parser.add_argument("--command", action="append", default=[], help="a command to run, repeatable")
    args = parser.parse_args()

    if not args.command:
        print("error: no --command was given", file=sys.stderr)
        return 2

    results = []
    failed = False
    for command in args.command:
        print(f"--- {command}", flush=True)
        started = time.monotonic()
        completed = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            check=False,
        )
        duration = time.monotonic() - started
        output = (completed.stdout or "") + (completed.stderr or "")
        lines = [line for line in output.splitlines() if line.strip()]
        entry = {
            "command": command,
            "exitCode": completed.returncode,
            "status": "passed" if completed.returncode == 0 else "failed",
            "durationSeconds": round(duration, 2),
            "outputTail": lines[-TAIL_LINES:],
        }
        results.append(entry)
        status = "passed" if completed.returncode == 0 else "FAILED"
        print(f"--- {command}: {status} in {duration:.1f}s", flush=True)
        if completed.returncode != 0:
            failed = True
            print("\n".join(lines[-TAIL_LINES:]), file=sys.stderr, flush=True)
            break

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
