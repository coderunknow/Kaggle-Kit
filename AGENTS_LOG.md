# AGENTS_LOG

Append-only log of the work done in this repository. Newest entries are
appended at the end. Do not edit or remove an existing entry.

---

## 2026-10-18 – Feature branch `arena/b94557e7-kaggle-kit`

**Task.** Build the Kaggle Qwen3.8-27B API deployment and a complete chat
interface, and open a pull request for it.

**Starting point.** The repository contained only a `LICENSE` file. There was
no `AGENTS.md`, no `DESIGN_LOG.md`, no `AGENTS_LOG.md`, no application code and
no test suite, so the stack, the design system and the conventions were
established as part of this task and are documented in `AGENTS.md`.

**What was added.**

* `notebooks/qwen3_8_27b_api.py` – the Kaggle deployment script, derived from
  the verified working cell. Kept: the direct release asset URLs, the
  resumable downloader, the GPU check, the build reuse, the model cache, the
  variant chain with a real inference test, the smoke test and the tunnel.
  Added: a flag filter based on the `--help` output of the installed build, a
  GGUF magic byte check, a key check for the "reuse a running server" path, a
  verification of the *public* endpoint, a local streaming probe, a runtime
  bundle (`api_key.txt` with mode `0600`, `runtime.json`, `profile.json`) and
  explicit messages for every failure.
* `notebooks/test_qwen_deployment.py` – 12 unit tests for the parts of the
  script that run without a GPU.
* `shared/` – the API client, URL normalisation, error classification, request
  building, SSE parsing, validation and the domain model. Used by the browser
  client and by the backend.
* `server/` – the local proxy backend (`node:http`, no runtime dependencies):
  it serves the built client, proxies the OpenAI-compatible calls, keeps the
  key out of the browser in the "server" credential mode, verifies streaming
  support and stores keys in a `0600` file.
* `src/` – the React chat client: profiles, connection test, inference
  settings, conversation list, Markdown rendering, copy, edit, resend, retry,
  cancel, dark mode, keyboard and screen reader support.
* `tools/mock-upstream.mjs` – a mock OpenAI-compatible server for local
  development.
* `docs/` – the deployment, interface, security and troubleshooting guides.
* `README.md`, `AGENTS.md`, `AGENTS_LOG.md`, `DESIGN_LOG.md`.

**Bugs that the tests found and that were fixed.**

1. The draft profile in the settings panel received a new id on every render,
   which reset the form while it was being filled in. The draft is now created
   once and the form is mounted with the id of the profile as its key.
2. The chat controller read the conversation from the React state right after
   a dispatch. Because a dispatch is asynchronous, the assistant message was
   appended to a stale conversation and the first user message was lost. The
   controller now keeps a synchronously updated mirror of the conversations.
3. A cancelled request was reported as a failure because the gateway did not
   translate an `AbortError` into an `ApiError` with the kind `aborted`.
4. The mock upstream stopped its SSE timer when the *request* was closed, which
   happens as soon as the request body was read, so it never sent an event.

**Checks that were run.**

* `npm run typecheck` – passed.
* `npm run lint` – passed.
* `npm test` – 85 tests in 10 files, all passed.
* `npm run build` – passed (client bundle 604 kB, 185 kB gzipped; the backend
  is bundled with esbuild into `dist/server/index.js`).
* `python3 -m unittest discover -s notebooks -p "test_*.py"` – 12 tests, all
  passed.
* End-to-end run of the built artifacts against the mock upstream: the static
  client is served, the connection test performs a real inference, a chat
  completion returns the answer, the streaming probe and a streaming request
  work, a wrong key is reported as an authentication failure and the secret
  store keeps the file at mode `0600`.

**Not verified.** A real run on Kaggle with two T4 GPUs was not possible in
this environment (no GPUs, and `huggingface.co` and the GitHub release CDN are
not reachable from the sandbox). The deployment script is therefore validated
by its unit tests and by the review of the working cell it is based on, not by
a real deployment.

---

## 2026-10-19 — Remediation pass on PR #1

