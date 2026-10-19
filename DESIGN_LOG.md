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

---

## 2026-10-19 – System prompt research and Qwen prompt optimization

### Objective (as received)

Investigate `asgeirtj/system_prompts_leaks` exhaustively, inventory its prompt
files with provenance, analyse what makes the prompts work, remove restrictions
that suppress capability without protecting anyone, synthesize an original
system prompt for the Qwen deployment in this repository, integrate it, test it
and document the result honestly.

### Starting point

The branch that contains this application had no research directory and no
system prompt; the profile editor accepted free text and sent nothing by
default. A second arena branch (`arena/a434278f-kaggle-kit`) contained research
for a *standalone* prompt without access to this application. It was not merged:
its target assumptions (no application, no integration point) do not match this
branch. The research here was written against the code in this repository.

### Decision 1 – establish the target from the code, not from the model name

Everything in `SOURCE_EVIDENCE.md` §1 is read from `notebooks/qwen3_8_27b_api.py`,
`shared/api/*`, `src/state/useChat.ts` and `server/*`, plus the pinned
`llama.cpp` server README. The important consequences: there is **no tool
channel**, the system prompt is **one message and only when non-empty**, the
chat template is applied by the server, and the context is **8 192 tokens**.
A prompt written for a 500 KB agent harness would be wrong here.

### Decision 2 – inventory everything, read selectively, say which is which

`build_inventory.py` classifies all 1 304 text files (233 system prompts, 76
instruction fragments, 886 skills, 43 supporting documents, …), hashes them,
finds 128 exact duplicates and 14 near-duplicate clusters, and records
provenance and compatibility per file. `inspected_files.json` records which 19
files were read end to end and which 15 were read at section level. The
analysis states the coverage instead of claiming exhaustiveness.

### Decision 3 – measure before asserting

`analyze_corpus.py` produces the numbers quoted in `PROMPT_ANALYSIS.md`
(theme shares per behavioural group, restriction census, recurring directive
extraction). Two examples that changed the design: hard word caps appear in only
11% of prompts and are a terminal constraint, and hardcoded dates appear in 40%
of prompts and are a staleness bug rather than a feature.

### Decision 4 – the prompt is small, one message, and tool-free

1 017 estimated tokens (12.4% of the window), original text, no template tokens,
no tool schemas, no date, no cutoff, no persona. The optional tool and
summarisation appendices live in `SYSTEM_PROMPT.md` and are explicitly not
pasted, because the runtime cannot execute them.

### Decision 5 – integrate through the existing form, not the default

The recommended prompt is inserted by a button in the profile editor rather than
made the default for every profile: the application talks to any
OpenAI-compatible endpoint, and a Qwen-specific prompt is wrong for the mock
server or for another model. An empty field keeps meaning "no system message",
which is the pre-existing behaviour and is now pinned by a test. The text has a
single source of truth in `shared/prompts/qwen.ts`; `SYSTEM_PROMPT.md` mirrors
it and a test fails on drift.

### Decision 6 – do not evaluate without a model

The evaluation suite (17 cases, 36 objective checks, 45 manual criteria) and its
runner are part of the deliverable, but this environment has no GPU, no weights
and no endpoint. `PROMPT_EVALUATION.md` labels every claim about model behaviour
as an untested hypothesis and records the dry-run output verbatim.

### Validation (executed)

* `npm run typecheck` – passed.
* `npm run lint` – passed, no findings.
* `npm test` – **96 tests in 11 files**, all passed (85 before this work).
  New: 9 prompt-invariant tests, 2 end-to-end tests that the inserted prompt
  becomes `messages[0]` exactly once, and that an empty field still sends no
  system message.
* `python3 research/qwen-system-prompt/eval/run_eval.py --dry-run` – suite
  valid: 17 cases, 36 auto checks, 45 manual criteria, prompt SHA-256
  `2f52bd9a1c9c1935`.
* Inventory and census regenerated from the clone; counts as reported in
  `PROMPT_INVENTORY.json` and `corpus_analysis.json`.

### Incomplete and blocked

* **No model run.** No GPU, no GGUF file, `huggingface.co` is not reachable and
  no endpoint was provided. The baseline/candidate comparison is prepared, not
  executed; no score is claimed.
* **No vendor-document verification of any leaked prompt.** Only GitHub, npm and
  PyPI are reachable; provenance is classified, not confirmed.
* **The token count is an estimate** from characters (3.6 chars/token), not a
  count from the Qwen tokenizer.
* **A real browser click-through of the new button** was covered by jsdom
  component tests only.

### Open questions

* Should `Current date: YYYY-MM-DD (UTC)` be injected at request time? It would
  fix a real gap (the model has no clock and the corpus shows 40% of prompts
  hardcode one), but it changes every profile and belongs to the product owner.
* Should the app ship a prompt *per profile* from a small set (tool-free,
  coding, research) instead of a single recommended prompt? The research found
  that conditioning modules on real capabilities matters; today there is exactly
  one capability set.
