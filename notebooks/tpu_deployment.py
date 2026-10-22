#!/usr/bin/env python3
"""
Qwen3.8-27B on Kaggle TPU v5e-8 (vLLM TPU backend)
====================================================

Serves the authoritative non-GGUF Qwen checkpoint
(``Qwen/Qwen3.8-27B``, bf16 safetensors) through vLLM's TPU backend
(tpu-inference) as an OpenAI-compatible API, for use with the same chat
interface as the GPU deployment.

The script is written so that it can be used in three ways:

* pasted into a single Kaggle notebook cell (accelerator **TPU v5e-8**,
  Kaggle CLI id ``TpuV5E8``),
* executed with ``python notebooks/tpu_deployment.py``,
* imported by the test suite (``notebooks/test_tpu_deployment.py``).

Hard rules, shared with the GPU deployment and enforced rather than assumed:

* **TPU or nothing.** Eight real TPU devices must be detected at runtime.
  A CPU-only (or GPU) session aborts with an actionable message; CPU
  inference is never substituted and never reported as success.
* **MTP stays off on TPU.** Stock vllm-tpu 0.28.0 corrupts Qwen3.8 outputs
  with its MTP draft head (rejected draft tokens advance the gated-DeltaNet
  recurrent state). Enabling it in the config is refused, not ignored.
* **Raon on TPU is blocked, explicitly.** Raon's ``raon1`` architecture
  (Raon Delta Attention, Gated MLA, SiTU-GLU, Raon-mHC) has no kernels in
  any documented TPU serving stack; KRAFTON ships CUDA paths only and a
  GGUF file is not consumable by a TPU runtime. Requesting it raises
  :class:`UnsupportedDeploymentError` with those reasons instead of
  falling back to anything else.
* **Real inference before success.** The endpoint must answer an
  authenticated chat completion (and must reject an unauthenticated one)
  before the deployment reports itself as running. No speedup, memory, or
  throughput figure is printed by this script: none was measured here.
* **No embedded secrets.** The API key is generated at runtime, stored in a
  ``0600`` file, handed to vLLM through the environment (never argv), and
  printed once for copying into the chat interface.

Environment (Kaggle):

* Accelerator: *TPU v5e-8* (Settings -> Accelerator -> TPU v5e-8)
* Internet: on

Status (dev7): implemented, **not live-verified** — no TPU was available in
the development environment. The operator procedure in
``docs/kaggle-deployment.md`` is the live-verification path.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

try:  # pragma: no cover - Kaggle always has requests installed
    import requests

    REQUESTS_AVAILABLE = True
except ImportError:  # pragma: no cover - keeps the module importable for tests
    requests = None  # type: ignore[assignment]
    REQUESTS_AVAILABLE = False

# Kaggle accelerator identifier (kaggle-cli docs, kernels.md: "TpuV5E8").
KAGGLE_TPU_ACCELERATOR = "TpuV5E8"
EXPECTED_TPU_CHIPS = 8

# Authoritative non-GGUF checkpoint (Hugging Face API, 2026-10-22:
# safetensors, architectures=["Qwen3_5ForConditionalGeneration"], Apache-2.0,
# not gated). The revision is pinned so every run resolves the same bytes.
QWEN_TPU_REPO = "Qwen/Qwen3.8-27B"
QWEN_TPU_REVISION = "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0"
QWEN_TPU_SERVED_NAME = "Qwen3.8-27B"

# vllm-tpu 0.28.0 is the release that shipped native gated-DeltaNet Pallas
# kernels and the one with public Kaggle v5e-8 evidence for this model,
# including the MTP corruption finding. Newer releases exist; bump this pin
# only together with a fresh live verification.
VLLM_TPU_VERSION = "0.28.0"

# Same pinned tunnel binary as the GPU deployment (keep in sync with
# notebooks/qwen3_8_27b_api.py): one exact cloudflared release, SHA-256
# verified, never the moving "latest" target.
CLOUDFLARED_VERSION = "2026.10.2"
CLOUDFLARED_BINARY = "cloudflared-linux-amd64"
CLOUDFLARED_SHA256 = "35fbdd2beb378436c7da377d7358cea8e33f9c94a6705d1d8036bf9b0d6d8005"

STATE_FILE_NAME = "server-state.json"
KEY_FILE_NAME = "api_key.txt"

RAON_TPU_BLOCKED_REASONS: Tuple[str, ...] = (
    "The published Raon GGUF file is a llama.cpp artifact; no TPU runtime consumes GGUF.",
    "KRAFTON's llama.cpp branch and vLLM fork are CUDA paths; CUDA kernels do not run on TPU.",
    "Raon's raon1 architecture (Raon Delta Attention, Gated MLA, SiTU-GLU, Raon-mHC) has "
    "no kernels in the documented vLLM TPU / tpu-inference or SGLang TPU model support.",
    "A checkpoint merely loading would not prove generation works, and another TPU type "
    "would not prove Kaggle v5e-8 works either; no such execution proof exists upstream.",
)


class UnsupportedDeploymentError(RuntimeError):
    """A requested model x accelerator combination has no genuine runtime path."""


@dataclass
class TpuDeploymentConfig:
    """Everything that can be changed without touching the logic."""

    model: str = "qwen"  # "qwen" (implemented) or "raon" (blocked, see reasons)
    repo: str = QWEN_TPU_REPO
    revision: str = QWEN_TPU_REVISION
    served_model_name: str = QWEN_TPU_SERVED_NAME

    host: str = "127.0.0.1"
    port: int = 8000
    tensor_parallel_size: int = EXPECTED_TPU_CHIPS
    dtype: str = "bfloat16"
    # Conservative default. The model's native context is 262144 and its
    # hybrid architecture keeps only a small KV cache, but compile time and
    # activation memory grow with this value; raise it deliberately.
    max_model_len: int = 32_768
    max_num_seqs: int = 8
    gpu_memory_utilization: float = 0.90
    # MTP speculative decoding on TPU corrupts outputs with the pinned
    # vllm-tpu release (see module docstring). True is refused explicitly.
    enable_mtp: bool = False

    vllm_tpu_version: str = VLLM_TPU_VERSION
    enable_tunnel: bool = True

    root: Path = Path("/kaggle/working/qwen38_tpu_api")
    input_root: Path = Path("/kaggle/input")

    # XLA compilation of a 27B model is slow; the startup wait is generous
    # and always bounded (an unbounded wait would hide a dead server).
    startup_timeout_s: int = 3600
    request_timeout: Tuple[int, int] = (10, 180)

    @property
    def bin_root(self) -> Path:
        return self.root / "bin"

    @property
    def local_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def local_api_url(self) -> str:
        return f"{self.local_url}/v1"


def log(message: str) -> None:
    print(f"[tpu] {message}", flush=True)


def warn(message: str) -> None:
    print(f"[tpu] WARNING: {message}", flush=True)


def fail(message: str) -> None:
    print(f"[tpu] ERROR: {message}", flush=True)


# --------------------------------------------------------------------------
# Combination support and hardware truth
# --------------------------------------------------------------------------


def ensure_supported_combination(config: TpuDeploymentConfig) -> None:
    """
    Refuse combinations that cannot run genuinely on TPU.

    This runs before any installation, download, or server start, so a
    blocked combination fails immediately and can never degrade into a CPU,
    GPU, remote, or hosted fallback wearing a TPU label.
    """
    model = (config.model or "qwen").strip().lower()
    if model in ("raon", "raon-1", "raon-1-mini-preview", "raon1"):
        reasons = "\n".join(f"  - {reason}" for reason in RAON_TPU_BLOCKED_REASONS)
        raise UnsupportedDeploymentError(
            "Raon-1 mini preview on Kaggle TPU v5e-8 is blocked; there is no "
            "genuine TPU runtime path for it today:\n"
            f"{reasons}\n"
            "Nothing was installed or started, and no CPU/GPU/hosted fallback "
            "was substituted. Use Raon on GPU T4 x2 (notebooks/qwen3_8_27b_api.py "
            "with KAGGLE_KIT_MODEL=raon) or a hosted Raon profile instead. "
            "Revisit this combination when a TPU backend publishes raon1 support."
        )
    if model not in ("qwen", "qwen3.8-27b", "qwen3.8"):
        raise UnsupportedDeploymentError(
            f"Unknown TPU deployment model {config.model!r}; implemented: 'qwen'. "
            "'raon' is explicitly blocked (see RAON_TPU_BLOCKED_REASONS)."
        )
    if config.enable_mtp:
        raise UnsupportedDeploymentError(
            "MTP speculative decoding is refused on the TPU path: with the "
            f"pinned vllm-tpu {config.vllm_tpu_version}, rejected draft tokens "
            "advance Qwen3.8's gated-DeltaNet recurrent state and corrupt the "
            "output. Set enable_mtp=False (the default) until a live Kaggle "
            "run verifies a fixed runtime; the flag is never silently dropped."
        )
    if config.tensor_parallel_size != EXPECTED_TPU_CHIPS:
        raise UnsupportedDeploymentError(
            f"This deployment shards across the whole v5e-8 pod slice; "
            f"tensor_parallel_size must be {EXPECTED_TPU_CHIPS}, not "
            f"{config.tensor_parallel_size}. A smaller value would not be the "
            "requested TPU v5e-8 deployment."
        )


def _default_device_lister() -> List[str]:  # pragma: no cover - needs a real TPU/JAX
    """Device strings from JAX, the authoritative view of the accelerator."""
    import jax  # type: ignore

    return [f"{device.platform}:{device.device_kind}" for device in jax.devices()]


def detect_tpu_devices(
    device_lister: Optional[Callable[[], Sequence[str]]] = None,
) -> List[str]:
    """Return the detected TPU device descriptions (empty when there are none)."""
    lister = device_lister or _default_device_lister
    try:
        devices = [str(device) for device in lister()]
    except Exception:  # noqa: BLE001 - no JAX/no accelerator is reported by the caller
        return []
    return [device for device in devices if "tpu" in device.lower()]


def require_tpu_v5e8(
    config: TpuDeploymentConfig,
    device_lister: Optional[Callable[[], Sequence[str]]] = None,
) -> List[str]:
    """
    Require the eight TPU chips of a Kaggle v5e-8 session.

    Kaggle can provision sessions without the requested hardware (for
    example unverified accounts can land in a CPU-only container). Such a
    session must abort here: continuing would either crash later inside the
    mesh setup or, worse, "work" on the wrong accelerator.
    """
    devices = detect_tpu_devices(device_lister)
    log(f"Detected {len(devices)} TPU device(s):")
    for device in devices:
        log(f"  - {device}")
    if len(devices) != EXPECTED_TPU_CHIPS:
        raise RuntimeError(
            f"This deployment requires Kaggle TPU v5e-8 ({KAGGLE_TPU_ACCELERATOR}, "
            f"{EXPECTED_TPU_CHIPS} chips) but {len(devices)} TPU device(s) were "
            "detected. Set Settings -> Accelerator -> TPU v5e-8 and rerun. If the "
            "session came up without hardware (a CPU-only container also "
            "detects zero TPUs), start a new TPU session — this cell never "
            "falls back to CPU or GPU inference."
        )
    return devices


# --------------------------------------------------------------------------
# Runtime installation and server command
# --------------------------------------------------------------------------


def pip_install_command(config: TpuDeploymentConfig) -> List[str]:
    """The pinned runtime installation. No unpinned 'latest' anywhere."""
    return [
        sys.executable, "-m", "pip", "install",
        f"vllm-tpu=={config.vllm_tpu_version}",
    ]


def runtime_installed(version: str, version_lookup: Optional[Callable[[], Optional[str]]] = None) -> bool:
    """True when the installed vllm-tpu distribution matches the pin exactly."""
    if version_lookup is not None:
        return version_lookup() == version

    def _lookup() -> Optional[str]:  # pragma: no cover - environment dependent
        try:
            from importlib.metadata import version as dist_version

            return dist_version("vllm-tpu")
        except Exception:  # noqa: BLE001
            return None

    return _lookup() == version


def build_vllm_serve_command(config: TpuDeploymentConfig) -> Tuple[List[str], Dict[str, str]]:
    """
    The vLLM OpenAI-server command for the TPU deployment, plus its env.

    Pure and testable: bf16 safetensors from the pinned revision, sharded
    across all eight chips (tensor parallel 8), served under a stable model
    name. No speculative-decoding flag is ever emitted (MTP is refused in
    :func:`ensure_supported_combination`), and the API key is not part of
    the command at all — ``main`` adds it to the environment as
    ``VLLM_API_KEY`` so it never appears in the process list.
    """
    command = [
        sys.executable, "-m", "vllm.entrypoints.openai.api_server",
        "--model", config.repo,
        "--revision", config.revision,
        "--served-model-name", config.served_model_name,
        "--host", config.host,
        "--port", str(config.port),
        "--tensor-parallel-size", str(config.tensor_parallel_size),
        "--dtype", config.dtype,
        "--max-model-len", str(config.max_model_len),
        "--max-num-seqs", str(config.max_num_seqs),
        "--gpu-memory-utilization", str(config.gpu_memory_utilization),
    ]
    env = {
        # Force the TPU backend. If JAX cannot see TPUs the server fails;
        # require_tpu_v5e8 has already refused such a session before this.
        "PJRT_DEVICE": "TPU",
    }
    return command, env


def install_runtime(config: TpuDeploymentConfig, runner=None) -> None:
    """Install the pinned vllm-tpu release unless it is already installed."""
    run = runner or subprocess.run
    if runtime_installed(config.vllm_tpu_version):
        log(f"vllm-tpu {config.vllm_tpu_version} is already installed.")
        return
    log(f"Installing vllm-tpu=={config.vllm_tpu_version} (pinned)...")
    result = run(pip_install_command(config), capture_output=True, text=True, timeout=3600)
    if result.returncode != 0:
        tail = ((result.stderr or "") + (result.stdout or ""))[-4000:]
        raise RuntimeError(f"The pinned vllm-tpu installation failed. Output tail:\n{tail}")
    if not runtime_installed(config.vllm_tpu_version):
        raise RuntimeError(
            "pip reported success but the installed vllm-tpu version does not "
            f"match the pin ({config.vllm_tpu_version}); refusing to continue "
            "with an unverified runtime."
        )


# --------------------------------------------------------------------------
# Server state (same ownership rules as the GPU deployment)
# --------------------------------------------------------------------------


def _write_private_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)
    path.chmod(0o600)


def state_file(config: TpuDeploymentConfig) -> Path:
    return config.root / STATE_FILE_NAME


def key_file(config: TpuDeploymentConfig) -> Path:
    return config.root / KEY_FILE_NAME


def read_server_state(config: TpuDeploymentConfig) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(state_file(config).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_server_state(config: TpuDeploymentConfig, state: Dict[str, Any]) -> Path:
    path = state_file(config)
    _write_private_text(path, json.dumps(state, indent=2, sort_keys=True) + "\n")
    return path


def clear_server_state(config: TpuDeploymentConfig) -> None:
    state_file(config).unlink(missing_ok=True)


def write_api_key(config: TpuDeploymentConfig, api_key: str) -> Path:
    path = key_file(config)
    _write_private_text(path, api_key + "\n")
    return path


def read_api_key(config: TpuDeploymentConfig) -> Optional[str]:
    try:
        value = key_file(config).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def process_cmdline(pid: int) -> str:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return ""
    return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()


def owns_process(state: Optional[Dict[str, Any]]) -> bool:
    """True when the recorded pid is still this cell's vLLM server."""
    if not state:
        return False
    try:
        pid = int(state.get("pid") or 0)
    except (TypeError, ValueError):
        return False
    if not process_alive(pid):
        return False
    cmdline = process_cmdline(pid)
    if not cmdline:
        return True  # no /proc (not Linux): the recorded pid is the evidence
    return "vllm.entrypoints.openai.api_server" in cmdline


