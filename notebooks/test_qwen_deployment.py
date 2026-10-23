"""
Tests for the Kaggle deployment script.

The tests only cover the parts that can run without a GPU: flag selection,
model discovery, the resume logic of the downloader, the safe extraction of
archives, the state of a running server and the runtime bundle that connects
the deployment to the chat interface.

    python3 -m unittest discover -s notebooks -p "test_*.py"

The tests that need ``requests`` are skipped when the package is missing.
"""

from __future__ import annotations

import http.server
import io
import json
import os
import socketserver
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import qwen3_8_27b_api as nb  # noqa: E402

REQUESTS_READY = nb.REQUESTS_AVAILABLE


class FakeResponse:
    """Minimal stand in for the parts of ``requests.Response`` that are used."""

    def __init__(
        self,
        payload: bytes,
        status_code: int = 200,
        headers: dict | None = None,
    ) -> None:
        self._payload = payload
        self.status_code = status_code
        self.headers = headers or {"content-type": "application/octet-stream"}

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args) -> bool:
        return False

    def iter_content(self, chunk_size: int = 1024):
        for start in range(0, len(self._payload), chunk_size):
            yield self._payload[start : start + chunk_size]

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return json.loads(self._payload.decode("utf-8"))


class FakeSession:
    """A session that serves a payload and records the range requests."""

    def __init__(self, payload: bytes, headers: dict | None = None) -> None:
        self.payload = payload
        self.headers = headers or {"content-type": "application/octet-stream"}
        self.ranges: list = []

    def get(self, url, headers=None, stream=False, allow_redirects=True, timeout=None):
        self.ranges.append((url, dict(headers or {})))
        offset = 0
        raw_range = (headers or {}).get("Range")
        if raw_range and raw_range.startswith("bytes="):
            offset = int(raw_range.split("=", 1)[1].split("-", 1)[0])
        return FakeResponse(self.payload[offset:], 206 if offset else 200, dict(self.headers))


class FlagSelectionTests(unittest.TestCase):
    def test_server_flags_reads_the_long_options(self) -> None:
        text = "  --ctx-size N     context size\n  --flash-attn on\n  --reasoning-effort <value>\n"
        flags = nb.server_flags(text)
        self.assertIn("--ctx-size", flags)
        self.assertIn("--flash-attn", flags)
        self.assertIn("--reasoning-effort", flags)
        self.assertNotIn("--not-a-flag", flags)

    def _launch(self, supported_text: str, variant: dict, **kwargs):
        config = nb.DeploymentConfig()
        config.root = Path("/tmp/qwen-test")
        supported = nb.server_flags(supported_text)
        return nb.build_server_command(
            config,
            Path("/tmp/llama-server"),
            Path("/tmp/model.gguf"),
            "secret",
            supported,
            variant,
            **kwargs,
        )

    def test_command_only_contains_supported_flags(self) -> None:
        launch = self._launch(
            "--ctx-size N --n-gpu-layers N --host H --port P --api-key K",
            {"ctx": 8192, "mtp": True, "reasoning": True},
        )

        self.assertIn("--ctx-size", launch.command)
        self.assertNotIn("--split-mode", launch.command)
        self.assertNotIn("--tensor-split", launch.command)
        self.assertNotIn("--flash-attn", launch.command)
        self.assertNotIn("--reasoning-effort", launch.command)
        self.assertNotIn("--spec-type", launch.command)
        self.assertNotIn("--jinja", launch.command)

    def test_command_adds_mtp_and_reasoning_when_supported(self) -> None:
        launch = self._launch(
            "--ctx-size N --split-mode M --tensor-split T --cache-type-k T "
            "--cache-type-v T --flash-attn on --jinja --reasoning-effort <value> "
            "--spec-type T --spec-draft-n-max N --api-key K",
            {"ctx": 8192, "mtp": True, "reasoning": True},
        )

        self.assertIn("--split-mode", launch.command)
        self.assertIn("layer", launch.command)
        self.assertIn("--tensor-split", launch.command)
        self.assertIn("--reasoning-effort", launch.command)
        self.assertIn("medium", launch.command)
        self.assertIn("draft-mtp", launch.command)

        # The applied options describe what the server really got.
        self.assertTrue(launch.applied["mtp"])
        self.assertTrue(launch.applied["reasoning"])
        self.assertEqual(launch.applied["ctx"], 8192)
        self.assertEqual(launch.applied["split_mode"], "layer")
        self.assertEqual(launch.dropped, [])

    def test_unsupported_mtp_is_not_reported_as_enabled(self) -> None:
        launch = self._launch(
            "--ctx-size N --n-gpu-layers N --host H --port P --api-key K",
            {"ctx": 8192, "mtp": True, "reasoning": True},
        )

        self.assertNotIn("--spec-type", launch.command)
        self.assertFalse(launch.applied["mtp"])
        self.assertIn("mtp", launch.dropped)
        self.assertIn("reasoning", launch.dropped)
        self.assertFalse(launch.applied["reasoning"])

    def test_the_api_key_is_read_from_a_file_when_the_build_supports_it(self) -> None:
        launch = self._launch(
            "--ctx-size N --n-gpu-layers N --host H --port P --api-key-file F",
            {"ctx": 8192, "mtp": False, "reasoning": False},
            api_key_file=Path("/tmp/qwen-test/api_key.txt"),
        )

        self.assertIn("--api-key-file", launch.command)
        self.assertNotIn("--api-key", launch.command)
        self.assertNotIn("secret", " ".join(launch.command))
        self.assertEqual(launch.applied["api_key_source"], "file")
        self.assertEqual(launch.env, {})

    def test_the_api_key_falls_back_to_the_environment_never_to_argv(self) -> None:
        # The pinned llama.cpp builds read --api-key from LLAMA_API_KEY when
        # the environment variable is set (common/arg.cpp, set_env). The key
        # must never appear in the command line: argv is world-readable via
        # /proc/<pid>/cmdline while the process runs.
        launch = self._launch(
            "--ctx-size N --n-gpu-layers N --host H --port P --api-key K",
            {"ctx": 8192, "mtp": False, "reasoning": False},
        )

        self.assertNotIn("--api-key", launch.command)
        self.assertNotIn("secret", " ".join(launch.command))
        self.assertEqual(launch.env, {"LLAMA_API_KEY": "secret"})
        self.assertEqual(launch.applied["api_key_source"], "environment")

    def test_a_build_that_cannot_authenticate_is_refused(self) -> None:
        with self.assertRaises(RuntimeError):
            self._launch(
                "--ctx-size N --n-gpu-layers N --host H --port P",
                {"ctx": 8192, "mtp": False, "reasoning": False},
            )

    def test_the_cloudflared_download_is_pinned_and_digest_verified(self) -> None:
        import inspect

        self.assertEqual(len(nb.CLOUDFLARED_SHA256), 64)
        int(nb.CLOUDFLARED_SHA256, 16)  # raises when not hexadecimal
        self.assertRegex(nb.CLOUDFLARED_VERSION, r"^\d{4}\.\d{1,2}\.\d{1,2}$")
        source = inspect.getsource(nb.get_cloudflared)
        # The pinned version tag and the moving-target ban.
        self.assertIn("CLOUDFLARED_VERSION", source)
        self.assertNotIn("releases/latest", source)
        self.assertIn("CLOUDFLARED_SHA256", source)
        self.assertIn("expected_sha256", source)

    def test_variants_start_with_the_verified_configuration(self) -> None:
        config = nb.DeploymentConfig()
        variants = nb.server_variants(config)
        self.assertEqual(variants[0]["ctx"], 8192)
        self.assertTrue(variants[0]["mtp"])
        self.assertTrue(any(not variant["mtp"] for variant in variants))

    def test_usable_variants_drop_a_duplicate_when_mtp_is_not_supported(self) -> None:
        config = nb.DeploymentConfig()
        variants = nb.server_variants(config)

        with_mtp = nb.usable_variants(
            variants, nb.server_flags("--ctx-size N --reasoning-effort <value>")
        )
        self.assertEqual(len(with_mtp), len(variants) - 1)
        self.assertFalse(any(variant["mtp"] for variant in with_mtp))

        with_mtp_support = nb.usable_variants(
            variants,
            nb.server_flags(
                "--ctx-size N --spec-type T --spec-draft-n-max N --reasoning-effort <value>"
            ),
        )
        self.assertEqual(len(with_mtp_support), len(variants))
        self.assertTrue(with_mtp_support[0]["mtp"])


