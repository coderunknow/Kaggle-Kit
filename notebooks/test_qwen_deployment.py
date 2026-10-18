"""
Tests for the Kaggle deployment script.

The tests only cover the parts that can run without a GPU: flag selection,
model discovery, the resume logic of the downloader and the runtime bundle
that connects the deployment to the chat interface.

    python3 -m unittest discover -s notebooks -p "test_*.py"
"""

from __future__ import annotations

import http.server
import json
import os
import socketserver
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import qwen3_8_27b_api as nb  # noqa: E402


class FakeResponse:
    """Minimal stand in for the parts of ``requests.Response`` that are used."""

    def __init__(self, payload: bytes, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.headers = {"content-type": "application/octet-stream"}

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args) -> bool:
        return False

    def iter_content(self, chunk_size: int = 1024):
        for start in range(0, len(self._payload), chunk_size):
            yield self._payload[start : start + chunk_size]

    def raise_for_status(self) -> None:
        return None


class FakeSession:
    """A session that serves a payload and records the range requests."""

    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.ranges: list = []

    def get(self, url, headers=None, stream=False, allow_redirects=True, timeout=None):
        self.ranges.append((url, dict(headers or {})))
        offset = 0
        raw_range = (headers or {}).get("Range")
        if raw_range and raw_range.startswith("bytes="):
            offset = int(raw_range.split("=", 1)[1].split("-", 1)[0])
        return FakeResponse(self.payload[offset:], 206 if offset else 200)


class FlagSelectionTests(unittest.TestCase):
    def test_server_flags_reads_the_long_options(self) -> None:
        text = "  --ctx-size N     context size\n  --flash-attn on\n  --reasoning-effort <value>\n"
        flags = nb.server_flags(text)
        self.assertIn("--ctx-size", flags)
        self.assertIn("--flash-attn", flags)
        self.assertIn("--reasoning-effort", flags)
        self.assertNotIn("--not-a-flag", flags)

    def test_command_only_contains_supported_flags(self) -> None:
        config = nb.DeploymentConfig()
        config.root = Path("/tmp/qwen-test")
        binary = Path("/tmp/llama-server")
        model = Path("/tmp/model.gguf")

        supported = nb.server_flags("--ctx-size N --n-gpu-layers N --host H --port P --api-key K")
        command = nb.build_server_command(
            config,
            binary,
            model,
            "secret",
            supported,
            {"ctx": 8192, "mtp": True, "reasoning": True},
        )

        self.assertIn("--ctx-size", command)
        self.assertNotIn("--split-mode", command)
        self.assertNotIn("--tensor-split", command)
        self.assertNotIn("--flash-attn", command)
        self.assertNotIn("--reasoning-effort", command)
        self.assertNotIn("--spec-type", command)
        self.assertNotIn("--jinja", command)

    def test_command_adds_mtp_and_reasoning_when_supported(self) -> None:
        config = nb.DeploymentConfig()
        supported = nb.server_flags(
            "--ctx-size N --split-mode M --tensor-split T --cache-type-k T "
            "--cache-type-v T --flash-attn on --jinja --reasoning-effort <value> "
            "--spec-type T --spec-draft-n-max N"
        )
        command = nb.build_server_command(
            config,
            Path("/tmp/llama-server"),
            Path("/tmp/model.gguf"),
            "secret",
            supported,
            {"ctx": 8192, "mtp": True, "reasoning": True},
        )

        self.assertIn("--split-mode", command)
        self.assertIn("layer", command)
        self.assertIn("--tensor-split", command)
        self.assertIn("--reasoning-effort", command)
        self.assertIn("medium", command)
        self.assertIn("draft-mtp", command)

    def test_variants_start_with_the_verified_configuration(self) -> None:
        config = nb.DeploymentConfig()
        variants = nb.server_variants(config)
        self.assertEqual(variants[0]["ctx"], 8192)
        self.assertTrue(variants[0]["mtp"])
        self.assertTrue(any(not variant["mtp"] for variant in variants))


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
                {"ctx": 8192, "mtp": True, "reasoning": True},
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
            self.assertEqual(profile["model"], "model-a")


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


if __name__ == "__main__":
    unittest.main()
