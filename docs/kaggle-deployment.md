# Kaggle deployment

This guide describes how to run `notebooks/qwen3_8_27b_api.py` on Kaggle, how to
keep the 12 GB model file for the next session and how to use the API that the
cell exposes.

## 1. Prepare the notebook

1. Create a new Kaggle notebook.
2. **Settings → Accelerator → GPU T4 x2**. The deployment mode `t4x2` refuses to
   start without two GPUs.
3. **Settings → Internet → On**. The model, the `llama.cpp` build and
   `cloudflared` are downloaded from the internet.
4. Open the file `notebooks/qwen3_8_27b_api.py` and paste the whole content
   into one cell. The script also runs as a normal Python file:
   `python notebooks/qwen3_8_27b_api.py`.

## 2. What the cell does

| Step | Behaviour |
| --- | --- |
| GPU check | Lists the GPUs and aborts with an actionable message when fewer than two (or no T4) are present. |
| `llama.cpp` | Reuses a working `llama-server` from the working directory, otherwise downloads the pinned CUDA build from **direct release asset URLs** and verifies it with `--version`. |
| Model | Reuses a complete GGUF file from `/kaggle/input` (Kaggle Dataset), from the working directory (Notebook Output) or from an earlier run. Otherwise it downloads the pinned file with resume support. Two optional `DeploymentConfig` fields harden the fetch: `model_revision` (the exact Hugging Face revision every download resolves against, default `main`) and `model_sha256` (an operator-supplied digest; when set, every reused or downloaded weight file is verified against it and a mismatch fails closed — no digest is baked into the script). |
| Server | Reuses a healthy server of a previous run when its configuration still fits, restarts a server of this cell that no longer fits, and starts a new one otherwise. A process that the cell did not start is never touched. |
| Smoke test | Sends a **real** chat completion (`Reply with exactly: OK`) before success is announced. The test proves that the model answers; it does **not** prove that speculative decoding is active. |
| Tunnel | Downloads `cloudflared` from one pinned release (SHA-256-verified, no `latest` target), starts a Cloudflare Quick Tunnel and verifies the public URL with an authenticated **chat completion**. |
| Runtime bundle | Writes `api_key.txt` (mode `0600`), `server-state.json`, `runtime.json` and `profile.json` into `/kaggle/working/qwen38_api`. |

### Verified start-up configuration

```
--model <gguf> --host 127.0.0.1 --port 8000
--api-key-file <api_key.txt, mode 0600>        (when the build supports it;
                                                otherwise the key is passed
                                                via the LLAMA_API_KEY
                                                environment variable — it is
                                                never an argv element)
--n-gpu-layers 99 --split-mode layer --tensor-split 1,1
--ctx-size 8192 --parallel 1 --batch-size 512 --ubatch-size 128
--flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --jinja
--reasoning-effort medium
--spec-type draft-mtp --spec-draft-n-max 2      (only when the build supports it)
```

* **Multi GPU:** the model is split *per layer* over the two devices
  (`--split-mode layer --tensor-split 1,1`). The two T4s are **not** treated as
  one memory pool; each device holds its share of the layers and the KV cache
  is quantised to `q8_0` to stay inside the 16 GB of a T4.
* **Context size** is configurable (`ctx_size` in `DeploymentConfig`, default
  8192). Lower it if the model does not fit.
* **Reasoning effort** `medium` is passed as the start-up flag
  `--reasoning-effort` and only when the installed build lists that option.
* **MTP** (speculative decoding with the MTP head) is attempted first and
  falls back to ordinary inference when the build or the model does not support
  it. The fallback chain is `ctx=8192 + MTP` → `ctx=8192` → `ctx=4096` →
  `ctx=4096` without the reasoning flag. Every variant has to pass the real
  inference test before it is accepted.
* **Only what was applied is reported.** The start-up command is built from
  the options the installed build really understands. `runtime.json` and the
  summary describe the options that were passed to the binary – a build
  without `--spec-type` is reported as `MTP decoding: disabled`, not as
  enabled. The options the build does not know are listed as
  `Not supported: …`.

## 3. Read the result

The cell ends with a summary block:

```
================================================================
QWEN API STATUS
================================================================
Model:            <model id>
Model file:       /kaggle/working/qwen38_api/models/....gguf
Context size:     8192
Reasoning effort: medium (start-up flag)
MTP decoding:     enabled (--spec-type draft-mtp, --spec-draft-n-max 2)
Local endpoint:   http://127.0.0.1:8000/v1
Local server:     started in this run
Local inference:  verified with a real chat completion
Local streaming:  supported
Public endpoint:  https://<random>.trycloudflare.com/v1
Public route:     The public endpoint answered an authenticated chat completion.
Public streaming: not supported (use the non streaming mode)
llama-server:     /kaggle/working/qwen38_api/bin/b11719/.../llama-server
Runtime info:     /kaggle/working/qwen38_api/runtime.json
Profile template: /kaggle/working/qwen38_api/profile.json
----------------------------------------------------------------
The API key is stored in /kaggle/working/qwen38_api/api_key.txt (mode 0600).
Copy it into the chat interface. Do not publish this output.
API key: <generated key>
================================================================
```

