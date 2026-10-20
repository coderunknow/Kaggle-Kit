# Troubleshooting

The entries below are based on the failures that were actually observed while
building and running this project.

## Deployment (Kaggle)

### `requests.exceptions.ConnectionError: RemoteDisconnected` while listing releases

The GitHub release **list** API is unreliable from Kaggle. The deployment
script never calls it: it downloads the pinned release assets directly
(`https://github.com/ggml-org/llama.cpp/releases/download/<tag>/<asset>`).
If you extend the script, keep using the direct asset URLs.

### The download stops at 30 %, 80 % …

The download is resumable. The partial file is kept as `<name>.part` and the
next attempt continues with a `Range` request, so the model is not downloaded
again from the start. Simply rerun the cell.

If the server rejects the resume range (HTTP 416), the partial file is deleted
and the download starts over once. Everything after that attempt is resumable
again.

### "Two GPUs were not detected"

The deployment mode `t4x2` needs two GPUs. Set **Settings → Accelerator → GPU
T4 x2** and make sure the session was restarted after the change (Kaggle only
applies the accelerator to a new session).

### "No working CUDA build of llama-server could be installed"

Read the log above the message:

* `The assets of <tag> are not available` – that tag has no CUDA 12.8 build;
  the script moves on to the next tag.
* `The downloaded binary does not start` – the archive was extracted but the
  binary needs the CUDA runtime libraries. They are part of the `cudart-…`
  archive; the script adds the library directories to `LD_LIBRARY_PATH` and
  tests the binary with `--version` before it is used.
* A download error after 10 attempts – check the Internet connection of the
  session and rerun; the partial data is reused.

### "The model did not pass the start-up and the inference test"

The log of the failed variant is printed. The usual causes:

* **Not enough VRAM.** Lower `ctx_size` (8192 → 4096) and/or `batch_size`.
  The fallback chain in the script tries 8192 and then 4096 automatically.
* **An unsupported option.** Only the options that appear in `--help` of the
  installed build are used, so this should not happen – but check the printed
  command.
* **A damaged model file.** Delete
  `/kaggle/working/qwen38_api/models/<file>.gguf` and let the cell download it
  again.

### "The port 8000 on 127.0.0.1 is used by a process that this cell did not start"

The cell found something on the port of the local server that it did not
start itself. It never kills a foreign process – that could be a service of
the machine. Either stop that process, or use another port in
`DeploymentConfig` and rerun the cell.

The cell only stops a process that it started itself: the process id in
`server-state.json` is checked against the live process, and the command line
of that process has to contain `llama-server` before it is stopped.

### "The API key was rotated because the server was restarted"

The server of the previous run no longer fits the configuration (a different
model, a different context size) or did not answer. The cell stopped that
server, started a new one and created a new key. The old key does not work
any more: copy the new key into the chat interface and delete the old entry
in the local secret store.

When nothing changed, a rerun **reuses** the running server and the key stays
the same. The summary then says `Local server: reused from a previous run`.

### The tunnel does not come up

* `No public URL was returned` – cloudflared did not report a URL. The local
  API stays available; use `http://127.0.0.1:8000/v1` from a notebook cell or
  from a port forward.
* `The public endpoint is not usable yet` – the tunnel exists but the request
  through it failed. The public URL of a Quick Tunnel needs a moment before it
  routes; the cell reports the exact reason: `auth` (the key was rejected),
  `upstream` (an HTTP error of the model server), `timeout`, `unreachable`
  (the tunnel is not routing) or `invalid_response` (the answer was not a
  valid chat completion). The local API stays available in every case.
* A Quick Tunnel URL is **temporary**: it changes on every run and disappears
  when the session ends.

### The model has to be downloaded again in every session