**Starting point.** The branch `arena/b94557e7-kaggle-kit` was at `5ba50cd`
(PR #1, open against `main`). The working tree was verified against the
remote commit (`git write-tree` and the tree of the remote commit were both
`80c1681`) and restored with `git reset --hard origin/arena/b94557e7-kaggle-kit`,
so nothing was lost. There was no `.github/workflows` directory, no CI and
no human review comment on the pull request.

**Confirmed defects (each one reproduced before it was fixed).**

1. *Static file containment.* `serveStatic()` compared the resolved path with
   `candidate.startsWith(path.resolve(clientDir))`. A sibling directory whose
   name starts with the name of the client directory was accepted. The path
   `/%2e%2e%2fclient-secret%2fsecret.txt` reaches the file resolution
   (the URL parser keeps the encoded slash), resolves to
   `<clientDir>-secret/secret.txt` and passed the check. Replaced with a
   `path.relative` based containment check (`server/requestPolicy.ts`).
2. *Streaming lifecycle.* `streamChat()` aborted the upstream request on
   `request.on('close')`. A measurement on a local HTTP server showed the
   order `end` → `nextTick` → `close` → promise microtask: the handler was
   registered after the event had already been fired, so a **client
   disconnect never cancelled the upstream request** and the upstream kept
   streaming into a dead socket. The disconnect is now detected on the
   *response* (`response.on('close')` with `writableFinished`), the upstream
   request is aborted, the reader of the upstream body is always closed and
   the stream has a timeout.
3. *No origin and content type check.* Any page in the browser could use the
   proxy of the user (`POST /api/proxy/chat` with a JSON body is a simple
   request for some content types). A request with an `Origin` header must now
   come from the origin of the server or from `KAGGLE_KIT_ALLOWED_ORIGINS`,
   and a body must use `Content-Type: application/json`.
4. *Unrestricted upstream.* The allow list compared the raw host name, so
   `Example.com` did not match `example.com`, and a redirect could leave the
   allow list. The host names are normalized now, `*.example.com` patterns
   work, `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1` refuses loopback, private,
   link local and unique local addresses, and the client follows redirects
   manually and validates every hop.
5. *Notebook: the server was never reused safely.* A rerun generated a new
   key, tested the running server with that new key, concluded that the
   server was unhealthy and started a **second** `llama-server` on the
   occupied port. The key of the running server also stopped working for the
   profile in the chat interface.
6. *Notebook: the reported configuration was not the applied one.*
   `build_server_command()` dropped `--spec-type/--spec-draft-n-max` when the
   build did not support them, but `start_server()` returned the requested
   variant, so `runtime.json` and the summary reported
   `mtp_speculative_decoding: true` for a server that never had it.
7. *Notebook: the public endpoint was only checked with `GET /v1/models`.*
   A public route that answered the model list but not a chat completion was
   reported as usable.
8. *Notebook: `tar.extractall()` without any member validation.* An archive
   could write outside of the target directory.
9. *Download integrity.* An HTML error page was accepted as a file, and a
   truncated download was not detected.
10. *Browser: a cancelled stream was reported as a finished answer.* The
    event parser leaves the loop when the signal is aborted, the gateway
    then reported a partial answer as `complete`.
11. *Browser: the event parser only recognised `\\n\\n` as the end of an
    event.* A server that answers with `\\r\\n\\r\\n` was read as one single
    event.
12. *Browser: the model select had no manual entry.* A model id that the
    server did not report could not be typed.

**Fixes.** See `DESIGN_LOG.md` for the decisions. The short version: a
`server-state.json` with the process id, the port, the model and the applied
options makes the rerun of the cell safe (`reuse` / `restart` / `start` /
`conflict`, and a foreign process is never stopped); the start-up command
reports the options that were really applied; the public route is verified
with an authenticated chat completion; archives are extracted with a
validated member list; and the backend gained the origin, content type,
containment and destination controls.

**Tests that were added (all of them fail without the fix).**

* `server/app.security.test.ts` – 13 tests: the traversal, the sibling
  directory, the foreign origin, the content type, the allow list.
  *6 of them fail with the old code.*
* `server/app.streaming.test.ts` – 5 tests: the complete stream, delayed
  chunks, a frame that is split over two writes, the cancellation by the
  client, an upstream failure. *The cancellation test fails with the old
  code.*
* `server/destinations.test.ts` (14), `server/requestPolicy.test.ts` (14) –
  the host name normalization, the private addresses, the origin policy, the
  content type, the containment and the disconnect detection.
* `shared/api/client.test.ts` – 5 redirect tests (same origin, cross origin
  with a key, a refused hop, too many redirects, `303` becomes a `GET`).
* `shared/api/stream.test.ts` – CRLF events and a frame that is split over
  several chunks.
* `src/lib/gateway.test.ts` – 4 tests: a complete stream, a cancelled
  stream, a failing proxy, and the key never in the URL.
* `notebooks/test_qwen_deployment.py` – the flag selection with the applied
  options, the decision matrix of the server, the state and the key files,
  the safe extraction, the HTML and truncated downloads, and the public
  endpoint against a local HTTP server (success, auth failure, upstream
  error, malformed answer, timeout, unreachable) and the whole flow of a
  rerun (fresh deployment, reuse of a healthy server, restart after a
  configuration change, restart after a failed health check, conflict with a
  foreign process).
* `src/components/App.test.tsx` – a model id that the server did not report.

**Checks that were run (2026-10-19, in this working copy).**

* `npm ci` – exit 0, `found 0 vulnerabilities`.
* `npm run typecheck` – exit 0 (both TypeScript projects).
* `npm run lint` – exit 0.
* `npm test` – exit 0, **143 tests in 15 files**, all passed.
* `npm run build` – exit 0 (client and bundled backend).
* `npm run check:integration` – exit 0, **14/14 checks** against the built
  application and the mock upstream: health, the served client, the
  connection test with a correct and with a wrong key, a chat completion,
  the streaming probe, a complete stream, the cancellation, the foreign
  origin and the content type.
* `python3 -m unittest discover -s notebooks -p "test_*.py"` – exit 0,
  **39 tests**, all passed (the tests need the `requests` package).
* `git diff --check` – exit 0.

**Not verified.**

* A real run on Kaggle with two T4 GPUs. The sandbox has no GPU and cannot
  reach `huggingface.co` or the release CDN, so the GPU detection, the
  download of the model, the real start-up of `llama-server`, the measured
  effect of the MTP flags and a real chat completion through a public
  Quick Tunnel are **not** validated. The exact steps a maintainer has to
  run are listed in `DESIGN_LOG.md`.
* A real browser. The component tests run in jsdom; they are not a browser
  test. What is still open: the real rendering of the Markdown, the copy
  button of a code block, the keyboard navigation of the settings and the
  layout on a small screen.
* The DNS rebinding limit of the host allow list: the check works on the
  name of the host, not on the address it resolves to.
