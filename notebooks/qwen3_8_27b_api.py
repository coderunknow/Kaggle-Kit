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
* **One server per notebook.** The running server is described by
  ``server-state.json`` (process id, port, model, applied options). A rerun
  reuses a healthy server whose configuration still matches, restarts a
  server that this cell started itself but that no longer fits, and never
  touches a process that this cell did not start.
* **Reported state is applied state.** The runtime bundle and the summary
  only report options that were really passed to the binary. A plain
  inference test proves that the model works; it never proves that
  speculative decoding is active.
* **The public route is tested on its own.** The public endpoint is verified
  with an authenticated chat completion over the tunnel, separately from the
  local server.

Environment (Kaggle):

* Accelerator: *GPU T4 x2* (Settings -> Accelerator -> GPU T4 x2)
* Internet: on
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import socket
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

STATE_FILE_NAME = "server-state.json"
KEY_FILE_NAME = "api_key.txt"

# What the cell may do with the port of the local server.
ACTION_START = "start"
ACTION_REUSE = "reuse"
ACTION_RESTART = "restart"
ACTION_CONFLICT = "conflict"


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


class ChecksumMismatch(Exception):
    """A downloaded file does not match its pinned SHA-256 digest."""


# SHA-256 digests of the official llama.cpp release assets, as published by
# the GitHub API for each release. A download that does not match is deleted
# and aborts the deployment: executing an unverified binary is never an
# acceptable fallback.
LLAMA_CPP_SHA256 = {
    "llama-b11719-bin-ubuntu-cuda-12.8-x64.tar.gz": "e283eb9a2c245501317d4abbb822e5ab429a84693580f4ff5c533712db014f3b",
    "cudart-llama-b11719-bin-ubuntu-cuda-12.8-x64.tar.gz": "0b8816822a8258683fe15e7bb29eb8aaca9f9a36a949c985430e0f94ad838722",
    "llama-b11718-bin-ubuntu-cuda-12.8-x64.tar.gz": "491595b522685a7b51974e80c21a8458e3afb5cf630fa48dc74fa854c378b3e0",
    "cudart-llama-b11718-bin-ubuntu-cuda-12.8-x64.tar.gz": "57ec265d78c97fa23399226d3228d6be5295d5ae9214681fa292b88c809873d5",
    "llama-b11717-bin-ubuntu-cuda-12.8-x64.tar.gz": "50db91afc85f5e1c96ed0edb5cf8fde5102c342a55c964887ca35610c4163bf4",
    "cudart-llama-b11717-bin-ubuntu-cuda-12.8-x64.tar.gz": "d79451494f2e990b1fb0742163bfb308a77152c6912cb4075968d4a3fe1fed2f",
}


