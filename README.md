# Kaggle-Kit

[![CI](https://github.com/coderunknow/Kaggle-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/coderunknow/Kaggle-Kit/actions/workflows/ci.yml)

Deploy a large GGUF model on Kaggle (Tesla T4 x2) with the official CUDA build of
`llama.cpp`, expose it through an OpenAI-compatible API, and talk to it from a
polished browser chat interface.

The repository contains two halves that work together:

| Part | Location | What it does |
| --- | --- | --- |
| Kaggle deployment | [`notebooks/qwen3_8_27b_api.py`](notebooks/qwen3_8_27b_api.py) | Downloads the model and a CUDA `llama-server`, starts it with the verified configuration, smoke tests it with a real chat completion and (optionally) publishes it through a Cloudflare Quick Tunnel. |
| Chat interface | [`src/`](src) + [`server/`](server) | A React chat client and a small local proxy backend that talk to any OpenAI-compatible endpoint. |

```
browser  ──same origin──▶  local proxy backend  ──HTTP──▶  llama-server (Kaggle)
                            (server/)                              │
                            • serves the built client              └── optional
                            • injects the API key                    Cloudflare Quick Tunnel
                            • verifies streaming support
```

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
for details, and [docs/release-notes/0.1.0-dev4.md](docs/release-notes/0.1.0-dev4.md)
for this development release's changes and verification limits.

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

## Releases

A release is built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
from the tagged commit: the workflow runs the checks, builds the application,
stages the assets, validates them and uploads them to a prerelease of the same
tag. Nothing is uploaded by hand.

```bash
git tag v0.1.0-dev4 <commit> && git push origin v0.1.0-dev4
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
