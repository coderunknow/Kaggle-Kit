#!/usr/bin/env python3
"""Validate the artifacts of a release before and after they are published.

The validator refuses a release that contains a missing, empty, unexpected or
corrupt asset. It checks the artifacts against the manifest, against the
checksum file and against the source of the release commit, so that a release
can only contain files that belong to it.

    python3 tools/validate_release.py --stage release --version 0.1.0-dev2 \\
        --tag v0.1.0-dev2 --source-sha <sha> [--downloaded downloaded]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

REQUIRED_SUFFIXES = ("-notebook.ipynb", "-app.zip", "-source.zip")
FIXED_FILES = ("manifest.json", "SHA256SUMS", "verification-report.json")

# A file that must never be part of a release.
FORBIDDEN_NAMES = (
    ".env",
    ".env.local",
    "api_key.txt",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
    "server-state.json",
)
FORBIDDEN_SUFFIXES = (".gguf", ".gguf.part", ".key", ".pem", ".p12", ".tar.gz", ".bin")
FORBIDDEN_DIRECTORIES = ("node_modules/", ".git/", ".data/", "__pycache__/")

# A literal secret in a text file. The value of an assignment only counts as
# a secret when it looks like a random token: a test fixture such as
# "test-key-not-to-be-persisted" is not a secret.
SECRET_ASSIGNMENT = re.compile(
    r"""(?i)(?:api[_-]?key|access[_-]?token|secret|password)\s*=\s*["']([^"'\n]{16,})["']"""
)
SECRET_BEARER = re.compile(r"(?i)bearer\s+([A-Za-z0-9_\-]{16,})")
SECRET_SK = re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}")
SECRET_PRIVATE_KEY = re.compile(r"^-----BEGIN [A-Z ]*PRIVATE KEY-----", re.MULTILINE)


def looks_like_a_token(value: str) -> bool:
    """True when the value looks like a random token and not like a word."""
    if len(value) < 32:
        # A real key of this project is 43 characters long (secrets.token_urlsafe
        # of 32 bytes). Shorter values are examples of a documentation or a
        # test, not a key.
        return False
    if not re.fullmatch(r"[A-Za-z0-9_\-=+/]+", value):
        return False
    if not (
        any(character.isdigit() for character in value)
        and any(character.isupper() for character in value)
        and any(character.islower() for character in value)
    ):
        return False
    counts = Counter(value)
    entropy = -sum(
        (number / len(value)) * math.log2(number / len(value)) for number in counts.values()
    )
    return entropy >= 3.5

# A public Quick Tunnel URL of a real session must not be part of a release.
TUNNEL_PATTERN = re.compile(r"https://[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\.trycloudflare\.com")


class ValidationError(Exception):
    """A problem that makes the release invalid."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_no_secrets(name: str, data: bytes, problems: list) -> None:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return
    for pattern in (SECRET_ASSIGNMENT, SECRET_BEARER, SECRET_SK):
        for match in pattern.finditer(text):
            value = match.group(1) if match.lastindex else match.group(0)
            if looks_like_a_token(value):
                problems.append(f"{name}: the file contains something that looks like a secret")
                return
    if SECRET_PRIVATE_KEY.search(text):
        problems.append(f"{name}: the file contains a private key")
        return
    if TUNNEL_PATTERN.search(text):
        problems.append(f"{name}: the file contains a Quick Tunnel URL")


def check_archive_names(name: str, members: list, problems: list) -> None:
    for member in members:
        base = member.rsplit("/", 1)[-1]
        if base in FORBIDDEN_NAMES:
            problems.append(f"{name}: the archive contains {member}")
            continue
        if any(member.endswith(suffix) for suffix in FORBIDDEN_SUFFIXES):
            problems.append(f"{name}: the archive contains {member}")
            continue
        if any(directory in member for directory in FORBIDDEN_DIRECTORIES):
            problems.append(f"{name}: the archive contains {member}")


def read_checksums(path: Path, problems: list) -> dict:
    checksums = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        parts = line.split("  ", 1)
        if len(parts) != 2 or len(parts[0]) != 64:
            problems.append(f"{path.name}: line {number} is not a valid checksum line")
            continue
        checksums[parts[1]] = parts[0]
    return checksums