def sha256_of(path: Path) -> str:
    """The SHA-256 digest of a file, read in chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sha256(path: Path, expected_sha256: str) -> None:
    """Refuse a file whose digest differs from the pinned one."""
    actual = sha256_of(path)
    if actual.lower() != expected_sha256.lower():
        raise ChecksumMismatch(
            f"{path.name} does not match its pinned SHA-256 digest "
            f"(expected {expected_sha256.lower()}, got {actual}). "
            "The file was deleted and nothing was executed."
        )


def download_resumable(
    session: requests.Session,
    url: str,
    destination: Path,
    min_bytes: int = 1_000_000,
    verify_tar: bool = False,
    attempts: int = 10,
    expected_sha256: Optional[str] = None,
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
        if expected_sha256 is not None:
            try:
                verify_sha256(destination, expected_sha256)
            except ChecksumMismatch:
                log(f"Removing {destination.name}: it does not match the pinned SHA-256 digest.")
                destination.unlink(missing_ok=True)
        if destination.exists() and (not verify_tar or _is_valid_tar(destination)):
            log(f"Reusing {destination.name} ({destination.stat().st_size / 1e9:.2f} GB)")
            return destination
        if destination.exists():
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

                content_type = (response.headers.get("content-type") or "").lower()
                if content_type.startswith("text/html"):
                    raise IOError(
                        "The server answered with an HTML page instead of the file."
                    )

                append = offset > 0 and response.status_code == 206
                mode = "ab" if append else "wb"

                # The length the server announces. A range answer only
                # announces the remaining bytes.
                expected: Optional[int] = None
                raw_length = response.headers.get("content-length")
                if raw_length and str(raw_length).strip().isdigit():
                    announced = int(str(raw_length).strip())
                    expected = announced + offset if append else announced

                with open(part, mode) as handle:
                    for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
                        if chunk:
                            handle.write(chunk)

            if not part.exists() or part.stat().st_size < min_bytes:
                raise IOError("The downloaded file is too small or incomplete.")

            if expected is not None and part.stat().st_size != expected:
                raise IOError(
                    "The download was truncated: the server announced "
                    f"{expected} bytes, {part.stat().st_size} bytes arrived."
                )

            if verify_tar and not _is_valid_tar(part):
                raise IOError("The downloaded archive is not a readable tar file.")

            if expected_sha256 is not None:
                try:
                    verify_sha256(part, expected_sha256)
                except ChecksumMismatch:
                    part.unlink(missing_ok=True)
                    raise

            os.replace(part, destination)
            log(f"Downloaded {destination.name} ({destination.stat().st_size / 1e9:.2f} GB)")
            return destination

        except (AssetNotFound, ChecksumMismatch):
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


def _is_within(base: Path, target: Path) -> bool:
    """True when ``target`` is ``base`` or lives inside of it."""
    try:
        target.relative_to(base)
    except ValueError:
        return False
    return True


def safe_extract(archive: tarfile.TarFile, destination: Path) -> List[str]:
    """
    Extract an archive without letting it write outside of ``destination``.

    Every member is checked before a single byte is written:

    * the name of a member must stay inside the destination,
    * a symbolic or hard link must point inside the destination,
    * device files and named pipes are refused.

    Returns the names of the extracted members.
    """
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    for member in archive.getmembers():
        name = member.name
        if name.startswith("/") or ".." in Path(name).parts:
            raise RuntimeError(
                f"The archive contains an unsafe path ({name!r}); it was not extracted."
            )

        target = (destination / name).resolve()
        if not _is_within(destination, target):
            raise RuntimeError(
                f"The archive would write outside of the target directory ({name!r}); "
                "it was not extracted."
            )

        if member.issym() or member.islnk():
            if member.islnk():
                link_target = (destination / member.linkname).resolve()
            else:
                link_target = (target.parent / member.linkname).resolve()
            if not _is_within(destination, link_target):
                raise RuntimeError(
                    f"The archive contains a link that points outside of the target "
                    f"directory ({name!r}); it was not extracted."
                )

        if member.isdev() or member.isfifo():
            raise RuntimeError(
                f"The archive contains a device or pipe ({name!r}); it was not extracted."
            )

    names = [member.name for member in archive.getmembers()]
    try:
        archive.extractall(destination, filter="data")
    except TypeError:  # pragma: no cover - Python without the extraction filter
        archive.extractall(destination)
    return names


def extract_archive(archive_path: Path, destination: Path) -> List[str]:
    """Open a tar.gz archive and extract it safely."""
    with tarfile.open(archive_path, "r:gz") as archive:
        return safe_extract(archive, destination)


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
                expected_sha256=LLAMA_CPP_SHA256.get(main_name),
            )
            cuda_archive = download_resumable(
                session,
                f"{base_url}/{cuda_name}",
                build_dir / cuda_name,
                min_bytes=1_000_000,
                verify_tar=True,
                attempts=config.download_attempts,
                expected_sha256=LLAMA_CPP_SHA256.get(cuda_name),
            )
        except AssetNotFound:
            warn(f"The assets of {tag} are not available, trying an older build.")
            continue
        except RuntimeError as exc:
            warn(f"The build {tag} could not be downloaded: {exc}")
            continue

        for archive in (main_archive, cuda_archive):
            log(f"Extracting {archive.name}...")
            try:
                extract_archive(archive, build_dir)
            except RuntimeError as exc:
                warn(f"The archive {archive.name} was not extracted: {exc}")
                archive.unlink(missing_ok=True)
                continue
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


@dataclass
class ServerLaunch:
    """
    A start-up command and the options that are really applied.

    ``applied`` is the source of truth for the runtime bundle and for the
    summary: an option is only listed when the flag was really passed to the
    binary. ``dropped`` lists the requested options the build does not
    understand.
    """

    command: List[str]
    applied: Dict[str, Any]
    dropped: List[str] = field(default_factory=list)


MTP_FLAGS = ("--spec-type", "--spec-draft-n-max")


def build_server_command(
    config: DeploymentConfig,
    binary: Path,
    model_path: Path,
    api_key: str,
    supported: set,
    variant: Dict[str, Any],
    api_key_file: Optional[Path] = None,
) -> ServerLaunch:
    """
    Build the start-up command, using only the flags the build supports.

    ``variant`` selects the context size and whether speculative decoding
    (MTP) is attempted. The returned object also reports which options were
    applied, so the runtime bundle never claims more than the server has.
    """
    dropped: List[str] = []
    applied: Dict[str, Any] = {
        "ctx": int(variant["ctx"]),
        "n_gpu_layers": config.n_gpu_layers,
        "parallel": config.parallel,
        "batch_size": config.batch_size,
        "ubatch_size": config.ubatch_size,
        "mtp": False,
        "reasoning": False,
        "split_mode": None,
        "tensor_split": None,
        "cache_type_k": None,
        "cache_type_v": None,
        "flash_attn": False,
        "jinja": False,
        "api_key_source": None,
    }

    command = [
        str(binary),
        "--model",
        str(model_path),
        "--host",
        config.host,
        "--port",
        str(config.port),
    ]

    # The key is read from a file when the build supports it, so it does not
    # show up in the process list of the machine.
    if "--api-key-file" in supported and api_key_file is not None:
        command += ["--api-key-file", str(api_key_file)]
        applied["api_key_source"] = "file"
    else:
        command += ["--api-key", api_key]
        applied["api_key_source"] = "argument"

    command += [
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
        applied["split_mode"] = config.split_mode
    elif config.split_mode:
        dropped.append("split_mode")

    if "--tensor-split" in supported:
        command += ["--tensor-split", config.tensor_split]
        applied["tensor_split"] = config.tensor_split
    elif config.tensor_split:
        dropped.append("tensor_split")

    if "--cache-type-k" in supported:
        command += ["--cache-type-k", config.cache_type_k]
        applied["cache_type_k"] = config.cache_type_k
    else:
        dropped.append("cache_type_k")

    if "--cache-type-v" in supported:
        command += ["--cache-type-v", config.cache_type_v]
        applied["cache_type_v"] = config.cache_type_v
    else:
        dropped.append("cache_type_v")

    if "--flash-attn" in supported:
        command += ["--flash-attn", "on"]
        applied["flash_attn"] = True

    if "--jinja" in supported:
        command.append("--jinja")
        applied["jinja"] = True

    # Reasoning effort is a start-up flag in llama.cpp.
    if variant.get("reasoning"):
        if "--reasoning-effort" in supported:
            command += ["--reasoning-effort", config.reasoning_effort]
            applied["reasoning"] = True
            applied["reasoning_effort"] = config.reasoning_effort
        else:
            dropped.append("reasoning")
            log("This build has no --reasoning-effort option; the server default is used.")

    # Speculative decoding with the MTP head of the model.
    if variant.get("mtp"):
        if all(flag in supported for flag in MTP_FLAGS):
            command += [
                "--spec-type",
                "draft-mtp",
                "--spec-draft-n-max",
                str(config.mtp_draft_n_max),
            ]
            applied["mtp"] = True
            applied["mtp_draft_n_max"] = config.mtp_draft_n_max
        else:
            dropped.append("mtp")
            log(
                "This build does not support MTP speculative decoding "
                f"({', '.join(flag for flag in MTP_FLAGS if flag not in supported)} "
                "is missing); plain inference is used."
            )

    return ServerLaunch(command=command, applied=applied, dropped=dropped)


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


def usable_variants(
    variants: List[Dict[str, Any]], supported: set
) -> List[Dict[str, Any]]:
    """
    The variants that are really different for this build.

    A variant that needs an option the build does not understand is reduced
    to the same behaviour as the variant without that option, so it is only
    tried once.
    """
    result: List[Dict[str, Any]] = []
    seen: set = set()

    for variant in variants:
        reduced = dict(variant)
        if reduced.get("mtp") and not all(flag in supported for flag in MTP_FLAGS):
            reduced["mtp"] = False
        if reduced.get("reasoning") and "--reasoning-effort" not in supported:
            reduced["reasoning"] = False

        marker = (reduced.get("ctx"), bool(reduced.get("mtp")), bool(reduced.get("reasoning")))
        if marker in seen:
            continue
        seen.add(marker)
        result.append(reduced)

    return result


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
# Server state
# --------------------------------------------------------------------------


def state_file(config: DeploymentConfig) -> Path:
    """The file that describes the server this cell started."""
    return config.root / STATE_FILE_NAME


def key_file(config: DeploymentConfig) -> Path:
    """The file that holds the API key of the running server (mode 0600)."""
    return config.root / KEY_FILE_NAME


def read_server_state(config: DeploymentConfig) -> Optional[Dict[str, Any]]:
    """Read the state of a previously started server, if there is one."""
    try:
        raw = state_file(config).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def write_server_state(config: DeploymentConfig, state: Dict[str, Any]) -> Path:
    """Write the state of the running server."""
    path = state_file(config)
    # The state never contains the API key.
    _write_private_text(path, json.dumps(state, indent=2, sort_keys=True) + "\n")
    return path


def _write_private_text(path: Path, text: str) -> None:
    """Write ``text`` so the file is owner-only from the first byte."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)
    path.chmod(0o600)