class ModelDiscoveryTests(unittest.TestCase):
    def _write_gguf(self, path: Path, size: int) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            handle.write(b"GGUF")
            handle.write(b"\0" * max(0, size - 4))
        return path

    def test_finds_a_complete_gguf_in_the_working_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = nb.DeploymentConfig()
            config.root = root
            config.input_root = root / "input"
            config.min_model_bytes = 1024

            self._write_gguf(config.model_dir / config.model_file, 2048)
            found = nb.find_saved_model(config)
            self.assertIsNotNone(found)
            self.assertTrue(found.name == config.model_file)

    def test_ignores_an_incomplete_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = nb.DeploymentConfig()
            config.root = root
            config.input_root = root / "input"
            config.min_model_bytes = 1024

            self._write_gguf(config.model_dir / config.model_file, 16)
            self.assertIsNone(nb.find_saved_model(config))

    def test_ignores_a_file_that_is_not_a_gguf(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = nb.DeploymentConfig()
            config.root = root
            config.input_root = root / "input"
            config.min_model_bytes = 16

            path = config.model_dir / config.model_file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"NOTGGUF" + b"0" * 64)

            self.assertIsNone(nb.find_saved_model(config))


class DownloadTests(unittest.TestCase):
    def test_download_writes_the_file(self) -> None:
        payload = b"0123456789" * 100
        session = FakeSession(payload)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            result = nb.download_resumable(
                session, "https://example.invalid/asset.bin", destination, min_bytes=10
            )
            self.assertEqual(result.read_bytes(), payload)
            self.assertFalse((destination.parent / "asset.bin.part").exists())

    def test_download_resumes_from_the_partial_file(self) -> None:
        payload = bytes(range(256)) * 8
        session = FakeSession(payload)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            part = destination.with_name(destination.name + ".part")
            part.write_bytes(payload[:100])

            result = nb.download_resumable(
                session, "https://example.invalid/asset.bin", destination, min_bytes=10
            )

            self.assertEqual(result.read_bytes(), payload)
            self.assertTrue(session.ranges[0][1].get("Range", "").startswith("bytes=100-"))

    def test_an_existing_complete_file_is_reused(self) -> None:
        payload = b"x" * 512
        session = FakeSession(payload)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            destination.write_bytes(payload)

            nb.download_resumable(
                session, "https://example.invalid/asset.bin", destination, min_bytes=10
            )
            self.assertEqual(session.ranges, [])

    def test_an_html_error_page_is_refused(self) -> None:
        session = FakeSession(
            b"<html><body>Not found</body></html>",
            headers={"content-type": "text/html; charset=utf-8"},
        )

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            with self.assertRaises(RuntimeError):
                nb.download_resumable(
                    session,
                    "https://example.invalid/asset.bin",
                    destination,
                    min_bytes=1,
                    attempts=1,
                )
            self.assertFalse(destination.exists())

    def test_a_truncated_download_is_refused(self) -> None:
        # The server announces more bytes than it sends.
        session = FakeSession(
            b"short", headers={"content-type": "application/octet-stream", "content-length": "999"}
        )

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            with self.assertRaises(RuntimeError):
                nb.download_resumable(
                    session,
                    "https://example.invalid/asset.bin",
                    destination,
                    min_bytes=1,
                    attempts=1,
                )
            self.assertFalse(destination.exists())


class ChecksumTests(unittest.TestCase):
    def test_a_download_with_the_pinned_digest_is_accepted(self) -> None:
        import hashlib

        payload = b"pinned asset" * 64
        session = FakeSession(payload)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            result = nb.download_resumable(
                session,
                "https://example.invalid/asset.bin",
                destination,
                min_bytes=10,
                expected_sha256=hashlib.sha256(payload).hexdigest(),
            )
            self.assertEqual(result.read_bytes(), payload)

    def test_a_download_with_a_wrong_digest_is_deleted_and_refused(self) -> None:
        payload = b"tampered asset" * 64
        session = FakeSession(payload)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            with self.assertRaises(nb.ChecksumMismatch):
                nb.download_resumable(
                    session,
                    "https://example.invalid/asset.bin",
                    destination,
                    min_bytes=10,
                    attempts=3,
                    expected_sha256="0" * 64,
                )
            self.assertFalse(destination.exists())
            self.assertFalse((destination.parent / "asset.bin.part").exists())
            # A mismatch is not retried as a transient download failure.
            self.assertEqual(len(session.ranges), 1)

    def test_a_cached_file_with_a_wrong_digest_is_redownloaded(self) -> None:
        import hashlib

        payload = b"fresh asset" * 64
        session = FakeSession(payload)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.bin"
            destination.write_bytes(b"stale bytes" * 64)
            result = nb.download_resumable(
                session,
                "https://example.invalid/asset.bin",
                destination,
                min_bytes=10,
                expected_sha256=hashlib.sha256(payload).hexdigest(),
            )
            self.assertEqual(result.read_bytes(), payload)

    def test_every_configured_build_has_pinned_digests(self) -> None:
        config = nb.DeploymentConfig()
        for tag in config.llama_cpp_tags:
            for prefix in ("llama", "cudart-llama"):
                name = f"{prefix}-{tag}-bin-ubuntu-cuda-{config.cuda_version}-x64.tar.gz"
                digest = nb.LLAMA_CPP_SHA256.get(name, "")
                self.assertEqual(len(digest), 64, name)
                int(digest, 16)


class ArchiveExtractionTests(unittest.TestCase):
    def _archive(self, members) -> bytes:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, content, kind in members:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                if kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = content.decode()
                    info.size = 0
                archive.addfile(info, io.BytesIO(content) if kind != "symlink" else None)
        return buffer.getvalue()

    def test_a_normal_archive_is_extracted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "archive.tar.gz"
            archive_path.write_bytes(self._archive([("bin/llama-server", b"binary", "file")]))

            names = nb.extract_archive(archive_path, root / "out")

            self.assertIn("bin/llama-server", names)
            self.assertEqual((root / "out" / "bin" / "llama-server").read_bytes(), b"binary")

    def test_an_archive_cannot_write_outside_the_target_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "evil.tar.gz"
            archive_path.write_bytes(
                self._archive([("../escaped.txt", b"owned", "file")])
            )

            with self.assertRaises(RuntimeError):
                nb.extract_archive(archive_path, root / "out")

            self.assertFalse((root / "escaped.txt").exists())

    def test_an_archive_cannot_use_a_link_out_of_the_target_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "evil.tar.gz"
            archive_path.write_bytes(
                self._archive([("link", b"/etc/passwd", "symlink")])
            )

            with self.assertRaises(RuntimeError):
                nb.extract_archive(archive_path, root / "out")

            self.assertFalse((root / "out" / "link").exists())


