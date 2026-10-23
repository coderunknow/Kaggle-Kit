#!/usr/bin/env python3
"""Write the manifest and the checksum file of a release.

``manifest.json`` lists every asset of the release with its size, its SHA-256
checksum, the commit it was built from and the requirements of the platform.
``SHA256SUMS`` contains the checksums in the format of ``sha256sum`` and
covers every file of the release except itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# The manifest and the checksum file are not part of their own listings.
SELF_REFERENCES = {"manifest.json", "SHA256SUMS"}

BUILD_COMMANDS = [
    "npm ci",
    "npm run typecheck",
    "npm run lint",
    "npm test",
    "npm run build",
    "npm run check:integration",
    "python3 -m unittest discover -s notebooks -p 'test_*.py'",
    "python3 -m unittest discover -s tools -p 'test_*.py'",
]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe(name: str) -> dict:
    descriptions = {
        "notebook": "The Kaggle notebook with the deployment cell of the tagged commit.",
        "app": "The production build: the client, the bundled backend and the instructions to run it.",
        "source": "The source of the tagged commit.",
    }
    for kind, description in descriptions.items():
        if f"-{kind}." in name:
            return {"type": kind, "description": description}
    return {"type": "report", "description": "The machine readable verification report of the release."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--checksums", required=True, type=Path)
    args = parser.parse_args()

    if not args.stage.is_dir():
        print(f"error: {args.stage} is not a directory", file=sys.stderr)
        return 1

    files = sorted(
        path for path in args.stage.iterdir() if path.is_file() and path.name not in SELF_REFERENCES
    )
    if not files:
        print(f"error: {args.stage} does not contain any artifact", file=sys.stderr)
        return 1

    artifacts = []
    for path in files:
        entry = {"name": path.name, "size": path.stat().st_size, "sha256": sha256_of(path)}
        entry.update(describe(path.name))
        artifacts.append(entry)

    manifest = {
        "name": "Kaggle-Kit",
        "version": args.version,
        "tag": args.tag,
        "sourceCommit": args.source_sha,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "build": {
            "workflow": ".github/workflows/release.yml",
            "commands": BUILD_COMMANDS,
            "platform": f"{platform.system().lower()}-{platform.machine()}",
            "node": subprocess.run(
                ["node", "--version"], capture_output=True, text=True, check=False
            ).stdout.strip(),
            "python": platform.python_version(),
        },
        "requirements": {
            # The minimum has to match the contract the application actually
            # enforces: package.json engines.node and the launcher's
            # DEFAULT_NODE_REQUIREMENT (tools/launcher.mjs). test_release_tools
            # fails when the strings drift apart.
            "application": "Node.js 20.19 or newer, the application bundle has no runtime dependencies.",
            "notebook": "Kaggle GPU runtime, Python 3.11 and the requests package.",
            "platform": "Linux x64 for the release artifacts.",
        },
        "artifacts": artifacts,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # The checksum file covers every file of the release except itself.
    covered = sorted(path for path in args.stage.iterdir() if path.is_file() and path.name != "SHA256SUMS")
    lines = [f"{sha256_of(path)}  {path.name}" for path in covered]
    args.checksums.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"wrote {args.output} and {args.checksums} for {len(covered)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
