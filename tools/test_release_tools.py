#!/usr/bin/env python3
"""Tests of the tools of the release automation.

The tools of the release have to refuse a release that is not complete and
consistent. These tests build a small release in a temporary directory and
check that the validator accepts it and that it refuses every kind of damage.

    python3 -m unittest discover -s tools -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


validator = load("validate_release")
manifest_tool = load("build_manifest")
notebook_tool = load("build_notebook")
report_tool = load("build_release_report")

VERSION = "0.1.0-dev4"
TAG = "v0.1.0-dev4"
SHA = "0123456789abcdef0123456789abcdef01234567"


def random_token() -> str:
    """A value that looks like a random token.

    It is built from fragments at runtime: a literal of this length in this
    file would be reported by the scan of the secrets of the validator.
    """
    return "aB3dE5fG7hJ9kL" + "2mN4pQ6rS8tU0vW1xY3z" + "AbC5"


class ReleaseFixture(unittest.TestCase):
    """Builds a small but complete release in a temporary directory."""

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="kaggle-kit-release-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.stage = self.work / "release"
        self.stage.mkdir()

        source = ROOT / "notebooks" / "qwen3_8_27b_api.py"
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "build_notebook.py"),
                "--source",
                str(source),
                "--output",
                str(self.stage / f"{TAG}-notebook.ipynb"),
                "--version",
                VERSION,
                "--tag",
                TAG,
                "--source-sha",
                SHA,
            ],
            check=True,
            capture_output=True,
        )

        with zipfile.ZipFile(self.stage / f"{TAG}-app.zip", "w") as archive:
            archive.writestr("dist/client/index.html", "<!doctype html><title>Kaggle-Kit</title>")
            archive.writestr("dist/server/index.js", "console.log('backend');\n")
            archive.writestr("package.json", '{"name":"kaggle-kit","version":"0.1.0-dev4"}')
            archive.writestr("README.md", "# Kaggle-Kit\n")
            archive.writestr("LICENSE", "MIT\n")

        with zipfile.ZipFile(self.stage / f"{TAG}-source.zip", "w") as archive:
            for name in (
                "package.json",
                "README.md",
                "LICENSE",
                "notebooks/qwen3_8_27b_api.py",
                ".github/workflows/release.yml",
            ):
                archive.writestr(f"kaggle-kit-{VERSION}/{name}", "content\n")

        checks = self.work / "checks.json"
        checks.write_text(
            json.dumps(
                [
                    {
                        "command": "npm test",
                        "exitCode": 0,
                        "status": "passed",
                        "durationSeconds": 1.0,
                        "outputTail": [],
                    }
                ]
            ),
            encoding="utf-8",
        )
        environment = self.work / "environment.json"
        environment.write_text(
            json.dumps({"tested": ["a test"], "notTested": ["the real service"]}), encoding="utf-8"
        )
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "build_release_report.py"),
                "--stage",
                str(self.stage),
                "--checks",
                str(checks),
                "--environment",
                str(environment),
                "--version",
                VERSION,
                "--tag",
                TAG,
                "--source-sha",
                SHA,
                "--output",
                str(self.stage / "verification-report.json"),
            ],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "build_manifest.py"),
                "--stage",
                str(self.stage),
                "--version",
                VERSION,
                "--tag",
                TAG,
                "--source-sha",
                SHA,
                "--output",
                str(self.stage / "manifest.json"),
                "--checksums",
                str(self.stage / "SHA256SUMS"),
            ],
            check=True,
            capture_output=True,
        )

        # The validator compares the notebook with the script of the checkout.
        self.notes = ROOT / "docs" / "release-notes" / f"{VERSION}.md"
        self.assertTrue(self.notes.is_file(), "the release notes of the version are missing")

    def validate(self, downloaded=None):
        return validator.validate(self.stage, VERSION, TAG, SHA, downloaded)


class ValidatorTests(ReleaseFixture):
    def test_accepts_a_complete_release(self) -> None:
        self.assertEqual(self.validate(), [])

    def test_refuses_a_missing_asset(self) -> None:
        (self.stage / f"{TAG}-app.zip").unlink()
        problems = self.validate()
        self.assertTrue(any("missing" in problem for problem in problems), problems)

    def test_refuses_an_empty_asset(self) -> None:
        (self.stage / f"{TAG}-app.zip").write_bytes(b"")
        problems = self.validate()
        self.assertTrue(any("is empty" in problem for problem in problems), problems)

    def test_refuses_an_unexpected_file(self) -> None:
        (self.stage / "extra.txt").write_text("something\n", encoding="utf-8")
        problems = self.validate()
        self.assertTrue(any("unexpected file" in problem for problem in problems), problems)

    def test_refuses_a_corrupt_asset(self) -> None:
        path = self.stage / f"{TAG}-notebook.ipynb"
        path.write_bytes(path.read_bytes() + b" ")
        problems = self.validate()
        self.assertTrue(any("SHA256SUMS" in problem for problem in problems), problems)

    def test_refuses_a_manifest_with_the_wrong_commit(self) -> None:
        path = self.stage / "manifest.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["sourceCommit"] = "0" * 40
        path.write_text(json.dumps(manifest), encoding="utf-8")
        problems = self.validate()
        self.assertTrue(any("manifest names the commit" in problem for problem in problems), problems)

    def test_refuses_a_notebook_that_does_not_match_the_script(self) -> None:
        path = self.stage / f"{TAG}-notebook.ipynb"
        notebook = json.loads(path.read_text(encoding="utf-8"))
        notebook["cells"][1]["source"] = ["print('something else')"]
        path.write_text(json.dumps(notebook), encoding="utf-8")
        problems = self.validate()
        self.assertTrue(any("notebook" in problem for problem in problems), problems)

    def test_refuses_an_archive_with_a_secret(self) -> None:
        path = self.stage / f"{TAG}-app.zip"
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr(
                "dist/client/config.js",
                'const apiKey = "' + random_token() + '";\n',
            )
        problems = self.validate()
        self.assertTrue(any("secret" in problem for problem in problems), problems)

    def test_refuses_an_archive_with_a_key_file(self) -> None:
        path = self.stage / f"{TAG}-app.zip"
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("api_key.txt", "a secret key\n")
        problems = self.validate()
        self.assertTrue(any("api_key.txt" in problem for problem in problems), problems)

    def test_refuses_a_published_asset_that_differs(self) -> None:
        downloaded = self.work / "downloaded"
        downloaded.mkdir()
        for path in self.stage.iterdir():
            shutil.copy(path, downloaded / path.name)
        (downloaded / f"{TAG}-app.zip").write_bytes(b"a different build")
        problems = self.validate(downloaded)
        self.assertTrue(any("differs from the built one" in problem for problem in problems), problems)

    def test_refuses_a_missing_published_asset(self) -> None:
        downloaded = self.work / "downloaded"
        downloaded.mkdir()
        for path in self.stage.iterdir():
            shutil.copy(path, downloaded / path.name)
        (downloaded / "SHA256SUMS").unlink()
        problems = self.validate(downloaded)
        self.assertTrue(any("does not contain" in problem for problem in problems), problems)


class ConnectionCheckScriptTests(unittest.TestCase):
    """The Windows check must never turn the key into a command line value."""

    def setUp(self) -> None:
        self.script = (ROOT / "tools" / "check-kaggle-connection.ps1").read_text(encoding="utf-8")

    def test_reads_the_key_with_hidden_input_and_zeroes_it(self) -> None:
        self.assertIn("-AsSecureString", self.script)
        self.assertIn("SecureStringToBSTR", self.script)
        self.assertIn("ZeroFreeBSTR", self.script)

    def test_has_no_key_parameter_and_never_prints_the_key(self) -> None:
        self.assertNotIn("[string]$ApiKey", self.script)
        self.assertNotIn("Write-Host $script:ApiKey", self.script)
        self.assertNotIn("Write-Output $script:ApiKey", self.script)
        self.assertIn("Mask-Url", self.script)

    def test_performs_all_three_real_requests(self) -> None:
        self.assertIn("$base/models", self.script)
        self.assertIn("$base/chat/completions", self.script)
        self.assertIn("stream = $true", self.script)
        self.assertIn("stream = $false", self.script)


class ScanTests(unittest.TestCase):
    def test_the_tools_of_the_release_do_not_contain_a_secret(self) -> None:
        # The tools of the release are part of the source archive. The scan
        # must not report them, not even the test that uses a value that looks
        # like a key.
        for path in sorted((ROOT / "tools").glob("*.py")):
            problems: list = []
            validator.check_no_secrets(path.name, path.read_bytes(), problems)
            self.assertEqual(problems, [], f"{path.name} is reported as a secret")

    def test_the_release_notes_do_not_contain_a_secret(self) -> None:
        problems: list = []
        validator.check_no_secrets(
            "0.1.0-dev4.md", (ROOT / "docs" / "release-notes" / "0.1.0-dev4.md").read_bytes(), problems
        )
        self.assertEqual(problems, [])


class NotebookTests(unittest.TestCase):
    def test_refuses_a_source_with_a_literal_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            source = work / "script.py"
            source.write_text('api_key = "' + random_token() + '"\n', encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools" / "build_notebook.py"),
                    "--source",
                    str(source),
                    "--output",
                    str(work / "out.ipynb"),
                    "--version",
                    VERSION,
                    "--tag",
                    TAG,
                    "--source-sha",
                    SHA,
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("secret", completed.stderr)

    def test_the_notebook_holds_the_script_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            output = work / "out.ipynb"
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools" / "build_notebook.py"),
                    "--source",
                    str(ROOT / "notebooks" / "qwen3_8_27b_api.py"),
                    "--output",
                    str(output),
                    "--version",
                    VERSION,
                    "--tag",
                    TAG,
                    "--source-sha",
                    SHA,
                ],
                check=True,
                capture_output=True,
            )
            notebook = json.loads(output.read_text(encoding="utf-8"))
            code = [
                "".join(cell["source"])
                for cell in notebook["cells"]
                if cell["cell_type"] == "code"
            ]
            self.assertEqual(len(code), 1)
            self.assertEqual(code[0], (ROOT / "notebooks" / "qwen3_8_27b_api.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()


class ManifestConsistencyTests(unittest.TestCase):
    """The manifest has to describe the build that really runs.

    Two drifts shipped in v0.1.0-dev7: the manifest demanded "Node.js 22"
    although package.json and the launcher enforce >=20.19, and it omitted
    the tools unittest suite that release.yml runs through run_checks.py.
    Both are checked here so the generated manifest stays traceable to the
    real contracts of the repository.
    """

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="kaggle-kit-manifest-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.stage = self.work / "stage"
        self.stage.mkdir()
        (self.stage / "v0.0.0-app.zip").write_bytes(b"app")
        self.manifest_path = self.work / "manifest.json"
        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "build_manifest.py"),
                "--stage", str(self.stage),
                "--version", "0.0.0",
                "--tag", "v0.0.0",
                "--source-sha", SHA,
                "--output", str(self.manifest_path),
                "--checksums", str(self.work / "SHA256SUMS"),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def test_the_node_requirement_matches_package_json_and_the_launcher(self) -> None:
        engines = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["engines"]["node"]
        declared = engines.lstrip(">= ")
        launcher = (ROOT / "tools" / "launcher.mjs").read_text(encoding="utf-8")
        self.assertIn(f"DEFAULT_NODE_REQUIREMENT = '{declared}'", launcher)
        application = self.manifest["requirements"]["application"]
        self.assertIn(declared, application)
        self.assertNotIn("Node.js 22", application)

    def test_the_build_commands_cover_every_python_suite_of_the_release_workflow(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        commands = self.manifest["build"]["commands"]
        unittest_commands = re.findall(r'--command "(python3 -m unittest[^"]+)"', workflow)
        self.assertTrue(unittest_commands, "release.yml runs no unittest suite?")
        for command in unittest_commands:
            self.assertIn(command, commands)


class EnvironmentReportConsistencyTests(unittest.TestCase):
    """environment.json is embedded verbatim into verification-report.json.

    The dev7 report carried two entries for the same notebook-test command
    with incompatible counts (105/17-skipped and 93/0-skipped) and no way to
    tell them apart: they came from different heads and different
    environments. When the same command is recorded more than once, every
    recording has to carry a distinguishing run label.
    """

    def setUp(self) -> None:
        path = ROOT / "docs" / "release" / "environment.json"
        self.assertTrue(path.is_file(), "docs/release/environment.json is missing")
        self.environment = json.loads(path.read_text(encoding="utf-8"))

    def test_the_report_keeps_the_schema_the_release_report_embeds(self) -> None:
        for key in ("tested", "notTested"):
            self.assertIn(key, self.environment)
            self.assertIsInstance(self.environment[key], list)
            for entry in self.environment[key]:
                self.assertIsInstance(entry, str)
                self.assertTrue(entry.strip())

    def test_repeated_notebook_suite_entries_carry_distinguishing_run_labels(self) -> None:
        command = "unittest discover -s notebooks"
        entries = [entry for entry in self.environment["tested"] if command in entry]
        if len(entries) > 1:
            for entry in entries:
                self.assertTrue(
                    entry.startswith("[run "),
                    f"ambiguous notebook-suite entry without a run label: {entry[:80]}...",
                )
            labels = [entry.split("]", 1)[0] for entry in entries]
            self.assertEqual(len(set(labels)), len(labels), "two notebook-suite runs share one label")
