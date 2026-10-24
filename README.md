# Kaggle-Kit

[![CI](https://github.com/coderunknow/Kaggle-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/coderunknow/Kaggle-Kit/actions/workflows/ci.yml)

Deploy large language models on Kaggle - Qwen3.8-27B, Raon-1 mini preview
and Spark-X2.6-4B on Tesla T4 x2, Qwen3.8-27B on TPU v5e-8 - expose them
through an OpenAI-compatible API, and talk to them from a polished browser
chat interface that also works with any other OpenAI-compatible endpoint
(including a hosted Raon API you configure yourself).

The repository contains two halves that work together:

| Part | Location | What it does |
| --- | --- | --- |
| Kaggle deployment (GPU) | [`notebooks/qwen3_8_27b_api.py`](notebooks/qwen3_8_27b_api.py) | Downloads the model and a CUDA `llama-server`, starts it with the verified configuration, smoke tests it with a real chat completion and (optionally) publishes it through a Cloudflare Quick Tunnel. `KAGGLE_KIT_MODEL=raon` selects the Raon-1 mini preview deployment (KRAFTON llama.cpp branch build, gated pinned GGUF); `KAGGLE_KIT_MODEL=spark` selects Spark-X2.6-4B (official pinned GGUF, llama.cpp b11719, required `--jinja`). |
| Kaggle deployment (TPU) | [`notebooks/tpu_deployment.py`](notebooks/tpu_deployment.py) | Serves Qwen3.8-27B bf16 through the pinned vLLM TPU backend on TPU v5e-8 with the same key/smoke-test/tunnel discipline. Raon x TPU and Spark x TPU are explicitly blocked (no TPU kernels upstream; no TPU runtime consumes GGUF) - never a silent CPU/GPU fallback. |
| Chat interface | [`src/`](src) + [`server/`](server) | A React chat client and a small local proxy backend that talk to any OpenAI-compatible endpoint. |

```
browser  ──same origin──▶  local proxy backend  ──HTTP──▶  llama-server (Kaggle)
                            (server/)                              │
                            • serves the built client              └── optional
                            • injects the API key                    Cloudflare Quick Tunnel
                            • verifies streaming support
```

## v0.1.0-beta1 candidate status

Guided connection setup, Basic/Advanced settings, an explicit reviewed
keyless built-in grant, a **model catalog** (Qwen3.8-27B, Raon-1 mini
preview, Spark-X2.6-4B, custom endpoints) with honest per-combination
verification statuses, and model-specific sampling defaults are available.
Spark's template-defined thinking levels (none/low/high) ride the
per-request `reasoning_effort` field and are only sent when the connected
server's `/props` confirm its loaded chat template consumes it. Calculator/
conversion, uploaded-file tools, endpoint diagnostics and opening public
pages need no separate tool subscription. Native tool calling still
requires verification and explicit profile permissions; the model server
may require its own credential.

**Deployment matrix:** Qwen on T4 x2 is the pre-existing deployment, preserved
unchanged (derived from an operator-verified cell; this script itself has not
been re-run on live Kaggle hardware in the development environments).
Raon on T4 x2, Spark-X2.6-4B on T4 x2 and Qwen on TPU v5e-8 are implemented
with pinned checkpoints/runtimes and unit tests but are **not live-verified**
yet - no Kaggle GPU/TPU or gated Raon access existed in the development
environment. Raon on TPU and Spark on TPU are **blocked** with evidence (no
upstream TPU kernels for Raon's architecture; no TPU runtime consumes Spark's
GGUF/`trust_remote_code` artifacts) and refuse explicitly instead of falling
back. A hosted Raon API works as an ordinary configurable profile; no
provider endpoint or token is built in.

**Deferred by evidence:** genuine keyless web search ships nothing - no
credential-free provider met the authorization/reliability bar (opening a
page is not search; Brave stays optional in Advanced). Browser Python
remains deferred pending a proven isolation boundary; optional secure
Docker execution remains in Advanced. See
[audit evidence, the search reassessment and blockers](docs/dev7-audit.md),
[deployment guide](docs/kaggle-deployment.md#8-model-x-accelerator-matrix-dev7)
and [setup instructions](docs/chat-interface.md).

## Quick start

**Windows, one command** (Node.js 20.19 or newer is the only prerequisite):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

The launcher checks Node and npm, installs missing dependencies (network
required), builds the client and the proxy when needed, picks a free port,
waits until the backend answers `/api/health`, opens the browser, prints the
URL and stops the backend cleanly with Ctrl+C. It never asks for administrator
rights and never reads or prints an API key. See
[docs/windows-launcher.md](docs/windows-launcher.md).

**From source, any platform:**

```bash
npm install
npm run dev            # proxy backend on :8787 + Vite dev server on :5173
```

Open <http://localhost:5173>, create a connection profile (base URL + API key),
run **Test connection**, start a conversation and send a message.

For a production-like run:

```bash
npm run build          # type check, build the client, bundle the backend
npm start              # serves the client and the API on http://127.0.0.1:8787
```

Without a GPU you can try the whole flow against the bundled mock server:

```bash
npm run mock:upstream  # OpenAI-compatible mock on http://127.0.0.1:8000/v1
npm start
```

Create a profile with base URL `http://127.0.0.1:8000` and the key `demo-key-123`
(the mock prints its own arguments).

To check a real Kaggle endpoint from your Windows machine, without copying the
key into a shell history or a file:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\check-kaggle-connection.ps1
```

The script asks for the base URL and the key with hidden input and prints a
sanitized JSON report (masked URL, model list, real inference, real streaming).

## Deploying the model on Kaggle

See [docs/kaggle-deployment.md](docs/kaggle-deployment.md) for the complete
procedure. In short:

1. Create a Kaggle notebook, set the accelerator to **GPU T4 x2**, turn Internet on.
2. Paste the contents of `notebooks/qwen3_8_27b_api.py` into a cell and run it.
3. Copy the printed base URL and API key into the chat interface.
4. To avoid the 12 GB download in the next session, save the model as a Kaggle
   Dataset or as a Notebook Output (see the deployment guide).

The deployment script never depends on the GitHub release *list* API, which is
unreliable from Kaggle (`RemoteDisconnected`). It downloads the pinned
`llama.cpp` release assets directly and resumes interrupted downloads.

For **Raon-1 mini preview** on the same T4 x2 setup, set
`KAGGLE_KIT_MODEL=raon` before running the same cell (gated Hugging Face
access + an `HF_TOKEN` secret are required; the cell builds KRAFTON's
pinned llama.cpp branch). For **TPU v5e-8**, use
`notebooks/tpu_deployment.py` instead (Qwen bf16 via the pinned vLLM TPU
backend; Raon on TPU is explicitly blocked). The full status matrix,
quantization reasoning and the operator live-verification procedure are in
[docs/kaggle-deployment.md](docs/kaggle-deployment.md#8-model-x-accelerator-matrix-dev7).

## Chat interface

* **Connections tab** – create, edit, select and delete API profiles: display
  name, base URL, API key, model ID, system prompt, request timeout and where
  the key is stored. A connection test reports reachability, authentication,
  the model list, the usable model and a real inference request as separate
  steps; streaming stays a separate probe and is never implied by a green
  connection. The same active profile and the same effective URL are used by
  the test, the chat, the context bar and the sidebar footer.
* **Inference tab** – request time parameters: maximum output tokens,
  temperature, top-p, optional frequency and presence penalties, reasoning
  effort and the streaming switch. Start-up options of the server (context
  size, GPU split, MTP) are shown separately because the browser cannot change
  them.
* **Data & credentials tab** – shows what is stored in the browser and by the
  local proxy, clears browser-held keys, deletes conversations, removes proxy
  secret references individually, and erases browser-local data (not proxy-held
  secrets or tool profiles).

The interface is a full chat workspace rather than a settings form:

* a date-grouped conversation sidebar with search, inline rename and a
  two-step delete, plus the active connection in its footer;
* a context bar with the profile, model, connection state, Markdown export and
  a light/dark switch that can also follow the operating system;
* prompt starters for an empty conversation, a draft per conversation that
  survives a reload, and a composer whose height follows the text;
* Markdown with GFM tables, code blocks with a language label and a copy
  button, message copy, edit, resend, retry and regenerate, a stop button and
  a jump-to-latest control that does not drag a reader away;
* truthful states: a failed or cancelled answer is never shown as complete, a
  stream that broke keeps the part that arrived, token counts appear only when
  the server returned them, and an unsupported inference parameter is left out
  of the request instead of being guessed;
* a modal settings drawer with four tabs, a focus trap, Escape handling,
  arrow-key tabs, and connection help that separates the address of this page
  from the address of the model API;
* keyboard access (Alt+Shift+N, Ctrl/Cmd+/, Escape), visible focus and a
  reduced-motion layout.

### Tool-using chat (opt-in)

Tools are disabled by default and enabled per connection profile. Before the
model can use them, run the **model-specific tool probe**: the proxy requires a
harmless native function call with `finish_reason=tool_calls`, then verifies an
isolated follow-up containing a synthetic tool result and a final stop response.
The probe never executes its function. URL shape, model family, normal chat, or
`--jinja` alone do not count as evidence; unverified endpoints keep ordinary
chat available and tool calls disabled. Streamed tool-call fragments are
verified separately by the probe (reported as `streamingSupported`); tool
rounds themselves are non-streaming so approvals can pause the loop. The
recommended Qwen prompt ships in two variants — the base text for ordinary
chat and a tool-use variant for verified profiles.

The catalog covers calculator/unit conversion, conversation-scoped uploaded
files, public web search/page retrieval, read-only endpoint diagnostics,
optional Python sandbox execution, configured HTTP tools, and remote MCP tools.
Uploads are extracted into a bounded in-memory vault; the app cannot browse host
files. Remote MCP uses public HTTPS only (no local stdio process). The code
runner is disabled by default and can be configured only with a digest-pinned
Python image; **every run requires a separate approval**. If Docker or the image
is unavailable, execution fails closed without a host-code fallback. Known
read-only operations may run automatically; writes and unknown operations
require approval each time. Calls, rounds, inputs, outputs, time and
file size are bounded server-side. An exact denied operation is refused without
a second approval prompt during that turn.

HTTP header credentials and provider keys use the local proxy's protected
SecretStore; profiles keep references, not direct credentials. MCP servers and
tools require review and an explicit grant. Changing the URL, headers, timeout,
adding a selected tool, or changing a selected tool's schema or permission
invalidates the grant; narrowing the selected set does not expand its scope.
Tool traces are not saved by default. Unless provider retention rights are
confirmed **and** tool-history persistence is opted in, Brave-derived assistant
answers remain visible for the current session but are not saved or exported.
Provider availability, account terms and fees are separate from the local
checks.

See [docs/chat-interface.md](docs/chat-interface.md) and [docs/security.md](docs/security.md)
for details, and [docs/release-notes/0.1.0-beta1.md](docs/release-notes/0.1.0-beta1.md)
for this beta candidate's changes and verification limits.

## Security model

* The API key is **never** part of a URL, a log line, a committed file or an
  error message. It is sent in the `Authorization` header of the request to
  the configured endpoint.
* Three credential modes: **in memory for this tab** (default), **in the local
  proxy secret store** (a `0600` file next to the backend) and, as an explicit
  opt-in, **in browser storage** (plain text, with a warning).
* The browser never talks to the model server directly. It calls the local
  proxy, which removes the CORS problem and keeps the key out of the browser
  whenever the server mode is used.
* `src/security.test.ts` fails the build when a tunnel URL or a credential
  appears in the source.
* The backend accepts only its own browser origin or an explicitly configured
  allowed origin, requires a JSON content type and resolves every static file
  inside the client directory with a proper containment check.
* The upstream host can be restricted with `KAGGLE_KIT_ALLOWED_HOSTS`; the
  default stays open so that any OpenAI-compatible endpoint keeps working.

See [docs/security.md](docs/security.md).

## Development

```bash
npm run typecheck      # tsc for the client and the backend
npm run lint           # eslint
npm test               # vitest (unit, integration and component tests)
npm run check          # all three
npm run build          # type check, build the client, bundle the backend
npm run check:integration   # drives the built application against the mock upstream
python3 -m unittest discover -s notebooks -p "test_*.py"   # deployment script tests
python3 -m unittest discover -s tools -p "test_*.py"        # tests of the release tools
```

The same checks run on every push and pull request in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). They need no secret,
no GPU, no weights and no tunnel. The notebook tests need the `requests`
package (`pip install requests`).

### Live-model tool-calling benchmark

`tools/model-benchmark.mjs` tests a **real** OpenAI-compatible endpoint —
for example the deployed Kaggle model — without sharing its URL or key with
anyone. The key is read from the environment or a masked prompt, never from
the command line:

```bash
export OPENAI_BASE_URL="https://<your-tunnel>/v1"   # sanitized in reports
export OPENAI_API_KEY="<your key>"                  # never printed
node tools/model-benchmark.mjs --model "<model id>" --trials 3 --report bench.json
```

Model mode verifies the native tool-call handshake, tool selection on an
unambiguous task, argument schema/semantics, honest handling of a synthetic
tool result, and that ordinary questions do **not** trigger tools. It feeds
the model synthetic results only — it never executes a real tool. A separate
`--mode integration` exercises a running Kaggle-Kit proxy end to end
(automatic calculator run, Python approval + denial) and reports skipped
cases as skipped when the proxy or profile is not configured. See
[docs/troubleshooting.md](docs/troubleshooting.md#live-model-tool-benchmark)
for what each layer proves and what it cannot.

## Releases

A release is built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
from the tagged commit: the workflow runs the checks, builds the application,
stages the assets, validates them and uploads them to a prerelease of the same
tag. Nothing is uploaded by hand. A tag push keeps this behavior; a manual
release dispatch additionally requires `publish_release: true` (default:
`false`).

The scheduled Nightly Release workflow is verification-only: it validates and
stages artifacts but never publishes on a schedule. Manual nightly publication
requires the explicit `publish_nightly: true` dispatch input (default:
`false`). Neither CI nor a local release dry-run publishes anything.

```bash
git tag v0.1.0-dev7 <commit> && git push origin v0.1.0-dev7
```

The version of `package.json` has to match the tag and the release notes have
to exist in `docs/release-notes/<version>.md`. Every release contains the
notebook with the deployment cell, the application bundle, the source archive,
a `manifest.json` with the size and the SHA-256 of every asset, a
`SHA256SUMS` file and a `verification-report.json` with the checks that were
executed. `tools/release-dry-run.sh` runs the same steps locally.

## Project layout

```
notebooks/    the Kaggle deployment script and its tests
shared/       code used by the browser client and by the backend
server/       the local proxy backend (node:http, no runtime dependencies)
src/          the React chat client
tools/        a mock OpenAI-compatible server for local development
docs/         deployment, interface, security and troubleshooting guides
```

## Documentation

* [docs/kaggle-deployment.md](docs/kaggle-deployment.md)
* [docs/chat-interface.md](docs/chat-interface.md)
* [docs/security.md](docs/security.md)
* [docs/troubleshooting.md](docs/troubleshooting.md)
* [DESIGN_LOG.md](DESIGN_LOG.md) – decisions and validation results
* [AGENTS.md](AGENTS.md) – conventions for contributors and agents
