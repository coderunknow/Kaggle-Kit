"""Regression tests for workflow shell boundaries and publication gates.

The release workflow formerly interpolated an untrusted tag into shell source.
These tests also model the exact GitHub Actions publisher `if` expressions so
schedule, ordinary pushes/PRs, and dispatches without explicit boolean opt-in
cannot reach publication. They inspect the actual workflow jobs and commands;
they do not dispatch workflows or call GitHub's publication APIs.
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
PUBLISH_COMMAND = re.compile(
    r"\bgh\s+release\b"
    r"|\bgh\s+api\b"
    r"|\b(?:npm|pnpm)\s+publish\b"
    r"|\bdocker\s+push\b"
    r"|\bgit\s+(?:push|tag)\b"
    r"|\bvercel\s+deploy\b"
    r"|\bwrangler\s+deploy\b"
    r"|\bkubectl\s+apply\b"
    r"|uses:\s*(?:actions/upload-artifact|actions/upload-pages-artifact|actions/create-release|actions/upload-release-asset|actions/deploy-pages|softprops/action-gh-release|docker/build-push-action|peaceiris/actions-gh-pages|JamesIves/github-pages-deploy-action)\b"
)


def mapping_block_span(text: str, key: str, indent: int) -> tuple[str, int, int]:
    """Return a simple YAML mapping block and its [start, end) source offsets."""
    lines = text.splitlines(keepends=True)
    offsets: list[int] = []
    cursor = 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line)
    start = next(
        (
            index
            for index, line in enumerate(lines)
            if re.fullmatch(rf" {{0,{indent}}}{re.escape(key)}:\s*", line.rstrip("\r\n"))
            and len(line) - len(line.lstrip(" ")) == indent
        ),
        None,
    )
    if start is None:
        raise AssertionError(f"Missing YAML mapping {key!r} at indent {indent}")
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if not line.strip():
            continue
        current_indent = len(line) - len(line.lstrip(" "))
        if current_indent <= indent:
            end = index
            break
    start_offset = offsets[start]
    end_offset = offsets[end] if end < len(lines) else len(text)
    return text[start_offset:end_offset], start_offset, end_offset


def mapping_block(text: str, key: str, indent: int) -> str:
    """Return a simple YAML mapping block, identified by key and indentation."""
    return mapping_block_span(text, key, indent)[0]


def without_yaml_comments(text: str) -> str:
    """Drop whole-line YAML comments before checking executable commands."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


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


def workflow_job_span(text: str, name: str) -> tuple[str, int, int]:
    jobs, jobs_start, _jobs_end = mapping_block_span(text, "jobs", 0)
    job, relative_start, relative_end = mapping_block_span(jobs, name, 2)
    return job, jobs_start + relative_start, jobs_start + relative_end


def workflow_job(text: str, name: str) -> str:
    return workflow_job_span(text, name)[0]


def workflow_dispatch_input(text: str, name: str) -> str:
    triggers = mapping_block(text, "on", 0)
    dispatch = mapping_block(triggers, "workflow_dispatch", 2)
    inputs = mapping_block(dispatch, "inputs", 4)
    return mapping_block(inputs, name, 6)


def job_condition(text: str, name: str) -> str:
    block = workflow_job(text, name)
    match = re.search(r"^    if:\s*(.+?)\s*$", block, flags=re.MULTILINE)
    if not match:
        raise AssertionError(f"Publisher job {name!r} has no job-level `if` guard")
    return match.group(1)


_TOKEN = re.compile(
    r"\s*(\&\&|\|\||==|startsWith|github\.event_name|github\.ref|"
    r"inputs\.[A-Za-z_][A-Za-z0-9_]*|true|false|\(|\)|,|'[^']*'|\"[^\"]*\")"
)