def validate(stage: Path, version: str, tag: str, source_sha: str, downloaded: Path | None) -> list:
    problems: list = []
    notes: list = []

    expected = {f"{tag}{suffix}" for suffix in REQUIRED_SUFFIXES} | set(FIXED_FILES)
    present = {path.name for path in stage.iterdir() if path.is_file()}
    for name in sorted(expected - present):
        problems.append(f"the release is missing {name}")
    for name in sorted(present - expected):
        problems.append(f"the release contains the unexpected file {name}")

    for path in sorted(stage.iterdir()):
        if path.is_file() and path.stat().st_size == 0:
            problems.append(f"{path.name} is empty")

    if problems:
        return problems

    # 1. The checksum file covers every file of the release except itself.
    checksums = read_checksums(stage / "SHA256SUMS", problems)
    expected_covered = present - {"SHA256SUMS"}
    if set(checksums) != expected_covered:
        missing = sorted(expected_covered - set(checksums))
        extra = sorted(set(checksums) - expected_covered)
        if missing:
            problems.append(f"SHA256SUMS does not cover {', '.join(missing)}")
        if extra:
            problems.append(f"SHA256SUMS covers unknown files: {', '.join(extra)}")
    for name, expected_sum in sorted(checksums.items()):
        actual = sha256_of(stage / name)
        if actual != expected_sum:
            problems.append(f"{name} does not match the checksum in SHA256SUMS")

    # 2. The manifest describes the release.
    manifest = json.loads((stage / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != version:
        problems.append(f"the manifest names the version {manifest.get('version')}")
    if manifest.get("tag") != tag:
        problems.append(f"the manifest names the tag {manifest.get('tag')}")
    if manifest.get("sourceCommit") != source_sha:
        problems.append(f"the manifest names the commit {manifest.get('sourceCommit')}")
    listed = {entry.get("name"): entry for entry in manifest.get("artifacts", [])}
    expected_listed = expected_covered - {"manifest.json"}
    if set(listed) != expected_listed:
        problems.append(
            "the manifest does not describe exactly the assets of the release: "
            f"{sorted(set(listed) ^ expected_listed)}"
        )
    for name, entry in sorted(listed.items()):
        path = stage / name
        if not path.is_file():
            continue
        if entry.get("size") != path.stat().st_size:
            problems.append(f"the manifest has the wrong size for {name}")
        if entry.get("sha256") != sha256_of(path):
            problems.append(f"the manifest has the wrong checksum for {name}")
    if not manifest.get("build", {}).get("commands"):
        problems.append("the manifest does not list the build commands")
    if not manifest.get("requirements"):
        problems.append("the manifest does not list the platform requirements")

    # 3. The report documents the checks of the release.
    report = json.loads((stage / "verification-report.json").read_text(encoding="utf-8"))
    if report.get("sourceCommit") != source_sha:
        problems.append(f"the report names the commit {report.get('sourceCommit')}")
    if report.get("version") != version:
        problems.append(f"the report names the version {report.get('version')}")
    commands = report.get("commands") or []
    if not commands:
        problems.append("the report does not contain any command")
    for command in commands:
        if command.get("status") != "passed":
            problems.append(f"the report contains the failed check: {command.get('command')}")
    if not report.get("environments", {}).get("notTested"):
        problems.append("the report does not list the environments that were not tested")

    # 4. The notebook contains the deployment script of the release commit.
    notebook_path = stage / f"{tag}-notebook.ipynb"
    notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
    if not str(notebook.get("nbformat", "")).startswith("4"):
        problems.append("the notebook has an unexpected format")
    code = [
        "".join(cell.get("source", []))
        for cell in notebook.get("cells", [])
        if cell.get("cell_type") == "code"
    ]
    if len(code) != 1:
        problems.append("the notebook does not contain exactly one code cell")
    else:
        script = Path("notebooks/qwen3_8_27b_api.py")
        if not script.is_file():
            problems.append("the deployment script is missing in the checkout")
        elif code[0] != script.read_text(encoding="utf-8"):
            problems.append("the notebook does not match the deployment script of the release commit")
        else:
            notes.append("the notebook matches notebooks/qwen3_8_27b_api.py")

    # 5. The application bundle contains the build of the release commit.
    app_zip = stage / f"{tag}-app.zip"
    with zipfile.ZipFile(app_zip) as archive:
        members = archive.namelist()
        check_archive_names(app_zip.name, members, problems)
        for required in ("dist/client/index.html", "dist/server/index.js", "package.json", "README.md"):
            if required not in members:
                problems.append(f"the application bundle does not contain {required}")
        for member in members:
            if member.endswith("/"):
                continue
            check_no_secrets(f"{app_zip.name}:{member}", archive.read(member), problems)
    notes.append(f"the application bundle contains {len(members)} entries")

    # 6. The source archive contains the source of the release commit.
    source_zip = stage / f"{tag}-source.zip"
    with zipfile.ZipFile(source_zip) as archive:
        members = archive.namelist()
        check_archive_names(source_zip.name, members, problems)
        prefix = f"kaggle-kit-{version}/"
        for required in (
            "package.json",
            "README.md",
            "LICENSE",
            "notebooks/qwen3_8_27b_api.py",
            ".github/workflows/release.yml",
        ):
            if prefix + required not in members:
                problems.append(f"the source archive does not contain {required}")
        for member in members:
            if member.endswith("/"):
                continue
            check_no_secrets(f"{source_zip.name}:{member}", archive.read(member), problems)
    notes.append(f"the source archive contains {len(members)} entries")

    # 7. The release notes of this version are free of secrets.
    notes_file = Path(f"docs/release-notes/{version}.md")
    if not notes_file.is_file():
        problems.append(f"the release notes {notes_file} are missing")
    else:
        check_no_secrets(notes_file.name, notes_file.read_bytes(), problems)
        if "{{SOURCE_SHA}}" not in notes_file.read_text(encoding="utf-8"):
            problems.append(f"the release notes {notes_file} do not contain the commit placeholder")

    # 8. The downloaded assets are the ones that were built.
    if downloaded is not None:
        if not downloaded.is_dir():
            problems.append(f"the download directory {downloaded} does not exist")
        else:
            for name in sorted(expected):
                local = stage / name
                remote = downloaded / name
                if not remote.is_file():
                    problems.append(f"the published release does not contain {name}")
                    continue
                if sha256_of(remote) != sha256_of(local):
                    problems.append(f"the published {name} differs from the built one")
                else:
                    notes.append(f"the published {name} matches the built one")
            extra = {path.name for path in downloaded.iterdir() if path.is_file()} - expected
            for name in sorted(extra):
                problems.append(f"the published release contains the unexpected asset {name}")

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--downloaded", type=Path, default=None)
    args = parser.parse_args()

    try:
        problems = validate(args.stage, args.version, args.tag, args.source_sha, args.downloaded)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"error: the release could not be validated: {error}", file=sys.stderr)
        return 1

    if problems:
        print("The release is invalid:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print(f"The release {args.tag} is valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