The four states of the deployment are kept apart and are never merged:

| Line | Meaning |
| --- | --- |
| `Local server` | whether the server was started in this run or reused from a previous one |
| `Local inference` | the real chat completion against `127.0.0.1:8000` |
| `Public route` | an authenticated chat completion **through the tunnel** |
| `Local streaming` / `Public streaming` | the two transports are probed separately |

A healthy local server is never reported as a working public route.

The key is printed exactly once, at the end, because it has to be copied into
the chat interface. It is never written into `runtime.json`, `profile.json`,
the logs or this repository.

**The public endpoint is temporary.** A Cloudflare Quick Tunnel URL changes
every time the cell runs and disappears when the session ends. The status line
above states whether the public URL was actually verified – a healthy local
server alone is never reported as working remote access.

## 4. Keep the model for the next session

The model is ~12.12 GB. Downloading it again in every session wastes time and
Kaggle bandwidth. Two supported ways to keep it:

### Option A – Kaggle Dataset (recommended)

1. In the notebook, after the model is downloaded, add the model file as an
   **output** of the session: *Save Version → Output → Save & Run All* and
   select the file under `/kaggle/working/qwen38_api/models/`.
2. Create a new Dataset from that output (Kaggle: *Datasets → New Dataset →
   From Kaggle Notebooks*).
3. Attach the dataset to your next notebook (*Add Data → Your Datasets*).

The deployment script looks for the file under `/kaggle/input` first, so the
next session starts the server without a download.

### Option B – Notebook Output

1. *Save Version → Output* with the model file selected.
2. In the next session, open the saved version and use **File → Download
   Output**, then upload the archive as a Dataset and attach it (same as
   option A). Kaggle does not mount an output of another session directly.

### Option C – keep it in the working directory

The working directory survives inside a *saved version*. When the session
restarts from the same notebook version, `/kaggle/working/qwen38_api/models`
still contains the file. The script reuses it automatically.

> The model file must never be committed to this repository. `.gitignore`
> already excludes `*.gguf`, `*.tar.gz` and the working directories.

## 5. Use the API from the chat interface

1. Start the interface locally: `npm install && npm start` (see the README).
2. Open <http://127.0.0.1:8787>.
3. **Settings → Connections → Add profile**:
   * *Display name*: `Kaggle T4 x2`
   * *Base URL*: the public URL from the summary, e.g.
     `https://<random>.trycloudflare.com/v1` (a missing `/v1` is added
     automatically)
   * *API key*: the key from the summary
   * *Where the key is kept*: **This tab only** (default), **Local proxy
     secret store** or – only on a trusted machine – **Browser storage**
4. **Test connection**. The test performs a model list request *and* a real
   chat completion and reports both steps separately.
5. **Discover models** to fill the model ID from `/v1/models`.
6. Save the profile, select it and start a conversation.

`profile.json` contains the same information without the key, so it can be
copied into the profile form.

## 6. Rotate the API key

The key belongs to the server process, so it changes when the server is
restarted.

**A rerun of the cell does not need a new key.** The cell reads
`server-state.json` and `api_key.txt` from the working directory. When the
running server is healthy and its configuration still fits, it is reused and
the key stays the same – the profile in the chat interface keeps working.

A new key is created when

* no server is running (the first run of a session), or
* the server of the previous run no longer fits (a different model, a
  different context size) or does not answer any more.

In that case the cell stops the server it started itself, starts a new one
with a new key and says so in the summary:

```
The API key was rotated because the server was restarted.
The old key does not work any more; use the new key below.
```

Then copy the new key into the chat interface. If the old key was stored in
the local proxy secret store, delete the old reference under **Data &
credentials**.

**A process that the cell did not start is never stopped.** If the port 8000
is used by another program, the cell reports the conflict and stops:

```
The port 8000 on 127.0.0.1 is used by a process that this cell did not
start. The cell never stops a foreign process. Stop that process, or use
another port in DeploymentConfig, and rerun the cell.
```

## 7. Limitations

* **The public URL is temporary.** It changes on every run and dies with the
  session. A named Cloudflare tunnel is the alternative for a stable address.
* **Cloudflare Quick Tunnels do not support SSE streaming.** The chat
  interface therefore keeps the streaming switch off until a streaming probe
  against the *actual* endpoint succeeds. The notebook reports the local
  streaming support separately – do not confuse the two.