See [kaggle-deployment.md](kaggle-deployment.md#4-keep-the-model-for-the-next-session):
save the file as a Kaggle Dataset or as a Notebook Output and attach it. The
script looks in `/kaggle/input` first.

## Chat interface

### The backend answers "The origin ... is not allowed to call this proxy"

The backend only accepts browser requests from its own origin and from the
origins in `KAGGLE_KIT_ALLOWED_ORIGINS`. The development launcher
(`npm run dev`) sets the Vite origin automatically. If the client runs on
another port, add it:

```bash
KAGGLE_KIT_ALLOWED_ORIGINS=http://localhost:4173 npm start
```

### "This endpoint only accepts \"Content-Type: application/json\""

A request with a body reached the API without a JSON content type. The
browser always sends one; a script that calls the API by hand has to set the
header.

### The interface says the proxy is offline

The browser cannot reach the local backend. Start it with `npm start` (or
`npm run dev`) and open the address it prints. The backend has to be the same
origin as the client – the production build serves the client itself, the
development server proxies `/api` to the backend. The state is checked every
30 seconds and when the tab becomes visible again, so the banner clears on
its own after a restart.

### Which address belongs in the profile?

Two different addresses are involved and they are easy to swap:

* **Open this page at** `http://127.0.0.1:8787` – the local proxy that serves
  the interface. In development it is `http://localhost:5173`.
* **The model API base URL** – the address the proxy calls. For the Kaggle
  deployment that is the `https://<random>.trycloudflare.com` URL printed by
  the notebook (plus `/v1` if you type it by hand; the interface adds it).
  For a local `llama-server` it is `http://127.0.0.1:8000/v1`.

Never put the address of the interface into the profile: the proxy would try
to call itself, which ends in a timeout or a 404. The connection help in the
settings drawer and the *Connections* tab show both values.

### Do I have to restart the proxy after a change?

| Change | Restart needed? |
| --- | --- |
| Base URL, key, model, system prompt, inference settings | No |
| `KAGGLE_KIT_ALLOWED_HOSTS`, `KAGGLE_KIT_ALLOWED_ORIGINS`, `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS` | Yes |
| `KAGGLE_KIT_PORT`, `KAGGLE_KIT_HOST`, `KAGGLE_KIT_DATA_DIR` | Yes |
| A new build of the client | No for the API, reload the page |

The environment is read once at start-up. On Windows PowerShell:

```powershell
$env:KAGGLE_KIT_ALLOWED_HOSTS = "<random>.trycloudflare.com"
# stop the old process with Ctrl+C, then
npm start
```

`$env:` only affects the current window. For a permanent setting use
`setx KAGGLE_KIT_ALLOWED_HOSTS "<random>.trycloudflare.com"` and open a new
terminal; the running proxy must be restarted in both cases. A Quick Tunnel
URL changes on every Kaggle run, so the allow list has to be updated with it.

### "Authentication failed"

The key does not match the server. The key belongs to the *running* server
process: after a restart of the Kaggle cell a new key is generated. Copy the
new key into the profile (or update the entry in the local secret store).

### "Not found" (HTTP 404)

The base URL points to an endpoint that does not exist. The interface
normalises the URL, so `https://host` becomes `https://host/v1`. If the server
is not mounted under `/v1`, use the exact prefix of your server.

### "Blocked by CORS or proxy"

The browser could not complete the request. The interface never asks you to
disable browser security. The usual causes:

* The endpoint is not reachable from this machine (a Quick Tunnel that has
  already expired, a VPN or a firewall).
* The proxy backend cannot reach the endpoint either – the same error appears
  in the backend log.
* The endpoint is an HTTP page that is not an API (a proxy error page).

### "Streaming has not been verified for this endpoint"

The backend refuses to proxy a streaming request that was not verified with a
real `text/event-stream` response. Run **Verify streaming support** in the
*Inference* tab. A Cloudflare Quick Tunnel does not support SSE, so the
verification fails there and the interface keeps using ordinary requests.

### The answer is empty

* Check the model id: **Discover models** reads `/v1/models`.
* Check the *Maximum output tokens*: a value of `0` or `1` produces an almost
  empty answer.
* The server log of the Kaggle session contains the reason if the request
  never reached the model.

### The conversation disappeared

Conversations live in the browser storage of the current origin. Clearing the
site data, using a different browser or a different port removes them. The
*Data & credentials* tab shows what is stored.

## Tools (v0.1.0-dev6)

### "Native tool calling has not been verified for this exact endpoint…"

Ordinary chat working does not prove tool calling works. Open **Settings →
Tools** for the active profile and run the harmless probe. The probe sends a
no-op function, requires exactly one valid call with
`finish_reason=tool_calls`, verifies that the endpoint accepts the synthetic
tool result, and then checks streamed fragments separately. The probed
function is never executed. A probe result belongs to one endpoint URL,
credential and model ID: changing any of them (for example a new tunnel URL
or a rotated key) requires a fresh probe. Until a probe succeeds, tool
definitions are not sent and ordinary chat is used — the message in the chat
("Ordinary chat was used; no tools were executed") says exactly that.

Common causes of `failed_verification` on a self-hosted `llama.cpp` server:
the server was started without a Jinja chat template that renders tools
(`--jinja`), the model's chat template has no tool-call section, or the
server returns tool data without `finish_reason=tool_calls`. `unsupported`
means the endpoint rejected the probe request itself (HTTP 400/404/422):
old builds without OpenAI tool support behave this way. In both cases keep
using ordinary chat; do not edit the profile to "force" tools — there is no
such setting, by design.

### The model says it has no tools although the probe passed

The profile probably still carries the base recommended prompt, which
truthfully describes chat *without* tools. Insert the **tool-use variant**
in the profile editor, or rely on the proxy: the tool loop automatically
replaces the known no-tools sentence before sending. A custom prompt that
denies tools in other words must be edited by hand.

### An approval request expired or "is no longer active"

An approval is single-use, bound to one exact call, and expires after two
minutes. It is also invalidated when the tool settings change, the job is
cancelled, or the approval was already used (approving twice returns
HTTP 410). Nothing ran in these cases; ask the question again to get a fresh
approval. If you denied an operation, the same exact operation will not be
re-requested in that turn.

### "The tool-round budget was reached" / the loop timed out

Execution is bounded on the server: by default 3 model rounds, 8 tool calls,
15 s per tool and 120 s for the whole loop. Raise the profile limits in
**Settings → Tools → Bounded execution** if a legitimate task needs more
(hard maxima: 8 rounds, 24 calls, 60 s per tool, 300 s per loop). A
conversation can only tighten these values, never exceed them.

### Web search is offered but every call fails

`web_search` needs the Brave provider: select it in **Settings → Tools →
Web search provider** and store the API key through **Data & credentials**
so the profile keeps only a secret *reference*. "The required provider
credential is not configured" means the reference is missing or empty;
"rejected the configured API key" (401/403) and "rate limit" (429) come from
Brave. `web_open` refuses private/loopback/link-local/metadata addresses,
non-standard ports, HTTPS→HTTP downgrades and oversized pages; that refusal
is the SSRF policy working, not a bug. Answers derived from Brave results
stay session-only (not saved or exported) unless you confirm your plan's
retention rights *and* enable tool-history persistence.

### "Docker is not installed or not on PATH" / code execution stays disabled

Code execution fails closed. It needs Docker on the machine running the
proxy and a locally available, digest-pinned image
(`python:3.11|3.12|3.13-alpine@sha256:<64 hex>`) entered in **Settings →
Tools → Code execution sandbox**. The proxy never pulls images and never
falls back to running code on the host. Get the digest with
`docker image inspect` after pulling the image yourself. Resource limits
(timeout, memory, CPU, processes, output) live in the same card; isolation
is fixed to strict (no network, read-only root, dropped capabilities).

### MCP tools disappeared after editing the connection

Discovery results are bound to the exact URL, headers, transport and
timeout that produced them. Changing any of them — or a tool's schema on
the server — clears the grant on purpose. Run **Discover tools** again,
review the list, select the tools, and use **Explicitly grant selected
tools**. Only public HTTPS Streamable HTTP servers on port 443 are
supported; local stdio is disabled, and redirects are refused. A tool whose
schema changed since review fails with "re-discover and approve" instead of
running with unreviewed arguments.

### A configured HTTP tool is refused before it runs

Check the destination policy first: public DNS only (the address is pinned
after validation), ports 80/443 only, no redirects, no credentials in the
URL. Arguments whose field names look like credentials (`apiKey`, `token`,
…) are refused — configure the credential as a server-side secret header
instead. Non-GET tools and tools classified `write`/`unknown` always pause
for approval; an HTTP GET is only automatic when you classified the
operation `read_only` yourself.

### File uploads

Uploads are limited to 4 MiB and 100 000 extracted characters, live only in
the proxy's memory for one conversation, and expire after one hour.
Supported formats are TXT, Markdown, CSV, JSON, text-based PDF and DOCX. A
scanned PDF reports "no extractable text" — OCR is not performed and the app
will not pretend otherwise. Files are addressed by opaque ID; the model
cannot open host paths.

### The tool timeline vanished after reload

Tool traces are not persisted by default. Enable **tool-history
persistence** (profile default, overridable per conversation) to keep the
sanitized trace; secrets are never stored either way. A call that was
pending when the page reloaded is shown as *interrupted* and is never
re-run automatically.

### Running the tool-calling benchmark and diagnostic CLI

`tools/benchmark-tool-calling.mjs` (`npm run benchmark:tools`) verifies tool
calling in two explicitly separated phases:

1. **Model-Only Mode (`--mode model`):** Talks directly to an OpenAI-compatible
   `llama-server` endpoint and runs multi-trial checks for the two-step
   capability handshake (`kaggle_kit_capability_probe`), streamed tool-call
   fragment assembly (`text/event-stream`), unambiguous tool selection
   (`calculator_calculate`, `calculator_convert`, `files_list`), JSON argument
   schema and semantic validation, synthetic tool result acceptance (explicitly
   labelled synthetic), and non-tool restraint on conversational greetings.
2. **Application Integration Mode (`--mode integration`):** Starts a temporary
   local Kaggle-Kit proxy (`createApp`) and exercises the actual
   `ToolChatService` + `ToolExecutor` across capability gating, calculator and
   unit conversion, conversation file upload/list/read/analyze/cleanup,
   `web_open` SSRF protection, `diagnostics_check`, configured HTTP and MCP
   approval/SSRF fixtures, the `code_execute` approval/denial gate (without
   auto-running unapproved code; pass `--run-docker-sandbox` only when Docker
   is installed and you want to test an approved container run), and bounded
   1-attempt corrective recovery (invalid arguments, invalid tool name, and raw
   `<tool_call>` markup in prose).

```bash
# Against the deterministic local mock upstream + real proxy handlers:
npm run benchmark:tools -- --spawn-mock

# Against a live Kaggle / llama-server endpoint (never pass --api-key on the CLI):
KAGGLE_KIT_BASE_URL="https://<your-tunnel>.trycloudflare.com/v1" \
KAGGLE_KIT_API_KEY="<your-api-key>" \
npm run benchmark:tools -- --mode both --trials 3 --output benchmark-report.json
```

**Safety controls:** Passing `--api-key`, `--key`, or `--token` on the command
line is refused with exit code `2` so credentials never appear in `ps`. API
keys and `*.trycloudflare.com` hostnames are automatically redacted from stdout
and JSON report files. A `--spawn-mock` run proves the application's wire
protocol, schema validation, corrective loop, and tool handlers; only a live
`llama-server` run (`endpointType: "live_upstream"`) proves the deployed model
weights' own tool-selection and argument-generation quality.

## Development

### `npm test` fails with "Found multiple elements"

The component tests use `cleanup()` between the cases. If you add a test file,
import `cleanup` from `@testing-library/react` and call it in `afterEach`, or
add the file to the shared setup in `src/test-setup.ts`.

### The build fails with "Chunks are larger than 500 kB"

The Markdown renderer (`react-markdown` + `rehype-highlight`) is the bulk of
the bundle. The warning is informational; the client is ~185 kB gzipped.
