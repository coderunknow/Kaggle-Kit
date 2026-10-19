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

### "proxy offline" in the header

The browser cannot reach the local backend. Start it with `npm start` (or
`npm run dev`) and open the address it prints. The backend has to be the same
origin as the client – the production build serves the client itself, the
development server proxies `/api` to the backend.

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

## Development

### `npm test` fails with "Found multiple elements"

The component tests use `cleanup()` between the cases. If you add a test file,
import `cleanup` from `@testing-library/react` and call it in `afterEach`, or
add the file to the shared setup in `src/test-setup.ts`.

### The build fails with "Chunks are larger than 500 kB"

The Markdown renderer (`react-markdown` + `rehype-highlight`) is the bulk of
the bundle. The warning is informational; the client is ~185 kB gzipped.
