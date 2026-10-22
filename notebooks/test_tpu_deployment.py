"""
Tests for the Kaggle TPU deployment script.

No TPU exists in the test environment, so these tests cover exactly the
parts that must be right before hardware enters the picture: combination
support/refusal, device-count truth, the pinned runtime and server command
(no MTP, no key in argv), ownership rules, and the HTTP verification helpers
against a local HTTP server.

    python3 -m unittest discover -s notebooks -p "test_*.py"
"""

from __future__ import annotations

import http.server
import json
import socketserver
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import tpu_deployment as tpu  # noqa: E402

TPU_DEVICES = [f"tpu:TPU v5e" for _ in range(8)]


class CombinationSupportTests(unittest.TestCase):
    def test_raon_on_tpu_is_blocked_with_reasons_and_no_fallback(self) -> None:
        config = tpu.config_for_model("raon")
        with self.assertRaises(tpu.UnsupportedDeploymentError) as raised:
            tpu.ensure_supported_combination(config)
        message = str(raised.exception)
        self.assertIn("blocked", message)
        self.assertIn("GGUF", message)
        self.assertIn("CUDA", message)
        self.assertIn("no CPU/GPU/hosted fallback was substituted", message)
        for reason in tpu.RAON_TPU_BLOCKED_REASONS:
            self.assertIn(reason, message)

    def test_mtp_is_refused_not_silently_dropped(self) -> None:
        config = tpu.TpuDeploymentConfig(enable_mtp=True)
        with self.assertRaises(tpu.UnsupportedDeploymentError) as raised:
            tpu.ensure_supported_combination(config)
        self.assertIn("MTP", str(raised.exception))
        self.assertIn("corrupt", str(raised.exception))

    def test_tensor_parallel_must_cover_the_whole_v5e8_slice(self) -> None:
        config = tpu.TpuDeploymentConfig(tensor_parallel_size=4)
        with self.assertRaises(tpu.UnsupportedDeploymentError):
            tpu.ensure_supported_combination(config)

    def test_qwen_is_the_implemented_default(self) -> None:
        config = tpu.config_for_model("qwen")
        tpu.ensure_supported_combination(config)  # must not raise
        self.assertEqual(config.repo, "Qwen/Qwen3.8-27B")
        self.assertEqual(config.revision, tpu.QWEN_TPU_REVISION)
        self.assertEqual(len(config.revision), 40)
        self.assertFalse(config.enable_mtp)
        with self.assertRaises(ValueError):
            tpu.config_for_model("llama")


class HardwareTruthTests(unittest.TestCase):
    def test_eight_tpu_devices_are_accepted(self) -> None:
        devices = tpu.require_tpu_v5e8(
            tpu.TpuDeploymentConfig(), device_lister=lambda: TPU_DEVICES,
        )
        self.assertEqual(len(devices), 8)

    def test_a_cpu_only_session_aborts_instead_of_falling_back(self) -> None:
        with self.assertRaises(RuntimeError) as raised:
            tpu.require_tpu_v5e8(
                tpu.TpuDeploymentConfig(),
                device_lister=lambda: ["cpu:CPU"],
            )
        self.assertIn("TpuV5E8", str(raised.exception))
        self.assertIn("never falls back to CPU", str(raised.exception))

    def test_a_partial_tpu_slice_aborts(self) -> None:
        with self.assertRaises(RuntimeError):
            tpu.require_tpu_v5e8(
                tpu.TpuDeploymentConfig(),
                device_lister=lambda: TPU_DEVICES[:4],
            )

    def test_a_missing_jax_reports_zero_devices(self) -> None:
        def broken() -> list:
            raise ImportError("no jax")

        self.assertEqual(tpu.detect_tpu_devices(broken), [])