def port_in_use(host: str, port: int, timeout: float = 1.0) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def deployment_fingerprint(config: TpuDeploymentConfig) -> str:
    payload = {
        "model": config.model,
        "repo": config.repo,
        "revision": config.revision,
        "served_model_name": config.served_model_name,
        "host": config.host,
        "port": config.port,
        "tensor_parallel_size": config.tensor_parallel_size,
        "dtype": config.dtype,
        "max_model_len": config.max_model_len,
        "max_num_seqs": config.max_num_seqs,
        "vllm_tpu_version": config.vllm_tpu_version,
        "enable_mtp": bool(config.enable_mtp),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def decide_server_action(*, port_busy: bool, owned: bool, healthy: bool, compatible: bool) -> str:
    if not port_busy:
        return "start"
    if not owned:
        return "conflict"
    if healthy and compatible:
        return "reuse"
    return "restart"


def stop_process(process: Optional[subprocess.Popen]) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def stop_owned_server(config: TpuDeploymentConfig, state: Optional[Dict[str, Any]]) -> bool:
    """Stop only the server this cell started; a foreign process is never touched."""
    if not owns_process(state):
        return False
    try:
        pid = int((state or {}).get("pid") or 0)
    except (TypeError, ValueError):
        return False
    log(f"Stopping the vLLM server of a previous run (pid {pid}).")
    try:
        os.kill(pid, 15)
    except OSError:
        return False
    for _ in range(40):
        if not process_alive(pid):
            return True
        time.sleep(0.5)
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    return True


# --------------------------------------------------------------------------
# HTTP verification (health, auth enforcement, real inference)
# --------------------------------------------------------------------------


def _session():
    if not REQUESTS_AVAILABLE:
        raise RuntimeError("The 'requests' package is required; install it with 'pip install requests'.")
    session = requests.Session()
    session.headers.update({"User-Agent": "Kaggle-Qwen-TPU-API/1.0"})
    return session


def server_healthy(session, config: TpuDeploymentConfig, api_key: str) -> bool:
    try:
        models = session.get(
            f"{config.local_api_url}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=(5, 15),
        )
        if models.status_code != 200:
            return False
        payload = models.json()
    except Exception:  # noqa: BLE001
        return False
    data = payload.get("data") if isinstance(payload, dict) else None
    return bool(data)


def verify_auth_enforced(session, base_api_url: str) -> bool:
    """
    True when the endpoint rejects a request without the API key.

    The key reaches vLLM through the environment; this check proves the
    running server really enforces it instead of the deployment assuming
    so. A server that answers unauthenticated requests is a failed
    deployment, especially behind a public tunnel.
    """
    try:
        response = session.get(f"{base_api_url}/models", timeout=(5, 15))
    except Exception:  # noqa: BLE001
        return False
    return response.status_code in (401, 403)


def smoke_test(session, base_api_url: str, api_key: str, model_id: str,
               timeout: Tuple[int, int] = (10, 180)) -> str:
    """Send a real chat completion and return its answer text."""
    response = session.post(
        f"{base_api_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model_id,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "max_tokens": 24,
            "temperature": 0,
            "stream": False,
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("The smoke test returned no choices.")
    message = (choices[0] or {}).get("message") or {}
    content = message.get("content") or ""
    reasoning = message.get("reasoning_content") or message.get("reasoning") or ""
    if not str(content).strip() and not str(reasoning).strip():
        raise RuntimeError("The smoke test returned an empty completion.")
    return str(content)


def list_models(session, base_api_url: str, api_key: str) -> str:
    response = session.get(
        f"{base_api_url}/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=(5, 15),
    )
    response.raise_for_status()
    models = response.json().get("data", [])
    if not models:
        raise RuntimeError("The server returned an empty model list.")
    return models[0]["id"]


def wait_for_server(session, config: TpuDeploymentConfig, api_key: str,
                    process: Optional[subprocess.Popen] = None) -> bool:
    """Poll until the server answers the model list with the key, bounded."""
    deadline = time.time() + config.startup_timeout_s
    while time.time() < deadline:
        if process is not None and process.poll() is not None:
            return False
        if server_healthy(session, config, api_key):
            return True
        time.sleep(5)
    return False


def start_server(session, config: TpuDeploymentConfig, api_key: str,
                 fingerprint: str) -> str:
    """Start vLLM, record ownership before waiting, prove real inference."""
    command, extra_env = build_vllm_serve_command(config)
    log_path = config.root / "vllm-server.log"
    env = os.environ.copy()
    env.update(extra_env)
    # The key travels in the environment only; it never appears in argv
    # (world-readable through /proc/<pid>/cmdline).
    env["VLLM_API_KEY"] = api_key

    log("Starting vLLM on the TPU (XLA compilation can take a long time)...")
    with open(log_path, "w") as log_file:
        process = subprocess.Popen(
            command, stdout=log_file, stderr=subprocess.STDOUT,
            env=env, start_new_session=True,
        )
    write_server_state(config, {
        "pid": process.pid,
        "host": config.host,
        "port": config.port,
        "repo": config.repo,
        "revision": config.revision,
        "served_model_name": config.served_model_name,
        "fingerprint": fingerprint,
        "log_file": str(log_path),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })

    if not wait_for_server(session, config, api_key, process):
        stop_process(process)
        clear_server_state(config)
        tail = ""
        try:
            tail = "\n".join(log_path.read_text(errors="replace").splitlines()[-40:])
        except OSError:
            tail = "(no log available)"
        raise RuntimeError(
            "vLLM did not become healthy before the startup timeout (or it "
            f"exited). Server log tail:\n{tail}"
        )

    model_id = list_models(session, config.local_api_url, api_key)
    content = smoke_test(session, config.local_api_url, api_key, model_id, config.request_timeout)
    log(f"The inference test passed: {content!r}")
    state = read_server_state(config) or {}
    state.update({"model_id": model_id})
    write_server_state(config, state)
    return model_id


# --------------------------------------------------------------------------
# Public tunnel (pinned cloudflared, verified with a real completion)
# --------------------------------------------------------------------------


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_cloudflared(session, config: TpuDeploymentConfig) -> Path:
    binary = config.bin_root / "cloudflared"
    config.bin_root.mkdir(parents=True, exist_ok=True)
    if not (binary.exists() and _sha256_of(binary) == CLOUDFLARED_SHA256):
        url = (
            "https://github.com/cloudflare/cloudflared/releases/download/"
            f"{CLOUDFLARED_VERSION}/{CLOUDFLARED_BINARY}"
        )
        part = binary.with_name(binary.name + ".part")
        with session.get(url, stream=True, timeout=(30, 180)) as response:
            response.raise_for_status()
            with open(part, "wb") as handle:
                for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
                    if chunk:
                        handle.write(chunk)
        if _sha256_of(part) != CLOUDFLARED_SHA256:
            part.unlink(missing_ok=True)
            raise RuntimeError("The cloudflared download does not match its pinned SHA-256 digest; it was deleted.")
        os.replace(part, binary)
    binary.chmod(0o755)
    check = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=20)
    if check.returncode != 0:
        raise RuntimeError("The downloaded cloudflared binary does not run.")
    return binary


def parse_tunnel_url(log_text: str) -> Optional[str]:
    match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", log_text)
    return match.group(0) if match else None


def start_public_tunnel(session, config: TpuDeploymentConfig) -> Optional[str]:
    log_path = config.root / "cloudflared.log"
    try:
        binary = get_cloudflared(session, config)
    except Exception as exc:  # noqa: BLE001
        warn(f"The public tunnel is not available: {type(exc).__name__}: {exc}")
        return None
    with open(log_path, "w") as log_file:
        process = subprocess.Popen(
            [str(binary), "tunnel", "--url", config.local_url, "--no-autoupdate"],
            stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True,
        )
    for _ in range(90):
        if process.poll() is not None:
            warn("The tunnel process exited; see cloudflared.log.")
            return None
        try:
            text = log_path.read_text(errors="replace")
        except OSError:
            text = ""
        url = parse_tunnel_url(text)
        if url:
            return url
        time.sleep(1)
    # Never leave an orphan that could expose the server after reporting
    # that no public URL exists.
    try:
        stop_process(process)
    except Exception as exc:  # noqa: BLE001
        warn(f"The timed-out tunnel process could not be stopped: {type(exc).__name__}: {exc}")
    warn("The tunnel did not report a URL within 90 seconds.")
    return None


# --------------------------------------------------------------------------
# Runtime bundle and main
# --------------------------------------------------------------------------


def write_runtime_bundle(config: TpuDeploymentConfig, api_key: str, model_id: str,
                         public_url: Optional[str], *, reused: bool,
                         server_pid: Optional[int]) -> Dict[str, Path]:
    config.root.mkdir(parents=True, exist_ok=True)
    key_path = write_api_key(config, api_key)
    runtime = {
        "deployment": "Qwen-TPU",
        "accelerator": KAGGLE_TPU_ACCELERATOR,
        "model": model_id,
        "model_repo": config.repo,
        "model_revision": config.revision,
        "served_model_name": config.served_model_name,
        "dtype": config.dtype,
        "tensor_parallel_size": config.tensor_parallel_size,
        "max_model_len": config.max_model_len,
        "mtp_speculative_decoding": False,
        "mtp_note": "MTP is forced off on TPU (output corruption with the pinned vllm-tpu).",
        "vllm_tpu_version": config.vllm_tpu_version,
        "local_base_url": config.local_api_url,
        "public_base_url": f"{public_url}/v1" if public_url else None,
        "reused_existing_server": bool(reused),
        "server_pid": server_pid,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    runtime_path = config.root / "runtime.json"
    runtime_path.write_text(json.dumps(runtime, indent=2) + "\n", encoding="utf-8")
    profile = {
        "name": "Kaggle TPU v5e-8",
        "baseUrl": f"{public_url}/v1" if public_url else config.local_api_url,
        "model": model_id,
        "note": "The API key is not part of this file; paste it into the chat interface.",
    }
    profile_path = config.root / "profile.json"
    profile_path.write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")
    return {"api_key": key_path, "runtime": runtime_path, "profile": profile_path}


def main(config: Optional[TpuDeploymentConfig] = None) -> Dict[str, Any]:
    """
    Deploy Qwen3.8-27B on the TPU and return the runtime information.

    Ordering matters: combination support first (Raon/MTP refused before
    anything is installed), then real TPU detection, then the pinned
    runtime, then server ownership/health, then real inference and auth
    enforcement — only then is anything reported as running.
    """
    config = config or TpuDeploymentConfig()
    ensure_supported_combination(config)
    devices = require_tpu_v5e8(config)

    for directory in (config.root, config.bin_root):
        directory.mkdir(parents=True, exist_ok=True)
    session = _session()
    install_runtime(config)

    fingerprint = deployment_fingerprint(config)
    state = read_server_state(config)
    owned = owns_process(state)
    busy = port_in_use(config.host, config.port)
    stored_key = read_api_key(config)
    healthy = bool(stored_key) and busy and server_healthy(session, config, stored_key)
    compatible = bool(state) and state.get("fingerprint") == fingerprint
    action = decide_server_action(port_busy=busy, owned=owned, healthy=healthy, compatible=compatible)
    log(f"Local server decision: {action} (port busy: {busy}, own process: {owned}).")

    if action == "conflict":
        raise RuntimeError(
            f"The port {config.port} on {config.host} is used by a process that this "
            "cell did not start. The cell never stops a foreign process. Stop that "
            "process, or use another port in TpuDeploymentConfig, and rerun the cell."
        )

    reused = False
    rotated = False
    server_pid: Optional[int] = None
    if action == "reuse":
        api_key = stored_key or ""
        model_id = (state or {}).get("model_id") or list_models(session, config.local_api_url, api_key)
        server_pid = (state or {}).get("pid")
        reused = True
        log("The vLLM server of a previous run is healthy and still fits; it is reused.")
    else:
        if action == "restart":
            stop_owned_server(config, state)
            for _ in range(40):
                if not port_in_use(config.host, config.port):
                    break
                time.sleep(0.5)
            rotated = True
        elif state:
            clear_server_state(config)
        api_key = secrets.token_urlsafe(32)
        write_api_key(config, api_key)
        model_id = start_server(session, config, api_key, fingerprint)
        server_pid = (read_server_state(config) or {}).get("pid")

    if not verify_auth_enforced(session, config.local_api_url):
        # Do not leave an unauthenticated model server running behind us.
        if not reused:
            stop_owned_server(config, read_server_state(config))
            clear_server_state(config)
        raise RuntimeError(
            "The server answers requests without the API key, so authentication "
            "is not enforced (the VLLM_API_KEY environment handoff did not take "
            "effect for this runtime). The deployment failed closed"
            + ("" if reused else " and the server was stopped")
            + "; do not expose it through a tunnel."
        )

    public_url: Optional[str] = None
    public_verified = False
    if config.enable_tunnel:
        public_url = start_public_tunnel(session, config)
        if public_url:
            try:
                public_model = list_models(session, f"{public_url}/v1", api_key)
                smoke_test(session, f"{public_url}/v1", api_key, public_model, (10, 90))
                public_verified = True
                log("The public endpoint answered an authenticated chat completion.")
            except Exception as exc:  # noqa: BLE001
                warn(f"The public endpoint is not usable yet: {type(exc).__name__}: {exc}")
        else:
            warn("No public URL was returned. The local API stays available.")

    paths = write_runtime_bundle(config, api_key, model_id, public_url,
                                 reused=reused, server_pid=server_pid)

    print("\n" + "=" * 60)
    print("QWEN TPU API STATUS (implemented; live-verify on Kaggle TPU v5e-8)")
    print("=" * 60)
    print(f"Model:            {model_id}")
    print(f"Checkpoint:       {config.repo}@{config.revision} ({config.dtype})")
    print(f"Accelerator:      {len(devices)} TPU device(s) detected; tensor parallel {config.tensor_parallel_size}")
    print(f"Max model len:    {config.max_model_len}")
    print("MTP decoding:     disabled (forced off on TPU)")
    print(f"Local endpoint:   {config.local_api_url}")
    print("Local server:     " + ("reused from a previous run" if reused else "started in this run"))
    print("Local inference:  verified with a real chat completion")
    print("Authentication:   verified enforced (unauthenticated request rejected)")
    print(f"Public endpoint:  {f'{public_url}/v1' if public_url else 'unavailable'}")
    if public_url:
        print("Public route:     " + ("verified with an authenticated chat completion" if public_verified else "not verified"))
    print(f"Runtime info:     {paths['runtime']}")
    print(f"Profile template: {paths['profile']}")
    print("-" * 60)
    if rotated:
        print("The API key was rotated because the server was restarted.")
        print("The old key does not work any more; use the new key below.")
    print(f"The API key is stored in {paths['api_key']} (mode 0600).")
    print("Copy it into the chat interface. Do not publish this output.")
    print(f"API key: {api_key}")
    print("=" * 60)

    return {
        "model_id": model_id,
        "api_key": api_key,
        "local_url": config.local_api_url,
        "public_url": f"{public_url}/v1" if public_url else None,
        "public_verified": public_verified,
        "server_reused": reused,
        "key_rotated": rotated,
        "server_pid": server_pid,
        "tpu_devices": devices,
        "paths": {name: str(path) for name, path in paths.items()},
    }


def config_for_model(name: str) -> TpuDeploymentConfig:
    """Resolve ``KAGGLE_KIT_MODEL`` for the TPU cell (Raon stays blocked)."""
    normalized = (name or "qwen").strip().lower()
    if normalized in ("qwen", "qwen3.8-27b", "qwen3.8", ""):
        return TpuDeploymentConfig()
    if normalized in ("raon", "raon-1", "raon-1-mini-preview", "raon1"):
        # Returned (not raised here) so main() reports the full blocked
        # analysis through ensure_supported_combination.
        return TpuDeploymentConfig(model="raon")
    raise ValueError(
        f"Unknown TPU deployment model {name!r}; implemented: 'qwen'. 'raon' is blocked."
    )


if __name__ == "__main__":
    try:
        main(config_for_model(os.environ.get("KAGGLE_KIT_MODEL", "qwen")))
    except UnsupportedDeploymentError as error:
        fail(str(error))
        sys.exit(2)
    except Exception as error:  # noqa: BLE001
        fail(f"{type(error).__name__}: {error}")
        sys.exit(1)