* **One session, one model.** The script starts at most one server per
  session. A rerun reuses the running server instead of starting a second
  one.
* **The smoke test does not measure the speculative decoding.** It proves
  that the model answers. `runtime.json` reports that the MTP flags were
  passed to the binary, not that they made the answer faster.
* The `t4x2` mode needs two T4s. `single` exists for experiments only and is
  not the verified configuration.

## 8. Model x accelerator matrix (dev7)

| Model | Accelerator | Status | Runtime / checkpoint |
| --- | --- | --- | --- |
| Qwen3.8-27B | GPU T4 x2 | **Verified** (existing deployment, preserved) | CUDA `llama.cpp` (pinned b11717-b11719), GGUF IQ3_S, ctx 8192, MTP when supported |
| Raon-1 mini preview | GPU T4 x2 | **Implemented - not live-verified** | KRAFTON `llama.cpp` branch `raon-1-mini-preview` @ `fb895662...`, GGUF Q4_K_M on T4 |
| Qwen3.8-27B | TPU v5e-8 | **Implemented - not live-verified** | `vllm-tpu==0.28.0`, `Qwen/Qwen3.8-27B` bf16 @ `1d4bf0f2...`, tensor parallel 8, MTP off |
| Raon-1 mini preview | TPU v5e-8 | **Blocked** (evidence in section 11) | none - no TPU kernels for the `raon1` architecture |
| Raon-1 mini preview | Hosted API | **Implemented - not live-verified** | ordinary connection profile with the endpoint/credential your provider issued |

"Implemented - not live-verified" means the code path, its pins, its failure
modes and its unit tests exist, but no run on the real accelerator happened
in the development environment. It never means "will work". Section 12 is
the exact operator procedure that turns a row into a verified one.

## 9. Raon-1 mini preview on GPU T4 x2

Raon is KRAFTON AI's 30B-A4B MoE model (28.8B total parameters, 4.3B active
per token, Apache-2.0 weights). It uses the **same cell** as Qwen
(`notebooks/qwen3_8_27b_api.py`); Qwen stays the default and is unchanged.

1. **Get access first.** The GGUF repository
   (`KRAFTON/Raon-1-mini-preview-gguf`) is access-gated. Request access on
   Hugging Face with your own account, then make a token available *without
   pasting it into the notebook*: add it as a Kaggle Secret/environment
   variable named `HF_TOKEN`, or run `hf auth login`. The cell reads the
   token at download time only and sends it solely in the
   `huggingface.co` request header - never in a URL, argv, log or file of
   this repository. Without authorization the run stops with that exact
   message; nothing is substituted.
2. Set the accelerator to **GPU T4 x2**, Internet on, and select Raon:
   environment `KAGGLE_KIT_MODEL=raon`, or call
   `main(raon_deployment_config())` after pasting the cell.
3. The cell then, in order: checks the two T4s; *builds* `llama-server`
   from KRAFTON's pinned branch commit `fb895662...` with CUDA (the
   `raon1` GGUF architecture is not assumed to exist in upstream prebuilt
   binaries, so none is used); selects a quantization from the detected
   GPU memory; downloads that exact file from the pinned revision
   `fe24f24e...` and verifies its SHA-256 from the official repository
   metadata; starts the server with alias `Raon-1-mini-preview` and the
   model-card startup sampling (only flags the built binary lists);
   and proves a real chat completion before announcing success.

**Quantization choice is evidence-based, not "fits the aggregate".**
Published sizes: Q8_0 30.69 GB, Q6_K 25.84 GB, Q5_K_M 22.18 GB,
Q4_K_M 19.69 GB, IQ4_XS 16.07 GB. A layer split does not pool the two
16 GB devices, so the cell caps the conservative per-device weight share
(equal share inflated by 1.10 for split imbalance) at 70% of a device,
leaving at least 30% for KV cache (small for Raon - only its 7 MLA layers
keep one), compute buffers, the CUDA context and fragmentation. On T4 that
selects **Q4_K_M** (about 10.1 GiB/device estimated), the quantization of
KRAFTON's documented examples. `raon_deployment_config(quantization=...)`
overrides it explicitly; the applied value is always what the summary and
`runtime.json` report.

Context stays at the application's documented 8192 although the model
supports 262144. Qwen's MTP flags are never applied to Raon; its DFlash
speculative path is *not* enabled in this release (baseline inference
first - it is added only after live verification). The Raon server owns a
separate directory (`/kaggle/working/raon1_api`) with its own key/state,
follows the same reuse/restart/conflict rules, and generates its own API
key. In the chat interface, use the **model catalog** entry
"Raon-1 mini preview" and apply its recommended sampling (temperature 1.0,
top_p 0.95, top_k 20, min_p 0.0, repetition_penalty 1.0,
frequency_penalty 0, presence_penalty 1.5 general / 0 coding-math).