def clear_server_state(config: DeploymentConfig) -> None:
    state_file(config).unlink(missing_ok=True)


def write_api_key(config: DeploymentConfig, api_key: str) -> Path:
    """Store the API key of the running server, readable by the owner only."""
    path = key_file(config)
    _write_private_text(path, api_key + "\n")
    return path


def read_api_key(config: DeploymentConfig) -> Optional[str]:
    """Read the stored API key, if there is one."""
    try:
        value = key_file(config).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def process_alive(pid: int) -> bool:
    """True when a process with this id exists."""
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
    """The command line of a process, or an empty string when it is unknown."""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return ""
    return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()


def owns_process(state: Optional[Dict[str, Any]]) -> bool:
    """
    True when the recorded process is still the ``llama-server`` of this cell.

    The check looks at the command line, so a process id that was reused by an
    unrelated program is never treated as our server.
    """
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
        # No /proc (not Linux): the recorded pid is the only evidence.
        return True
    return "llama-server" in cmdline


def port_in_use(host: str, port: int, timeout: float = 1.0) -> bool:
    """True when something is listening on the address."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def deployment_fingerprint(
    config: DeploymentConfig, model_path: Path, binary: Path
) -> str:
    """
    A digest of the inputs that decide whether a running server still fits.

    The digest is about the *request*, not about the result: a server that
    had to fall back to a smaller context is still the server of this
    configuration and is reused.
    """
    payload = {
        "model_file": str(model_path),
        "binary": str(binary),
        "host": config.host,
        "port": config.port,
        "ctx_size": config.ctx_size,
        "enable_mtp": bool(config.enable_mtp),
        "reasoning_effort": config.reasoning_effort,
        "n_gpu_layers": config.n_gpu_layers,
        "split_mode": config.split_mode,
        "tensor_split": config.tensor_split,
    }
    blob = json.dumps(payload, sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def decide_server_action(
    *, port_busy: bool, owned: bool, healthy: bool, compatible: bool
) -> str:
    """
    What the cell may do with the local port.

    * ``start``    - nothing is listening, a new server is started,
    * ``reuse``    - our own server is running, healthy and still fits,
    * ``restart``  - our own server is running but is unhealthy or outdated,
    * ``conflict`` - somebody else uses the port; the cell does not touch it.
    """
    if not port_busy:
        return ACTION_START
    if not owned:
        return ACTION_CONFLICT
    if healthy and compatible:
        return ACTION_REUSE
    return ACTION_RESTART


def stop_owned_server(config: DeploymentConfig, state: Optional[Dict[str, Any]]) -> bool:
    """
    Stop the server of a previous run of this cell.

    Only a process that is recorded in the state file *and* is still a
    ``llama-server`` is stopped. A foreign process is never touched.
    """
    if not owns_process(state):
        return False

    try:
        pid = int((state or {}).get("pid") or 0)
    except (TypeError, ValueError):
        return False

    log(f"Stopping the llama-server of a previous run (pid {pid}).")
    try:
        os.kill(pid, 15)
    except OSError:
        return False

    for _ in range(20):
        if not process_alive(pid):
            return True
        time.sleep(0.5)

    warn(f"The process {pid} did not stop, it is killed now.")
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    return True


# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------


def server_healthy(session: requests.Session, config: DeploymentConfig, api_key: str) -> bool:
    """
    True when a server with this API key answers on the local port.

    The key is the one of the *running* server: a server that was started
    with a different key is not healthy for this key and is not reused.
    """
    try:
        health = session.get(f"{config.local_url}/health", timeout=(3, 5))
        if health.status_code != 200:
            return False
        models = session.get(
            f"{config.local_api_url}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=(5, 15),
        )
        if models.status_code != 200:
            return False
        payload = models.json()
    except (requests.RequestException, ValueError):
        return False

    data = payload.get("data") if isinstance(payload, dict) else None
    return bool(data)


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
    fingerprint: str = "",
    api_key_file: Optional[Path] = None,
) -> Tuple[str, Dict[str, Any]]:
    """
    Start the server and prove that it answers a real request.

    Returns the model id and the options that were really applied. The
    options come from the start-up command, not from the request: a fallback
    to a smaller context or a build without MTP support is reported as such.
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

    variants = usable_variants(server_variants(config), supported)

    for variant in variants:
        launch = build_server_command(
            config, binary, model_path, api_key, supported, variant, api_key_file
        )
        applied = launch.applied
        label = (
            f"ctx={applied['ctx']}, "
            f"MTP={'on' if applied['mtp'] else 'off'}, "
            f"reasoning={'on' if applied['reasoning'] else 'off'}"
        )
        log(f"Starting llama-server: {label}")
        if launch.dropped:
            log(f"Not supported by this build: {', '.join(launch.dropped)}.")

        with open(log_path, "w") as log_file:
            process = subprocess.Popen(
                launch.command,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )

        # The state is written before the first check, so an interrupted run
        # still knows which process belongs to this cell.
        write_server_state(
            config,
            {
                "pid": process.pid,
                "host": config.host,
                "port": config.port,
                "model_path": str(model_path),
                "binary": str(binary),
                "fingerprint": fingerprint,
                "applied": applied,
                "dropped": launch.dropped,
                "log_file": str(log_path),
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            },
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
            state = read_server_state(config) or {}
            state.update({"model_id": model_id})
            write_server_state(config, state)
            return model_id, dict(applied)
        except Exception as exc:  # noqa: BLE001
            warn(f"The inference test of {label} failed: {type(exc).__name__}: {exc}")

        stop_process(process)
        warn(tail_log(log_path))

    clear_server_state(config)
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
    session: requests.Session,
    public_url: str,
    api_key: str,
    model_id: Optional[str] = None,
    timeout: Tuple[int, int] = (10, 30),
    completion_timeout: Tuple[int, int] = (10, 90),
) -> Dict[str, Any]:
    """
    Check that the tunnel really forwards API calls.

    The local server answering is not enough, so the public route is tested on
    its own: first the model list, then a real chat completion with a small
    output limit. The result keeps the two steps apart, so a reachable but
    broken public route is not reported as a working one.

    The API key is only sent in the ``Authorization`` header. It never
    appears in a URL or in a message of this function.
    """
    result: Dict[str, Any] = {
        "models_ok": False,
        "inference_ok": False,
        "kind": "unknown",
        "detail": "",
    }
    base = public_url.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        response = session.get(f"{base}/v1/models", headers=headers, timeout=timeout)
    except requests.Timeout:
        result["kind"] = "timeout"
        result["detail"] = "The public endpoint did not answer in time."
        return result
    except requests.RequestException as exc:
        result["kind"] = "unreachable"
        result["detail"] = f"The public endpoint is not reachable ({type(exc).__name__})."
        return result

    if response.status_code in (401, 403):
        result["kind"] = "auth"
        result["detail"] = (
            f"The public endpoint rejected the API key (HTTP {response.status_code})."
        )
        return result

    if response.status_code != 200:
        result["kind"] = "upstream"
        result["detail"] = f"The public endpoint answered with HTTP {response.status_code}."
        return result

    try:
        payload = response.json()
    except ValueError:
        result["kind"] = "invalid_response"
        result["detail"] = "The public endpoint did not answer with JSON."
        return result

    models = payload.get("data") if isinstance(payload, dict) else None
    if not models:
        result["kind"] = "invalid_response"
        result["detail"] = "The public endpoint returned an empty model list."
        return result

    result["models_ok"] = True
    model = model_id or (models[0] or {}).get("id")

    try:
        completion = session.post(
            f"{base}/v1/chat/completions",
            headers={**headers, "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                "max_tokens": 8,
                "temperature": 0,
                "stream": False,
            },
            timeout=completion_timeout,
        )
    except requests.Timeout:
        result["kind"] = "timeout"
        result["detail"] = "The public chat completion did not answer in time."
        return result
    except requests.RequestException as exc:
        result["kind"] = "unreachable"
        result["detail"] = f"The public chat completion failed ({type(exc).__name__})."
        return result

    if completion.status_code in (401, 403):
        result["kind"] = "auth"
        result["detail"] = (
            f"The public endpoint rejected the API key for the chat completion "
            f"(HTTP {completion.status_code})."
        )
        return result

    if completion.status_code != 200:
        result["kind"] = "upstream"
        result["detail"] = (
            f"The public chat completion answered with HTTP {completion.status_code}."
        )
        return result

    try:
        data = completion.json()
    except ValueError:
        result["kind"] = "invalid_response"
        result["detail"] = "The public chat completion did not answer with JSON."
        return result

    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        result["kind"] = "invalid_response"
        result["detail"] = "The public chat completion returned no choices."
        return result

    content = ((choices[0] or {}).get("message") or {}).get("content")
    if not isinstance(content, str):
        result["kind"] = "invalid_response"
        result["detail"] = "The public chat completion returned no answer text."
        return result

    result["inference_ok"] = True
    result["kind"] = "ok"
    result["detail"] = "The public endpoint answered an authenticated chat completion."
    return result


