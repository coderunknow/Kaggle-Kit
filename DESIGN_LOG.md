# DESIGN_LOG

Append-only record of the design decisions, the validation results and the open
items. New entries are appended at the end; existing entries are never
rewritten or removed.

---

## 2026-10-18 – Kaggle Qwen3.8-27B API and chat interface

### Original requirements (as received)

1. A reliable Kaggle deployment cell that starts
   `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` (≈12.12 GB, GGUF) with the official
   CUDA `llama.cpp` server on two Tesla T4 GPUs, context size 8192, reasoning
   effort `medium`, MTP speculative decoding enabled, an OpenAI-compatible API
   (`/v1/models`, `/v1/chat/completions`) and an optional public endpoint
   through a Cloudflare Quick Tunnel.
2. A complete, polished chat interface that configures that API and talks to
   the model from a browser: connection profiles, a real connection test,
   inference settings, a full chat experience, persistence and a shared,
   reliable API client.
3. Constraints: no hard coded endpoint or credential, no committed secrets or
   weights, no dependency on the GitHub release *list* API, non streaming
   requests by default, streaming only after it is verified, honest reporting
   of what was and was not tested.
4. Deliverable: a branch with the implementation, the tests and the
   documentation, and an open pull request.

### Starting point

The repository was empty apart from the `LICENSE` file: no code, no tests, no
`AGENTS.md`, no `DESIGN_LOG.md`, no `AGENTS_LOG.md`. The stack and the design
system therefore had to be established. The decisions below follow from that.

### Decision 1 – the browser never talks to the model server directly

A browser cannot call a `llama-server` on Kaggle without a CORS policy, and
the API key would have to live in the browser. A small local proxy backend
(`server/`, plain `node:http`, no runtime dependencies) was added:

* it is served from the same origin as the client, so there is no CORS
  problem at all and the user never has to weaken the browser security,
* it injects the `Authorization` header server side, so the key can stay in a
  `0600` file on the user's machine and never reach the browser,
* it verifies streaming support before offering a streaming request,
* it is the only component that talks to the model, which keeps one code path
  for the connection test and for the chat.

The cost is one more process (`npm start`). The alternative – a static page
that calls the tunnel directly – was rejected because it cannot solve CORS
without the server's cooperation and it forces the key into the browser.

### Decision 2 – one API client, used by the test and by the chat

`shared/api/client.ts` implements the OpenAI-compatible calls once:
normalisation, the `Authorization` header, timeouts, cancellation, HTTP
classification, invalid JSON, empty bodies and redaction of the key from every
message. The connection test and the chat interface both go through it, so
they cannot drift apart.

The browser calls the proxy through `src/lib/gateway.ts`, which is a thin
transport layer: same origin, no credential in a URL, and the abort signal is
forwarded so that a cancelled request really cancels the upstream call.

### Decision 3 – unsupported parameters are omitted, never guessed

`shared/api/requests.ts` builds the request body and reports what it left
out. `frequency_penalty` and `presence_penalty` are only sent when the user
enabled them. `reasoning_effort` is only sent when the server advertises the
option – in `llama.cpp` reasoning effort is a *start-up* flag
(`--reasoning-effort medium`), and the interface says so instead of pretending
that a browser setting changes the server. `stream: true` is only sent after a
real SSE request against that endpoint succeeded.

The backend re-applies the same rule, so a hand crafted request cannot smuggle
an unsupported parameter to the model.

### Decision 4 – three credential modes, the safe one is the default

| Mode | Storage | Default |
| --- | --- | --- |
| `session` | memory of the page | yes |
| `server` | `0600` file of the proxy | no |
| `browser` | `localStorage`, plain text | no, opt-in with a warning |

`localStorage` is not a secure store and the interface says so. The key is
never part of a URL, a log line, a fixture or an error message; the repository
scan in `src/security.test.ts` fails the build when one appears in the source.

### Decision 5 – the deployment script keeps the verified cell and tightens it

The working cell was the starting point. What was kept: the pinned release
tags, the direct release asset URLs, the resumable downloader, the GPU check,
the reuse of a downloaded binary, the model cache in `/kaggle/input` and in the
working directory, the variant chain (`ctx=8192 + MTP` → `ctx=8192` →
`ctx=4096` → `ctx=4096` without the reasoning flag), the real inference smoke
test, the reuse of a healthy server and the Cloudflare Quick Tunnel.

