# Security

## The API key

The API key of a llama.cpp server is a bearer token: whoever has it can use the
model. The rules this project follows:

1. **The key is never part of a URL.** It is sent in the `Authorization` header
   of the request to the configured endpoint and nowhere else. The client test
   `shared/api/client.test.ts` and the repository scan in
   `src/security.test.ts` enforce this.
2. **The key is never logged.** The backend redacts every registered secret
   from its log output, and the error messages that reach the browser are
   scrubbed with the same helper (`shared/api/errors.ts` → `redactSecrets`).
3. **The key is never committed.** The deployment script generates it at
   runtime, stores it in a `0600` file and prints it once, in the final
   summary. No key, tunnel URL or other credential from a real session is part
   of this repository, its history, its tests or its documentation.
4. **The key is never in a URL, a query string or a fixture.** The only place
   it travels in the browser is the JSON body of a request to the *local* proxy
   (`POST /api/proxy/chat`), which is a same-origin request to your own
   machine.
5. **A redirect never carries the key to another host.** The client follows
   redirects manually and refuses a redirect to a different origin as soon as
   an API key is configured (`shared/api/client.ts`).
6. **Local helper scripts keep the key out of the command line.** The Windows
   connection check (`tools/check-kaggle-connection.ps1`) reads the key with
   `Read-Host -AsSecureString`, keeps it in memory, zeroes the unmanaged copy
   and prints only a sanitized report. The launcher
   (`scripts/start-windows.ps1` / `tools/launcher.mjs`) never reads a key at
   all; the proxy owns the secret store.

## Where the key is stored

| Mode | Storage | Survives a reload | Shared with the browser |
| --- | --- | --- | --- |
| `This tab only` (default) | Memory of the page | no | yes, for the requests of this tab |
| `Local proxy secret store` | `.data/secrets.json`, mode `0600` | yes | no – the browser only sends a reference |
| `Browser storage` (opt-in) | `localStorage`, plain text | yes | yes |

Browser storage is **not** a secure store: every script on the origin can read
it. The interface says so next to the option and the *Data & credentials* tab
shows a warning while such a key exists. The default is the in-memory mode,
which never writes the key to disk.

## The local proxy backend

The backend binds to `127.0.0.1` by default. It is a small `node:http` server
without runtime dependencies.

* **It is a proxy.** It forwards requests to the endpoint you configure, which
  makes it an open relay if it is exposed to a network. The controls are
  listed in the next section.
