#!/usr/bin/env python3
"""Write the machine readable verification report of a release.

The report contains the commands that were executed before the release, their
results, the commit the artifacts were built from and the environments that
were tested and the ones that were not. It is generated from the result file
of ``tools/run_checks.py``, so it documents the checks instead of claiming
that they passed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tool_versions() -> dict:
    def version(command: list) -> str:
        try:
            completed = subprocess.run(command, capture_output=True, text=True, check=False)
        except OSError:
            return "unknown"
        output = (completed.stdout or "").strip() or (completed.stderr or "").strip()
        return output.splitlines()[0] if output else "unknown"

    return {
        "node": version(["node", "--version"]),
        "npm": version(["npm", "--version"]),
        "python": version(["python3", "--version"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True, type=Path)
    parser.add_argument("--checks", required=True, type=Path)
    parser.add_argument("--environment", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if not args.checks.is_file():
        print(f"error: {args.checks} does not exist", file=sys.stderr)
        return 1
    if not args.environment.is_file():
        print(f"error: {args.environment} does not exist", file=sys.stderr)
        return 1

    checks = json.loads(args.checks.read_text(encoding="utf-8"))
    environment = json.loads(args.environment.read_text(encoding="utf-8"))

    failed = [entry for entry in checks if entry.get("status") != "passed"]
    if failed:
        print("error: not every check passed, the report would be wrong", file=sys.stderr)
        return 1

    artifacts = []
    for path in sorted(args.stage.iterdir()):
        if not path.is_file() or path.name in {"manifest.json", "SHA256SUMS"}:
            continue
        artifacts.append(
            {
                "name": path.name,
                "size": path.stat().st_size,
                "sha256": sha256_of(path),
            }
        )

    report = {
        "name": "Kaggle-Kit",
        "version": args.version,
        "tag": args.tag,
        "sourceCommit": args.source_sha,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "workflow": ".github/workflows/release.yml",
        "toolchain": tool_versions(),
        "commands": checks,
        "artifactsBuiltBeforeThisReport": artifacts,
        "environments": {
            "tested": environment["tested"],
            "notTested": environment["notTested"],
        },
        "notes": [
            "The checks of this report ran against stubs and a mock upstream.",
            "They are not a verification of a real service, a real model or a real browser.",
            "manifest.json and SHA256SUMS are the authority for the checksums of the assets.",
        ],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