## 10. Qwen3.8-27B on TPU v5e-8

The GGUF/CUDA path cannot run on a TPU, so this is a separate script:
`notebooks/tpu_deployment.py`. It serves the authoritative checkpoints
`Qwen/Qwen3.8-27B` bf16 safetensors at pinned revision `1d4bf0f2...`
through the vLLM TPU backend, sharded tensor-parallel 8.

1. Create the notebook with **TPU v5e-8** (Kaggle CLI accelerator id
   `TpuV5E8`), Internet on. Beware sessions provisioned without hardware
   (a CPU-only container): the cell detects the accelerator with JAX and
   **aborts** - it never falls back to CPU and never reports CPU work as
   TPU success.
2. Paste `notebooks/tpu_deployment.py` and run it. In order, it: requires
   exactly 8 TPU devices; installs the pinned `vllm-tpu==0.28.0` (the
   release with native gated-DeltaNet Pallas kernels for this hybrid
   architecture); starts vLLM's OpenAI server (`PJRT_DEVICE=TPU`,
   dtype bfloat16, `max_model_len` 32768 by default); waits (bounded) for
   health; runs a **real authenticated chat completion**; and verifies
   that an *unauthenticated* request is rejected before anything is
   exposed through the optional tunnel. The API key is generated,
   stored at mode `0600`, and passed through the `VLLM_API_KEY`
   environment variable - never argv.
3. **MTP is forced off.** With the pinned vllm-tpu, rejected MTP draft
   tokens advance the gated-DeltaNet recurrent state and corrupt output.
   Setting `enable_mtp=True` is refused with that reason instead of being
   silently applied or dropped. No speculative flag is emitted.
4. Expect long XLA compilation on the first run; the startup wait is
   bounded at one hour and the server log is `vllm-server.log` in
   `/kaggle/working/qwen38_tpu_api`. The ~55 GB bf16 checkpoint download
   dominates disk use; keep it as a Kaggle Dataset like the GGUF.
5. The summary prints local/public endpoints, detected devices, and the
   key once. `profile.json` ("Kaggle TPU v5e-8") has the values for the
   chat interface; nothing about speed or memory is printed because this
   script does not measure them - measure with
   `tools/model-benchmark.mjs` against your live endpoint instead.

## 11. Raon-1 mini preview on TPU v5e-8: blocked

Requesting this combination (`KAGGLE_KIT_MODEL=raon` in the TPU cell)
raises `UnsupportedDeploymentError` before anything is installed. The
evidence, checked against the vendor and runtime documentation:

* the published GGUF is a llama.cpp artifact - no TPU runtime consumes it;
* KRAFTON's `llama.cpp` branch and vLLM fork are CUDA paths, and CUDA
  kernels do not run on TPU;
* the `raon1` architecture (Raon Delta Attention, Gated MLA, SiTU-GLU,
  Raon-mHC) has no kernels in the documented vLLM TPU / tpu-inference or
  SGLang TPU model support;
* a checkpoint merely loading somewhere would prove neither generation
  nor Kaggle v5e-8 support, and no such execution proof exists upstream.

There is deliberately no CPU, GPU, remote, or hosted fallback behind this
refusal. Revisit when a TPU backend publishes `raon1` support; the first
steps would be the minimal proof (checkpoint load, short generation,
correct decoding) on v5e-8 before any serving work.

## 12. Live verification procedure (operator)

Run these on real Kaggle sessions and record the summary blocks,
`runtime.json`, and benchmark reports. Only executed output turns a matrix
row into "verified".

**Raon / T4 x2** (needs approved gated access + `HF_TOKEN`):
`KAGGLE_KIT_MODEL=raon` in the GPU cell. Expect `RAON API STATUS`, model
`Raon-1-mini-preview`, `Local inference: verified`, the selected
quantization in the log, and a verified public route. Rerun the cell: it
must *reuse* the server with the same key. Then, locally:
`OPENAI_API_KEY=<key> node tools/model-benchmark.mjs --base-url <public>/v1
--model Raon-1-mini-preview --trials 3` (synthetic-result protocol
evidence), plus one ordinary chat and one tool-probe verification from the
interface (Tools settings -> Verify native tool calling). Record the
tokens/sec *from the server log/benchmark*, not from expectations.

**Qwen / TPU v5e-8**: run the TPU cell in a `TpuV5E8` session. Expect
"8 TPU device(s) detected", the inference test, the auth-enforcement line,
and a verified public route. Negative checks worth the minutes: the same
cell in a CPU session must abort with the accelerator message, and
`KAGGLE_KIT_MODEL=raon` in the TPU cell must print the blocked analysis
and exit non-zero without installing anything.
