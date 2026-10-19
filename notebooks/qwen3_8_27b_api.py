#!/usr/bin/env python3
"""
Qwen3.8-27B GSQ-RCO IQ3_S (MTP) on Kaggle T4 x2
================================================

Deploys a GGUF model with the official CUDA build of ``llama.cpp`` and exposes
it through an OpenAI-compatible API.

The script is written so that it can be used in three ways:

* pasted into a single Kaggle notebook cell,
* executed with ``python notebooks/qwen3_8_27b_api.py``,
* imported by the test suite (``notebooks/test_qwen_deployment.py``).

Design rules that the implementation follows:

* **No GitHub release list API.** The ``llama.cpp`` build is fetched from
  direct release asset URLs. The release list endpoint is unreliable from
  Kaggle (it fails with ``requests.exceptions.ConnectionError:
  RemoteDisconnected``) and is not needed.
* **Resumable downloads.** Every download continues from the bytes that are
  already on disk, so an interrupted session does not restart from zero.
* **Verified state.** Archives are checked, the model file is checked for size
  and magic bytes, the server binary has to pass ``--version`` and the server
  has to answer a *real* chat completion before success is announced.
* **Supported flags only.** The start-up flags are filtered through the
  ``--help`` output of the installed build, so an older or newer build never
  receives a flag it does not understand.
* **No embedded secrets.** The API key is generated at runtime and stored in a
  ``0600`` file. It is printed once, in the final summary, because the
  operator has to copy it into the chat interface.

Environment (Kaggle):

* Accelerator: *GPU T4 x2* (Settings -> Accelerator -> GPU T4 x2)
* Internet: on
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:  # pragma: no cover - Kaggle always has requests installed
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    REQUESTS_AVAILABLE = True
except ImportError:  # pragma: no cover - keeps the module importable for tests
    requests = None  # type: ignore[assignment]
    HTTPAdapter = None  # type: ignore[assignment,misc]
    Retry = None  # type: ignore[assignment,misc]

    REQUESTS_AVAILABLE = False

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


@dataclass
class DeploymentConfig:
    """Everything that can be changed without touching the logic."""

    # Model
    repo: str = "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF"
    model_file: str = "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"
    min_model_bytes: int = 11_000_000_000

    # llama.cpp
    llama_cpp_tags: Tuple[str, ...] = ("b11719", "b11718", "b11717")
    cuda_version: str = "12.8"

    # Hardware
    mode: str = "t4x2"  # "t4x2" (verified) or "single"
    required_gpus: int = 2
    require_gpu_name: str = "T4"

    # Server
    host: str = "127.0.0.1"
    port: int = 8000
    ctx_size: int = 8192
    batch_size: int = 512
    ubatch_size: int = 128
    n_gpu_layers: int = 99
    split_mode: str = "layer"
    tensor_split: str = "1,1"
    cache_type_k: str = "q8_0"
    cache_type_v: str = "q8_0"
    parallel: int = 1
    reasoning_effort: str = "medium"
    enable_mtp: bool = True
    mtp_draft_n_max: int = 2

    # Public access
    enable_tunnel: bool = True

    # Paths
    root: Path = Path("/kaggle/working/qwen38_api")
    input_root: Path = Path("/kaggle/input")

    # Networking
    connect_timeout: int = 30
    read_timeout: int = 120
    request_timeout: Tuple[int, int] = (10, 180)
    download_attempts: int = 10

    @property
    def model_dir(self) -> Path:
        return self.root / "models"

    @property
    def bin_root(self) -> Path:
        return self.root / "bin"

    @property
    def local_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def local_api_url(self) -> str:
        return f"{self.local_url}/v1"


# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------

_LOG_PREFIX = "[qwen]"


def log(message: str) -> None:
    print(f"{_LOG_PREFIX} {message}", flush=True)


def warn(message: str) -> None:
    print(f"{_LOG_PREFIX} WARNING: {message}", flush=True)


def fail(message: str) -> None:
    print(f"{_LOG_PREFIX} ERROR: {message}", flush=True)


# --------------------------------------------------------------------------
# HTTP session with retries
# --------------------------------------------------------------------------


def build_session() -> "requests.Session":
    """A session that retries transient failures of idempotent requests."""
    if not REQUESTS_AVAILABLE:
        raise RuntimeError(
            "The 'requests' package is required to download the model and the "
            "llama.cpp build. Install it with 'pip install requests'."
        )
    session = requests.Session()
    session.headers.update({"User-Agent": "Kaggle-Qwen-Local-API/2.0"})

    retry = Retry(
        total=5,
        connect=5,
        read=5,
        status=5,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "HEAD"]),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


class AssetNotFound(Exception):
    """The requested release asset does not exist."""


def download_resumable(
    session: requests.Session,
    url: str,
    destination: Path,
    min_bytes: int = 1_000_000,
    verify_tar: bool = False,
    attempts: int = 10,
) -> Path:
    """
    Download ``url`` to ``destination`` and continue after an interruption.

    The partial file is kept in ``<destination>.part``. A new attempt sends a
    ``Range`` header so the server only sends the missing bytes. The file is
    renamed into place only after it is complete, so a half written download
    is never mistaken for a finished one.
    """
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    part = destination.with_name(destination.name + ".part")

    if destination.exists() and destination.stat().st_size >= min_bytes:
        if not verify_tar or _is_valid_tar(destination):
            log(f"Reusing {destination.name} ({destination.stat().st_size / 1e9:.2f} GB)")
            return destination
        log(f"Removing the damaged archive {destination.name}")
        destination.unlink(missing_ok=True)

    last_error: Optional[BaseException] = None

    for attempt in range(1, attempts + 1):
        offset = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}

        try:
            with session.get(
                url,
                headers=headers,
                stream=True,
                allow_redirects=True,
                timeout=(30, 120),
            ) as response:
                if response.status_code == 404:
                    raise AssetNotFound(url)

                if response.status_code == 416:
                    part.unlink(missing_ok=True)
                    raise requests.ConnectionError(
                        "The server rejected the resume range; restarting the download."
                    )

                response.raise_for_status()

                append = offset > 0 and response.status_code == 206
                mode = "ab" if append else "wb"

                with open(part, mode) as handle:
                    for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
                        if chunk:
                            handle.write(chunk)

            if not part.exists() or part.stat().st_size < min_bytes:
                raise IOError("The downloaded file is too small or incomplete.")

            if verify_tar and not _is_valid_tar(part):
                raise IOError("The downloaded archive is not a readable tar file.")

            os.replace(part, destination)
            log(f"Downloaded {destination.name} ({destination.stat().st_size / 1e9:.2f} GB)")
            return destination

        except AssetNotFound:
            raise

        except Exception as exc:  # noqa: BLE001 - the reason is reported to the user
            last_error = exc
            log(f"Download attempt {attempt}/{attempts} failed: {type(exc).__name__}: {exc}")
            if attempt < attempts:
                delay = min(2 ** (attempt - 1), 30)
                log(f"Retrying in {delay}s, the partial download is kept.")
                time.sleep(delay)

    raise RuntimeError(
        f"Download failed after {attempts} attempts: {url}\n"
        f"Last error: {last_error}\n"
        "Check the Kaggle Internet connection and rerun the cell; the partial "
        "download is resumed instead of restarted."
    ) from last_error


def _is_valid_tar(path: Path) -> bool:
    try:
        with tarfile.open(path, "r:gz") as archive:
            return bool(archive.getmembers())
    except Exception:  # noqa: BLE001
        return False


# --------------------------------------------------------------------------
# Hardware
# --------------------------------------------------------------------------


def list_gpus() -> List[str]:
    """Return one line per detected GPU."""
    result = subprocess.run(
        ["nvidia-smi", "-L"], capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def check_gpus(config: DeploymentConfig) -> List[str]:
    """
    Make sure the hardware the selected deployment mode needs is present.

    ``t4x2`` needs two GPUs (the verified configuration). ``single`` needs one
    and is only a fallback for experimenting.
    """
    gpus = list_gpus()
    log(f"Detected {len(gpus)} GPU(s):")
    for gpu in gpus:
        log(f"  - {gpu}")

    required = config.required_gpus if config.mode == "t4x2" else 1
    if len(gpus) < required:
        raise RuntimeError(
            f"The deployment mode '{config.mode}' needs {required} GPU(s) but "
            f"{len(gpus)} were detected. Set the Kaggle accelerator to "
            "GPU T4 x2 (Settings -> Accelerator) and rerun the cell."
        )

    if config.require_gpu_name and config.mode == "t4x2":
        matching = [gpu for gpu in gpus if config.require_gpu_name.upper() in gpu.upper()]
        if len(matching) < required:
            raise RuntimeError(
                f"The deployment mode '{config.mode}' needs {required} {config.require_gpu_name} "
                f"GPUs but found: {', '.join(gpus) or 'none'}."
            )

    return gpus


# --------------------------------------------------------------------------
# llama.cpp
# --------------------------------------------------------------------------


def library_env(root: Path) -> Dict[str, str]:
    """An environment that finds the CUDA runtime libraries of the build."""
    env = os.environ.copy()
    lib_dirs = {str(root)}
    for lib in root.rglob("*.so*"):
        lib_dirs.add(str(lib.parent))

    old = env.get("LD_LIBRARY_PATH", "")
    if old:
        lib_dirs.add(old)

    env["LD_LIBRARY_PATH"] = ":".join(sorted(lib_dirs))
    return env


def server_flags(help_text: str) -> set:
    """The set of long options the installed build understands."""
    return set(re.findall(r"(--[a-z0-9][a-z0-9-]*)", help_text))


def find_working_server(root: Path) -> Optional[Path]:
    """An already downloaded ``llama-server`` that starts."""
    for binary in sorted(root.rglob("llama-server")):
        if not binary.is_file():
            continue
        binary.chmod(0o755)
        try:
            result = subprocess.run(
                [str(binary), "--version"],
                capture_output=True,
                text=True,
                timeout=30,
                env=library_env(root),
            )
        except Exception:  # noqa: BLE001
            continue
        if result.returncode == 0:
            log(f"Reusing llama-server: {binary}")
            return binary
    return None


def get_server_binary(session: requests.Session, config: DeploymentConfig) -> Path:
    """
    Return a working CUDA build of ``llama-server``.

    The build is downloaded from direct release asset URLs; the GitHub release
    *list* API is never called.
    """
    existing = find_working_server(config.bin_root)
    if existing:
        return existing

    for tag in config.llama_cpp_tags:
        build_dir = config.bin_root / tag
        build_dir.mkdir(parents=True, exist_ok=True)

        main_name = f"llama-{tag}-bin-ubuntu-cuda-{config.cuda_version}-x64.tar.gz"
        cuda_name = f"cudart-llama-{tag}-bin-ubuntu-cuda-{config.cuda_version}-x64.tar.gz"
        base_url = f"https://github.com/ggml-org/llama.cpp/releases/download/{tag}"

        try:
            log(f"Preparing the official llama.cpp build {tag}...")
            main_archive = download_resumable(
                session,
                f"{base_url}/{main_name}",
                build_dir / main_name,
                min_bytes=10_000_000,
                verify_tar=True,
                attempts=config.download_attempts,
            )
            cuda_archive = download_resumable(
                session,
                f"{base_url}/{cuda_name}",
                build_dir / cuda_name,
                min_bytes=1_000_000,
                verify_tar=True,
                attempts=config.download_attempts,
            )
        except AssetNotFound:
            warn(f"The assets of {tag} are not available, trying an older build.")
            continue
        except RuntimeError as exc:
            warn(f"The build {tag} could not be downloaded: {exc}")
            continue

        for archive in (main_archive, cuda_archive):
            log(f"Extracting {archive.name}...")
            with tarfile.open(archive, "r:gz") as tar:
                tar.extractall(build_dir)
            archive.unlink(missing_ok=True)

        env = library_env(config.bin_root)
        for binary in sorted(build_dir.rglob("llama-server")):
            if not binary.is_file():
                continue
            binary.chmod(0o755)
            check = subprocess.run(
                [str(binary), "--version"],
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
            if check.returncode == 0:
                log(f"llama.cpp is ready: {check.stdout.strip()}")
                return binary
            warn("The downloaded binary does not start:")
            warn((check.stderr or check.stdout)[-2000:])

    raise RuntimeError(
        "No working CUDA build of llama-server could be installed. Check the "
        "download log above, verify that Kaggle has Internet access and rerun "
        "the cell."
    )


def build_server_command(
    config: DeploymentConfig,
    binary: Path,
    model_path: Path,
    api_key: str,
    supported: set,
    variant: Dict[str, Any],
) -> List[str]:
    """
    Build the start-up command, using only the flags the build supports.

    ``variant`` selects the context size and whether speculative decoding
    (MTP) is attempted.
    """
    command = [
        str(binary),
        "--model",
        str(model_path),
        "--host",
        config.host,
        "--port",
        str(config.port),
        "--api-key",
        api_key,
        "--n-gpu-layers",
        str(config.n_gpu_layers),
        "--ctx-size",
        str(variant["ctx"]),
        "--parallel",
        str(config.parallel),
        "--batch-size",
        str(config.batch_size),
        "--ubatch-size",
        str(config.ubatch_size),
    ]

    # Multi GPU: split the layers over the devices instead of assuming one
    # unified memory pool.
    if "--split-mode" in supported:
        command += ["--split-mode", config.split_mode]
    if "--tensor-split" in supported:
        command += ["--tensor-split", config.tensor_split]
    if "--cache-type-k" in supported:
        command += ["--cache-type-k", config.cache_type_k]
    if "--cache-type-v" in supported:
        command += ["--cache-type-v", config.cache_type_v]
    if "--flash-attn" in supported:
        command += ["--flash-attn", "on"]
    if "--jinja" in supported:
        command.append("--jinja")

    # Reasoning effort is a start-up flag in llama.cpp.
    if variant.get("reasoning") and "--reasoning-effort" in supported:
        command += ["--reasoning-effort", config.reasoning_effort]

    # Speculative decoding with the MTP head of the model.
    if variant.get("mtp"):
        if "--spec-type" in supported and "--spec-draft-n-max" in supported:
            command += [
                "--spec-type",
                "draft-mtp",
                "--spec-draft-n-max",
                str(config.mtp_draft_n_max),
            ]
        else:
            log("This build does not support MTP speculative decoding, using plain inference.")

    return command


def server_variants(config: DeploymentConfig) -> List[Dict[str, Any]]:
    """
    The start-up variants that are tried, best first.

    The first variant is the verified configuration. The others are fallbacks
    for a machine with less memory or a build without the MTP support.
    """
    variants: List[Dict[str, Any]] = [
        {"ctx": config.ctx_size, "mtp": config.enable_mtp, "reasoning": True},
        {"ctx": config.ctx_size, "mtp": False, "reasoning": True},
        {"ctx": 4096, "mtp": False, "reasoning": True},
        {"ctx": 4096, "mtp": False, "reasoning": False},
    ]
    return variants


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------


def _looks_like_gguf(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(4) == b"GGUF"
    except OSError:
        return False


def find_saved_model(config: DeploymentConfig) -> Optional[Path]:
    """
    Find a complete model file.

    Looked at, in this order:

    1. an attached Kaggle Dataset (``/kaggle/input``),
    2. a previous Notebook Output that was copied into the working directory,
    3. the model that was downloaded in an earlier run of this cell.
    """
    candidates: List[Path] = []

    if config.input_root.exists():
        candidates.extend(sorted(config.input_root.rglob(config.model_file)))

    candidates.append(config.model_dir / config.model_file)

    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            if candidate.stat().st_size < config.min_model_bytes:
                log(f"Ignoring the incomplete model file {candidate}")
                continue
            if not _looks_like_gguf(candidate):
                log(f"Ignoring {candidate}: it is not a GGUF file")
                continue
        except OSError:
            continue
        return candidate

    return None


def download_model(session: requests.Session, config: DeploymentConfig) -> Path:
    """Download the GGUF model, resuming an interrupted download."""
    config.model_dir.mkdir(parents=True, exist_ok=True)
    destination = config.model_dir / config.model_file

    try:
        from huggingface_hub import hf_hub_download  # type: ignore

        log("Downloading the model from Hugging Face...")
        path = Path(
            hf_hub_download(
                repo_id=config.repo,
                filename=config.model_file,
                local_dir=str(config.model_dir),
            )
        )
        if path.exists() and path.stat().st_size >= config.min_model_bytes:
            log(f"The model is ready: {path} ({path.stat().st_size / 1e9:.2f} GB)")
            return path
        raise IOError("The model file appears to be incomplete.")
    except ImportError:
        log("huggingface_hub is not available, using the direct download.")
    except Exception as exc:  # noqa: BLE001
        warn(f"The Hugging Face download failed: {type(exc).__name__}: {exc}")
        log("Falling back to the direct download with resume support.")

    url = f"https://huggingface.co/{config.repo}/resolve/main/{config.model_file}"
    path = download_resumable(
        session,
        url,
        destination,
        min_bytes=config.min_model_bytes,
        verify_tar=False,
        attempts=config.download_attempts,
    )
    if not _looks_like_gguf(path):
        raise RuntimeError(f"The downloaded file {path} is not a GGUF file.")
    return path


# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------


def server_healthy(session: requests.Session, config: DeploymentConfig, api_key: str) -> bool:
    """True when a server with this API key answers on the local port."""
    try:
        health = session.get(f"{config.local_url}/health", timeout=(3, 5))
        if health.status_code != 200:
            return False
        models = session.get(
            f"{config.local_api_url}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=(5, 15),
        )
        return models.status_code == 200
    except requests.RequestException:
        return False


def stop_process(process: Optional[subprocess.Popen]) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def tail_log(path: Path, lines: int = 40) -> str:
    try:
        return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])
    except Exception:  # noqa: BLE001
        return "(no log available)"


def start_server(
    session: requests.Session,
    config: DeploymentConfig,
    binary: Path,
    model_path: Path,
    api_key: str,
) -> Tuple[str, Dict[str, Any]]:
    """
    Start the server and prove that it answers a real request.

    Returns the model id and the configuration that worked.
    """
    log_path = config.root / "llama-server.log"
    env = library_env(config.bin_root)

    try:
        help_text = subprocess.run(
            [str(binary), "--help"],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        ).stdout
    except Exception:  # noqa: BLE001
        help_text = ""
    supported = server_flags(help_text)
    log(f"The build supports {len(supported)} command line options.")

    for variant in server_variants(config):
        command = build_server_command(
            config, binary, model_path, api_key, supported, variant
        )
        label = (
            f"ctx={variant['ctx']}, "
            f"MTP={'on' if variant.get('mtp') else 'off'}, "
            f"reasoning={'on' if variant.get('reasoning') else 'off'}"
        )
        log(f"Starting llama-server: {label}")

        with open(log_path, "w") as log_file:
            process = subprocess.Popen(
                command,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )

        ready = False
        for _ in range(150):
            if process.poll() is not None:
                break
            if server_healthy(session, config, api_key):
                ready = True
                break
            time.sleep(2)

        if not ready:
            stop_process(process)
            warn(f"The variant {label} did not start.")
            warn(tail_log(log_path))
            continue

        try:
            model_id = list_models(session, config, api_key)
            log(f"Running the inference test for {label}...")
            content = smoke_test(session, config, api_key, model_id)
            log(f"The inference test passed ({label}): {content!r}")
            return model_id, dict(variant)
        except Exception as exc:  # noqa: BLE001
            warn(f"The inference test of {label} failed: {type(exc).__name__}: {exc}")

        stop_process(process)
        warn(tail_log(log_path))

    raise RuntimeError(
        "The model did not pass the start-up and the inference test. The log "
        "above shows why. Common causes: not enough VRAM for the context "
        "size, an unsupported build option or a damaged model file."
    )


def list_models(session: requests.Session, config: DeploymentConfig, api_key: str) -> str:
    response = session.get(
        f"{config.local_api_url}/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=(5, 15),
    )
    response.raise_for_status()
    models = response.json().get("data", [])
    if not models:
        raise RuntimeError("The server returned an empty model list.")
    return models[0]["id"]


def smoke_test(
    session: requests.Session, config: DeploymentConfig, api_key: str, model_id: str
) -> str:
    """Send a real chat completion and return the answer."""
    response = session.post(
        f"{config.local_api_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model_id,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "max_tokens": 24,
            "temperature": 0,
            "stream": False,
        },
        timeout=config.request_timeout,
    )
    response.raise_for_status()
    payload = response.json()
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("The smoke test returned no choices.")
    return (choices[0].get("message", {}) or {}).get("content", "")


def probe_local_streaming(
    session: requests.Session, config: DeploymentConfig, api_key: str, model_id: str
) -> bool:
    """Check whether the *local* server delivers a Server-Sent Event stream."""
    try:
        response = session.post(
            f"{config.local_api_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model_id,
                "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                "max_tokens": 8,
                "temperature": 0,
                "stream": True,
            },
            timeout=(10, 60),
            stream=True,
        )
        if response.status_code != 200:
            return False
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" not in content_type.lower():
            return False
        for chunk in response.iter_content(chunk_size=1024):
            if chunk:
                return True
        return False
    except requests.RequestException:
        return False


# --------------------------------------------------------------------------
# Public tunnel
# --------------------------------------------------------------------------


def get_cloudflared(session: requests.Session, config: DeploymentConfig) -> Path:
    """Download the cloudflared binary and check that it runs."""
    binary = config.bin_root / "cloudflared"

    if binary.exists():
        try:
            test = subprocess.run(
                [str(binary), "--version"], capture_output=True, text=True, timeout=20
            )
            if test.returncode == 0:
                return binary
        except Exception:  # noqa: BLE001
            pass
        binary.unlink(missing_ok=True)

    url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    binary = download_resumable(
        session,
        url,
        binary,
        min_bytes=5_000_000,
        verify_tar=False,
        attempts=8,
    )
    binary.chmod(0o755)

    test = subprocess.run(
        [str(binary), "--version"], capture_output=True, text=True, timeout=20
    )
    if test.returncode != 0:
        binary.unlink(missing_ok=True)
        raise RuntimeError("The downloaded cloudflared binary does not run.")
    return binary


def start_public_tunnel(session: requests.Session, config: DeploymentConfig) -> Optional[str]:
    """Start a Cloudflare Quick Tunnel and return its URL, if one appears."""
    log_path = config.root / "cloudflared.log"

    try:
        binary = get_cloudflared(session, config)
    except Exception as exc:  # noqa: BLE001
        warn(f"The public tunnel is not available: {type(exc).__name__}: {exc}")
        return None

    with open(log_path, "w") as log_file:
        process = subprocess.Popen(
            [str(binary), "tunnel", "--url", config.local_url, "--no-autoupdate"],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    for _ in range(90):
        if process.poll() is not None:
            warn("The tunnel process exited:")
            warn(tail_log(log_path))
            return None
        try:
            text = log_path.read_text(errors="replace")
        except OSError:
            text = ""
        match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", text)
        if match:
            return match.group(0)
        time.sleep(1)

    warn("The tunnel did not report a URL within 90 seconds:")
    warn(tail_log(log_path))
    return None


def verify_public_endpoint(
    session: requests.Session, public_url: str, api_key: str
) -> Tuple[bool, str]:
    """
    Check that the tunnel really forwards API calls.

    The local server answering is not enough: the public path has to be
    verified separately.
    """
    try:
        response = session.get(
            f"{public_url}/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=(10, 30),
        )
        if response.status_code == 200:
            return True, "The public endpoint answered a model list request."
        return False, f"The public endpoint answered with HTTP {response.status_code}."
    except requests.RequestException as exc:
        return False, f"The public endpoint is not reachable: {type(exc).__name__}: {exc}"


# --------------------------------------------------------------------------
# Runtime bundle
# --------------------------------------------------------------------------


def write_runtime_bundle(
    config: DeploymentConfig,
    api_key: str,
    model_id: str,
    model_path: Path,
    variant: Dict[str, Any],
    public_url: Optional[str],
    binary: Path,
) -> Dict[str, Path]:
    """
    Write the files that connect this deployment to the chat interface.

    * ``api_key.txt``  - the key, readable by the owner only (0600),
    * ``runtime.json`` - the start-up configuration of the server,
    * ``profile.json`` - a profile that can be pasted into the chat client.

    The key is never written into ``runtime.json`` or ``profile.json``.
    """
    config.root.mkdir(parents=True, exist_ok=True)

    key_path = config.root / "api_key.txt"
    key_path.write_text(api_key + "\n", encoding="utf-8")
    key_path.chmod(0o600)

    runtime = {
        "model": model_id,
        "model_file": str(model_path),
        "model_bytes": model_path.stat().st_size if model_path.exists() else None,
        "context_size": variant.get("ctx"),
        "reasoning_effort": config.reasoning_effort if variant.get("reasoning") else None,
        "mtp_speculative_decoding": bool(variant.get("mtp")),
        "gpu_layer_offload": config.n_gpu_layers,
        "split_mode": config.split_mode,
        "tensor_split": config.tensor_split,
        "local_base_url": config.local_api_url,
        "public_base_url": f"{public_url}/v1" if public_url else None,
        "server_binary": str(binary),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    runtime_path = config.root / "runtime.json"
    runtime_path.write_text(json.dumps(runtime, indent=2) + "\n", encoding="utf-8")

    profile = {
        "name": "Kaggle T4 x2",
        "baseUrl": f"{public_url}/v1" if public_url else config.local_api_url,
        "model": model_id,
        "note": "The API key is not part of this file; paste it into the chat interface.",
    }
    profile_path = config.root / "profile.json"
    profile_path.write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")

    return {"api_key": key_path, "runtime": runtime_path, "profile": profile_path}


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main(config: Optional[DeploymentConfig] = None) -> Dict[str, Any]:
    """Deploy the model and return the resulting runtime information."""
    config = config or DeploymentConfig()
    for directory in (config.root, config.model_dir, config.bin_root):
        directory.mkdir(parents=True, exist_ok=True)

    session = build_session()

    # The key is generated for this session only. It is never stored in the
    # repository and never written into the log output.
    api_key = secrets.token_urlsafe(32)
    headers = {"Authorization": f"Bearer {api_key}"}

    check_gpus(config)

    binary = get_server_binary(session, config)

    model_path = find_saved_model(config)
    if model_path:
        log(f"Reusing the model: {model_path}")
    else:
        model_path = download_model(session, config)

    if server_healthy(session, config, api_key):
        log("A healthy llama-server is already running, it is reused.")
        model_id = list_models(session, config, api_key)
        variant = {"ctx": config.ctx_size, "mtp": config.enable_mtp, "reasoning": True}
    else:
        model_id, variant = start_server(session, config, binary, model_path, api_key)

    local_streaming = probe_local_streaming(session, config, api_key, model_id)
    log(f"Local streaming supported: {local_streaming}")

    public_url: Optional[str] = None
    public_verified = False
    public_detail = "The public tunnel was not started."
    if config.enable_tunnel:
        public_url = start_public_tunnel(session, config)
        if public_url:
            public_verified, public_detail = verify_public_endpoint(session, public_url, api_key)
            if not public_verified:
                warn(f"The public endpoint is not usable yet: {public_detail}")
        else:
            warn("No public URL was returned. The local API stays available.")

    paths = write_runtime_bundle(
        config, api_key, model_id, model_path, variant, public_url, binary
    )

    print("\n" + "=" * 60)
    print("QWEN API STATUS")
    print("=" * 60)
    print(f"Model:            {model_id}")
    print(f"Model file:       {model_path}")
    print(f"Context size:     {variant.get('ctx')}")
    print(f"Reasoning effort: {config.reasoning_effort if variant.get('reasoning') else 'server default'}")
    print(f"MTP decoding:     {'enabled' if variant.get('mtp') else 'disabled'}")
    print(f"Local endpoint:   {config.local_api_url}")
    print(f"Public endpoint:  {f'{public_url}/v1' if public_url else 'unavailable'}")
    if public_url:
        print(f"Public status:    {public_detail}")
    print(f"Local streaming:  {'supported' if local_streaming else 'not supported'}")
    print(f"llama-server:     {binary}")
    print(f"Runtime info:     {paths['runtime']}")
    print(f"Profile template: {paths['profile']}")
    print("-" * 60)
    print("The API key is generated for this session only.")
    print(f"It is stored in {paths['api_key']} (mode 0600).")
    print("Copy it into the chat interface; rotate it by restarting the cell.")
    print(f"API key: {api_key}")
    print("=" * 60)

    return {
        "model_id": model_id,
        "model_path": str(model_path),
        "api_key": api_key,
        "local_url": config.local_api_url,
        "public_url": f"{public_url}/v1" if public_url else None,
        "public_verified": public_verified,
        "public_detail": public_detail,
        "local_streaming": local_streaming,
        "variant": variant,
        "paths": {name: str(path) for name, path in paths.items()},
    }


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        fail(f"{type(error).__name__}: {error}")
        sys.exit(1)