What was added:

* **A flag filter.** The start-up flags are checked against the `--help`
  output of the installed build, so `--reasoning-effort`, `--spec-type`,
  `--flash-attn`, `--jinja`, `--split-mode` … are only used when the build
  understands them.
* **A public endpoint verification.** The tunnel URL is not reported as
  working because the local server answers: a real request through the tunnel
  decides it. A failed verification is stated explicitly.
* **A key aware health check.** A running server is only reused when it also
  accepts the current API key.
* **A GGUF magic byte check** next to the size check, so a truncated or
  renamed file is not used.
* **A local streaming probe** that reports the local support separately from
  the tunnel (a Quick Tunnel does not support SSE).
* **A runtime bundle**: `api_key.txt` (mode `0600`), `runtime.json` (the
  start-up configuration) and `profile.json` (a profile template without the
  key).

### Decision 6 – the repository was empty, so the stack was chosen

TypeScript, React 19, Vite 8, Vitest 5 and ESLint 10. No UI framework, no
state library, no router, no CSS framework, no icon package: the design system
is one token based stylesheet (`src/styles/global.css`) and the icons are
inline SVG. The domain model is small enough for one reducer.

### Validation results

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc`, client and backend) | passed |
| `npm run lint` (`eslint`) | passed, no warnings |
| `npm test` (`vitest`) | 85 tests in 10 files, all passed |
| `npm run build` | passed: client 604 kB (185 kB gzip), backend bundled to `dist/server/index.js` (45 kB) |
| `python3 -m unittest discover -s notebooks -p "test_*.py"` | 12 tests, all passed |
| End-to-end run of the built artifacts against the mock upstream | the client is served; the connection test performs a real inference; a chat completion returns the answer; the streaming probe and a streaming request work; a wrong key is reported as an authentication failure; the secret store file has mode `0600` |
| Real deployment on Kaggle with two T4 GPUs | **not executed** – no GPU and no access to `huggingface.co` or the GitHub release CDN from the sandbox |

The component tests (`src/components/App.test.tsx`) drive the real application
in jsdom against a `fetch` that mimics the backend and cover: a multi turn
conversation, the request payload (model, messages, parameters, key in the
body and not in the URL), a failing request with an actionable error, the
retry, the cancellation, the conversation persistence without the key, the
rename and delete of a conversation and a failing connection test.

The backend tests (`server/app.test.ts`) run the real server on an ephemeral
port against a mock OpenAI-compatible upstream and cover the model list, the
connection test, the chat proxy, the streaming probe, the secret store, the
unknown routes and the absence of the key in the answers and in the logs.

### Completed

* The deployment script exists, is executable, is documented and reuses the
  files and a healthy server of an earlier run.
* The chat interface configures an arbitrary OpenAI-compatible endpoint
  without a hard coded URL or credential, tests the connection for real and
  holds a real multi turn conversation.
* The inference controls change the real request; unsupported parameters are
  omitted.
* The conversation and profile management works, including rename, delete and
  clear.
* Network failures and invalid settings produce an actionable message.
* No credential or model weight is committed; the tests enforce it.
* All applicable checks were executed and their real results are documented
  above and in `AGENTS_LOG.md`.
* The work is committed on a feature branch and proposed through a pull
  request.

### Incomplete and blocked

* **The real Kaggle deployment was not repeated.** The sandbox has no GPU and
  cannot reach `huggingface.co` or the GitHub release CDN. The script is based
  on a cell that was verified by the operator and its logic is unit tested, but
  the end-to-end run on Kaggle still has to happen there.
* **A real browser was not available in the sandbox** (no Chromium, no
  Playwright browsers – the download hosts are not reachable). The interface
  was verified with the jsdom component tests, with the end-to-end run of the
  built artifacts and through the live preview; a click-through in a real
  browser is still worth doing.
* **The Quick Tunnel was not tested end to end** from this environment, only
  the code path that starts it and verifies the public URL.

### Open questions

* Should the proxy expose an authentication for the case that it is deployed
  on a shared machine? Today it binds to loopback and can be restricted with
  `KAGGLE_KIT_ALLOWED_HOSTS`.
* Should the runtime bundle of the deployment script be importable into the
  chat interface (a "paste the startup configuration" field) instead of being
  only a file? The information is currently shown as an explanatory card.
