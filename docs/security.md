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

**Known limits.** The allow list works on the name of the host, not on the
address it resolves to: a name that points to a private address is not
detected (DNS rebinding). The private network check has the same limit. Both
are documented trade-offs of a tool whose main job is to reach a
`llama-server` on `127.0.0.1`.

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
| `KAGGLE_KIT_ALLOWED_ORIGINS` | *(empty)* | Extra browser origins that may call `/api/*` |
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
| Profiles, conversations, drafts, theme and send preference | `localStorage` of the origin | Conversations and drafts contain the text you typed |
| Session key | Memory of the tab | Yes, never written to disk |
| Browser key (explicit opt-in) | `localStorage`, plain text | Yes |
| Proxy key (server mode) | `.data/secrets.json`, mode `0600` | Yes, never sent to the browser |

There is no analytics, no telemetry and no third-party script. An exported
Markdown file is written by the browser to the download directory you chose;
the application cannot see or delete it afterwards.

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