def evaluate_actions_condition(
    source: str,
    *,
    event_name: str,
    ref: str = "",
    inputs: dict[str, object] | None = None,
) -> bool:
    """Evaluate the small, side-effect-free expression subset used by job gates."""
    tokens: list[str] = []
    position = 0
    while position < len(source):
        if source[position:].strip() == "":
            break
        match = _TOKEN.match(source, position)
        if not match:
            raise ValueError(f"Unsupported/malformed Actions expression near {source[position:]!r}")
        tokens.append(match.group(1))
        position = match.end()
    cursor = 0
    input_values = inputs or {}

    def peek() -> str | None:
        return tokens[cursor] if cursor < len(tokens) else None

    def take(expected: str | None = None) -> str:
        nonlocal cursor
        if cursor >= len(tokens):
            raise ValueError("Unexpected end of Actions expression")
        token = tokens[cursor]
        if expected is not None and token != expected:
            raise ValueError(f"Expected {expected!r}, got {token!r}")
        cursor += 1
        return token

    def value() -> object:
        token = take()
        if token == "github.event_name":
            return event_name
        if token == "github.ref":
            return ref
        if token.startswith("inputs."):
            return input_values.get(token.removeprefix("inputs."), False)
        if token == "true":
            return True
        if token == "false":
            return False
        if token.startswith("'") or token.startswith('"'):
            return token[1:-1]
        raise ValueError(f"Expected a value, got {token!r}")

    def primary() -> object:
        if peek() == "(":
            take("(")
            result = disjunction()
            take(")")
            return result
        if peek() == "startsWith":
            take("startsWith")
            take("(")
            source_value = value()
            take(",")
            prefix = value()
            take(")")
            return str(source_value).lower().startswith(str(prefix).lower())
        left = value()
        if peek() == "==":
            take("==")
            return left == value()
        raise ValueError("Expected equality comparison or startsWith()")

    def conjunction() -> bool:
        result = bool(primary())
        while peek() == "&&":
            take("&&")
            right = bool(primary())
            result = result and right
        return result

    def disjunction() -> bool:
        result = conjunction()
        while peek() == "||":
            take("||")
            right = conjunction()
            result = result or right
        return result

    result = disjunction()
    if cursor != len(tokens):
        raise ValueError(f"Unexpected trailing Actions tokens: {tokens[cursor:]!r}")
    return bool(result)


