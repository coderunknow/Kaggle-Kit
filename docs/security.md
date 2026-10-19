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
  makes it an open relay if it is exposed to a network. Keep it on loopback,
  or set `KAGGLE_KIT_ALLOWED_HOSTS=host1,host2` to restrict the reachable
  hosts, or put it behind an authenticating reverse proxy.
* **It never logs request bodies** and it redacts the secrets it handles.
* **It sets security headers**: `Content-Security-Policy` (no inline script,
  `connect-src 'self'`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
* **The secret store** is written atomically with mode `0600` inside a
  directory with mode `0700`.

## The Kaggle deployment

* The key is created with `secrets.token_urlsafe(32)` when the cell runs.
* `api_key.txt` is written with mode `0600`.
* The cell prints the key once. Anyone who can see the notebook output can
  read it – treat the output like a secret and delete the output when it is
  no longer needed.
* **Rotate the key** by rerunning the cell: a new key is generated and the
  old server (and with it the old key) is replaced. Then update the profile in
  the chat interface and remove the old reference under *Data & credentials*.
* The public Quick Tunnel URL is a bearer-free but unauthenticated path to the
  model: the API key is the only protection. The URL is temporary and changes
  on every run – do not publish it.

## What is never stored

* Model weights (`*.gguf`), release archives (`*.tar.gz`), the runtime
  directory `.data/`, `*.log` files and `.env` are excluded by `.gitignore`.
* The test suite never writes a real credential into a fixture. The keys used
  in the tests are constants of the test files themselves.

## Reporting a problem

If you find a place where a credential could leak, open an issue without
including the key. Rotate the key afterwards and remove it from the history of
the affected system.
