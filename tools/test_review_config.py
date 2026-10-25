"""Guards for the parts of `.coderabbit.yaml` that silently stop working.

Two CodeRabbit settings are easy to write in a way that looks correct and has no
effect:

1. `reviews.path_instructions[].path` is a single minimatch glob. A value that
   joins several globs with commas is a literal pattern, matches no file, and
   the instructions behind it are never applied.
2. CodeRabbit ignores a set of paths by default, including
   `!**/package-lock.json`. A broad include such as `**/*` does not override a
   default: the exact default pattern has to be repeated without the leading
   `!`.

Reference: https://docs.coderabbit.ai/configuration/path-instructions and
https://docs.coderabbit.ai/reference/configuration (checked 2026-10-25).

The tests below parse the checked-in YAML without a third-party dependency and
match representative repository paths with the same glob features CodeRabbit
documents for minimatch (`**`, `*`, `?`, `{a,b}`).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / ".coderabbit.yaml"


def _expand_braces(pattern: str) -> list[str]:
    """Expand `{a,b}` (one level, as used in this repository) into patterns."""
    match = re.search(r"\{([^{}]*)\}", pattern)
    if not match:
        return [pattern]
    expanded: list[str] = []
    for alternative in match.group(1).split(","):
        expanded.extend(
            _expand_braces(pattern[: match.start()] + alternative + pattern[match.end() :])
        )
    return expanded


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a minimatch-style glob into an anchored regular expression."""
    out = ["^"]
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if pattern.startswith("**/", index):
            # `**/` also matches zero directories: `**/*.md` matches `README.md`.
            out.append("(?:.*/)?")
            index += 3
        elif pattern.startswith("**", index):
            out.append(".*")
            index += 2
        elif char == "*":
            out.append("[^/]*")
            index += 1
        elif char == "?":
            out.append("[^/]")
            index += 1
        else:
            out.append(re.escape(char))
            index += 1
    out.append("$")
    return re.compile("".join(out))


def glob_matches(glob: str, path: str) -> bool:
    """True when any brace expansion of `glob` matches the repository path."""
    return any(_glob_to_regex(pattern).match(path) for pattern in _expand_braces(glob))


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _section_lines(text: str, start_marker: str, stop_marker: str) -> list[str]:
    lines = text.splitlines()
    start = next(index for index, line in enumerate(lines) if line.strip() == start_marker)
    stop = next(
        (index for index in range(start + 1, len(lines)) if lines[index].strip() == stop_marker),
        len(lines),
    )
    return lines[start:stop]


def load_config_text() -> str:
    return CONFIG_PATH.read_text(encoding="utf-8")


def path_instruction_globs(text: str) -> list[str]:
    """Every `path:` value under `path_instructions`, in file order."""
    return [
        _unquote(match.group(1))
        for match in re.finditer(r"^\s*-?\s*path:\s*(.+)$", text, re.MULTILINE)
    ]


def path_filter_globs(text: str) -> list[str]:
    """Every entry of `reviews.path_filters`."""
    block = _section_lines(text, "path_filters:", "finishing_touches:")
    return [
        _unquote(match.group(1))
        for match in re.finditer(r"^\s*-\s*(.+)$", "\n".join(block[1:]), re.MULTILINE)
    ]


class ReviewConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = load_config_text()
        self.instructions = path_instruction_globs(self.text)
        self.filters = path_filter_globs(self.text)

    def test_config_exists_and_has_instructions(self) -> None:
        self.assertTrue(CONFIG_PATH.is_file(), "the repository review config is missing")
        # 9 instruction blocks: backend, client, notebooks, tests, tools, python
        # tests, documentation, CI/dependencies, and the config itself.
        self.assertEqual(len(self.instructions), 9, self.instructions)

    def test_every_path_value_is_one_glob_without_comma_lists(self) -> None:
        # A comma outside braces is the defect this test exists for: the value is
        # then one literal pattern that matches nothing.
        for glob in self.instructions:
            depth = 0
            for char in glob:
                if char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                elif char == "," and depth == 0:
                    self.fail(f"path value is a comma-separated list, not one glob: {glob!r}")
            self.assertEqual(depth, 0, f"unbalanced braces in {glob!r}")

    def test_documentation_instructions_reach_the_intended_files(self) -> None:
        glob = next(
            glob for glob in self.instructions if "docs/**" in glob
        )
        for path in (
            "docs/release-notes/0.1.0-beta2.md",
            "docs/release/environment.json",
            "DESIGN_LOG.md",
            "AGENTS_LOG.md",
            "README.md",
        ):
            self.assertTrue(glob_matches(glob, path), f"{glob!r} does not match {path!r}")
        self.assertFalse(glob_matches(glob, "server/app.ts"))

    def test_workflow_and_dependency_instructions_reach_the_intended_files(self) -> None:
        glob = next(glob for glob in self.instructions if ".github/workflows/**" in glob)
        for path in (
            ".github/workflows/ci.yml",
            "package.json",
            "package-lock.json",
            "requirements.txt",
            "requirements-dev.txt",
        ):
            self.assertTrue(glob_matches(glob, path), f"{glob!r} does not match {path!r}")
        self.assertFalse(glob_matches(glob, "server/app.ts"))

    def test_other_instruction_scopes_still_match(self) -> None:
        cases = {
            "{server,shared}/**": ["server/app.ts", "shared/api/stream.ts"],
            "src/**": ["src/lib/gateway.ts"],
            "notebooks/**": ["notebooks/qwen3_8_27b_api.py"],
            "**/*.test.*": ["server/app.streaming.test.ts", "shared/api/stream.test.ts"],
            "tools/**": ["tools/integration-check.mjs"],
            "notebooks/test_*.py": ["notebooks/test_qwen_deployment.py"],
            ".coderabbit.yaml": [".coderabbit.yaml"],
        }
        for glob, paths in cases.items():
            self.assertIn(glob, self.instructions)
            for path in paths:
                self.assertTrue(glob_matches(glob, path), f"{glob!r} does not match {path!r}")

    def test_comma_joined_glob_is_recognised_as_the_regression(self) -> None:
        # Negative control: the value that shipped before this fix must fail the
        # same matcher, otherwise the tests above could pass on broken input.
        broken = "docs/**,**/*.md,DESIGN_LOG.md,AGENTS_LOG.md"
        for path in ("docs/release-notes/0.1.0-beta2.md", "DESIGN_LOG.md", "AGENTS_LOG.md"):
            self.assertFalse(glob_matches(broken, path), f"{broken!r} unexpectedly matches {path!r}")

    def test_lockfile_is_kept_in_review_scope(self) -> None:
        # `**/*` is broad and does not override a default ignore; the exact
        # default pattern without `!` is the documented override.
        self.assertIn("**/*", self.filters)
        self.assertIn("**/package-lock.json", self.filters)
        self.assertTrue(glob_matches("**/package-lock.json", "package-lock.json"))

    def test_no_exclusion_can_silently_drop_reviewed_files(self) -> None:
        # Exclusions win over includes, so every changed source or log file would
        # disappear from review without any error being reported.
        for entry in self.filters:
            self.assertFalse(entry.startswith("!"), f"exclusion added to the review scope: {entry!r}")

    def test_review_pause_is_disabled(self) -> None:
        match = re.search(r"^\s*auto_pause_after_reviewed_commits:\s*(\d+)", self.text, re.MULTILINE)
        self.assertIsNotNone(match, "auto_pause_after_reviewed_commits is not configured")
        self.assertEqual(match.group(1), "0", "a non-zero value pauses automatic reviews")

    def test_automatic_approval_stays_disabled(self) -> None:
        # A single maintainer must not be able to obtain an automatic approval
        # that looks like review by someone else.
        self.assertRegex(self.text, r"auto_approvals:\s*\n\s*enabled:\s*false")


if __name__ == "__main__":
    unittest.main()
