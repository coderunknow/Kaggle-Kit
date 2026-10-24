"""Regression tests for GitHub Actions shell-injection boundaries.

The release workflow once interpolated the (untrusted) tag input directly
into a `run:` script before validating it:

    TAG="${{ github.event.inputs.tag || github.ref_name }}"

An expression result containing a quote could break out of the assignment
and execute arbitrary shell before the format check ever ran. These tests
pin the fixed shape:

* no `${{ ... }}` expression may appear inside any `run:` block of any
  workflow (data must flow through `env:` instead),
* every third-party action is pinned to a full-length commit SHA,
* the tag validation the workflow performs rejects hostile values without
  executing them, even when the value is passed as environment data.

Run with: python3 -m unittest discover -s tools -p "test_*.py"
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
VERSION_TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$")


def run_blocks(text: str) -> list[str]:
    """Extract the literal body of every `run:` block (indentation based)."""
    blocks: list[str] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        match = re.match(r"^(\s*)run:\s*(\|.*)?$", line)
        if match:
            indent = len(match.group(1))
            body: list[str] = []
            index += 1
            while index < len(lines):
                current = lines[index]
                if current.strip() == "":
                    body.append(current)
                    index += 1
                    continue
                current_indent = len(current) - len(current.lstrip(" "))
                if current_indent <= indent:
                    break
                body.append(current)
                index += 1
            blocks.append("\n".join(body))
            continue
        single = re.match(r"^\s*run:\s+(.+)$", line)
        if single:
            blocks.append(single.group(1))
        index += 1
    return blocks


class WorkflowInjectionBoundary(unittest.TestCase):
    def test_workflows_exist(self) -> None:
        self.assertGreaterEqual(len(WORKFLOWS), 2)

    def test_no_expression_interpolation_inside_run_blocks(self) -> None:
        for workflow in WORKFLOWS:
            text = workflow.read_text(encoding="utf-8")
            for block in run_blocks(text):
                self.assertNotIn(
                    "${{",
                    block,
                    f"{workflow.name} interpolates a GitHub expression into "
                    f"shell source:\n{block}",
                )

    def test_release_tag_arrives_as_environment_data(self) -> None:
        text = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        self.assertIn("RAW_TAG: ${{ github.event.inputs.tag || github.ref_name }}", text)
        self.assertIn('TAG="$RAW_TAG"', text)
        # The format validation must happen before the tag is used in git.
        self.assertLess(text.index("grep -Eq"), text.index("git rev-list"))

    def test_actions_are_pinned_to_commit_shas(self) -> None:
        for workflow in WORKFLOWS:
            text = workflow.read_text(encoding="utf-8")
            for _match in re.finditer(r"uses:\s+([^\s#]+)", text):
                reference = _match.group(1)
                self.assertRegex(
                    reference,
                    r"@[0-9a-f]{40}$",
                    f"{workflow.name} uses an unpinned action: {reference}",
                )

    def test_release_permissions_stay_least_privilege(self) -> None:
        release = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("contents: write", release)
        self.assertNotIn("pull-requests: write", release)
        self.assertIn("contents: read", ci)

    def test_nightly_version_line_executes(self) -> None:
        """Regression (confirmed 2026-10-24): the nightly metadata step failed
        on every scheduled run with `syntax error near unexpected token '('`
        because the version read was written with backslash-escaped quotes,
        `node -p \\"require(...)\\"`, inside the command substitution. GitHub
        passes the literal block to bash, which rejects that shape before any
        later step can run. The exact lines from the workflow must execute."""
        nightly = (ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8")
        self.assertNotIn('\\"', nightly, "escaped quotes inside a run: block break bash parsing")
        lines = [line.strip() for line in nightly.splitlines() if "node -p" in line]
        self.assertEqual(len(lines), 2, "both nightly jobs resolve the version")
        expected = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
        for line in lines:
            result = subprocess.run(
                ["bash", "-c", f"{line}\nprintf '%s' \"$VERSION\""],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout, expected)

    def test_nightly_workflow_has_expected_schedule_and_tag_shape(self) -> None:
        nightly = (ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8")
        self.assertIn("cron: '0 19 * * *'", nightly)
        self.assertIn("02:00 in Asia/Ho_Chi_Minh", nightly)
        self.assertIn("nightly-${DATE_LOCAL}-${RUN_ID}-${RUN_ATTEMPT}", nightly)

    def test_nightly_permissions_are_scoped(self) -> None:
        nightly = (ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8")
        self.assertIn("permissions:\n  contents: read", nightly)
        self.assertIn("publish:\n", nightly)
        self.assertIn("permissions:\n      contents: write", nightly)

    def test_tag_regex_rejects_hostile_values(self) -> None:
        hostile = [
            'v1.2.3"; touch PWNED; echo "',
            "$(touch PWNED)",
            "`touch PWNED`",
            "v1.2.3\nversion=pwned",
            "v1.2.3$(touch PWNED)",
            "v1.2.3; echo x >> GITHUB_OUTPUT",
            "../v1.2.3",
            "v1.2.3/../../etc",
            "1.2.3",
            "v1.2",
            "v1.2.3 ",
            " v1.2.3",
            "",
        ]
        for value in hostile:
            self.assertIsNone(VERSION_TAG.match(value), repr(value))
        for value in ["v0.1.0-dev4", "v1.2.3", "v10.20.30-rc.1"]:
            self.assertIsNotNone(VERSION_TAG.match(value), value)

    def test_hostile_tag_cannot_execute_through_the_env_boundary(self) -> None:
        """Run the workflow's exact assignment+validation shape with hostile data."""
        hostile = 'v1.2.3"; touch PWNED; echo "'
        script = (
            "set -euo pipefail\n"
            'TAG="$RAW_TAG"\n'
            "if ! printf '%s' \"$TAG\" | grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then\n"
            "  exit 1\n"
            "fi\n"
            "echo release-would-proceed\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                ["bash", "-c", script],
                cwd=directory,
                env={"PATH": "/usr/bin:/bin", "RAW_TAG": hostile},
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertNotIn("release-would-proceed", result.stdout)
            self.assertFalse(
                (Path(directory) / "PWNED").exists(),
                "hostile tag executed a shell command",
            )

            ok = subprocess.run(
                ["bash", "-c", script],
                cwd=directory,
                env={"PATH": "/usr/bin:/bin", "RAW_TAG": "v0.1.0-dev5"},
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            self.assertIn("release-would-proceed", ok.stdout)


if __name__ == "__main__":
    unittest.main()