class ServerStateTests(unittest.TestCase):
    def test_the_decision_matrix(self) -> None:
        self.assertEqual(
            nb.decide_server_action(
                port_busy=False, owned=False, healthy=False, compatible=False
            ),
            nb.ACTION_START,
        )
        self.assertEqual(
            nb.decide_server_action(
                port_busy=True, owned=True, healthy=True, compatible=True
            ),
            nb.ACTION_REUSE,
        )
        self.assertEqual(
            nb.decide_server_action(
                port_busy=True, owned=True, healthy=True, compatible=False
            ),
            nb.ACTION_RESTART,
        )
        self.assertEqual(
            nb.decide_server_action(
                port_busy=True, owned=True, healthy=False, compatible=True
            ),
            nb.ACTION_RESTART,
        )
        self.assertEqual(
            nb.decide_server_action(
                port_busy=True, owned=False, healthy=True, compatible=True
            ),
            nb.ACTION_CONFLICT,
        )

    def test_a_foreign_process_is_never_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = nb.DeploymentConfig()
            config.root = Path(directory)

            # The test process itself is not a llama-server.
            state = {"pid": os.getpid()}
            self.assertFalse(nb.owns_process(state))
            self.assertFalse(nb.stop_owned_server(config, state))
            self.assertTrue(nb.process_alive(os.getpid()))

    def test_a_state_without_a_process_is_not_owned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = nb.DeploymentConfig()
            config.root = Path(directory)

            self.assertFalse(nb.owns_process(None))
            self.assertFalse(nb.owns_process({"pid": 0}))
            self.assertFalse(nb.owns_process({"pid": 999_999_999}))
            self.assertFalse(nb.stop_owned_server(config, {"pid": 999_999_999}))

    def test_the_state_and_the_key_are_stored_separately(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = nb.DeploymentConfig()
            config.root = Path(directory)

            key_path = nb.write_api_key(config, "super-secret")
            self.assertEqual(os.stat(key_path).st_mode & 0o777, 0o600)
            self.assertEqual(nb.read_api_key(config), "super-secret")

            state_path = nb.write_server_state(
                config,
                {
                    "pid": 1234,
                    "port": 8000,
                    "fingerprint": "abc",
                    "applied": {"ctx": 8192, "mtp": True},
                },
            )
            self.assertEqual(os.stat(state_path).st_mode & 0o777, 0o600)
            self.assertNotIn("super-secret", state_path.read_text())

            state = nb.read_server_state(config)
            self.assertEqual(state["pid"], 1234)
            self.assertEqual(state["applied"]["ctx"], 8192)

            nb.clear_server_state(config)
            self.assertIsNone(nb.read_server_state(config))

    def test_the_fingerprint_changes_with_the_configuration(self) -> None:
        config = nb.DeploymentConfig()
        base = nb.deployment_fingerprint(config, Path("/tmp/a.gguf"), Path("/tmp/llama-server"))
        same = nb.deployment_fingerprint(config, Path("/tmp/a.gguf"), Path("/tmp/llama-server"))
        other_model = nb.deployment_fingerprint(
            config, Path("/tmp/b.gguf"), Path("/tmp/llama-server")
        )
        self.assertEqual(base, same)
        self.assertNotEqual(base, other_model)

        config.ctx_size = 4096
        self.assertNotEqual(
            base, nb.deployment_fingerprint(config, Path("/tmp/a.gguf"), Path("/tmp/llama-server"))
        )

    def test_a_free_port_is_reported_as_free(self) -> None:
        with socket_holder() as (host, port):
            self.assertTrue(nb.port_in_use(host, port))
        self.assertFalse(nb.port_in_use(host, port))


class socket_holder:
    """A context manager that holds a listening socket."""

    def __init__(self) -> None:
        import socket

        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(1)

    def __enter__(self):
        return self._socket.getsockname()

    def __exit__(self, *args) -> bool:
        self._socket.close()
        return False


class RuntimeBundleTests(unittest.TestCase):
    def test_the_key_is_only_written_to_the_key_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = nb.DeploymentConfig()
            config.root = root
            config.model_dir.mkdir(parents=True, exist_ok=True)

            model = config.model_dir / config.model_file
            model.write_bytes(b"GGUF" + b"0" * 2048)

            paths = nb.write_runtime_bundle(
                config,
                "super-secret",
                "model-a",
                model,
                {"ctx": 8192, "mtp": True, "reasoning": True, "reasoning_effort": "medium"},
                "https://example.trycloudflare.com",
                Path("/tmp/llama-server"),
            )

            self.assertEqual(paths["api_key"].read_text().strip(), "super-secret")
            self.assertEqual(os.stat(paths["api_key"]).st_mode & 0o777, 0o600)

            runtime = json.loads(paths["runtime"].read_text())
            profile = json.loads(paths["profile"].read_text())
            self.assertNotIn("super-secret", json.dumps(runtime))
            self.assertNotIn("super-secret", json.dumps(profile))
            self.assertEqual(runtime["context_size"], 8192)
            self.assertTrue(runtime["mtp_speculative_decoding"])
            self.assertEqual(runtime["reasoning_effort"], "medium")
            self.assertEqual(profile["model"], "model-a")

    def test_the_runtime_reports_only_the_applied_options(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = nb.DeploymentConfig()
            config.root = root
            config.model_dir.mkdir(parents=True, exist_ok=True)

            model = config.model_dir / config.model_file
            model.write_bytes(b"GGUF" + b"0" * 2048)

            paths = nb.write_runtime_bundle(
                config,
                "super-secret",
                "model-a",
                model,
                {
                    "ctx": 4096,
                    "mtp": False,
                    "reasoning": False,
                    "reasoning_effort": None,
                    "unsupported_options": ["mtp", "reasoning"],
                },
                None,
                Path("/tmp/llama-server"),
            )

            runtime = json.loads(paths["runtime"].read_text())
            self.assertFalse(runtime["mtp_speculative_decoding"])
            self.assertIsNone(runtime["reasoning_effort"])
            self.assertEqual(runtime["context_size"], 4096)
            self.assertEqual(runtime["unsupported_options"], ["mtp", "reasoning"])
            self.assertIsNone(runtime["public_base_url"])
            self.assertFalse(runtime["public_endpoint_verified"])


class BusyPort:
    """A port that is used once and free afterwards, like after a restart."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, host: str, port: int) -> bool:
        self.calls += 1
        return self.calls == 1


class MainFlowTests(unittest.TestCase):
    """The flow of a rerun: start, reuse, restart and conflict."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

        self.config = nb.DeploymentConfig()
        self.config.root = self.root
        self.config.enable_tunnel = False
        # model_dir and bin_root are derived from the root.
        self.config.model_dir.mkdir(parents=True, exist_ok=True)

        self.model = self.config.model_dir / self.config.model_file
        self.model.write_bytes(b"GGUF" + b"0" * 2048)

        self.started: list = []
        self.stopped: list = []

        patches = [
            ("build_session", lambda: object()),
            ("check_gpus", lambda config: ["GPU 0: T4", "GPU 1: T4"]),
            ("get_server_binary", lambda session, config: Path("/tmp/llama-server")),
            ("find_saved_model", lambda config: self.model),
            ("probe_local_streaming", lambda *args, **kwargs: True),
            (
                "verify_local_authentication",
                lambda *args, **kwargs: {
                    "unauthenticated_rejected": True,
                    "wrong_key_rejected": True,
                    "authenticated_ok": True,
                    "detail": "Authentication verified by the test fixture.",
                },
            ),
            ("start_public_tunnel", lambda *args, **kwargs: None),
            ("owns_process", lambda state: True),
            ("stop_owned_server", self._stop),
            ("start_server", self._start),
        ]
        self._patchers = []
        for name, replacement in patches:
            patcher = unittest.mock.patch.object(nb, name, replacement)
            patcher.start()
            self._patchers.append(patcher)

    def tearDown(self) -> None:
        for patcher in self._patchers:
            patcher.stop()
        self.directory.cleanup()

    def _stop(self, config, state):
        self.stopped.append(state)
        return True

    def _start(self, session, config, binary, model_path, api_key, **kwargs):
        self.started.append(api_key)
        return "model-a", {
            "ctx": 8192,
            "mtp": False,
            "reasoning": False,
            "n_gpu_layers": 99,
            "unsupported_options": ["mtp"],
        }

    def _main(self, **patches):
        import contextlib
        import io

        # Every name is patched exactly once: a second patch of the same
        # attribute would leave the first replacement behind.
        active = {
            "port_in_use": lambda host, port: False,
            "server_healthy": lambda *args, **kwargs: False,
        }
        active.update(patches)

        patchers = []
        for name, replacement in active.items():
            patcher = unittest.mock.patch.object(nb, name, replacement)
            patcher.start()
            patchers.append(patcher)

        buffer = io.StringIO()
        try:
            with contextlib.redirect_stdout(buffer):
                result = nb.main(self.config)
        finally:
            for patcher in patchers:
                patcher.stop()

        return result, buffer.getvalue()

    def test_a_fresh_deployment_starts_a_server_with_a_new_key(self) -> None:
        result, output = self._main()

        self.assertEqual(len(self.started), 1)
        self.assertFalse(result["server_reused"])
        self.assertEqual(result["api_key"], self.started[0])
        self.assertIn("started in this run", output)
        self.assertIn("Local inference:  verified with a real chat completion", output)

        # The key of the new server is stored with mode 0600.
        key_path = self.root / "api_key.txt"
        self.assertEqual(key_path.read_text().strip(), result["api_key"])
        self.assertEqual(os.stat(key_path).st_mode & 0o777, 0o600)

    def test_a_healthy_server_of_a_previous_run_is_reused(self) -> None:
        nb.write_api_key(self.config, "existing-key")
        nb.write_server_state(
            self.config,
            {
                "pid": 4242,
                "port": 8000,
                "model_id": "model-a",
                "fingerprint": nb.deployment_fingerprint(
                    self.config, self.model, Path("/tmp/llama-server")
                ),
                "applied": {"ctx": 8192, "mtp": True, "reasoning": True},
            },
        )

        result, output = self._main(
            port_in_use=BusyPort(),
            server_healthy=lambda *args, **kwargs: True,
        )

        self.assertEqual(self.started, [])
        self.assertTrue(result["server_reused"])
        self.assertEqual(result["api_key"], "existing-key")
        self.assertIn("reused from a previous run", output)

    def test_a_server_with_a_different_configuration_is_restarted(self) -> None:
        nb.write_api_key(self.config, "old-key")
        nb.write_server_state(
            self.config,
            {
                "pid": 4242,
                "port": 8000,
                "model_id": "model-a",
                "fingerprint": "a-different-configuration",
                "applied": {"ctx": 4096, "mtp": False, "reasoning": False},
            },
        )

        result, output = self._main(
            port_in_use=BusyPort(),
            server_healthy=lambda *args, **kwargs: True,
        )

        self.assertEqual(len(self.started), 1)
        self.assertNotEqual(result["api_key"], "old-key")
        self.assertTrue(result["key_rotated"])
        self.assertEqual(len(self.stopped), 1)
        self.assertIn("The API key was rotated", output)

    def test_a_server_that_does_not_answer_is_restarted(self) -> None:
        nb.write_api_key(self.config, "old-key")
        nb.write_server_state(
            self.config,
            {
                "pid": 4242,
                "port": 8000,
                "model_id": "model-a",
                "fingerprint": nb.deployment_fingerprint(
                    self.config, self.model, Path("/tmp/llama-server")
                ),
                "applied": {"ctx": 8192, "mtp": True, "reasoning": True},
            },
        )

        result, _ = self._main(
            port_in_use=BusyPort(),
            server_healthy=lambda *args, **kwargs: False,
        )

        self.assertEqual(len(self.started), 1)
        self.assertTrue(result["key_rotated"])
        self.assertEqual(len(self.stopped), 1)

    def test_a_foreign_process_on_the_port_is_never_stopped(self) -> None:
        import contextlib
        import io

        with unittest.mock.patch.object(nb, "owns_process", lambda state: False):
            with unittest.mock.patch.object(nb, "port_in_use", lambda host, port: True):
                buffer = io.StringIO()
                with self.assertRaises(RuntimeError) as caught:
                    with contextlib.redirect_stdout(buffer):
                        nb.main(self.config)

        self.assertIn("did not start", str(caught.exception))
        self.assertEqual(self.started, [])
        self.assertEqual(self.stopped, [])


@unittest.skipUnless(REQUESTS_READY, "the requests package is not installed")
class PublicEndpointTests(unittest.TestCase):
    """The public route is verified against a local HTTP server."""

    def setUp(self) -> None:
        self.state = {"models_status": 200, "chat_status": 200, "body": None, "delay": 0}
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):  # noqa: N802 - http.server API
                if outer.state["delay"]:
                    time.sleep(outer.state["delay"])
                if self.path.endswith("/v1/models"):
                    self._send(
                        outer.state["models_status"],
                        json.dumps({"data": [{"id": "model-a"}]}).encode(),
                    )
                else:
                    self._send(404, b"{}")

            def do_POST(self):  # noqa: N802 - http.server API
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                outer.state["seen_auth"] = self.headers.get("Authorization")
                outer.state["seen_path"] = self.path
                if outer.state["delay"]:
                    time.sleep(outer.state["delay"])
                if outer.state["body"] is not None:
                    self._send(outer.state["chat_status"], outer.state["body"])
                    return
                payload = json.dumps(
                    {"choices": [{"message": {"role": "assistant", "content": "OK"}}]}
                ).encode()
                self._send(outer.state["chat_status"], payload)

            def _send(self, status: int, body: bytes) -> None:
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    # The client gave up (timeout test).
                    pass

            def log_message(self, *args):  # noqa: D102 - silence the test server
                return

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True
            block_on_close = False

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.url = f"http://{host}:{port}"
        # A session without the retry adapter: a timeout has to be seen.
        self.session = nb.requests.Session()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def test_a_working_public_route_is_verified_with_a_chat_completion(self) -> None:
        result = nb.verify_public_endpoint(self.session, self.url, "the-key", "model-a")

        self.assertTrue(result["models_ok"])
        self.assertTrue(result["inference_ok"])
        self.assertEqual(result["kind"], "ok")
        self.assertEqual(self.state["seen_path"], "/v1/chat/completions")
        self.assertEqual(self.state["seen_auth"], "Bearer the-key")

    def test_an_authentication_failure_is_reported(self) -> None:
        self.state["models_status"] = 401
        result = nb.verify_public_endpoint(self.session, self.url, "the-key", "model-a")

        self.assertFalse(result["models_ok"])
        self.assertFalse(result["inference_ok"])
        self.assertEqual(result["kind"], "auth")
        self.assertNotIn("the-key", result["detail"])

    def test_an_upstream_error_is_reported(self) -> None:
        self.state["chat_status"] = 500
        result = nb.verify_public_endpoint(self.session, self.url, "the-key", "model-a")

        self.assertTrue(result["models_ok"])
        self.assertFalse(result["inference_ok"])
        self.assertEqual(result["kind"], "upstream")

    def test_a_malformed_answer_is_reported(self) -> None:
        self.state["body"] = b"not json"
        result = nb.verify_public_endpoint(self.session, self.url, "the-key", "model-a")

        self.assertFalse(result["inference_ok"])
        self.assertEqual(result["kind"], "invalid_response")

    def test_an_answer_without_choices_is_reported(self) -> None:
        self.state["body"] = json.dumps({"choices": []}).encode()
        result = nb.verify_public_endpoint(self.session, self.url, "the-key", "model-a")

        self.assertFalse(result["inference_ok"])
        self.assertEqual(result["kind"], "invalid_response")

    def test_an_unreachable_endpoint_is_reported(self) -> None:
        with socket_holder() as (host, port):
            dead = f"http://{host}:{port}"

        result = nb.verify_public_endpoint(self.session, dead, "the-key", "model-a")

        self.assertFalse(result["inference_ok"])
        self.assertEqual(result["kind"], "unreachable")
        self.assertNotIn("the-key", result["detail"])

    def test_a_timeout_is_reported(self) -> None:
        self.state["delay"] = 2.0
        result = nb.verify_public_endpoint(
            self.session,
            self.url,
            "the-key",
            "model-a",
            timeout=(1, 1),
            completion_timeout=(1, 1),
        )

        self.assertFalse(result["inference_ok"])
        self.assertEqual(result["kind"], "timeout")


class RangeServerTests(unittest.TestCase):
    """End to end check of the resume logic against a real HTTP server."""

    def test_range_request_continues_the_download(self) -> None:
        payload = b"abcdefghij" * 50

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - http.server API
                raw_range = self.headers.get("Range")
                offset = 0
                if raw_range and raw_range.startswith("bytes="):
                    offset = int(raw_range.split("=", 1)[1].split("-", 1)[0])
                body = payload[offset:]
                self.send_response(206 if offset else 200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # noqa: D102 - silence the test server
                return

        socketserver.TCPServer.allow_reuse_address = True
        with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            host, port = server.server_address

            with tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / "asset.bin"
                part = destination.with_name(destination.name + ".part")
                part.write_bytes(payload[:120])

                if nb.REQUESTS_AVAILABLE:
                    session = nb.build_session()
                    nb.download_resumable(
                        session,
                        f"http://{host}:{port}/asset.bin",
                        destination,
                        min_bytes=10,
                    )
                    self.assertEqual(destination.read_bytes(), payload)

            server.shutdown()


class FakeTunnelProcess:
    """A stand-in for the cloudflared child process."""

    def __init__(self, exited: bool = False, fail_stop: bool = False) -> None:
        self._exited = exited
        self._fail_stop = fail_stop
        self.terminate_called = False
        self.kill_called = False

    def poll(self):
        return 0 if self._exited else None

    def terminate(self) -> None:
        if self._fail_stop:
            raise OSError("terminate refused")
        self.terminate_called = True

    def kill(self) -> None:
        self.kill_called = True

    def wait(self, timeout=None):
        return 0


class TunnelLifecycleTests(unittest.TestCase):
    """A tunnel that never reports its URL must not stay alive."""

    def _run(self, process, announce_url: str | None = None):
        with tempfile.TemporaryDirectory() as directory:
            config = nb.DeploymentConfig()
            config.root = Path(directory)

            def fake_popen(cmd, stdout=None, stderr=None, start_new_session=False):
                if announce_url and stdout is not None:
                    stdout.write(f"INF | Your quick Tunnel has been created! Visit it at:\nINF | {announce_url}\n")
                    stdout.flush()
                return process

            with unittest.mock.patch.object(nb, "get_cloudflared", lambda session, cfg: Path("/tmp/fake-cloudflared")), \
                 unittest.mock.patch.object(nb.subprocess, "Popen", fake_popen), \
                 unittest.mock.patch.object(nb.time, "sleep", lambda seconds: None):
                return nb.start_public_tunnel(object(), config)

    def test_a_timed_out_tunnel_process_is_stopped(self) -> None:
        process = FakeTunnelProcess()
        result = self._run(process)
        self.assertIsNone(result)
        self.assertTrue(process.terminate_called)

    def test_an_exited_tunnel_process_is_left_alone(self) -> None:
        process = FakeTunnelProcess(exited=True)
        result = self._run(process)
        self.assertIsNone(result)
        self.assertFalse(process.terminate_called)

    def test_a_failed_stop_never_reports_a_url(self) -> None:
        process = FakeTunnelProcess(fail_stop=True)
        result = self._run(process)
        # The cleanup failure is warned about but never turns the timeout
        # into a success: no URL is reported.
        self.assertIsNone(result)

    def test_a_reported_url_keeps_the_tunnel_running(self) -> None:
        process = FakeTunnelProcess()
        result = self._run(process, announce_url="https://abc-123.trycloudflare.com")
        self.assertEqual(result, "https://abc-123.trycloudflare.com")
        self.assertFalse(process.terminate_called)


class UnsupportedOptionsFreshnessTests(unittest.TestCase):
    """The reported unsupported options must come from the server this run started."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.config = nb.DeploymentConfig()
        self.config.root = Path(self.directory.name)
        self.config.enable_tunnel = False
        self.config.model_dir.mkdir(parents=True, exist_ok=True)
        self.model = self.config.model_dir / self.config.model_file
        self.model.write_bytes(b"GGUF" + b"0" * 2048)

        patches = [
            ("build_session", lambda: object()),
            ("check_gpus", lambda config: ["GPU 0: T4", "GPU 1: T4"]),
            ("get_server_binary", lambda session, config: Path("/tmp/llama-server")),
            ("find_saved_model", lambda config: self.model),
            ("probe_local_streaming", lambda *args, **kwargs: True),
            (
                "verify_local_authentication",
                lambda *args, **kwargs: {
                    "unauthenticated_rejected": True,
                    "wrong_key_rejected": True,
                    "authenticated_ok": True,
                    "detail": "Authentication verified by the test fixture.",
                },
            ),
            ("start_public_tunnel", lambda *args, **kwargs: None),
            ("owns_process", lambda state: True),
            ("stop_owned_server", lambda config, state: True),
            ("port_in_use", lambda host, port: False),
            ("server_healthy", lambda *args, **kwargs: False),
            ("start_server", self._start),
        ]
        self._patchers = [unittest.mock.patch.object(nb, name, replacement) for name, replacement in patches]
        for patcher in self._patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in self._patchers:
            patcher.stop()
        self.directory.cleanup()

    def _start(self, session, config, binary, model_path, api_key, **kwargs):
        # The real start_server writes the state of the server it started;
        # this stand-in does the same with a different dropped list than the
        # stale state of the previous run.
        nb.write_server_state(config, {
            "fingerprint": "fresh",
            "dropped": ["fresh-flag"],
            "pid": 4321,
            "model_id": "model-a",
            "applied": {},
        })
        return "model-a", {"ctx": 8192, "mtp": False, "reasoning": False, "n_gpu_layers": 99}

    def test_a_restart_reports_the_dropped_options_of_the_new_server(self) -> None:
        import contextlib

        # A stale state of a previous run with a different fingerprint.
        nb.write_server_state(self.config, {
            "fingerprint": "stale",
            "dropped": ["stale-flag"],
            "pid": 1234,
            "model_id": "old-model",
            "applied": {},
        })

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            result = nb.main(self.config)

        # The stale snapshot said "stale-flag"; the server started by this run
        # says "fresh-flag". Only the fresh value may be reported.
        self.assertEqual(result["applied"]["unsupported_options"], ["fresh-flag"])
        self.assertFalse(result["server_reused"])


class ModelChecksumTests(unittest.TestCase):
    """Optional, operator-supplied pinning of the model weights."""

    GGUF_PAYLOAD = b"GGUF" + b"7" * 4092

    def _config(self, directory: str) -> nb.DeploymentConfig:
        config = nb.DeploymentConfig()
        config.root = Path(directory)
        config.input_root = Path(directory) / "input"
        config.min_model_bytes = 1024
        return config

    def _write_gguf(self, path: Path, size: int) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            handle.write(b"GGUF")
            handle.write(b"\0" * max(0, size - 4))
        return path

    def test_a_saved_model_with_a_mismatched_digest_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._config(directory)
            config.model_sha256 = "0" * 64
            path = self._write_gguf(config.model_dir / config.model_file, 2048)
            self.assertIsNone(nb.find_saved_model(config))

            config.model_sha256 = nb.sha256_of(path)
            self.assertEqual(nb.find_saved_model(config), path)

    def test_a_saved_model_without_a_configured_digest_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._config(directory)
            path = self._write_gguf(config.model_dir / config.model_file, 2048)
            self.assertEqual(nb.find_saved_model(config), path)

    def test_the_direct_download_resolves_the_configured_revision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._config(directory)
            config.model_revision = "rev-42"
            session = FakeSession(self.GGUF_PAYLOAD)
            with unittest.mock.patch.dict(sys.modules, {"huggingface_hub": None}):
                path = nb.download_model(session, config)
            self.assertTrue(path.exists())
            self.assertIn("/resolve/rev-42/", session.ranges[0][0])

    def test_the_direct_download_fails_closed_on_a_wrong_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self._config(directory)
            config.model_revision = "rev-42"
            config.model_sha256 = "0" * 64
            session = FakeSession(self.GGUF_PAYLOAD)
            with unittest.mock.patch.dict(sys.modules, {"huggingface_hub": None}):
                with self.assertRaises(nb.ChecksumMismatch):
                    nb.download_model(session, config)
            self.assertFalse((config.model_dir / config.model_file).exists())

    def test_the_direct_download_accepts_a_matching_digest(self) -> None:
        import hashlib

        with tempfile.TemporaryDirectory() as directory:
            config = self._config(directory)
            config.model_sha256 = hashlib.sha256(self.GGUF_PAYLOAD).hexdigest()
            session = FakeSession(self.GGUF_PAYLOAD)
            with unittest.mock.patch.dict(sys.modules, {"huggingface_hub": None}):
                path = nb.download_model(session, config)
            self.assertTrue(path.exists())

    def test_the_hub_download_receives_the_configured_revision(self) -> None:
        import types

        calls: dict = {}

        def fake_hf_hub_download(repo_id, filename, local_dir, revision=None):
            calls["revision"] = revision
            destination = Path(local_dir) / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(self.GGUF_PAYLOAD)
            return str(destination)

        fake_module = types.ModuleType("huggingface_hub")
        fake_module.hf_hub_download = fake_hf_hub_download

        with tempfile.TemporaryDirectory() as directory:
            config = self._config(directory)
            config.model_revision = "rev-42"
            with unittest.mock.patch.dict(sys.modules, {"huggingface_hub": fake_module}):
                path = nb.download_model(FakeSession(b""), config)
            self.assertEqual(calls["revision"], "rev-42")
            self.assertTrue(path.exists())

    def test_a_tampered_file_never_passes_either_download_path(self) -> None:
        import types

        tampered = b"GGUF" + b"9" * 4092

        def fake_hf_hub_download(repo_id, filename, local_dir, revision=None):
            destination = Path(local_dir) / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(tampered)
            return str(destination)

        fake_module = types.ModuleType("huggingface_hub")
        fake_module.hf_hub_download = fake_hf_hub_download

        with tempfile.TemporaryDirectory() as directory:
            config = self._config(directory)
            config.model_sha256 = "0" * 64  # a digest the tampered file cannot match
            session = FakeSession(tampered)
            with unittest.mock.patch.dict(sys.modules, {"huggingface_hub": fake_module}):
                with self.assertRaises(nb.ChecksumMismatch):
                    nb.download_model(session, config)
            self.assertFalse((config.model_dir / config.model_file).exists())


class RaonDeploymentTests(unittest.TestCase):
    """Raon-1 mini preview on T4 x2: pinned sources, sizing, gated download."""

    GGUF_PAYLOAD = b"GGUF" + b"5" * 4092

    def test_the_default_deployment_stays_the_verified_qwen_one(self) -> None:
        config = nb.DeploymentConfig()
        self.assertEqual(config.repo, "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF")
        self.assertEqual(config.model_file, "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf")
        self.assertEqual(config.llama_cpp_source, "release")
        self.assertEqual(config.llama_cpp_tags, ("b11719", "b11718", "b11717"))
        self.assertFalse(config.requires_hf_token)
        self.assertEqual(nb.config_for_model("qwen").repo, config.repo)
        self.assertEqual(nb.config_for_model("").repo, config.repo)

    def test_an_unknown_model_name_is_refused_explicitly(self) -> None:
        with self.assertRaises(ValueError):
            nb.config_for_model("llama")

    def test_the_raon_preset_is_pinned_and_kept_apart_from_qwen(self) -> None:
        config = nb.raon_deployment_config()
        self.assertEqual(config.repo, "KRAFTON/Raon-1-mini-preview-gguf")
        # Exact revision + digest pins from the official repo metadata.
        self.assertEqual(len(config.model_revision), 40)
        self.assertEqual(config.model_revision, nb.RAON_GGUF_REVISION)
        file_name, size, digest = nb.RAON_QUANTIZATIONS["Q4_K_M"]
        self.assertEqual(config.model_file, file_name)
        self.assertEqual(config.min_model_bytes, size)
        self.assertEqual(config.model_sha256, digest)
        self.assertEqual(len(digest), 64)
        self.assertEqual(config.llama_cpp_source, "krafton-branch")
        self.assertTrue(config.requires_hf_token)
        self.assertFalse(config.enable_mtp)  # no Qwen MTP flags for Raon
        self.assertEqual(config.model_alias, "Raon-1-mini-preview")
        self.assertNotEqual(config.root, nb.DeploymentConfig().root)
        self.assertEqual(nb.config_for_model("raon").repo, config.repo)

    def test_every_published_quantization_has_a_size_and_a_digest(self) -> None:
        for name in nb.RAON_QUANTIZATION_PREFERENCE:
            file_name, size, digest = nb.RAON_QUANTIZATIONS[name]
            self.assertTrue(file_name.endswith(".gguf"), name)
            self.assertGreater(size, 10_000_000_000, name)
            self.assertEqual(len(digest), 64, name)
            int(digest, 16)  # must be hex

    def test_quantization_selection_uses_per_device_headroom_not_aggregate_vram(self) -> None:
        gib = 1024 ** 3
        self.assertEqual(nb.select_raon_quantization(15 * gib), "Q4_K_M")
        self.assertEqual(nb.select_raon_quantization(16 * gib), "Q4_K_M")
        self.assertEqual(nb.select_raon_quantization(32 * gib), "Q8_0")
        # The conservative share leaves real headroom on a T4.
        share = nb.estimate_per_device_bytes(nb.RAON_QUANTIZATIONS["Q4_K_M"][1])
        self.assertLess(share, int(15 * gib * 0.70))
        with self.assertRaises(RuntimeError):
            nb.select_raon_quantization(8 * gib)
        with self.assertRaises(ValueError):
            nb.apply_raon_quantization(nb.DeploymentConfig(), "Q3_K_M")

    def test_gpu_memory_parsing_reads_nvidia_smi_mib_lines(self) -> None:
        self.assertEqual(
            nb._parse_gpu_memory_mib("16384\n16384\n"),
            [16384 * 1024 * 1024, 16384 * 1024 * 1024],
        )
        self.assertEqual(nb._parse_gpu_memory_mib("no devices\n"), [])

    def test_a_missing_gated_token_fails_before_any_download(self) -> None:
        import types

        hub_without_token = types.ModuleType("huggingface_hub")
        hub_without_token.get_token = lambda: None
        hub_without_token.hf_hub_download = lambda **kwargs: self.fail("must not download")

        with tempfile.TemporaryDirectory() as directory:
            config = nb.raon_deployment_config()
            config.root = Path(directory)
            config.input_root = Path(directory) / "input"
            session = FakeSession(self.GGUF_PAYLOAD)
            with unittest.mock.patch.dict(os.environ, {}, clear=True):
                with unittest.mock.patch.dict(sys.modules, {"huggingface_hub": hub_without_token}):
                    with self.assertRaises(RuntimeError) as raised:
                        nb.download_model(session, config)
            self.assertIn("access-gated", str(raised.exception))
            self.assertIn("HF_TOKEN", str(raised.exception))
            self.assertEqual(session.ranges, [])  # no request was attempted

    def test_the_token_only_travels_in_the_hf_request_header(self) -> None:
        token = "hf-test-token-not-a-real-secret"
        with tempfile.TemporaryDirectory() as directory:
            config = nb.DeploymentConfig()
            config.root = Path(directory)
            config.input_root = Path(directory) / "input"
            config.min_model_bytes = 1024
            config.requires_hf_token = True
            session = FakeSession(self.GGUF_PAYLOAD)
            with unittest.mock.patch.dict(os.environ, {"HF_TOKEN": token}):
                with unittest.mock.patch.dict(sys.modules, {"huggingface_hub": None}):
                    path = nb.download_model(session, config)
            self.assertTrue(path.exists())
            url, headers = session.ranges[0]
            self.assertTrue(url.startswith("https://huggingface.co/"))
            self.assertNotIn(token, url)
            self.assertEqual(headers.get("Authorization"), f"Bearer {token}")

    def test_the_krafton_build_is_pinned_to_a_commit_and_builds_only_the_server(self) -> None:
        url = nb.krafton_llama_archive_url()
        self.assertIn(nb.KRAFTON_LLAMA_CPP_REF, url)
        self.assertEqual(len(nb.KRAFTON_LLAMA_CPP_REF), 40)
        self.assertNotIn("latest", url)
        commands = nb.krafton_build_commands(Path("/src"), Path("/build"))
        self.assertIn("-DGGML_CUDA=ON", commands[0])
        self.assertIn("llama-server", commands[1])
        for command in commands:
            self.assertNotIn("sh", command[0])

    def test_raon_startup_args_are_filtered_by_build_support_and_mtp_stays_off(self) -> None:
        config = nb.raon_deployment_config()
        supported = nb.server_flags(
            "--api-key-file --alias --temp --top-p --top-k --min-p --repeat-penalty "
            "--split-mode --tensor-split --cache-type-k --cache-type-v --jinja"
        )
        launch = nb.build_server_command(
            config,
            Path("/tmp/llama-server"),
            Path("/tmp/raon.gguf"),
            "secret",
            supported,
            {"ctx": 8192, "mtp": False, "reasoning": True},
            api_key_file=Path("/tmp/api_key.txt"),
        )
        self.assertEqual(launch.applied["alias"], "Raon-1-mini-preview")
        self.assertIn("--temp", launch.command)
        self.assertIn("--top-k", launch.command)
        self.assertIn("20", launch.command)
        # Unsupported extras are dropped and reported, never sent blind.
        self.assertNotIn("--reasoning", launch.command)
        self.assertIn("extra:--reasoning", launch.dropped)
        self.assertIn("extra:--chat-template-kwargs", launch.dropped)
        # No Qwen speculative-decoding flags and no key in argv.
        self.assertNotIn("--spec-type", launch.command)
        self.assertFalse(launch.applied["mtp"])
        self.assertNotIn("secret", launch.command)

    def test_the_qwen_fingerprint_is_unchanged_but_raon_is_distinct(self) -> None:
        import hashlib
        import json as json_module

        config = nb.DeploymentConfig()
        legacy_payload = {
            "model_file": "/m/model.gguf",
            "binary": "/b/llama-server",
            "host": config.host,
            "port": config.port,
            "ctx_size": config.ctx_size,
            "enable_mtp": bool(config.enable_mtp),
            "reasoning_effort": config.reasoning_effort,
            "n_gpu_layers": config.n_gpu_layers,
            "split_mode": config.split_mode,
            "tensor_split": config.tensor_split,
        }
        legacy = hashlib.sha256(json_module.dumps(legacy_payload, sort_keys=True).encode()).hexdigest()
        current = nb.deployment_fingerprint(config, Path("/m/model.gguf"), Path("/b/llama-server"))
        self.assertEqual(current, legacy)

        raon = nb.raon_deployment_config()
        self.assertNotEqual(
            nb.deployment_fingerprint(raon, Path("/m/model.gguf"), Path("/b/llama-server")),
            current,
        )

    def test_the_raon_runtime_bundle_names_the_deployment_without_the_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = nb.raon_deployment_config()
            config.root = Path(directory)
            model_path = config.model_dir / config.model_file
            model_path.parent.mkdir(parents=True, exist_ok=True)
            model_path.write_bytes(self.GGUF_PAYLOAD)
            paths = nb.write_runtime_bundle(
                config,
                "raon-secret",
                "Raon-1-mini-preview",
                model_path,
                {"ctx": 8192, "mtp": False, "alias": "Raon-1-mini-preview", "extra_args": ["--temp=1.0"]},
                None,
                Path("/tmp/llama-server"),
            )
            runtime = json.loads(paths["runtime"].read_text())
            profile = json.loads(paths["profile"].read_text())
            self.assertEqual(runtime["deployment"], "Raon")
            self.assertEqual(runtime["model_repo"], "KRAFTON/Raon-1-mini-preview-gguf")
            self.assertEqual(runtime["model_revision"], nb.RAON_GGUF_REVISION)
            self.assertFalse(runtime["mtp_speculative_decoding"])
            self.assertNotIn("enabled with --spec-type", runtime["mtp_note"])
            self.assertEqual(profile["name"], "Kaggle T4 x2 - Raon")
            self.assertNotIn("raon-secret", paths["runtime"].read_text())
            self.assertNotIn("raon-secret", paths["profile"].read_text())



class SparkDeploymentTests(unittest.TestCase):
    """Spark-X2.6-4B on T4 x2: official artifacts, pins and fail-closed rules."""

    GGUF_PAYLOAD = b"GGUF" + b"7" * 4092

    def test_the_spark_preset_is_pinned_to_official_artifacts_only(self) -> None:
        config = nb.spark_deployment_config()
        self.assertEqual(config.repo, "XHToken/Spark-X2.6-4B-GGUF")
        self.assertEqual(config.model_revision, nb.SPARK_GGUF_REVISION)
        self.assertEqual(len(config.model_revision), 40)
        self.assertEqual(config.llama_cpp_tags, ("b11719",))
        self.assertFalse(config.requires_hf_token)  # public/ungated
        self.assertFalse(config.enable_mtp)  # no draft head for Spark
        self.assertTrue(config.require_jinja)  # template-defined thinking/tools
        self.assertEqual(config.min_llama_cpp_build, 10828)
        self.assertEqual(config.model_alias, "Spark-X2.6-4B")
        self.assertEqual(config.reasoning_effort, "high")  # template default
        self.assertEqual(config.thinking_levels, ("none", "low", "high"))
        self.assertEqual(config.thinking_mechanism, "llama_cpp_reasoning_effort")
        self.assertEqual(config.quantization, "Q4_K_M")
        self.assertNotEqual(config.root, nb.DeploymentConfig().root)
        self.assertNotEqual(config.root, nb.raon_deployment_config().root)
        self.assertEqual(nb.config_for_model("spark").repo, config.repo)

    def test_every_exposed_quantization_is_a_pinned_official_file(self) -> None:
        self.assertEqual(set(nb.SPARK_QUANTIZATIONS), {"Q4_K_M", "Q8_0"})
        for name, (file_name, size, digest) in nb.SPARK_QUANTIZATIONS.items():
            self.assertTrue(file_name.endswith(".gguf"), name)
            self.assertTrue(file_name.startswith("Spark-X2.6-4B-"), name)
            self.assertGreater(size, 3_000_000_000, name)
            self.assertEqual(len(digest), 64, name)
            int(digest, 16)  # must be hex
        self.assertEqual(
            nb.SPARK_QUANTIZATIONS["Q4_K_M"],
            (
                "Spark-X2.6-4B-Q4_K_M.gguf",
                3_543_441_312,
                "91cb2811aebb47ac916aa619d27d4cdd7f4143106b7917accb8ead4cd7f5cbd9",
            ),
        )
        self.assertEqual(
            nb.SPARK_QUANTIZATIONS["Q8_0"],
            (
                "Spark-X2.6-4B-Q8_0.gguf",
                4_375_021_824,
                "145c2aa606820663f26ad530b8fc141ed885e2e9ca29f9be7c3bfe8931d58b81",
            ),
        )

    def test_the_quantization_comes_from_the_environment_and_fails_closed(self) -> None:
        self.assertEqual(nb.spark_quantization_from_env({}), "Q4_K_M")
        self.assertEqual(nb.spark_quantization_from_env({"KAGGLE_KIT_QUANTIZATION": "Q8_0"}), "Q8_0")
        for missing in ("Q5_K_M", "Q6_K"):
            with self.assertRaises(ValueError) as raised:
                nb.spark_quantization_from_env({"KAGGLE_KIT_QUANTIZATION": missing})
            # The error names the file that does not exist and the choices that do.
            self.assertIn(missing, str(raised.exception))
            self.assertIn("no " + missing, str(raised.exception))
            self.assertIn("Q4_K_M, Q8_0", str(raised.exception))
        with self.assertRaises(ValueError) as raised:
            nb.spark_quantization_from_env({"KAGGLE_KIT_QUANTIZATION": "Q3_K_M"})
        self.assertIn("Unknown Spark quantization", str(raised.exception))
        self.assertIn("Q4_K_M, Q8_0", str(raised.exception))
        with self.assertRaises(ValueError):
            nb.apply_spark_quantization(nb.spark_deployment_config(), "Q1_0")
        with self.assertRaises(ValueError):
            nb.config_for_model("spark", {"KAGGLE_KIT_QUANTIZATION": "Q5_K_M"})
        # Selecting Q8_0 really changes the pinned file, size and digest.
        q8 = nb.spark_deployment_config("Q8_0")
        self.assertEqual(q8.model_file, "Spark-X2.6-4B-Q8_0.gguf")
        self.assertEqual(q8.quantization, "Q8_0")

    def test_a_quantization_that_cannot_fit_two_devices_is_refused_before_download(self) -> None:
        # 3.54 GB over two 15 GiB devices is far below the 70% guard; the guard
        # exists for a future artifact, so a too-small device budget must raise.
        with self.assertRaises(RuntimeError):
            nb.spark_deployment_config("Q4_K_M", per_gpu_usable_bytes=2_000_000_000)

    def test_the_build_number_is_parsed_and_old_builds_are_not_accepted(self) -> None:
        self.assertEqual(nb.parse_llama_cpp_build("version: b11719 (build 11719, commit abc)"), 11719)
        self.assertEqual(nb.parse_llama_cpp_build("build 10828"), 10828)
        self.assertIsNone(nb.parse_llama_cpp_build("version: 9.9.9"))
        self.assertTrue(nb.build_supports_minimum("version: b11719 (build 11719)", 10828))
        self.assertFalse(nb.build_supports_minimum("version: b10827 (build 10827)", 10828))
        # Unparsable output is never "new enough".
        self.assertFalse(nb.build_supports_minimum("unknown", 10828))
        self.assertTrue(nb.build_supports_minimum("unknown", None))

    def test_spark_startup_requires_jinja_and_never_sends_qwen_speculation(self) -> None:
        config = nb.spark_deployment_config()
        supported = nb.server_flags(
            "--api-key-file --alias --temp --top-p --top-k --jinja --reasoning-effort "
            "--split-mode --tensor-split --cache-type-k --cache-type-v"
        )
        launch = nb.build_server_command(
            config,
            Path("/tmp/llama-server"),
            Path("/tmp/spark.gguf"),
            "spark-secret",
            supported,
            {"ctx": 8192, "mtp": False, "reasoning": True},
            api_key_file=Path("/tmp/api_key.txt"),
        )
        self.assertTrue(launch.applied["jinja"])
        self.assertIn("--jinja", launch.command)
        self.assertEqual(launch.applied["alias"], "Spark-X2.6-4B")
        self.assertEqual(launch.applied["reasoning_effort"], "high")
        self.assertNotIn("medium", launch.command)
        self.assertNotIn("--spec-type", launch.command)
        self.assertFalse(launch.applied["mtp"])
        self.assertNotIn("spark-secret", launch.command)

        # A build without --jinja is refused instead of serving a substituted
        # template.
        without_jinja = nb.server_flags("--api-key-file --alias --ctx-size")
        with self.assertRaises(RuntimeError) as raised:
            nb.build_server_command(
                config,
                Path("/tmp/llama-server"),
                Path("/tmp/spark.gguf"),
                "spark-secret",
                without_jinja,
                {"ctx": 8192, "mtp": False, "reasoning": False},
                api_key_file=Path("/tmp/api_key.txt"),
            )
        self.assertIn("--jinja", str(raised.exception))

    def test_spark_runtime_bundle_records_the_pins_without_the_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = nb.spark_deployment_config("Q8_0")
            config.root = Path(directory)
            model_path = config.model_dir / config.model_file
            model_path.parent.mkdir(parents=True, exist_ok=True)
            model_path.write_bytes(self.GGUF_PAYLOAD)
            paths = nb.write_runtime_bundle(
                config,
                "spark-secret",
                "Spark-X2.6-4B",
                model_path,
                {"ctx": 8192, "mtp": False, "reasoning": True, "reasoning_effort": "high"},
                None,
                Path("/tmp/llama-server"),
                authentication={"authenticated_ok": True, "unauthenticated_rejected": True,
                                "detail": "verified in test"},
            )
            runtime = json.loads(paths["runtime"].read_text())
            self.assertEqual(runtime["deployment"], "Spark")
            self.assertEqual(runtime["model_repo"], "XHToken/Spark-X2.6-4B-GGUF")
            self.assertEqual(runtime["model_revision"], nb.SPARK_GGUF_REVISION)
            self.assertEqual(runtime["quantization"], "Q8_0")
            self.assertEqual(runtime["model_sha256"], nb.SPARK_QUANTIZATIONS["Q8_0"][2])
            self.assertEqual(runtime["thinking_levels"], ["none", "low", "high"])
            self.assertEqual(runtime["thinking_mechanism"], "llama_cpp_reasoning_effort")
            self.assertFalse(runtime["mtp_speculative_decoding"])
            self.assertTrue(runtime["authentication_enforced"])
            self.assertEqual(json.loads(paths["profile"].read_text())["model"], "Spark-X2.6-4B")
            self.assertNotIn("spark-secret", paths["runtime"].read_text())
            self.assertNotIn("spark-secret", paths["profile"].read_text())

    def test_spark_is_distinct_in_the_deployment_fingerprint(self) -> None:
        qwen = nb.DeploymentConfig()
        spark = nb.spark_deployment_config()
        self.assertNotEqual(
            nb.deployment_fingerprint(spark, Path("/m/spark.gguf"), Path("/b/llama-server")),
            nb.deployment_fingerprint(qwen, Path("/m/qwen.gguf"), Path("/b/llama-server")),
        )


class LocalAuthenticationTests(unittest.TestCase):
    """A keyed llama-server must reject anonymous and wrongly keyed requests."""

    def _serve(self, require_key: str, open_server: bool = False) -> tuple:
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server API
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                header = self.headers.get("Authorization") or ""
                if not open_server and header != f"Bearer {require_key}":
                    payload = b'{"error":{"message":"Invalid API Key"}}'
                    self.send_response(401)
                else:
                    payload = (
                        b'{"choices":[{"message":{"role":"assistant","content":"OK"}}]}'
                    )
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):  # noqa: D102 - silence the test server
                return

        socketserver.TCPServer.allow_reuse_address = True
        server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        host, port = server.server_address
        config = nb.DeploymentConfig()
        config.host = host
        config.port = port
        return config, "spark-secret"

    def test_a_keyed_server_passes_all_three_requests(self) -> None:
        if not nb.REQUESTS_AVAILABLE:
            self.skipTest("requests is not installed")
        config, key = self._serve("spark-secret")
        result = nb.verify_local_authentication(nb.build_session(), config, key, "Spark-X2.6-4B")
        self.assertTrue(result["unauthenticated_rejected"])
        self.assertTrue(result["wrong_key_rejected"])
        self.assertTrue(result["authenticated_ok"])
        self.assertIn("401/403", result["detail"])

    def test_a_server_that_answers_anonymous_requests_fails_the_check(self) -> None:
        if not nb.REQUESTS_AVAILABLE:
            self.skipTest("requests is not installed")
        # A server that treats every request as authorized must not pass the
        # gate, even though the correctly keyed request would also answer.
        config, key = self._serve("spark-secret", open_server=True)
        result = nb.verify_local_authentication(nb.build_session(), config, key, "Spark-X2.6-4B")
        self.assertFalse(result["unauthenticated_rejected"])
        self.assertFalse(result["wrong_key_rejected"])
        self.assertTrue(result["authenticated_ok"])
        self.assertIn("No tunnel is started", result["detail"])
        # The gate is a three-part conjunction, so this state cannot continue.
        self.assertFalse(
            result["unauthenticated_rejected"]
            and result["wrong_key_rejected"]
            and result["authenticated_ok"]
        )


if __name__ == "__main__":
    unittest.main()