* **It never logs request bodies** and it redacts the secrets it handles.
* **It sets security headers**: `Content-Security-Policy` (no inline script,
  `connect-src 'self'`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
* **The secret store** is written atomically with mode `0600` inside a
  directory with mode `0700`. The store never returns a key value, only the
  references.

### The threat model of the proxy

The backend answers two kinds of requests:

* the browser client of this project (same origin, served by the backend
  itself), and
* the *upstream* API the user configured, which is reached through the proxy.

The risks and the controls:

| Risk | Control |
| --- | --- |
| A page of another site uses the proxy of the user (CSRF / DNS rebinding) | A request with an `Origin` header must come from the origin of the server or from `KAGGLE_KIT_ALLOWED_ORIGINS`. A body must use `Content-Type: application/json`, which a browser cannot send cross origin without a preflight. |
| The proxy reaches an unintended host (SSRF) | `KAGGLE_KIT_ALLOWED_HOSTS` restricts the reachable hosts, `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1` refuses loopback, private, link local and unique local addresses. Host names are normalized (lower case, no trailing dot) and `*.example.com` patterns are supported. |
| A redirect bypasses the allow list | The client follows redirects manually, validates every hop against the same policy and never sends the key to another origin. |
| A request body floods the backend | `KAGGLE_KIT_MAX_BODY_BYTES` (default 1 MB) limits the body of a request. |
| A path of the client escapes the client directory | The file is resolved with `path.relative` against the client directory; a traversal, an absolute path or a sibling directory with the same prefix is refused with HTTP 403. |
| A stream runs forever | The streaming route aborts the upstream request when the client disconnects and after a timeout, and the reader of the upstream body is always closed. |
| The secret API is used by another program on the machine | The secret store only returns references. Any local program can still talk to the backend, so the backend has to stay on the loopback interface. |

**DNS rebinding.** The hostname policy alone cannot see the address a name
resolves to, so every proxy and tool request validates the resolved address
set at connect time (`server/pinnedFetch.ts`, the same pinning used by the
web/HTTP/MCP fetches). A rebinding name that answers with a loopback,
link-local, multicast, unspecified or cloud-metadata address is refused
before anything is sent; with `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1` any
private answer is refused. The remaining residual risk is a name that
resolves to an ordinary private LAN address with private networks allowed —
that is the intended behaviour for reaching servers on the user's own
network. Set `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1` and/or
`KAGGLE_KIT_ALLOWED_HOSTS` to close it.

**The defaults keep the product usable.** There is no allow list and no
private network block by default, because the normal setup is a local
`llama-server` on `127.0.0.1:8000` and an arbitrary OpenAI-compatible
endpoint. The backend prints a warning at start-up when no allow list is
configured.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `KAGGLE_KIT_HOST` | `127.0.0.1` | Interface of the backend |
| `KAGGLE_KIT_PORT` | `8787` | Port of the backend |
| `KAGGLE_KIT_ALLOWED_HOSTS` | *(empty)* | Comma separated list of reachable hosts, `*.example.com` is allowed |
| `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS` | `0` | `1` refuses loopback, private and link local destinations |
| `KAGGLE_KIT_ALLOWED_ORIGINS` | *(empty)* | Extra browser origins that may call `/api/*`. Required when the app is served through a non-loopback name (e.g. a LAN hostname), because only loopback origins are trusted automatically. |
| `KAGGLE_KIT_MAX_BODY_BYTES` | `1000000` | Maximum size of a request body |
| `KAGGLE_KIT_CLIENT_DIR` | `dist/client` | Directory with the built browser client |
| `KAGGLE_KIT_DATA_DIR` | `.data` | Directory with the secret store |

The values are read **at start-up**. After changing one of them, stop the
proxy and start it again; changing a profile or an API key in the interface
does not need a restart.

### The two addresses

The most common connection mistake is to enter the address of the interface
where the address of the model belongs:

* **This page** is served by the local proxy, normally
  `http://127.0.0.1:8787` (development: `http://localhost:5173`).
* **The model API** is the base URL of the profile: the short-lived
  `https://<random>.trycloudflare.com` address that the notebook prints, or
  `http://127.0.0.1:8000/v1` for a local `llama-server`.

The proxy is the only component that talks to the model API. The settings
drawer names both addresses and the connection help repeats the distinction.

### Setting the allow list on Windows (PowerShell)

```powershell
# Only the host of your own tunnel, without a scheme or a path.
$env:KAGGLE_KIT_ALLOWED_HOSTS = "<random>.trycloudflare.com"
npm start
```

`$env:` sets the variable for the current PowerShell session. To keep it for
new terminals, use `setx KAGGLE_KIT_ALLOWED_HOSTS "<random>.trycloudflare.com"`
and open a new terminal; `setx` does not change the current session. Restart
the proxy after either change. On macOS or Linux the equivalent is
`KAGGLE_KIT_ALLOWED_HOSTS="<host>" npm start`.

Do not add a real tunnel URL or a key to a file in this repository: the allow
list belongs to your environment, not to the source.

### What the interface stores

| Data | Place | Sensitive |
| --- | --- | --- |
| Profiles, conversations, drafts, theme and send preference | `localStorage` of the origin | Conversations and drafts contain text you typed. Profiles may contain tool settings and secret references, never direct HTTP header credentials. |
| Uploaded files | Proxy process memory; browser stores metadata only | File bytes/extracted text are not persisted. |
| Session key | Memory of the tab | Yes, never written to disk |
| Browser key (explicit opt-in) | `localStorage`, plain text | Yes |
| Server-side secrets (model/API/provider keys) | `.data/secrets.json` `secrets` record, mode `0600` | Yes, never sent to the browser |
| Tool profile settings | `.data/secrets.json` `toolProfiles` record, mode `0600` | Settings and secret references, not credential values. Clearing server secrets preserves these settings/references. |

There is no analytics, no telemetry and no third-party script. When a user
enables a provider or configured HTTP/MCP tool, requests and tool arguments go
to that explicitly configured service; an exported Markdown file is written
by the browser to the download directory the user chose, and the application
cannot see or delete it afterwards. Retention-restricted Brave-derived answers
are excluded from the app's saved history and Markdown export unless the user
has confirmed account rights for retention and opted in to tool-history persistence.

## Tool integrations and approval boundaries (dev4)

Tool use is off by default and must be enabled per profile. Ordinary chat is
not gated by tool support. A model/endpoint/credential-specific probe must
return a correctly correlated function call with `finish_reason: "tool_calls"`,
then accept the same call in an assistant message, a synthetic `role: "tool"`
result and a final `finish_reason: "stop"`. Neither probe turn executes a
function. Every explicit verification action runs a fresh probe; its result is
cached for up to ten minutes to gate tool chats for the exact model, endpoint
and credential. Streamed tool-call fragments are then probed separately:
partial argument JSON is only concatenated per call index, never parsed or
executed, and streaming is reported supported only when the assembled call
arrives with `finish_reason: "tool_calls"`. Tool loops use non-streaming
requests so approvals can pause between rounds.

The server enforces the policy; prompts are not an authorization boundary:

* The model may request only names in a server-built catalog. It cannot create
  a handler by placing a name or executable code in prose, a code block, or an
  uploaded document. Tool arguments are size-bounded, parsed as JSON, checked
  against the configured schema and rejected on prototype-pollution keys.
  Untrusted schemas are size/depth/node-bounded; regex/pattern keywords,
  quadratic uniqueness checks and deeply nested branching/conditional schema
  constructs are rejected to bound validation work.
* Calculator, conversation-scoped file operations, read-only diagnostics,
  public web retrieval and tools explicitly classified as `read_only` are the
  only candidates for automatic execution. A non-GET custom HTTP request, a
  code run, or a selected tool with `write`/`unknown` permission pauses for a
  specific user approval. Unselected or ungranted MCP tools are not exposed to
  the model and are refused server-side. Approval is single-use, expires, is
  tied to the exact prepared arguments and fails if settings changed. Exact
  denied actions are not re-requested during the same turn.
* The approval view is an accessible execution timeline: bounded/redacted
  arguments, target, state and result; it does not rely on color. Live approval
  IDs/job IDs are not restored after reload. Clear/delete abort requests, cancel
  paused jobs and remove the conversation's in-memory file vault.
* Tool output **and error text** are untrusted data before they are sent back to
  the model. A returned instruction is not executed. Tool output is bounded and
  secrets from the local SecretStore are redacted from displayed traces. Model
  response bodies in tool chats are capped at 1 MiB (capability-probe bodies at
  16 KiB), and upstream request timeouts/cancellation remain active while those
  response bodies are read.

### Network and data boundaries for tools

The configured model endpoint follows the pre-existing upstream host policy
(`KAGGLE_KIT_ALLOWED_HOSTS` and optional private-network blocking). This proxy
still validates the model endpoint by hostname and does not pin DNS there; use
an explicit host allowlist when the proxy can be reached by other local users.

Public web, configured HTTP and MCP destinations have a stricter tool-specific
policy: private, loopback, link-local, reserved and metadata addresses are
rejected, DNS answers are checked and the selected public address is pinned for
the socket. `web_open` rejects URL userinfo and credential-like query parameter
names, and revalidates each redirect hop; configured HTTP and MCP redirects are
refused. MCP additionally requires public HTTPS on port 443 and
never launches local `stdio` processes. A hostname that resolves to a private
address is not made safe by an allowlist entry in a tool profile.

* Uploaded data is limited to 4 MiB per file and 100k extracted characters,
  then kept only in the proxy's bounded, in-memory, conversation-scoped vault.
  The proxy exposes no host path/file API. Clearing or deleting a conversation
  aborts active work and deletes that vault; process restart and expiry also
  remove it. Browser persistence contains file metadata only.
* HTTP/MCP header credentials and Brave keys are accepted through references
  resolved by the proxy. Profiles retain references; literal values are limited
  to non-sensitive header allowlist entries. Unknown header names must use a
  secret reference. Credential-like HTTP argument names are refused rather
  than placed in URLs or request bodies. The secret store uses v2
  `{ version, secrets, toolProfiles }`
  records, migrates valid v1 stores, validates both maps as plain records and
  retains secure file permissions.
* Brave history persistence is off by default. Without an explicit retention
  rights confirmation **and** an opt-in, Brave-derived assistant text and later
  assistant replies are replaced with a visible placeholder in local storage
  and Markdown exports; the search query/result data is not saved by the app.
  Provider terms, account rights and fees are not verified by the local tests.
* Python execution is disabled by default and the tool is offered only after a
  digest-pinned Python image is configured. Every call still requires approval;
  the container uses no network, constrained resources and no host fallback.
  Docker availability is not proven by the native tool-call probe: if the CLI
  or image is unavailable, the run fails closed. Docker was unavailable in
  this development environment, so runtime isolation is unverified.

External provider credentials, account retention terms, live MCP servers and
the deployed Kaggle model's tool behavior must be verified by the operator.
No capability is claimed from a model family, URL or template flag alone.

## The Kaggle deployment

* The key is created with `secrets.token_urlsafe(32)` when a **new** server
  is started.
* `api_key.txt` is written with mode `0600` and holds the key of the server
  that is currently running.
* The cell prints the key once. Anyone who can see the notebook output can
  read it – treat the output like a secret and delete the output when it is
  no longer needed.
* **A rerun reuses the running server.** The cell reads `server-state.json`
  (process id, port, model, applied options) and reuses the server when it is
  healthy and its configuration still fits. The key of that server stays
  valid, so the profile in the chat interface keeps working.
* **A restart rotates the key.** When the server of a previous run no longer
  fits (a different model, a different context size) or does not answer, the
  cell stops *that* process, starts a new one with a new key and says so in
  the summary. The old key stops working at that moment.
* **A foreign process is never stopped.** If the port is used by a process
  that the cell did not start, the cell reports the conflict and stops; it
  does not kill anything it does not own.
* The public Quick Tunnel URL is a bearer-free but unauthenticated path to the
  model: the API key is the only protection. The URL is temporary and changes
  on every run – do not publish it.
* The key is passed to `llama-server` through `--api-key-file` when the
  installed build supports it, so it does not show up in the process list.

## What is never stored

* Model weights (`*.gguf`), release archives (`*.tar.gz`), the runtime
  directory `.data/`, `*.log` files and `.env` are excluded by `.gitignore`.
* The test suite never writes a real credential into a fixture. The keys used
  in the tests are constants of the test files themselves.

## Reporting a problem

If you find a place where a credential could leak, open an issue without
including the key. Rotate the key afterwards and remove it from the history of
the affected system.