class ServerCommandTests(unittest.TestCase):
    def test_the_command_shards_bf16_across_eight_chips_without_mtp_or_the_key(self) -> None:
        config = tpu.TpuDeploymentConfig()
        command, env = tpu.build_vllm_serve_command(config)
        joined = " ".join(command)
        self.assertIn("vllm.entrypoints.openai.api_server", joined)
        self.assertIn("Qwen/Qwen3.8-27B", command)
        self.assertIn(tpu.QWEN_TPU_REVISION, command)  # pinned, never moving
        self.assertIn("--tensor-parallel-size", command)
        self.assertIn("8", command)
        self.assertIn("bfloat16", command)
        self.assertIn("Qwen3.8-27B", command)  # served model name
        # No speculative decoding of any spelling, and no key material in argv.
        self.assertNotIn("speculative", joined.lower())
        self.assertNotIn("mtp", joined.lower())
        self.assertNotIn("--api-key", command)
        self.assertEqual(env.get("PJRT_DEVICE"), "TPU")

    def test_the_runtime_install_is_pinned(self) -> None:
        command = tpu.pip_install_command(tpu.TpuDeploymentConfig())
        self.assertIn(f"vllm-tpu=={tpu.VLLM_TPU_VERSION}", command)
        self.assertNotIn("latest", " ".join(command))
        self.assertTrue(tpu.runtime_installed("0.28.0", version_lookup=lambda: "0.28.0"))
        self.assertFalse(tpu.runtime_installed("0.28.0", version_lookup=lambda: "0.32.0"))
        self.assertFalse(tpu.runtime_installed("0.28.0", version_lookup=lambda: None))

    def test_the_fingerprint_changes_with_revision_and_runtime(self) -> None:
        base = tpu.deployment_fingerprint(tpu.TpuDeploymentConfig())
        other_revision = tpu.deployment_fingerprint(
            tpu.TpuDeploymentConfig(revision="0" * 40),
        )
        other_runtime = tpu.deployment_fingerprint(
            tpu.TpuDeploymentConfig(vllm_tpu_version="9.9.9"),
        )
        self.assertNotEqual(base, other_revision)
        self.assertNotEqual(base, other_runtime)

    def test_the_decision_matrix_never_touches_foreign_processes(self) -> None:
        decide = tpu.decide_server_action
        self.assertEqual(decide(port_busy=False, owned=False, healthy=False, compatible=False), "start")
        self.assertEqual(decide(port_busy=True, owned=False, healthy=True, compatible=True), "conflict")
        self.assertEqual(decide(port_busy=True, owned=True, healthy=True, compatible=True), "reuse")
        self.assertEqual(decide(port_busy=True, owned=True, healthy=False, compatible=True), "restart")
        self.assertEqual(decide(port_busy=True, owned=True, healthy=True, compatible=False), "restart")
        self.assertFalse(tpu.owns_process(None))
        self.assertFalse(tpu.owns_process({"pid": 0}))


class _FakeVllmHandler(http.server.BaseHTTPRequestHandler):
    api_key = "tpu-test-key"

    def log_message(self, *args):  # keep the test output clean
        pass

    def _authorized(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {self.api_key}"

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        if self.path == "/v1/models":
            self._json(200, {"data": [{"id": "Qwen3.8-27B"}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        if self.path == "/v1/chat/completions":
            self._json(200, {
                "choices": [{
                    "message": {"role": "assistant", "content": "OK", "reasoning": "brief"},
                    "finish_reason": "stop",
                }],
            })
        else:
            self._json(404, {"error": "not found"})


@unittest.skipUnless(tpu.REQUESTS_AVAILABLE, "needs the requests package")
class HttpVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _FakeVllmHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.port}/v1"
        self.session = tpu._session()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def test_auth_is_enforced_and_real_inference_answers(self) -> None:
        self.assertTrue(tpu.verify_auth_enforced(self.session, self.base))
        self.assertEqual(
            tpu.list_models(self.session, self.base, _FakeVllmHandler.api_key),
            "Qwen3.8-27B",
        )
        self.assertEqual(
            tpu.smoke_test(self.session, self.base, _FakeVllmHandler.api_key, "Qwen3.8-27B"),
            "OK",
        )

    def test_a_wrong_key_is_not_healthy(self) -> None:
        config = tpu.TpuDeploymentConfig(port=self.port)
        self.assertFalse(tpu.server_healthy(self.session, config, "wrong-key"))
        self.assertTrue(tpu.server_healthy(self.session, config, _FakeVllmHandler.api_key))


class BundleTests(unittest.TestCase):
    def test_the_runtime_bundle_reports_tpu_facts_without_the_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = tpu.TpuDeploymentConfig(root=Path(directory))
            paths = tpu.write_runtime_bundle(
                config, "tpu-secret", "Qwen3.8-27B", None, reused=False, server_pid=123,
            )
            runtime = json.loads(paths["runtime"].read_text())
            profile = json.loads(paths["profile"].read_text())
            self.assertEqual(runtime["accelerator"], "TpuV5E8")
            self.assertFalse(runtime["mtp_speculative_decoding"])
            self.assertEqual(runtime["tensor_parallel_size"], 8)
            self.assertEqual(runtime["model_revision"], tpu.QWEN_TPU_REVISION)
            self.assertEqual(profile["model"], "Qwen3.8-27B")
            self.assertNotIn("tpu-secret", paths["runtime"].read_text())
            self.assertNotIn("tpu-secret", paths["profile"].read_text())
            self.assertEqual(paths["api_key"].read_text().strip(), "tpu-secret")
            self.assertEqual(oct(paths["api_key"].stat().st_mode)[-3:], "600")

    def test_the_tunnel_url_is_parsed_from_the_log(self) -> None:
        text = "INF | https://quick-brown-fox.trycloudflare.com |"
        self.assertEqual(
            tpu.parse_tunnel_url(text),
            "https://quick-brown-fox.trycloudflare.com",
        )
        self.assertIsNone(tpu.parse_tunnel_url("no url yet"))


if __name__ == "__main__":
    unittest.main()