class WorkflowSecurityAndPublicationGates(unittest.TestCase):
    def test_workflows_exist(self) -> None:
        self.assertGreaterEqual(len(WORKFLOWS), 2)

    def test_no_expression_interpolation_inside_run_blocks(self) -> None:
        for workflow in WORKFLOWS:
            text = workflow.read_text(encoding="utf-8")
            for block in run_blocks(text):
                self.assertNotIn(
                    "${{",
                    block,
                    f"{workflow.name} interpolates a GitHub expression into shell source:\n{block}",
                )

    def test_release_tag_arrives_as_environment_data(self) -> None:
        text = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        dispatch_inputs = mapping_block(text, "inputs", 4)
        tag_input = mapping_block(dispatch_inputs, "tag", 6)
        self.assertRegex(tag_input, r"(?m)^\s+required:\s*true$")
        self.assertIn("RAW_TAG: ${{ github.event.inputs.tag || github.ref_name }}", text)
        self.assertIn('TAG="$RAW_TAG"', text)
        self.assertLess(text.index("grep -Eq"), text.index("git rev-list"))

    def test_actions_are_pinned_to_commit_shas(self) -> None:
        for workflow in WORKFLOWS:
            text = workflow.read_text(encoding="utf-8")
            for match in re.finditer(r"uses:\s+([^\s#]+)", text):
                reference = match.group(1)
                self.assertRegex(
                    reference,
                    r"@[0-9a-f]{40}$",
                    f"{workflow.name} uses an unpinned action: {reference}",
                )

    def test_workflow_and_publisher_permissions_are_scoped(self) -> None:
        for workflow_name, job_name in [("nightly-release.yml", "publish"), ("release.yml", "release")]:
            text = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
            self.assertRegex(text, r"(?m)^permissions:\n  contents: read\s*$")
            job = workflow_job(text, job_name)
            self.assertRegex(job, r"(?m)^    permissions:\n      contents: write\s*$")
            self.assertNotRegex(text, r"(?m)^permissions:\n  contents: write\s*$")
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertRegex(ci, r"(?m)^permissions:\n  contents: read\s*$")

    def test_nightly_schedule_runs_verification_only(self) -> None:
        text = (ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8")
        triggers = mapping_block(text, "on", 0)
        self.assertIn("cron: '0 19 * * *'", triggers)
        self.assertNotRegex(triggers, r"(?m)^  (push|pull_request|workflow_run):")
        verify = workflow_job(text, "verify")
        self.assertIn("Validate staged nightly artifacts", verify)
        self.assertIsNone(PUBLISH_COMMAND.search(verify), "scheduled verification job contains a publisher command")
        condition = job_condition(text, "publish")
        self.assertEqual(
            condition,
            "github.event_name == 'workflow_dispatch' && inputs.publish_nightly == true",
        )
        gate_input = workflow_dispatch_input(text, "publish_nightly")
        self.assertIn("type: boolean", gate_input)
        self.assertIn("default: false", gate_input)
        self.assertIn("required: false", gate_input)

    def test_nightly_publisher_event_matrix(self) -> None:
        text = (ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8")
        condition = job_condition(text, "publish")
        matrix = [
            ("scheduled event has no input", "schedule", {}, "", False),
            ("schedule cannot be enabled by a forged input", "schedule", {"publish_nightly": True}, "", False),
            ("manual default is false", "workflow_dispatch", {"publish_nightly": False}, "refs/heads/main", False),
            ("manual missing input is false", "workflow_dispatch", {}, "refs/heads/main", False),
            ("explicit manual opt-in", "workflow_dispatch", {"publish_nightly": True}, "refs/heads/main", True),
            ("branch push", "push", {"publish_nightly": True}, "refs/heads/main", False),
            ("tag push", "push", {"publish_nightly": True}, "refs/tags/v0.1.0", False),
            ("pull request", "pull_request", {"publish_nightly": True}, "refs/pull/21/merge", False),
        ]
        for label, event, inputs, ref, expected in matrix:
            with self.subTest(label=label):
                self.assertEqual(
                    evaluate_actions_condition(condition, event_name=event, inputs=inputs, ref=ref),
                    expected,
                )

    def test_release_tag_behavior_is_preserved_and_manual_publish_is_opt_in(self) -> None:
        text = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        triggers = mapping_block(text, "on", 0)
        push = mapping_block(triggers, "push", 2)
        self.assertIn("tags:\n      - 'v*'", push)
        condition = job_condition(text, "release")
        self.assertEqual(
            condition,
            "(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')) || "
            "(github.event_name == 'workflow_dispatch' && inputs.publish_release == true)",
        )
        gate_input = workflow_dispatch_input(text, "publish_release")
        self.assertIn("type: boolean", gate_input)
        self.assertIn("default: false", gate_input)
        self.assertIn("required: false", gate_input)
        matrix = [
            ("schedule", "schedule", "", {}, False),
            ("pull request", "pull_request", "refs/pull/21/merge", {"publish_release": True}, False),
            ("ordinary branch push", "push", "refs/heads/main", {}, False),
            ("version tag push keeps behavior", "push", "refs/tags/v0.1.0", {}, True),
            ("manual default", "workflow_dispatch", "refs/heads/main", {}, False),
            ("manual false", "workflow_dispatch", "refs/heads/main", {"publish_release": False}, False),
            ("manual true explicit opt-in", "workflow_dispatch", "refs/heads/main", {"publish_release": True}, True),
            ("dispatch true does not replace event check", "schedule", "refs/heads/main", {"publish_release": True}, False),
        ]
        for label, event, ref, inputs, expected in matrix:
            with self.subTest(label=label):
                self.assertEqual(
                    evaluate_actions_condition(condition, event_name=event, ref=ref, inputs=inputs),
                    expected,
                )

    def test_release_manual_dispatch_description_matches_its_gate(self) -> None:
        text = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        description = workflow_dispatch_input(text, "publish_release")
        self.assertIn("publish_release: true", description)
        self.assertNotRegex(description, r"(?i)validation only")

    def test_beta1_release_example_matches_the_candidate_package_version(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("git tag v0.1.0-beta1 <commit> && git push origin v0.1.0-beta1", text)
        self.assertNotIn("git tag v0.1.0-dev7", text)

    def test_publication_command_spans_distinguish_duplicate_commands_outside_the_guard(self) -> None:
        text = """jobs:
  publish:
    if: github.event_name == 'workflow_dispatch'
    steps:
      - run: gh release create v1
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: gh release create v2
"""
        _job, start, end = workflow_job_span(text, "publish")
        matches = list(PUBLISH_COMMAND.finditer(text))
        self.assertEqual(len(matches), 2)
        inside = [match for match in matches if start <= match.start() < end]
        self.assertEqual(len(inside), 1)
        self.assertEqual(inside[0].group(), "gh release")

    def test_all_publication_commands_are_inside_the_guarded_publisher_job(self) -> None:
        expected_jobs = {
            "nightly-release.yml": "publish",
            "release.yml": "release",
        }
        for workflow in WORKFLOWS:
            text = without_yaml_comments(workflow.read_text(encoding="utf-8"))
            matches = list(PUBLISH_COMMAND.finditer(text))
            if not matches:
                continue
            self.assertIn(workflow.name, expected_jobs, f"unexpected workflow has publisher command: {workflow.name}")
            _guarded_job, job_start, job_end = workflow_job_span(text, expected_jobs[workflow.name])
            self.assertTrue(job_condition(text, expected_jobs[workflow.name]))
            for match in matches:
                command = match.group(0)
                self.assertTrue(
                    job_start <= match.start() < job_end,
                    f"publication command escaped guarded job at offset {match.start()}: {command}",
                )
        nightly = without_yaml_comments((ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8"))
        self.assertIsNone(PUBLISH_COMMAND.search(workflow_job(nightly, "verify")))

    def test_ci_push_and_pull_request_workflow_cannot_publish(self) -> None:
        text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        triggers = mapping_block(text, "on", 0)
        self.assertIn("push:", triggers)
        self.assertIn("pull_request:", triggers)
        self.assertIsNone(PUBLISH_COMMAND.search(text))
        self.assertIn("contents: read", text)

    def test_nightly_version_lines_execute_as_written_in_bash(self) -> None:
        """Run the exact version assignments from both nightly jobs."""
        nightly = (ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8")
        assignments = [
            line.strip()
            for line in nightly.splitlines()
            if line.strip().startswith("VERSION=")
        ]
        self.assertEqual(len(assignments), 2, "verify and publish jobs must resolve version independently")
        expected = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
        for assignment in assignments:
            script = f'{assignment}\nprintf \'%s\\n\' "$VERSION"\n'
            result = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", script],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout.strip(), expected)

    def test_nightly_tag_metadata_is_quoted_and_rejects_shell_metacharacters(self) -> None:
        """Execute the actual TAG assignment and validation from both jobs."""
        nightly = (ROOT / ".github" / "workflows" / "nightly-release.yml").read_text(encoding="utf-8")
        blocks = [block for block in run_blocks(nightly) if 'TAG="nightly-${DATE_LOCAL}-${RUN_ID}-${RUN_ATTEMPT}"' in block]
        self.assertEqual(len(blocks), 2)
        for block in blocks:
            assignment = next(line.strip() for line in block.splitlines() if line.strip().startswith('TAG="nightly-'))
            validation_match = re.search(
                r"(?ms)^[ \t]*if ! printf '%s' \"\$TAG\" \| grep -Eq '([^']+)'[ \t]*; then[ \t]*\n"
                r"(?P<body>.*?)^[ \t]*fi[ \t]*$",
                block,
            )
            self.assertIsNotNone(validation_match, "actual nightly tag validation block is missing")
            validation = validation_match.group(0)
            for run_id, run_attempt, expected_valid in [
                ("12345", "1", True),
                ("123; touch PWNED", "1", False),
                ("12345", "1; touch PWNED", False),
                ("", "1", False),
            ]:
                with self.subTest(run_id=run_id, run_attempt=run_attempt):
                    with tempfile.TemporaryDirectory() as directory:
                        script = (
                            "set -euo pipefail\n"
                            f"{assignment}\n"
                            f"{validation}\n"
                            "printf '%s\\n' \"$TAG\"\n"
                        )
                        result = subprocess.run(
                            ["bash", "-euo", "pipefail", "-c", script],
                            cwd=directory,
                            env={
                                "PATH": "/usr/bin:/bin",
                                "DATE_LOCAL": "20261024",
                                "RUN_ID": run_id,
                                "RUN_ATTEMPT": run_attempt,
                                "TAG": "",
                            },
                            capture_output=True,
                            text=True,
                            timeout=30,
                            check=False,
                        )
                        self.assertEqual(result.returncode == 0, expected_valid, result.stdout + result.stderr)
                        self.assertFalse((Path(directory) / "PWNED").exists())
                        if expected_valid:
                            self.assertEqual(result.stdout.strip(), "nightly-20261024-12345-1")

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
        for value in ["v0.1.0-dev4", "v0.1.0-beta1", "v1.2.3", "v10.20.30-rc.1"]:
            self.assertIsNotNone(VERSION_TAG.match(value), value)
        release = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        workflow_pattern = re.search(r"grep -Eq '([^']+)'", release)
        self.assertIsNotNone(workflow_pattern)
        self.assertEqual(workflow_pattern.group(1), r"^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$")

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
            self.assertFalse((Path(directory) / "PWNED").exists())

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