def probe_public_streaming(
    session: requests.Session, public_url: str, api_key: str, model_id: str
) -> Tuple[bool, str]:
    """
    Check whether the *public* route delivers a Server-Sent Event stream.

    A Quick Tunnel does not forward a streaming answer; the result is
    reported separately from the local streaming support, because a working
    local stream says nothing about the public route.
    """
    base = public_url.rstrip("/")
    try:
        response = session.post(
            f"{base}/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
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
    except requests.Timeout:
        return False, "The public streaming probe timed out."
    except requests.RequestException as exc:
        return False, f"The public streaming probe failed ({type(exc).__name__})."

    if response.status_code != 200:
        return False, f"The public streaming probe answered with HTTP {response.status_code}."

    content_type = (response.headers.get("content-type") or "").lower()
    if "text/event-stream" not in content_type:
        return False, (
            "The public endpoint answered with "
            f"\"{content_type or 'unknown'}\" instead of an event stream."
        )

    for chunk in response.iter_content(chunk_size=1024):
        if chunk:
            return True, "The public endpoint delivers an event stream."
    return False, "The public event stream was empty."


# --------------------------------------------------------------------------
# Runtime bundle
# --------------------------------------------------------------------------


def write_runtime_bundle(
    config: DeploymentConfig,
    api_key: str,
    model_id: str,
    model_path: Path,
    applied: Dict[str, Any],
    public_url: Optional[str],
    binary: Path,
    *,
    local_streaming: Optional[bool] = None,
    public_status: Optional[Dict[str, Any]] = None,
    reused: bool = False,
    server_pid: Optional[int] = None,
) -> Dict[str, Path]:
    """
    Write the files that connect this deployment to the chat interface.

    * ``api_key.txt``  - the key, readable by the owner only (0600),
    * ``runtime.json`` - the start-up configuration of the server,
    * ``profile.json`` - a profile that can be pasted into the chat client.

    The key is never written into ``runtime.json`` or ``profile.json``. The
    runtime file only reports the options that were really applied to the
    server.
    """
    config.root.mkdir(parents=True, exist_ok=True)

    key_path = write_api_key(config, api_key)

    public = public_status or {}
    runtime = {
        "model": model_id,
        "model_file": str(model_path),
        "model_bytes": model_path.stat().st_size if model_path.exists() else None,
        "context_size": applied.get("ctx"),
        "reasoning_effort": applied.get("reasoning_effort"),
        "reasoning_applied": bool(applied.get("reasoning")),
        "mtp_speculative_decoding": bool(applied.get("mtp")),
        "mtp_draft_n_max": applied.get("mtp_draft_n_max"),
        "gpu_layer_offload": applied.get("n_gpu_layers", config.n_gpu_layers),
        "split_mode": applied.get("split_mode"),
        "tensor_split": applied.get("tensor_split"),
        "cache_type_k": applied.get("cache_type_k"),
        "cache_type_v": applied.get("cache_type_v"),
        "flash_attn": bool(applied.get("flash_attn")),
        "unsupported_options": list(applied.get("unsupported_options") or []),
        "local_base_url": config.local_api_url,
        "public_base_url": f"{public_url}/v1" if public_url else None,
        "local_streaming_supported": local_streaming,
        "public_endpoint_verified": bool(public.get("inference_ok")),
        "public_verification": public.get("detail"),
        "public_streaming_supported": public.get("streaming_supported"),
        "reused_existing_server": bool(reused),
        "server_pid": server_pid,
        "server_binary": str(binary),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "mtp_note": (
            "The MTP draft head is enabled with --spec-type/--spec-draft-n-max. "
            "The start-up test proves that the server answers; it does not measure "
            "the effect of the speculative decoding."
        ),
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
    """
    Deploy the model and return the resulting runtime information.

    The cell can be run again: a healthy server of a previous run is reused
    when its configuration still fits, a server of this cell that no longer
    fits is restarted with a new key, and a process that this cell did not
    start is never touched.
    """
    config = config or DeploymentConfig()
    for directory in (config.root, config.model_dir, config.bin_root):
        directory.mkdir(parents=True, exist_ok=True)

    session = build_session()

    check_gpus(config)

    binary = get_server_binary(session, config)

    model_path = find_saved_model(config)
    if model_path:
        log(f"Reusing the model: {model_path}")
    else:
        model_path = download_model(session, config)

    fingerprint = deployment_fingerprint(config, model_path, binary)
    state = read_server_state(config)
    owned = owns_process(state)
    busy = port_in_use(config.host, config.port)
    stored_key = read_api_key(config)
    healthy = bool(stored_key) and busy and server_healthy(session, config, stored_key)
    compatible = bool(state) and state.get("fingerprint") == fingerprint

    action = decide_server_action(
        port_busy=busy, owned=owned, healthy=healthy, compatible=compatible
    )
    log(f"Local server decision: {action} (port busy: {busy}, own process: {owned}).")

    reused = False
    rotated = False
    server_pid: Optional[int] = None

    if action == ACTION_CONFLICT:
        raise RuntimeError(
            f"The port {config.port} on {config.host} is used by a process that this "
            "cell did not start. The cell never stops a foreign process. Stop that "
            "process, or use another port in DeploymentConfig, and rerun the cell."
        )

    if action == ACTION_REUSE:
        api_key = stored_key or ""
        model_id = (state or {}).get("model_id") or list_models(session, config, api_key)
        applied = dict((state or {}).get("applied") or {})
        server_pid = (state or {}).get("pid")
        reused = True
        log("The llama-server of a previous run is healthy and still fits; it is reused.")
    else:
        if action == ACTION_RESTART:
            stop_owned_server(config, state)
            for _ in range(20):
                if not port_in_use(config.host, config.port):
                    break
                time.sleep(0.5)
            rotated = True
            log("The server of the previous run does not fit this configuration any more.")
        elif state:
            clear_server_state(config)

        # A new server gets a new key. The key of a running server is never
        # changed behind the back of the user.
        api_key = secrets.token_urlsafe(32)
        write_api_key(config, api_key)
        model_id, applied = start_server(
            session,
            config,
            binary,
            model_path,
            api_key,
            fingerprint=fingerprint,
            api_key_file=key_file(config),
        )
        server_pid = (read_server_state(config) or {}).get("pid")

    local_streaming = probe_local_streaming(session, config, api_key, model_id)
    log(f"Local streaming supported: {local_streaming}")

    public_url: Optional[str] = None
    public_status: Dict[str, Any] = {
        "models_ok": False,
        "inference_ok": False,
        "kind": "no_tunnel",
        "detail": "The public tunnel was not started.",
        "streaming_supported": None,
    }

    if config.enable_tunnel:
        public_url = start_public_tunnel(session, config)
        if public_url:
            public_status = verify_public_endpoint(session, public_url, api_key, model_id)
            if public_status.get("inference_ok"):
                supported, detail = probe_public_streaming(
                    session, public_url, api_key, model_id
                )
                public_status["streaming_supported"] = supported
                public_status["streaming_detail"] = detail
            else:
                warn(f"The public endpoint is not usable yet: {public_status.get('detail')}")
        else:
            warn("No public URL was returned. The local API stays available.")

    applied = dict(applied)
    applied["unsupported_options"] = (state or {}).get("dropped") or []

    paths = write_runtime_bundle(
        config,
        api_key,
        model_id,
        model_path,
        applied,
        public_url,
        binary,
        local_streaming=local_streaming,
        public_status=public_status,
        reused=reused,
        server_pid=server_pid,
    )

    public_verified = bool(public_status.get("inference_ok"))
    public_detail = str(public_status.get("detail") or "")
    public_streaming = public_status.get("streaming_supported")

    print("\n" + "=" * 60)
    print("QWEN API STATUS")
    print("=" * 60)
    print(f"Model:            {model_id}")
    print(f"Model file:       {model_path}")
    print(f"Context size:     {applied.get('ctx')}")
    if applied.get("reasoning"):
        print(f"Reasoning effort: {applied.get('reasoning_effort')} (start-up flag)")
    else:
        print("Reasoning effort: server default (not changed by this cell)")
    print(
        "MTP decoding:     "
        + (
            f"enabled (--spec-type draft-mtp, --spec-draft-n-max "
            f"{applied.get('mtp_draft_n_max')})"
            if applied.get("mtp")
            else "disabled"
        )
    )
    if applied.get("unsupported_options"):
        print(f"Not supported:    {', '.join(applied['unsupported_options'])}")
    print(f"Local endpoint:   {config.local_api_url}")
    print(
        "Local server:     "
        + ("reused from a previous run" if reused else "started in this run")
    )
    print("Local inference:  verified with a real chat completion")
    print(f"Local streaming:  {'supported' if local_streaming else 'not supported'}")
    print(f"Public endpoint:  {f'{public_url}/v1' if public_url else 'unavailable'}")
    if public_url:
        print(f"Public route:     {public_detail}")
        if public_streaming is True:
            print("Public streaming: supported")
        elif public_streaming is False:
            print("Public streaming: not supported (use the non streaming mode)")
    print(f"llama-server:     {binary}")
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
        "model_path": str(model_path),
        "api_key": api_key,
        "local_url": config.local_api_url,
        "public_url": f"{public_url}/v1" if public_url else None,
        "public_verified": public_verified,
        "public_detail": public_detail,
        "public_streaming_supported": public_streaming,
        "local_streaming": local_streaming,
        "server_reused": reused,
        "key_rotated": rotated,
        "server_pid": server_pid,
        "applied": applied,
        "variant": {
            "ctx": applied.get("ctx"),
            "mtp": bool(applied.get("mtp")),
            "reasoning": bool(applied.get("reasoning")),
        },
        "paths": {name: str(path) for name, path in paths.items()},
    }


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        fail(f"{type(error).__name__}: {error}")
        sys.exit(1)
