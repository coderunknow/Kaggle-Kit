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

## 2026-10-19 — Remediation of PR #1 (append only)

This entry records the second pass over the branch `arena/b94557e7-kaggle-kit`.
The entries above are unchanged.

### 7. Decisions

**7.1 The deployment cell owns exactly one server, and it only ever stops a
process it started itself.** A new file `server-state.json` describes the
running server: process id, host, port, model, binary, a digest of the
requested configuration (`fingerprint`) and the options that were really
applied (`applied`). The cell reads the file, checks whether the recorded
process is still alive *and* still a `llama-server` (the command line is
read from `/proc/<pid>/cmdline`), and then decides:

| Situation | Action |
| --- | --- |
| nothing is listening | `start` – a new server with a new key |
| our own server, healthy, configuration still fits | `reuse` – the key stays valid |
| our own server, unhealthy or outdated | `restart` – the old process is stopped, a new key is created |
| something else is listening | `conflict` – the cell reports it and stops, it never kills a foreign process |

The digest is built from the *request* (model file, binary, host, port,
context size, MTP, reasoning effort, GPU split) and not from the result, so
a server that had to fall back to a smaller context is still the server of
this configuration and is reused instead of being restarted on every run.

**7.2 The key belongs to the server process.** `api_key.txt` (mode `0600`)
holds the key of the server that is running. A reuse keeps the key, a
restart rotates it and the summary says so. The key is handed to
`llama-server` through `--api-key-file` when the installed build supports
it, so it does not appear in the process list.

**7.3 Only the applied options are reported.** `build_server_command()`
returns a `ServerLaunch` with the command, the `applied` options and the
`dropped` options. `runtime.json` and the summary are built from `applied`,
so a build without `--spec-type` is reported as `MTP decoding: disabled`.
The smoke test stays a plain chat completion: it proves that the model
answers and it never claims that speculative decoding is active.
`usable_variants()` removes a variant that becomes identical to another one
after the unsupported options are removed, so a build without MTP support
does not start the same configuration twice.

**7.4 The public route is verified on its own.** `verify_public_endpoint()`
does a model list request *and* an authenticated chat completion with a
small output limit over the tunnel, validates the structure of the answer
and classifies the failure (`auth`, `upstream`, `timeout`, `unreachable`,
`invalid_response`). The public streaming support is probed separately from
the local one, because a Quick Tunnel does not forward an event stream while
the local server does. The local state is kept when the public route fails
and the summary never claims a complete success.

**7.5 The backend refuses browser requests from another origin.** A request
with an `Origin` header must come from the origin of the server itself or
from `KAGGLE_KIT_ALLOWED_ORIGINS`; a request with a body must use
`Content-Type: application/json`. Both are cheap, they do not need a
token, and they remove the cross site request forgery risk of a proxy that
binds to the loopback interface.

**7.6 The upstream policy stays open by default and is explicit when it is
closed.** A blanket restriction would break the main use case (an arbitrary
OpenAI-compatible endpoint, a `llama-server` on `127.0.0.1`). The controls
are therefore opt-in and documented: `KAGGLE_KIT_ALLOWED_HOSTS` (with
`*.example.com` patterns and normalized host names) and
`KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1`. The client follows redirects
manually, validates every hop against the same policy and refuses a
redirect to another origin as soon as an API key is configured, so the key
can never leak and the allow list cannot be bypassed with a redirect.

**7.7 The containment check is a path check, not a text check.** The static
file handler resolves the request against the client directory and compares
the result with `path.relative`. A traversal, an absolute path, a null byte
and a sibling directory with the same prefix are all refused. The check was
not "block `..`": the encoded slash (`%2f`) reaches the file resolution
through the URL parser, so the text of the path says nothing about where the
file ends up.

**7.8 The disconnect of a client is detected on the response.** The `close`
event of the *request* fires when the request body was received, not when
the client goes away; the `close` event of the *response* fires when the
connection is gone. A response that was written completely is not a
disconnect. The upstream request is aborted, the reader of the upstream body
is closed and the stream has a timeout.

**7.9 The download is only accepted when it is the file.** An HTML answer is
refused, the announced `Content-Length` is compared with the number of
bytes that arrived, and the archives are extracted with a validated member
list: no absolute path, no `..`, no link that points outside of the target
directory, no device file. No checksum is invented: the release assets of
`llama.cpp` do not ship one that could be verified here, so the integrity
that *is* checked is the one that can be checked (the size, the tar
structure, the magic bytes of the model file).

### 8. Validation (2026-10-19)

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | exit 0, `found 0 vulnerabilities` |
| Types | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Tests | `npm test` | exit 0, 143 tests in 15 files |
| Build | `npm run build` | exit 0 |
| Built application | `npm run check:integration` | exit 0, 14/14 checks |
| Notebook | `python3 -m unittest discover -s notebooks -p "test_*.py"` | exit 0, 39 tests |
| Whitespace | `git diff --check` | exit 0 |

The six security tests of `server/app.security.test.ts` and the cancellation
test of `server/app.streaming.test.ts` were run against the **old**
implementation as well: they fail there and pass with the fix. The other
new tests are new behaviour and have no predecessor.

### 9. What a maintainer has to run on Kaggle

The parts that cannot be verified in the sandbox, with the exact steps:

1. **GPU detection** – run the cell with *GPU T4 x2* and check the log
   `Detected 2 GPU(s)`. With one GPU the cell has to abort with the
   actionable message.
2. **Binary and model** – the log has to show `llama.cpp is ready: …` and
   `The model is ready: … (12.12 GB)`. The second run has to show
   `Reusing the model: …`.
3. **Start-up** – the summary has to show the context size that was applied
   and `MTP decoding: enabled (--spec-type draft-mtp, --spec-draft-n-max 2)`
   on a build that supports the flags, `MTP decoding: disabled` and
   `Not supported: mtp` on a build that does not.
4. **Real inference** – `Local inference: verified with a real chat
   completion` and an answer in the log of the smoke test.
5. **Public inference** – `Public route: The public endpoint answered an
   authenticated chat completion.` and `Public streaming: not supported`.
6. **Rerun** – run the cell a second time in the same session: the summary
   has to show `Local server: reused from a previous run` and the *same*
   key. Change `ctx_size` and run it again: the summary has to show
   `Local server: started in this run` and `The API key was rotated …`.
7. **Failure and cleanup** – occupy the port with another process and run
   the cell: it has to report the conflict and stop, without killing the
   foreign process.

### 10. Remaining limits

* The allow list of the upstream works on the host name, not on the address
  it resolves to. A host that resolves to a private address is not detected
  (DNS rebinding). This is a documented trade-off of a tool that has to
  reach a `llama-server` on the loopback interface.
* Any program on the machine can talk to the backend. The origin check stops
  a page of another site, not a local program. The backend has to stay on the
  loopback interface.
* The MTP flags are reported as *applied*, not as *measured*. The effect of
  the speculative decoding on the answer is not measured by the smoke test.
* The component tests run in jsdom. They are not a browser test; the real
  rendering, the copy button, the keyboard navigation and the small screen
  layout are still unverified in a real browser.


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


---

## 2026-10-19 – Release preparation for `v0.1.0-dev1`

### What this entry covers

The preparation of the first prerelease on the branch
`arena/b94557e7-kaggle-kit` (pull request #1). The merge, the tag and the
published release are recorded in a later entry, because the outcome was not
known when this entry was written.

### The release is built by a workflow, not by hand

`.github/workflows/release.yml` is the only supported way to publish a
release. It is triggered by a push of a version tag and

1. checks out the tagged commit and refuses a tag whose commit is not the
   commit of the checkout,
2. refuses a tag whose version differs from the version of `package.json`,
3. runs the checks of the project and records every command, its exit code
   and its output in `checks.json`,
4. builds the application and drives the built bundle against the mock
   upstream,
5. stages the assets in `release/`:
   * `v<version>-notebook.ipynb` – the deployment script of the tagged commit
     as a notebook that Kaggle can open, generated by
     `tools/build_notebook.py`. The generator refuses a source that contains
     a literal key.
   * `v<version>-app.zip` – the built client, the bundled backend, the
     package file, the licence and the instructions to run it.
   * `v<version>-source.zip` – `git archive` of the tagged commit.
   * `verification-report.json` – the commands that were executed, their
     result, the commit and the environments that were tested and the ones
     that were not (`docs/release/environment.json`).
   * `manifest.json` – every asset with its size, its SHA-256, the build
     commands and the platform requirements.
   * `SHA256SUMS` – the checksums of every asset of the release except the
     file itself.
6. validates the staged assets with `tools/validate_release.py` and refuses
   the release when an asset is missing, empty, unexpected, corrupt, when the
   manifest or the checksum file does not match, when the notebook does not
   match the deployment script of the commit, when an archive contains a key
   file or something that looks like a secret, or when the release notes are
   missing,
7. creates the prerelease for the tag (or uses the existing one, but never
   changes a stable release into a prerelease and never replaces an asset
   that is already published),
8. downloads the published assets again and compares every one of them with
   the artifact that was built. The workflow fails when they differ.

The permissions of the workflow are `contents: write`, nothing else. The
token stays in the platform, no key and no tunnel URL is written into the
source or into an archive.

### A redirect of the upstream was still followed in the stream

The review of the diff for the release found that the *streaming* request of
the proxy used a plain `fetch` without `redirect: 'manual'`, while the other
requests of the server already refused a redirect. A malicious or a broken
upstream could answer the streaming request with a redirect and the proxy
would have sent the prompt - and the authorization header - to the target of
the redirect. The request now uses `redirect: 'manual'` and a redirect is
answered with `502` and an explanation instead of being followed. The
regression test in `server/app.streaming.test.ts` starts a second server as
the target of the redirect and proves that it is not reached; the test fails
against the old implementation.

### The trust boundary of the proxy (unchanged, documented)

The backend binds to the loopback interface by default. The check of the
origin of a request is protection against cross site requests, it is *not* an
authentication: every program on the machine can use the proxy. The upstream
is not restricted by default, the allow list `KAGGLE_KIT_ALLOWED_HOSTS` has
to be set explicitly, and a name that is allowed can be changed by DNS after
the check, so the allow list does not protect against DNS rebinding. These
limits are stated in the release notes and in `docs/security.md`; they were
not changed by this release, because a restriction that breaks a legitimate
arbitrary endpoint is worse than a documented limit.

### Validation (executed on the branch, before the merge)

* `npm run typecheck` – passed.
* `npm run lint` – passed, no findings.
* `npm test` – **155 tests in 16 files**, all passed (154 before the redirect
  fix, 143 before the merge with the research branch).
* `npm run build` – passed.
* `npm run check:integration` – **14 of 14**, the built bundle against the
  mock upstream.
* `python3 -m unittest discover -s notebooks -p "test_*.py"` – **39 tests**,
  all passed.
* `python3 -m unittest discover -s tools -p "test_*.py"` – **13 tests**, all
  passed; they prove that the validator refuses a release that is incomplete,
  corrupt, inconsistent or that carries a secret.
* `tools/release-dry-run.sh` – the steps of the workflow that do not need
  GitHub, the staged release was valid.

### Not verified

The behaviour of the release on a real Kaggle GPU runtime, with a real model,
a real Cloudflare Quick Tunnel and a real browser is **not** verified. The
automated checks run against stubs, a mock upstream and jsdom. The release
notes of the version state this for every point that is not covered.

---

## 2026-10-19 – The release `v0.1.0-dev1` (published)

### The merge

* Pull request #1 – "the Kaggle deployment and the chat interface" – was
  merged into `main` with a merge commit on 2026-10-19 at 05:09 UTC.
  * Merge commit: `4f5446d2f6c69826f2bb51a7706cf4d62c9b41c7`
  * The checks of the head commit `b722bb1` were green: the job
    `typecheck, lint, test and build` and the job `notebook tests` both
    succeeded, the combined status was `success`. The check of the third
    party bot `Kilo Code Review` ended in `action_required` because the bot
    has no credits left; it is not a check of the repository and it was not
    treated as one.
* Pull request #3 – "fix the release automation before the prerelease is
  published" – was merged into `main` with a merge commit on 2026-10-19 at
  05:17 UTC.
  * Merge commit: `04c88d2c6d7e7bbbd5c8ac4409cbb1c5941efe55`

### Why the tag was moved once

The tag `v0.1.0-dev1` was created on the merge commit of pull request #1
(`4f5446d`, tag object `892f860`). The first run of the release workflow
([run 39203053154](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39203053154))
stopped in the step that stages the assets: the rule `release/` of the
`.gitignore` matched `docs/release/` as well, so the file with the tested and
the untested environments had never been committed and the report of the
release could not be built.

The workflow failed **before** it created a release: `GET /releases` returned
an empty list, no asset existed and no upload had happened. Because the tag
has to point at a commit that contains a working release automation, the tag
was moved to the merge commit of pull request #3 (`04c88d2`, tag object
`57b21a9`). The old target is written into the message of the new tag
object, so the correction is traceable. The tag was not moved a second time.

The second problem of the same step - the release notes were read after the
change into the directory of the assets - was found while the failure was
reproduced locally, and was fixed before the second run.

### The published release

* Release: `v0.1.0-dev1`, a **prerelease** (not a draft), published at
  2026-10-19T05:18:18Z.
  <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev1>
* Tag: `refs/tags/v0.1.0-dev1` -> tag object `57b21a9` -> commit
  `04c88d2c6d7e7bbbd5c8ac4409cbb1c5941efe55`. The commit of the tag is the
  commit the assets were built from.
* The run of the workflow that published it:
  [run 39203797957](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39203797957),
  every step succeeded, including "Publish the GitHub prerelease" and
  "Verify the published release".
* The body of the release is the file `docs/release-notes/0.1.0-dev1.md` with
  the placeholder `{{SOURCE_SHA}}` replaced by the commit of the release.

### The assets of the release

| Asset | Size | SHA-256 |
| --- | --- | --- |
| `v0.1.0-dev1-notebook.ipynb` | 83 561 | `c4eda3c6bc5cc557c6a5108b77f44efc1e171bf1b8f5b338a1f4f146c9f1b9d8` |
| `v0.1.0-dev1-app.zip` | 867 555 | `081541c3f950c3d035f8d33648e3dddaa12e21765cf1d13043078affb7578d11` |
| `v0.1.0-dev1-source.zip` | 538 355 | `d3db58e0fa124924053f6c3fcba2089418f9b9336548e1efa56f216f289318ba` |
| `manifest.json` | 1 901 | `309830d059710fa0b0386780ed9fb2e458bd31dcea515f75bfc77891dab5f707` |
| `SHA256SUMS` | 439 | `e5b8fc6a9b7c399d77efafde648ca91ddaf037f93b129cade1a046a7afc3debb` |
| `verification-report.json` | 7 799 | `286533613d36aac06775c08b7dd8558c00475417b646be9759193351d77c499f` |

The checksums are the digests that GitHub computed for the uploaded files
(`GET /releases/416925851/assets`). The last step of the workflow downloaded
every published asset again and compared it with the artifact that was
built, so the published files are the files of the tagged commit.

**The assets could not be downloaded from this sandbox**: the host
`release-assets.githubusercontent.com`, which serves the release files, is not
reachable from the environment of this work. The comparison of the published
files with the built files therefore comes from the run of the workflow and
not from a download here. The digests above are the ones of the server.

### The checks of the release

They ran in the workflow of the release on Linux x64 with Node.js 22 and
Python 3.11, against the commit of the tag:

* `npm run typecheck` - passed.
* `npm run lint` - passed, no findings.
* `npm test` - **155 tests in 16 files**, all passed.
* `npm run build` - passed.
* `npm run check:integration` - **14 of 14**, the built bundle against the
  mock upstream.
* `python3 -m unittest discover -s notebooks -p "test_*.py"` - **39 tests**,
  all passed.
* `python3 -m unittest discover -s tools -p "test_*.py"` - **15 tests**, all
  passed.
* The validator of the release accepted the staged assets and the published
  assets.

### What is still not verified

The same as in the release notes: the behaviour on a real Kaggle GPU runtime,
with the real download of the model, with a real llama.cpp inference, with a
real Cloudflare Quick Tunnel and in a real browser. The checks above run
against stubs, a mock upstream and jsdom. The measured effect of the multi
token prediction option is not known either.

---

## 2026-10-19 – v0.1.0-dev2: the chat workspace

### Scope

`dev2` is a focused evolution of `dev1`, not a rewrite. The deployment
notebook, the request contract, the storage keys and the proxy security
defaults are unchanged. The work was (1) to make the client a chat workspace
that can compete with the mainstream tools, (2) to audit the whole repository
for demonstrable defects and fix them without widening the scope and (3) to
ship the result through the existing release automation.

### Decision 1 – the sidebar owns the history, not a modal

The audit of `dev1` showed that the settings dialog was the only way to switch
a profile while the conversation list was a narrow column with no structure.
The new layout gives the sidebar the history (grouped by date, searchable,
inline rename, two-step delete) and the active connection, so the most common
navigation actions no longer open a dialog. The dialog stays for configuration
only. This follows the pattern of mature chat clients without copying any of
their assets or their visual identity.

### Decision 2 – a conversation does not exist before its first message

On the landing view the composer owns the draft and the provider creates the
conversation on send. The first message is queued in a ref (`queuedMessage`,
`queuedFor`) and sent once the conversation appears in state. Creating an
empty conversation on mount, the obvious alternative, leaves empty rows in the
history when the user only looks around.

### Decision 3 – drafts are per conversation and persisted

`useDraft` keeps a text per conversation id in
`localStorage` (`kaggle-kit.drafts.v1`), throttled, bounded to 50 drafts of
20 000 characters. The composer is controlled by the caller. The text is
removed on send and when a conversation is deleted. A reload restores the text
of the conversation the user returns to, which was not possible with the
single `useState` of `dev1`.

### Decision 4 – truthful state beats optimistic state

A stream without a finish reason, an error event in the middle of a stream and
a connection that breaks mid-answer all end the message as *failed*, while the
text that arrived is kept. `finish_reason: "length"` and `"content_filter"`
are surfaced. Token counts only appear when the server sent a `usage` object.
The streaming fallback (proxy answers `409` because the transport was not
verified in this session) only retries when no token arrived, so an answer can
never be duplicated. These rules are encoded in `gateway.test.ts` and the
stream tests of the backend, not in UI copy alone.

### Decision 5 – the capability cache belongs to endpoint *and* credential

`dev1` cached `streamingVerified`, `reasoningEffortSupported` and the `/props`
result under the base URL alone. Replacing the key of a profile, or adding a
second profile on the same host with a different key, could therefore inherit a
verification made with another credential. The cache key is now the SHA-256 of
the key plus the normalized base URL (the key itself is never stored), the
entry is bounded to 32 entries and the tests in `server/proxy.test.ts` prove
that a second key gets its own detection. The probe TTL stays at ten minutes.

### Decision 6 – rendering cost follows the reader

Code blocks are highlighted when a message is complete, not on every streamed
delta; the value of a per-token highlight is negative once the block is large.
Deltas are collected for 40 ms before a dispatch. The transcript follows new
tokens only while the reader is at the bottom and offers *Jump to latest*
otherwise. The message log is not a live region (it would read every token);
a visually hidden `role="status"` announces the state transitions instead.

### Decision 7 – no new dependency and no second source of truth

The new components reuse the existing design tokens, the existing
`react-markdown` and `highlight.js` and the existing `ui.tsx`. The export, the
clipboard wrapper, the focus trap and the media query hook are small local
modules. There is one request builder, one gateway and one configuration
store, as before. The settings drawer reads and writes through the provider;
the profile editor is the only writer of credentials.

### What the audit changed outside the client

* `/api/health` no longer returns the configured allow list. It returns
  `{ok, name}`; the status pill needs nothing more.
* Test/Discover no longer write a typed key to the server secret store before
  Save. The proxy receives the typed key for that request and stores nothing
  unless the profile is saved with the server credential mode.
* Editing a profile no longer changes the active profile; only creating one
  does. This was a silent data-flow bug, not a preference.
* The keyboard shortcut for a new conversation moved from Ctrl+Shift+O to
  Alt+Shift+N because Chromium reserves Ctrl+Shift+O for the bookmark manager.
  The preference tab and the sidebar hint show the new combination.
* The status pill collapses to its dot below 560 px, and its name and model
  strings can shrink (`min-width: 0`), so the title keeps its space at 360 px.
* `--focus-ring` was defined but never used; the rule was removed instead of
  inventing a second focus style. The outline-based focus indicator stays.

### Validation of the release

* `npm run typecheck`, `npm run lint`: clean.
* `npm test`: 24 files, 202 tests, all passed.
* `npm run build`: client and `dist/server/index.js` (56.4 kb) built.
* `npm run check:integration`: 14 of 14 against the mock upstream.
* Notebook tests: 39 (7 skipped). Release tools: 15.
* `tools/release-dry-run.sh 0.1.0-dev2`: the staged release validates, the
  notebook is one code cell, the app bundle contains the four expected files
  and the source archive is prefixed with `kaggle-kit-0.1.0-dev2/`.

### Open items and limits

* The UI was validated in jsdom and by unit/component tests only. No Chromium
  or Firefox binary and no Playwright download were available in the build
  environment (missing `libnss3`, no package index, CDN unreachable), so the
  visual result, the real scroll behaviour and the rendering of the new layout
  in a browser are **not** verified here. This is stated in the release notes.
* The Kaggle GPU, the real model, a real inference and a real Quick Tunnel are
  not exercised by the automated checks.
* DNS rebinding and the unencrypted secret file remain documented limits, not
  new bugs.

---

## 2026-10-19 – the published v0.1.0-dev2

### The release

* Release: `v0.1.0-dev2`, a **prerelease** (not a draft), published at
  2026-10-19T10:05:47Z.
  <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev2>
* Pull request: [#5](https://github.com/coderunknow/Kaggle-Kit/pull/5),
  merged with `--merge` at 2026-10-19T10:04:48Z into the merge commit
  `475ba25e08cf5e4b2ac2d463ff725df1022d76a2`. No branch rewrite, no
  force-push, no manual asset upload.
* Tag: `refs/tags/v0.1.0-dev2` -> tag object `68b315f5ca28c742a12fa1fbefbfa99ecce68023`
  -> commit `475ba25e08cf5e4b2ac2d463ff725df1022d76a2`. The tag points at the
  exact merged commit.
* `v0.1.0-dev1` keeps its release (`416925851`), its assets and its tag
  (`57b21a9` -> `04c88d2`); nothing was moved or edited.
* The body of the release is `docs/release-notes/0.1.0-dev2.md` with
  `{{SOURCE_SHA}}` replaced by `475ba25e08cf5e4b2ac2d463ff725df1022d76a2`.

### The assets of the release

| Asset | Size | SHA-256 (digest of the uploaded file) |
| --- | --- | --- |
| `v0.1.0-dev2-notebook.ipynb` | 83 561 | `e130a4be5558aee3232649f5cf51266314f572508148df823e32d0c8f794da2d` |
| `v0.1.0-dev2-app.zip` | 914 010 | `9c11df5178eaf35958bcc007e09fe3c46af5ab1e3614dfa27bede5956266773d` |
| `v0.1.0-dev2-source.zip` | 594 182 | `7e32a6e5b68f3ca9f75b5bb524cffcac772b1ca6ec58310b17c315c141bf3d36` |
| `manifest.json` | 1 901 | `c7e78e3d92967c2e3afa89f882f40023bd301d28ef18e8d2c68149d006b58b9a` |
| `SHA256SUMS` | 439 | `ab20d0935a4be76fe99d7687d9dcd3c309db93cb9afc3ae907da09541c6f4ab5` |
| `verification-report.json` | 7 684 | `a6215c1b2f359b32cda21a767319e365ecfae2dd7b32583e06588388cd3dec30` |

The digests are the ones GitHub reports for the uploaded assets. The last
step of the workflow ("Verify the published release") downloaded every
published asset and compared it with the staged artifact of the tagged
commit; it succeeded.

**The assets could not be downloaded from this sandbox.** The host
`release-assets.githubusercontent.com` is not reachable from this
environment, and neither is the host that serves the logs of a workflow run.
The comparison therefore comes from the successful verification step of the
workflow, not from a download here.

### The checks of the release

Run of the release workflow:
<https://github.com/coderunknow/Kaggle-Kit/actions/runs/39234842770> - every
step succeeded, including "Publish the GitHub prerelease" and "Verify the
published release".

* `npm run typecheck` - passed.
* `npm run lint` - passed.
* `npm test` - **202 tests in 24 files**, all passed.
* `npm run build` - passed.
* `npm run check:integration` - **14 of 14**.
* `python3 -m unittest discover -s notebooks -p "test_*.py"` - **39 tests**
  (7 skipped).
* `python3 -m unittest discover -s tools -p "test_*.py"` - **15 tests**.
* The validator accepted the staged and the published release.

The continuous integration of the merge commit
([run 39234827441](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39234827441))
is green. The external "Kilo Code Review" check reports `action_required`
with the message "Review could not start because the account has insufficient
credits." - it is not a code finding and not a required check; the merge was
not blocked.

### What is still not verified

The behaviour on a real Kaggle GPU, with the real model download, a real
llama.cpp inference, a real Cloudflare Quick Tunnel and in a real browser.
The checks run against stubs, a mock upstream and jsdom.

---

## 2026-10-19 – v0.1.0-dev3: one connection, evidence-based diagnosis

**The defect that shaped this release.** The chat sent `profile.baseUrl`,
while the connection test and the settings cards used the normalized URL
(`shared/api/url.ts` adds `/v1`). A profile saved as `https://host` tested
`https://host/v1` but chatted with `https://host`. The badge was read by
profile id alone, so a result could outlive the URL, model or key it described.
The release fixes the data flow, not the wording: one module
(`shared/connection.ts`) resolves the credential, the effective URL and the
fingerprint, and every consumer uses it.

**Decisions.**

* `effectiveProfileTarget()` is the only normalization path on the client. A
  pasted `/v1/v1` is collapsed; a legitimate path prefix is kept; an invalid
  value returns the typed text plus an error instead of silently changing it.
* `profileConfigFingerprint()` covers the effective URL, the model, the
  timeout and the credential mode; `profileFingerprint()` adds the credential
  identity. No key value is stored in a fingerprint.
* The reducer drops a stored test and its capabilities when the connection
  identity changes and drops the discovered models when the endpoint changes.
  Writing a **new** key does the same; writing the same key again does not.
* The test result may only be attached to the saved profile when the saved
  configuration and the credential that was tested match. A test with a typed
  key stores the key in component memory for the comparison and is otherwise
  editor-local.
* The connection test is a six-stage sequence. `ok` requires a non-empty
  inference answer; transport, auth and the model list can be `ok` while the
  test is `failed`. Streaming is never implied: it is `ok` only when the SSE
  probe cached a verified stream for the same base URL and credential.
* Errors are classified once (`shared/api/errors.ts`) and rendered with the
  same labels in Settings and the chat. The streaming proxy error body is
  redacted before it reaches the browser.
* The Windows launcher is split into a thin PowerShell wrapper (Node/npm and
  version checks, project files) and a dependency-free Node launcher (install,
  build, port, readiness, browser, shutdown). Only the wrapper is
  Windows-specific; the logic is testable on Linux. An application bundle
  starts without `node_modules` because it already contains the build.
* The real-endpoint checker reads the key with `Read-Host -AsSecureString`,
  zeroes the unmanaged copy and prints a masked, sanitized report.

**Publication.**

* PR [#7](https://github.com/coderunknow/Kaggle-Kit/pull/7), merged with
  `--merge`; merge commit `ea4aa427367fa441b87d39c7d256ec0147b21c84`.
* Tag `v0.1.0-dev3` (lightweight) points at that commit.
* Release: <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev3>
  (prerelease, not draft), created 2026-10-19T14:00:17Z.
* Release workflow
  [run 39265201384](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39265201384)
  succeeded; the main CI of the merge commit
  ([run 39265050445](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39265050445))
  is green.

**Assets (size and the digest GitHub reports).**

| Asset | Size | SHA-256 |
| --- | --- | --- |
| `v0.1.0-dev3-notebook.ipynb` | 83 561 | `55fed23e7c7b94b9306aece254d710640727de6c5949eb68e9f9073cff63a387` |
| `v0.1.0-dev3-app.zip` | 935 204 | `60ae9478c3b43dd87471c90bbb70f5fe5e79cc072a89f239aad529e986323fe3` |
| `v0.1.0-dev3-source.zip` | 626 339 | `659eb5e6cb618881830d69c31de6384070eeb055144616198c387f32303831e7` |
| `manifest.json` | 1 901 | `ce0187e16912f13394a0d09fe75d28dda49ee5ce4780bf454dcf374c4ce4bb64` |
| `SHA256SUMS` | 439 | `4c54cb943d6ccd5a069f2e91956ab99d2f80e15d97134bd49976639dbd218cb4` |
| `verification-report.json` | 8 038 | `3264531d093924fdc648989c8d5443d6c38cac0af896fd87d89ea7c39cb64c9e` |

The workflow's "Verify the published release" step downloaded every asset
and validated the manifest and checksums; it succeeded. The sandbox cannot
download from `release-assets.githubusercontent.com` (EOF), so the digests
above come from the GitHub API rather than a local download.

**What this release does not prove.** No real Kaggle endpoint request was
made here: outbound TLS is blocked and the user deferred the local PowerShell
check, so `/v1/models`, real inference and streaming against the live endpoint
are **not run**, not passed. The PowerShell wrapper was not executed on a real
Windows machine; the Node launcher was executed on Linux (readiness, port
conflict, forced conflict, clean shutdown). Real GPU inference and a real
browser remain outside this environment.

## 2026-10-20 – v0.1.0-dev4: policy-enforced tool use, not prompt promises

### Decisions

* Keep ordinary chat as the fallback. Tool definitions are sent only when a
  harmless, model/endpoint/credential-specific native probe succeeds; no model
  family, compatible URL, normal inference or `--jinja` flag is treated as
  evidence. The probe validates call correlation, accepted synthetic tool
  result and exact final sentinel without running any function.
* Use the existing API gateway, proxy, reducer, settings/profile model,
  conversation persistence and release workflow. Tool execution and authority
  stay in the local server; the browser only requests, displays and approves
  bounded operations. The server rejects unknown catalog names and validates
  bounded JSON/schema input before dispatch.
* Keep seven separate categories and explicit permissions. Read-only tools may
  run automatically; non-GET HTTP, `write`/`unknown` MCP and every code run
  pause for an exact single-use approval. Exact denials are not retried in the
  same turn. Execution budgets are enforced server-side, not by model prose.
* Keep uploaded files in a size/character-bounded, in-memory conversation vault;
  expose no host filesystem and remove vaults on delete/clear/expiry. Code
  execution is Docker-only, disabled until configured with a digest-pinned
  Python image, requires approval every run and has no host fallback. Docker
  absence means fail closed, not a claim that sandboxing was tested.
* Keep SecretStore v2 as `{ version: 2, secrets, toolProfiles }`. Tool profiles
  carry secret references, never direct credential values; the store migrates
  valid v1 data, checks both records as plain objects and retains secure file
  permissions. `clear()` intentionally erases secret values but preserves
  non-secret tool settings/references; browser-local erasure is documented as
  distinct from proxy-side erasure.
* Treat MCP discovery as server-owned data. A target change clears stale tools;
  profile writes cannot forge names, descriptions or schemas; a grant requires
  selected discovered tools. Adding a selected tool or changing its schema,
  permission, endpoint, headers or timeout requires rediscovery/reapproval.
* Brave-derived assistant content remains session-only unless both retention
  rights are confirmed and tool-history persistence is opted in. The same
  policy is applied to later assistant replies, browser history and Markdown
  export; rights and pricing remain operator/provider-specific.
* Cancellation distinguishes a job cancelled while waiting for approval (no
  operation ran) from one cancelled after approval/running (the operation may
  have started or completed). This avoids a false safety claim in the timeline.

### Validation and limits

* `npm run check`: typecheck/lint passed; Vitest **42 files, 332 tests passed**.
* Notebook Python tests: **39 passed, 7 skipped**; release-tool tests: **18
  passed**.
* Production build passed. Mock integration passed **19/19**. `git diff --check`
  passed. Non-failing warnings: Vite's >500 kB chunk advisory and PDF.js's
  missing optional canvas/font-data fallback in text-PDF tests.
* The release dry-run is pending the committed candidate. No GitHub workflow,
  release tag or publication is claimed. The Kaggle runtime, deployed model's
  native tool round trip, Docker isolation, provider rights, live MCP/HTTP and
  real-browser accessibility remain unverified. The model proxy's existing
  hostname check is not DNS pinning; documented allowlisting remains advised.

## 2026-10-20 – Review hardening before release dry-run

The final review added two fail-closed cases: parsed non-finite numeric
arguments are rejected, and configured HTTP tool arguments containing
credential-like field names cannot be sent in URLs or request bodies. Public
web requests reject credential-like query names; matching results are not
emitted as citations. This favors explicit server-side SecretStore header
references over model-supplied credential fields.

Validation on this working tree:

* Focused security suite: **6 files, 47 tests passed**.
* `npm run check`: typecheck/ESLint passed; Vitest **42 files, 344 tests
  passed**.
* Notebook suite: **39 passed, 7 skipped**; release-tool suite: **18 passed**.
* Release/environment JSON parsed successfully; `git diff --check` passed.
* Build, integration, and the archive/checksum release dry-run are pending
  execution against the committed candidate. No live model, Docker isolation,
  provider retention rights, or external endpoint was verified.

The local release pipeline passed on commit
`80b9a9203b890707d0866e3a6c9044fad7d87e89`:
`tools/release-dry-run.sh 0.1.0-dev4 v0.1.0-dev4` completed with exit 0.
All configured checks passed, the production bundle and 19-check mock
integration suite passed, and generated app/notebook/source archives, manifest,
checksums and the verification report passed both staged and simulated
post-download validation. This is local evidence only; no GitHub workflow,
tag or publication was executed. The report retains the unverified live model,
Kaggle, Docker, provider, external endpoint and real-browser limits.

## 2026-10-20 – v0.1.0-dev4 audit completion: streaming probe, tool prompt, E2E tool loop

### Original intent and audit result

The dev4 implementation from the earlier entry was re-audited requirement by
requirement on branch `arena/bef31f06-kaggle-kit` (base commit `0fce9de`,
which was already open as PR #9 with green CI). The audit confirmed the
server-governed tool loop, seven tool categories, SecretStore v2, approvals,
persistence rules and timeline were implemented and tested. Five gaps were
found and fixed in commit `63c8c31`:

1. **Prompt truthfulness.** The recommended Qwen prompt still said "You have
   no tools here", contradicting a verified tool profile. The base prompt is
   unchanged (it stays truthful for ordinary chat and keeps its research
   mirror). A derived tool-use variant (`qwen-selfhosted-tools-v1`) replaces
   that exact sentence and appends tool rules (schema arguments, untrusted
   output, real-source citations, approvals, bounded loops, honest final
   answers). The profile editor offers both; the server tool loop also
   neutralizes the known sentence so a tool list is never sent with it.
2. **Streamed tool calls.** Previously streaming tool deltas were only
   documented as unverified, with no fragment handling at all.
   `shared/api/stream.ts` now extracts `delta.tool_calls` fragments and
   assembles them per index (`ToolCallAccumulator`): partial argument JSON
   is concatenated, never parsed or executed, bounds are enforced, and a
   call is only "announced" with `finish_reason=tool_calls`. The capability
   probe runs a third, streamed stage with the same harmless no-op function
   and reports `streamingSupported` independently; a streaming failure never
   downgrades proven non-streaming support. Tool rounds stay non-streaming
   by design so approvals can pause between rounds.
3. **Settings completeness.** The bounded-execution card lacked the maximum
   tool input size, and the sandbox card had no resource controls. Both are
   now editable within the same bounds the server enforces (sandbox:
   timeout 1–60 s, memory 64–2048 MiB, CPU 0.1–2 cores, processes 1–128,
   output 256–32768 bytes). Isolation remains fixed to strict because that
   is what the Docker backend enforces; weaker modes are not offered.
4. **Integration depth.** The built-bundle check never exercised the tool
   loop. The mock upstream now speaks deterministic native tool calls
   (probe function, `calculate:`, `run code:`, streamed fragments), and
   `tools/integration-check.mjs` drives profile storage, the unverified
   409 refusal, the probe (both stages), an automatic calculator round
   trip, a denied code approval and approval-replay refusal (28 checks).
5. **Troubleshooting documentation.** `docs/troubleshooting.md` had no tool
   coverage; a Tools section now documents probe states, approvals, limits,
   Brave, Docker, MCP re-grants, HTTP policy refusals, uploads and
   persistence.

### Alternatives considered

* Executing tool rounds over streaming once `streamingSupported` is true:
  rejected for this release. The approval pause points make streamed rounds
  substantially more complex, and no live endpoint was available to verify
  real streamed tool behaviour. The protocol layer and probe now verify the
  capability honestly without claiming the loop uses it.
* Rewriting the base Qwen prompt to be tool-aware: rejected. It would make
  the default prompt false for the majority (ordinary chat) case and break
  the character-for-character research mirror. Derivation keeps one source.
* A regex/prose fallback protocol for endpoints without native tool calls:
  still rejected, unchanged from the earlier entry. No fallback can be made
  deterministic enough to execute safely.

### Validation on commit `63c8c31`

* `npm run typecheck` and `npm run lint`: passed.
* `npm test`: Vitest **42 files, 356 tests passed** (12 new: fragment
  assembly, streaming probe success/failure, prompt variant, no-tools
  neutralization in the tool loop).
* Notebook tests: **39 passed, 7 skipped**; release-tool tests: **18
  passed**.
* `npm run build`: passed (existing >500 kB chunk advisory only).
* `npm run check:integration`: **28/28 passed** against the built bundle.
* `git diff --check`: passed.
* `tools/release-dry-run.sh 0.1.0-dev4 v0.1.0-dev4`: exit 0; archives,
  manifest, checksums and verification report validated, including the
  simulated downloaded-asset check.

### Unresolved / unverified

Unchanged and explicitly recorded in the release notes: no live Kaggle
endpoint, model weights, tunnel, Docker runtime, Brave account, live MCP or
HTTP service, or real-browser audit was available. Mock-based verification
proves the local protocol, policy and orchestration; it does not prove the
deployed model's tool behaviour. Capability therefore remains
`not_verified` until the operator's probe succeeds on the live profile.

## 2026-10-20 – v0.1.0-dev4 published

* Final implementation/log commit `0d3a7424730b7454abfc234bd9bb192627da5795`
  passed a second full `tools/release-dry-run.sh 0.1.0-dev4 v0.1.0-dev4`
  (exit 0; 28/28 integration checks; staged and simulated-download
  validation valid) before being tagged.
* PR [#10](https://github.com/coderunknow/Kaggle-Kit/pull/10) against `main`
  is open and unmerged (mergeable; CI green). PR #9 was closed as superseded
  because it contained only the pre-audit commit, which is an ancestor of
  the #10 branch.
* Tag `v0.1.0-dev4` (lightweight) points at `0d3a742`. Release workflow
  [run 39414208382](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39414208382)
  succeeded, including "Verify the published release" (download +
  checksum/manifest validation of every asset).
* Prerelease (published 2026-10-20T11:21:27Z):
  <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev4> with
  six assets — `v0.1.0-dev4-notebook.ipynb` (83 561 B),
  `v0.1.0-dev4-app.zip` (1 925 281 B), `v0.1.0-dev4-source.zip`
  (767 600 B), `manifest.json`, `SHA256SUMS`, `verification-report.json`.
  Sizes for the notebook and app bundle match the local dry-run staging.
  The sandbox cannot download from `release-assets.githubusercontent.com`
  (EOF), so asset digests were verified by the workflow step, not locally.
* Publication does not change the unverified list: no live Kaggle endpoint,
  model weights, Docker isolation, Brave account, external MCP/HTTP service
  or real-browser test has run. Tool capability on any real endpoint stays
  `not_verified` until the operator runs the probe.

## 2026-10-20 – Full audit remediation and v0.1.0-dev5 preparation

A whole-repository audit of v0.1.0-dev4 (workflows, shared protocol, backend,
tool authorization, secrets, UI/state/persistence, launchers, notebook,
release tooling, tests, docs) was executed on the PR #10 branch, and every
confirmed finding was fixed with regression tests. The published
`v0.1.0-dev4` tag/release at `0d3a742` was not moved or modified; PR #10
remains open and unmerged.

### Confirmed defects fixed (verified by tests/CI as noted)

1. **P0 – release workflow shell injection.** `release.yml` interpolated the
   untrusted tag into shell source before validation. All `${{ }}` values now
   reach shells only via `env:`; the tag is fully validated before any path,
   Git or publish use; checked-out commit, `package.json`, notes, manifest
   and checksums must agree. Actions are full-SHA pinned; permissions are
   least-privilege. `tools/test_workflow_security.py` proves hostile tags
   cannot execute shell, alter outputs or influence the release early.
2. **P1 – proxy DNS rebinding.** The model proxy validated only hostnames.
   All server-side upstream paths now use `server/pinnedFetch.ts`: the
   complete DNS answer is validated at connect time (link-local/metadata
   always refused; hostname→loopback refused; private answers refused under
   `KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1`; literal local endpoints and default
   LAN names preserved; SNI/Host unchanged). A side fix gave non-streaming
   chat the redirect destination validation it had skipped.
3. **P1 – sandbox orphan containers.** Stopping a Python run signalled only
   the Docker CLI; SIGKILL cannot be forwarded, so containers could outlive
   the run. Containers are now named and force-removed on every stop path,
   and code is fed on stdin instead of argv. A real-Docker CI job runs the
   app's execution path (success, bounded output, timeout/abort cleanup,
   fail-closed without the image) and passes.
4. **P1 – origin policy trusted any Host.** A rebinding domain presenting
   matching Host/Origin passed the CSRF check. Self-origin is auto-trusted
   only for loopback hosts; other serving origins require
   `KAGGLE_KIT_ALLOWED_ORIGINS`.
5. **P1 – approvals not bound to credential values.** Rotating a secret while
   an approval was pending would execute the approved call under the new
   credential. Approvals now carry a fingerprint of the credential values and
   are refused (409) on rotation.
6. **P2 – approval UI understandability.** Approvals showed a generic tool
   description with arguments collapsed. They now show an operation-specific
   summary (method + endpoint, code size + first line, search query, URL)
   with arguments expanded.
7. **P2 – static symlink escape.** Lexical containment only; canonical-path
   containment added with a regression test.
8. **P2 – unverified notebook binaries.** llama.cpp release tarballs are now
   verified against SHA-256 digests pinned from the GitHub API; mismatch
   aborts before extraction/execution. Key/state files are `0600` from
   creation.
9. **P2 – bundle size.** Measured entry chunk 710,229 B; after lazy
   Settings/Markdown splitting it is 307,923 B (gzip ≈ 93 kB), no chunk
   ≥ 500 kB, advisory gone.

### Reviewed and found sound (no change)

SecretStore v1→v2 migration/permissions/ref validation, file-vault lifetime
and conversation scoping, browser storage sanitization and export shape,
launcher argument handling (Windows `npm` shell use is fixed-argument),
release tooling validation suite, tool protocol state machine (probes,
correlation, budgets, replay/expiry already covered by the existing tests).

### Corrections to earlier records

The dev4 entries reporting the notebook suite as "39 passed, 7 skipped" were
inaccurate: unittest counts skipped tests inside "Ran 39", so locally without
the `requests` package only 32 tests actually ran. The 7 gated tests are the
`RangeServerTests` class (`skipUnless(REQUESTS_READY)`); with `requests`
installed they run and pass locally (43 total after the new checksum tests)
and have always run in CI. No test was unskipped or weakened.

### Residual risks (documented, not fixed here)

Hugging Face model fetch uses `resolve/main` and `cloudflared` uses the
`latest` URL (HTTPS, unpinned) — pinning either changes model/tunnel
defaults and requires live Kaggle evidence first. A LAN hostname resolving to
a private address is reachable by default (intended for local servers);
`KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS=1`/`KAGGLE_KIT_ALLOWED_HOSTS` close it.

### Verification state legend

Implemented **and runtime-verified**: workflow boundary, DNS pinning (real
loopback sockets + injected DNS), sandbox lifecycle (real Docker in CI),
origin policy, credential-bound approvals, approval summaries, symlink
refusal, notebook checksum logic (unit), code splitting (build output),
browser flows incl. approval/denial (Playwright/Chromium in CI), Windows
launcher (windows-latest in CI). **Implemented, not runtime-verified**: the
notebook checksum path on live Kaggle hardware. **Blocked / not run**: live
Kaggle endpoint and model weights, Brave account, live MCP/HTTP services —
no such credentials/endpoints exist in this environment; failure and
missing-credential paths are covered by tests.

## 2026-10-20 – v0.1.0-dev5 published

* Release commit `df699bdcdb629a3ce0cdf4f5aa3a11f5f0967536` passed the full
  required suite on the exact HEAD (typecheck, lint, Vitest 43 files/373
  tests, build, integration 28/28, notebooks 43/0-skipped, tools 25,
  `git diff --check`, `npm audit` 0 vulnerabilities) and
  `tools/release-dry-run.sh 0.1.0-dev5 v0.1.0-dev5` (valid in staged and
  simulated-download validation). All CI jobs on that commit passed,
  including the new `docker sandbox integration`, `windows launcher` and
  `Browser end-to-end` jobs (run 39421934675).
* Tag `v0.1.0-dev5` (lightweight) points at `df699bd`; release workflow
  [run 39422153705](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39422153705)
  succeeded including published-release verification. Prerelease published
  2026-10-20T12:26:56Z:
  <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev5> with
  six assets whose sizes match the local dry-run staging exactly
  (app 2 150 258 B, notebook 87 038 B, source 795 886 B).
* `v0.1.0-dev4` remains unchanged at `0d3a742` (verified via API after the
  dev5 publication); PR #10 remains open and unmerged. This entry is a
  docs-only commit after the tag; the tag was not moved.

## 2026-10-20 – Tool-calling reliability remediation and v0.1.0-dev6 preparation

A full audit of the tool-calling lifecycle was executed on the current `main`
(`ad7995b`, the merge of PR #11 on top of the merged PR #10 / published
`v0.1.0-dev5` at `df699bd`). Every finding below was revalidated against the
current files; the dev5 protections (workflow injection removal, DNS-pinned
proxy fetches, origin policy, sandbox container cleanup, credential-bound
approvals, symlink refusal, notebook checksums) were confirmed intact by
re-running their existing tests, and none was reverted.

### Audit method and evidence

* Read `AGENTS.md`, both logs, the tool protocol modules
  (`shared/tools/catalog.ts`, `shared/tools/types.ts`,
  `shared/prompts/qwen.ts`, `shared/api/requests.ts`, `shared/api/stream.ts`,
  `server/proxy.ts`, `server/tools/{chat,executor,policy}.ts`,
  `src/state/useChat.ts`, `src/lib/gateway.ts`, `src/components/ChatView.tsx`),
  the notebook start-up path and the release tooling.
* Verified the GitHub state through the API: PR #10 merged 2026-10-20T13:04Z,
  PR #11 merged 13:22Z, tags `v0.1.0-dev4`→`0d3a742`, `v0.1.0-dev5`→`df699bd`;
  the working branch is based on `ad7995b`, the actual current `main`.
* Measured the serialized tool catalog: the full nine-tool built-in catalog is
  3,728 bytes (~1,036 estimated tokens at the repo's documented 3.6 chars/token
  estimate) — acceptable for the 8192-token context — while a single configured
  HTTP/MCP schema may reach the sanitizer's 24 KB bound, i.e. the *aggregate*
  catalog could previously exceed the whole context silently.
* Verified against the published llama.cpp sources (GitHub API, tags b11717,
  b11718, b11719 — the exact pinned builds): `common/arg.cpp` defines
  `--api-key-file` and gives `--api-key` the environment alias
  `LLAMA_API_KEY`. The notebook's argv fallback was therefore both unnecessary
  and unsafe (argv is world-readable via `/proc/<pid>/cmdline`).
* Verified the cloudflared release digests through the GitHub releases API:
  tag `2026.10.2`, `cloudflared-linux-amd64` =
  `35fbdd2beb378436c7da377d7358cea8e33f9c94a6705d1d8036bf9b0d6d8005`.
* Baseline before any edit: typecheck, lint and Vitest (43 files, 373 tests)
  all green on the untouched tree.

### Confirmed defects fixed (commit ff569f6)

1. **No bounded recovery from protocol-invalid model turns.** A turn carrying
   tool-call data with a wrong `finish_reason`, or only malformed calls,
   ended the job immediately; invalid arguments were fed back but nothing
   stopped the model from repeating the identical invalid call until the
   round budget ran out. `server/tools/chat.ts` now implements a correction-
   episode policy: at most one corrective attempt per episode (evidence +
   valid tool list for protocol failures; the validation error as the tool
   result for argument failures), an identical invalid call is never re-fed
   silently, a second failure in the episode ends the loop with an honest
   "what remains undone" report, a successful execution closes the episode,
   and every corrective round counts against the round/time budgets. Recovery
   cannot bypass approvals, denials or exhausted budgets — it triggers only on
   failures where nothing executed. Results carry a secret-free `recovery`
   record; the UI shows it as a message note.
2. **No user-controllable answer for "model ignored the tools".** Opt-in
   `selectionRecovery` (conversation setting + ChatView toggle, default off)
   spends at most one extra round per job asking the model whether a listed
   tool is needed when the first round answered with plain text and nothing
   ran. The corrective text explicitly permits a direct answer: no keyword
   heuristics, no forced tool use.
3. **Unbounded aggregate tool catalog.** The 48-definition catalog had no
   serialized-size guard. `measureToolCatalog` now measures exact bytes
   (TextEncoder, browser-safe); >16,000 bytes is refused with an actionable
   409 and >6,000 bytes produces a truthful `contextNotice` (estimates
   labelled as estimates, never tokenizer counts).
4. **Notebook API key on argv.** The `--api-key <key>` fallback was replaced:
   `--api-key-file` when supported, otherwise `LLAMA_API_KEY` in the child
   environment (proven supported by the pinned builds' sources), and a build
   that supports neither is refused instead of starting unauthenticated.
   `ServerLaunch` gained an `env` map; the key never reaches argv or the
   persisted server state.
5. **Moving `cloudflared` target.** `releases/latest/download` was replaced
   with the pinned `2026.10.2` release URL and the published SHA-256 digest;
   reuse of an existing binary now also requires the pinned digest
   (`download_resumable` re-verifies), and the `--version` run check remains.
6. **No real-model evidence path.** New `tools/model-benchmark.mjs` (+ pure
   core `tools/model-benchmark-core.mjs`): model-mode cases for the handshake,
   unambiguous selection with a distractor, schema+semantic argument checks
   (deterministic no-eval expression parser), clearly-labelled synthetic
   result acceptance, a negative no-tool case and optional streamed fragment
   assembly; blocked (endpoint rejects the protocol) is distinguished from
   failed (protocol works, behaviour wrong). Integration mode drives a running
   proxy end to end (calculator loop; Python approval always denied, never
   approved) and reports skipped preconditions as skipped. Credentials only
   from env or a masked prompt; `--api-key` argv is rejected; reports carry a
   sanitized endpoint identity and pass a final secret-leak check.

### Reviewed and found sound (no change)

Capability probing and its cache invalidation (keyed by base URL + SHA-256 of
the credential + model, 10-minute TTL, explicit re-probe button, re-checked at
every tool-chat start); assistant tool-call/tool-result correlation and ID
validation; per-round call limit (8) with excess calls traced, never silently
dropped; `parallel_tool_calls=false` with deterministic sequential execution;
prompt duality (`qwen-selfhosted-v1` truthful for ordinary chat,
`qwen-selfhosted-tools-v1` and server-side neutralization of the no-tools
claim in the tool loop); untrusted-output wrapping and citation rules;
approval lifetime/binding (settings fingerprint + credential fingerprint,
single-use, TTL, denial replay refusal); job/approval pruning and file-vault
cleanup; denied-operation fingerprints.

### Residual risks (unchanged, documented)

The Hugging Face model fetch still uses `resolve/main` — no authoritative
digest was reachable from this environment, so pinning it would be a guess.
Live Kaggle hardware, Docker, Brave, MCP and real-model behaviour remain
unverified here; the benchmark is the operator's tool to close the real-model
gap without disclosing credentials.

### Verification (real output, on ff569f6 and this docs commit)

* `npm run typecheck`, `npm run lint` — passed.
* `npm test` — Vitest **44 files, 398 tests passed**.
* `npm run build` — passed. `npm run check:integration` — **29/29** (new:
  one bounded corrective round after a protocol-violating mock turn).
* `python3 -m unittest discover -s notebooks -p 'test_*.py'` — **46 passed,
  0 skipped** (`requests` installed via `--break-system-packages`).
* `python3 -m unittest discover -s tools -p 'test_*.py'` — **25 passed**.
* `npm audit --json` — 0 vulnerabilities. `git diff --check` — passed.
* Benchmark smoke run against the local mock upstream: 6/6 model-mode cases,
  clean leak check, exit 0; integration skip path: 3 skipped, exit 0. This
  validates the script, not a real model.
* `npm run test:e2e` — **blocked locally** (Playwright browser binaries
  absent and the download host unreachable from this sandbox, as in dev5);
  the CI `Browser end-to-end` job covers it on the PR branch.
* `tools/release-dry-run.sh 0.1.0-dev6 v0.1.0-dev6` — exit 0 on `ff569f6`:
  all checks, staging, "The release v0.1.0-dev6 is valid" in both staged and
  simulated-download validation; notes rendered with the commit SHA.

## 2026-10-21 — Post-dev6 hardening: the selective salvage from PR #12

PR #12 (branch `arena/10403daf-kaggle-kit`, head `e2b4b31`) was a second,
parallel implementation of the same v0.1.0-dev6 task that PR #13 delivered
and that was published as the `v0.1.0-dev6` prerelease (merge commit
`c52d262`, https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev6).
A full audit of PR #12 on 2026-10-21 concluded that it must not be merged:
it re-declares the published version with different release notes, it
collides with the shipped recovery/catalog designs (10 textual conflicts
plus silently auto-merging semantic collisions), and parts of it are
security regressions against the shipped state. The audit did find real,
verified fixes in it that `main` lacks. This entry records exactly what was
ported onto `main` (post-dev6 hardening, no version change, no release),
what was deliberately excluded, and why. Nothing below was copied wholesale;
each behaviour was re-implemented against the current `main` and re-tested.

### Ported (each verified missing in `main` before the port)

1. **Orphaned tunnel process (notebook).** `start_public_tunnel` returned
   `None` after the 90-second timeout without stopping `cloudflared`; the
   orphan could complete the handshake later and expose the server publicly
   after the run reported "no public URL". The process is now stopped before
   giving up; a stop failure is warned about and never turns the timeout
   into a success. (`stop_process` already handled terminate/kill and
   already-exited processes.)
2. **Truthful approval-failure reporting (client).** A failed approve/deny
   request was recorded with `approvalState: 'approved'` regardless of the
   action or the error. The mapping is now: aborted → `cancelled`/`stale`;
   a failed **denial** keeps `denied` (the tool never ran through this
   action); a failed **approval** is `expired` with
   `failureKind: 'approval_expired'` only on the evidence-based HTTP 410
   signal, otherwise `stale`. Free-text message matching was deliberately
   *not* ported. Pure helper `approvalFailureStates`, unit-tested.
3. **Fresh server state for `unsupported_options` (notebook).** After a
   restart, `main()` reported the *previous* run's `dropped` list from the
   stale snapshot; it now re-reads `server-state.json` at decision time and
   falls back to the snapshot only when no fresh state exists.
4. **Tool-calling probe false negatives.** Probe turns (both non-streaming
   legs and the streamed fragment probe) got `max_tokens` 64 → 192, so a
   brief reasoning header no longer truncates the probe with
   `finish_reason: "length"`; a truncation is now named explicitly in the
   failure detail. The round-trip acknowledgement accepts the token
   verbatim with word boundaries (`\bKAGGLE_KIT_TOOL_PROBE_OK\b`) while the
   structural conditions (final `stop`, no additional calls) are unchanged;
   "OKAY"-style superstrings are rejected by test. The result reports which
   legs succeeded via `protocolVerified` / `roundTripVerified`.
5. **Verified capability survives re-detection.** `detectCapabilities`
   accepts the resolved model and attaches a *still-fresh, exact-key*
   tool-probe result instead of dropping it; nothing stale is attached and
   nothing is inferred. The client reducer `capabilities/set` merges: an
   incoming payload without `toolCalling` preserves the existing one, a
   newer explicit probe result always wins.
6. **Empty Model ID resolution for tool paths.** The capability probe, the
   streaming probe and the tool chat now resolve an empty model ID to the
   first model the endpoint reports — the same contract ordinary chat
   already used. A failing discovery or an empty list produces a meaningful
   error (never a simulated success), and a discovered model still needs its
   own verified capability before any tool runs.
7. **Ordinary-chat prompt truthfulness.** `neutralizeToolClaimsForOrdinaryChat`
   restores the no-tools boundary when a profile stored the tool-use prompt
   variant but the turn grants no tools (applied in `buildUpstreamBody`, the
   ordinary-chat choke point; the tool loop builds its own body and is
   unaffected). `neutralizeNoToolsClaim` additionally removes known custom
   no-tools claim shapes on tool-enabled turns; a prompt emptied by the
   removal stays empty instead of being replaced with a fabricated claim.
8. **Contextual job cancellation.** Server: `cancelConversation` /
   `cancelProfile` (snapshot-then-cancel, counted, idempotent, never touch
   other conversations/profiles, never execute anything) wired into
   `DELETE /api/tools/files` and `DELETE /api/tools/profile`. Client:
   retry/edit/resend cancel the tool jobs of the messages they drop
   (`droppedToolJobIds` helper); deleting a profile aborts its
   conversations' in-flight requests and cancels their paused jobs.
   **Deferred:** auto-cancelling prior jobs when a *new turn* starts (PR
   #12 did this) — a behaviour change that needs its own decision.
9. **Structured validation-failure feedback inside the existing recovery.**
   `ToolExecutionError` carries `failureKind` (typed union) and, for
   argument-validation failures, a bounded `expectedSchema` signature from
   the published definition (`summarizeToolSchema`: names, JSON types and
   enum literals only, greedily bounded to ≤600 chars with a truthful
   omission marker; never descriptions, argument values or credentials).
   The invalid-call tool result now carries `failureKind`, the signature,
   the active tool list and one-correction guidance; failure traces keep the
   model-issued `callId` next to the server UUID and the `failureKind`.
   The shipped bounded-recovery state machine (one attempt per episode,
   fingerprinted repeats, budgets, denial refusal) is **unchanged**; PR
   #12's parallel `correctionUsedInEpisode` machine was not ported.
   Timeout classification is evidence-based only (typed `kind` /
   `AbortError`), never free-text. `operationSummary` now reads the real
   `file_id` argument and summarises `calculator_convert`.
10. **Optional model-weight pinning (notebook).** `model_revision` (default
    `main`) pins the exact Hugging Face revision in both download paths, and
    an operator-supplied `model_sha256` is verified fail-closed on reused
    saved files (skipped with a warning), `hf_hub_download` results and
    resumable downloads (mismatched files are deleted, never served). No
    digest is baked in — a guessed digest would be worse than none — so the
    residual risk documented for dev6 remains *mitigable*, not eliminated,
    when no digest is configured.

### Deliberately excluded from the port

* The argv API-key fallback (`allow_cli_api_key_fallback`) and PR #12's
  silent argv path: `main`'s shipped key handling (file → `LLAMA_API_KEY`
  env → refuse) is strictly stronger and stays.
* `detectMissedToolCall` keyword heuristics (file/read/summarize triggers,
  any-URL triggers) with default-on corrective `role:'user'` prompts:
  contradicts the recorded dev6 decision (selection recovery is opt-in, no
  keyword heuristics) and false-positives would pressure ordinary answers.
* Catalog design B (12,000-byte budget, 16-active-tool filter,
  `compactSchema`, omitted-tool diagnostics) as a parallel system next to
  the shipped exact-byte 16,000/6,000-byte budget with 409 refusal.
  Adopting filtering/compaction is a separate design decision.
* A second benchmark CLI (`tools/benchmark-tool-calling.mjs`): the shipped
  `tools/model-benchmark.mjs` remains the one tool; its denial-coverage
  idea can be folded into the existing harness later.
* PR #12's dev6 release notes/version/log entries: `v0.1.0-dev6` is
  published; a second record for the same version would falsify the release
  history. This branch changes no version and publishes nothing.
* The `MessageItem` diagnostics UI and turn-outcome taxonomy: coupled to
  PR #12's chat design; deferred as its own scope.
* The multi-version cloudflared fallback chain: deferred — one pinned,
  digest-verified binary keeps builds reproducible (the digests of
  2026.10.1/2026.10.0 were verified via the GitHub releases API and are
  recorded here should a fallback ever be wanted).

### Verification (real output, on this branch's implementation commit)

* `npm run typecheck`, `npm run lint` — passed (exit 0).
* `npm test` — Vitest **44 files, 417 tests passed** (was 44/398 on dev6;
  +19 new tests across proxy, chat, catalog, qwen prompt, appState,
  useChat, AppProvider).
* `npm run build` — passed. `npm run check:integration` — **31/31** (was
  29/29; new: empty-model tool-chat discovery, contextual cancellation
  invalidating a paused approval with 410).
* `python3 -m unittest discover -s notebooks -p 'test_*.py'` — **58 passed,
  0 skipped** (was 46; new: tunnel lifecycle ×4, state freshness ×1, model
  checksum/revision ×7). `discover -s tools` — **25 passed**.
* `npm audit --json` — 0 vulnerabilities. `git diff --check` — clean.
* Benchmark smoke against the local mock: exit 0, layer report honest
  (protocol/selection/arguments verified **against synthetic results**;
  execution/end_to_end not proven). No real-model evidence is claimed
  anywhere in this change.
* Not verified here: real-model behaviour, the digest mechanism against the
  real Hugging Face host (unreachable from this environment; covered by
  fixtures), and browser e2e (CI job covers it).

## 2026-10-21 — dev7 partial candidate: guided setup, reviewed core grant and bounded web lifetime

**Baseline.** Complete AGENTS.md and both historical logs read before edits.
Live main/default branch verified at `3b5cec8ebeda2f985f27f65249d43c34f19d59a9`,
version `0.1.0-dev6`; tags/releases dev1–dev6, no dev7. Existing bound branch
`arena/4327fa8e-kaggle-kit` starts at that commit. Main CI 39594402934 green.
PR #15 remains separate/open (nightly workflow); no workflows were changed.

**Settled user intent.** Easier onboarding, Basic/Advanced, explicitly enabled
keyless core tools; genuine keyless search only with verified source/policy;
browser Python only if safety and real lifecycle integration can be demonstrated;
no host fallback, preserved probes/permissions/approvals/storage, append-only
history, tested dev7 branch and open PR, no tag, merge or release publication.

**Implemented in `d80a2e3829b8f17e1e37e5cfe71a464fa2d55fec`.** Guided ordered
connection help with endpoint-type guidance; no guessed model or connected state;
empty discovery guidance, Start chatting on a verified active connection;
in-memory Basic/Advanced views preserving mounted fields and existing data;
explicit reviewed calculator/conversion/file/diagnostics/page-open grant with
Save and native-probe gates unchanged. Narrowing presets intersect the existing
allowlist, never grant HTTP/MCP/code/search, change budgets, persist tool history
or widen conversation authority. No new application dependency or storage format.
Advanced prompt/timeout and integrations remain; inference/data/preferences tabs
stay available even in Basic.

**Confirmed defects.** Typed credential changes left a green editor test because
only non-secret configuration was compared (new regression fails with the old
expression). Web socket inactivity timers left DNS/total response duration
unbounded (whole-operation 12s deadline/cancellation plus DNS-stall tests now).
Malformed Brave result containers became an empty success or incidental TypeError
(explicit array validation, empty-result and safe-URL fixtures now). Already
cancelled Docker requests could spawn the CLI (early rejection; regression fails
without guard). New browser mode-switch E2E found author CSS overriding hidden;
explicit hidden rule fixes it. A suspected old-key fingerprint ordering issue
was rejected: presence-only fingerprint has no difference for two nonempty keys;
no speculative rewrite retained. Review/test coverage is not an exhaustive proof
that all repository code or external environments are bug-free.

**Search mechanism: none selected; incomplete.** SearXNG API and limiter sources
at `81371861f67226091d1c4df2e3908a11d3b54eb9` document JSON API, disabled public
formats/403 and bot blocking. These do not establish a public operator's consent
or upstream terms. Direct DuckDuckGo TLS access failed (curl exit 35); sandbox
outbound allowlist excludes search hosts. No compliant, usable public source was
verified, so no scraper/placeholder/fabricated citation ships. Existing optional
Brave stays Advanced. URL opening is explicitly not search. Public service
availability/rate limits remain external. Required follow-up: source access and
terms verification plus actual request/parser/provenance/error tests and a
separate live smoke. Detailed links/evidence: `docs/dev7-audit.md`.

**Python feasibility: deferred, not impossible in principle.** Inspected Pyodide
module-worker/JS-interop documentation at `f45d58d65de40251cc136c07c206328d91029bde`
and MPL-2.0 LICENSE. Downloaded pinned 314.0.7 npm archive outside the repo:
6,488,647 bytes (npm unpacked metadata 13,879,282); release API core archive
6,757,104 bytes/full distribution 337,536,678 bytes. These are distribution
measurements, not browser startup/memory measurements. Python can access worker
JS globals; worker isolation is not denial of origin/network/storage privileges,
nor a portable strict memory quota. Existing lifecycle is server-governed and has
no browser-result bridge. No sandbox/bridge isolation, timeout/recovery and
approval/continuation proof exists here, so no browser mode/runtime download was
added. Optional strict pinned Docker remains; no host/third-party fallback.
Need isolated origin/CSP, pinned assets and correlated authorization-preserving
bridge with actual runtime tests before reconsidering. No choice between two
proven modes needed user input because the browser mode was not proven safe.

**Files and compatibility.** `shared/tools/presets{,.test}.ts`, profile/settings
components and their tests, E2E, CSS, `server/tools/{web,code}` and tests, package/
lock/shared version, README/interface/security docs, release notes/environment,
and audit record. No persistence migration, second API client, state/secret store,
new authorization mechanism or dependency. Existing DNS pinning, URL/redirect
validation, resource limits, optional advanced integrations and history contract
remain. Corrected stale security documentation claiming model DNS was not pinned.

**Actual verification on implementation commit (all exit 0 unless noted).**

- `npm run typecheck`; `npm run lint` — passed, repeated by dry run.
- `npm test` — 45 files / 431 tests, repeated by dry run.
- `npm run build` — production Vite and standalone server bundle passed; entry
  about 310 kB / 95 kB gzip, no new dependency. Existing PDF font warning persists.
- `npm run check:integration` — 31/31 deterministic built-app/mock checks.
- `python3 -m unittest discover -s notebooks -p 'test_*.py'` — 58, no skips after
  installing requests (`--user --break-system-packages`). Initial run had 7 skips;
  the final run and dry run execute all 58.
- `python3 -m unittest discover -s tools -p 'test_*.py'` — 25 passed.
- `npm run test:e2e` with `LD_LIBRARY_PATH` for locally provisioned browser libs —
  5 passed on actual built app/mock model. Chromium 153 from pinned
  `@sparticuz/chromium@153.0.0` npm archive outside repo; bundled NSS/NSPR used.
  Initial standard launch failed for missing Playwright binary, then missing
  system libs; these blockers were provisioned without changing CI/dependencies.
- `npm audit --json` — 0 vulnerabilities. `git diff --check` — clean.
- `tools/release-dry-run.sh 0.1.0-dev7 v0.1.0-dev7` — exit 0 at `d80a2e3`;
  staged and simulated-download validators both say valid. App 2,166,718 bytes,
  notebook 91,914, source 875,918. This is artifact validation, not publication
  or acceptance of the incomplete search requirement.

**Unverified/deferred.** No live model, public search/provider account/terms,
Kaggle GPUs/model/tunnel, live MCP/HTTP, local Docker (CLI absent), Windows runtime
or assistive-technology audit. Existing CI Docker/Windows/browser jobs remain.
JS/CSS/browser tests do not prove a browser Python sandbox exists. No benchmark
results against a real model are claimed. No finite tests guarantee correctness.

**Delivery.** Version `0.1.0-dev7`, implementation SHA above, bound branch above.
A draft/open PR is appropriate because genuine keyless search remains missing;
this is partial dev7 work, not acceptance-complete. PR/CI state will be appended
when confirmed. No tag, release publication, merge or other branch write.


## 2026-10-22 - v0.1.0-dev7 continuation: deployment matrix and catalog decisions

This entry records the design decisions of the dev7 continuation (commits
on `arena/948908bc-kaggle-kit` after the merge of the PR #16 candidate).
Earlier entries are unchanged.

### Decision 1 - extend the verified GPU cell, add a separate TPU cell

Raon lives in `notebooks/qwen3_8_27b_api.py` behind `config_for_model()`
with additive `DeploymentConfig` fields whose defaults reproduce the
Qwen deployment exactly - including the reuse fingerprint payload, which
stays byte-identical for the default config (new identity fields are only
mixed in for non-default deployments, and a test pins the legacy digest).
The accepted alternative - a generic loader replacing the Qwen path - was
rejected: the verified behavior is worth more than the deduplication.
TPU gets its own script because forcing CUDA/GGUF and JAX/bf16 through
one execution branch would be exactly the fragile coupling the task
forbids; the two cells share conventions (ownership state, 0600 key,
real-inference smoke test, pinned tunnel), not code paths.

### Decision 2 - Raon quantization by per-device headroom, pinned by metadata

Sizes and SHA-256 digests come from the official GGUF repository's LFS
metadata at a pinned revision, so the operator-supplied-digest mechanism
of dev6 becomes a baked-in pin for Raon (a *sourced* digest, never a
guessed one). Selection caps the conservative per-device share (equal
share x 1.10 imbalance) at 70% of a device: on T4 that is Q4_K_M, with
Q5_K_M deliberately rejected although it fits the aggregate 32 GB -
aggregate fitting is how OOM-at-load happens with layer splits. The
KRAFTON llama.cpp branch is built from a pinned commit because `raon1`
support in upstream prebuilt binaries must not be assumed; the codeload
archive has no published digest and the script says so. DFlash
speculative decoding stays off: baseline inference first, optimizations
only after live verification.

### Decision 3 - TPU: genuine path for Qwen, explicit refusal for Raon

Qwen on v5e-8 uses the official bf16 safetensors checkpoint (the GGUF is
not a TPU artifact) with vllm-tpu 0.28.0 - the release whose
gated-DeltaNet Pallas kernels match this hybrid architecture - sharded
TP=8. Two evidence-driven refusals are coded, not documented away: MTP
(corrupts outputs on this stack via un-rolled-back recurrent state) and
any session without eight detected TPU devices (Kaggle can provision
CPU-only containers; a CPU "success" would be a false TPU claim). The
key handoff via `VLLM_API_KEY` is *verified* with an unauthenticated
probe and fails closed, because an env handoff that silently does not
take effect must never become a public unauthenticated endpoint.
Raon x TPU raises `UnsupportedDeploymentError` listing the kernel
evidence; "blocked with reasons" is the honest terminal state, and the
catalog, docs and audit all use that word.

### Decision 4 - the catalog is metadata, discovery is truth

`shared/model-catalog/catalog.ts` separates three things that are easy to
conflate: known model metadata, models an endpoint currently reports,
and verification status per deployment combination. Selection is a draft
edit; availability derives only from `/v1/models`; "Implemented - not
live-verified" and "Blocked" are first-class statuses with evidence
strings, rendered in the profile editor. Raon's sampling baseline is
applied per profile through the same omitted-when-unset rule as every
other optional parameter, and thinking stays a deployment/startup
property rather than an invented per-request field. No speed claim is
derived from the 4.3B active-parameter count anywhere.

### Decision 5 - streamed reasoning and tool-call identity are protocol invariants

The three reproduced defects were all invariant violations, now encoded
as tests: reasoning is a separate channel in both spellings
(`reasoning_content`, `reasoning`) and never merges into content; one
streamed index is one call identity, so a conflicting id/name poisons
the entry instead of fabricating a merged call; cancellation must wake
a pending read, because a deadline that cannot interrupt a silent stream
is not a deadline. Adjacent approval/recovery/cancellation suites were
re-run unchanged.

### Decision 6 - keyless search deferred by evidence, not by inertia

The reassessment was redone from primary sources. Marginalia was the
closest candidate and still fails three independent bars: a shared
experimentation key is not product authorization, CC-BY-NC-SA results
conflict with a general default and the retention model, and its index
is deliberately not general web search. SearXNG's docs do not authorize
third-party public instances, and DuckDuckGo has no web-search API.
Shipping any of them as "search" would misrepresent authorization,
coverage, or both; deferring with the requirement recorded is the
correct release state.

### Verification and residual state

Local evidence on the candidate head: typecheck/lint 0; Vitest 47/448;
build ok; integration 33/33; notebooks 86/0 skipped; tools 25; audit 0
vulnerabilities; benchmark smoke 6/6 vs the mock (synthetic, labelled).
Playwright e2e is blocked locally (browser download host unreachable)
and delegated to the CI Browser job - recorded as not-run. Live Kaggle
execution (Raon T4, Qwen TPU), hosted-API calls, real-model tool
behaviour, Docker, tunnels and Windows remain unverified; the operator
procedure in the deployment guide is the path to close the first two.
The PR therefore stays draft: implementation-complete and reviewable,
not acceptance-complete. No merge, tag, release or auto-merge.


## 2026-10-22 - Correction to the preceding entry (tools test count)

Same correction as in `AGENTS_LOG.md`: after restoring PR #15's
nightly-workflow tests (dropped by the merge's `--theirs` resolution),
the tools suite is **27 passed**, not 25. Appended rather than edited,
per the append-only rule.


## 2026-10-22 - Final audit decisions before the dev7 development merge

**Starting state (live GitHub, re-fetched).** PR #17 open/draft, head
`7502508a11454074507101153e02075fd52fa198`, base `main` @
`2b739831cb8b5a990129918362d5027815c3a7b0` (PR #15's merge), mergeable /
clean; PR #16 (`3abb618`) open/draft and an ancestor of the PR #17 head;
PR #15 already merged and untouched. `main` is reported unprotected with
no rulesets (the detailed branch-protection API returns 403 to this
integration, so reviews/required checks were read from the PR state: no
required reviewers, no review requests). Prior CI on `7502508` was green.

**Defects found by the audit and fixed in `0de64185530fc31ca903c74710fa8077b1907dac`
(each reproduced by a failing test first):**

1. Security - the TPU tunnel exposed vLLM directly, but vLLM's key guards
   only `/v1`, `/v2`, `/inference`, `/cohere` (read in vllm `v0.28.0`
   source: `entrypoints/serve/utils/server_utils.py` `GUARDED_PREFIX`;
   `entrypoints/serve/sagemaker/api_router.py` serves `/invocations` with
   the same inference handlers). The old `/v1/models` auth probe could not
   detect this. Fixed with an in-process allowlisting, bearer-checking,
   body-bounded gateway as the only tunnel target; tunnel start gated on
   the gateway refusing `/invocations`; tunnel stopped if the public URL
   answers it. llama.cpp (GPU) checked at both pinned revisions: only
   health/static frontend paths bypass its key - not affected.
2. Catalog selection of Raon overwrote a typed model ID; now only fills an
   empty field, replacement is explicit.
3. Qwen/T4 was labelled "Verified" without live evidence of this script;
   now "Pre-existing - not re-verified live", with a test forbidding any
   `verified` row.

**Primary-source re-verification.** Qwen TPU revision `1d4bf0f2...` is the
current HF sha; KRAFTON llama.cpp branch head is `fb895662...`; the pinned
Raon GGUF revision `fe24f24e...` still lists the pinned files, sizes and
LFS SHA-256 (repo `main` moved to `3afcfcdb...`, README-only change);
`vllm-tpu==0.28.0` exists (latest 0.32.0, pin kept until live parity);
kaggle-cli documents `TpuV5E8`; `VLLM_API_KEY` is the documented alias.

**Local verification on `0de6418` (real output).** `npm ci` (0
vulnerabilities); `npm run typecheck` 0; `npm run lint` 0; `npm test`
**47 files / 449 tests**; `npm run build` 0 (entry 310.00 kB / 94.61 kB
gzip); `npm run check:integration` **33/33**; notebooks **93 passed, 0
skipped**; tools **27 passed** (PR #15 nightly tests included);
`npm audit` 0; `git diff --check` clean; no conflict markers;
`tools/release-dry-run.sh 0.1.0-dev7 v0.1.0-dev7` exit 0, "The release
v0.1.0-dev7 is valid" (staged + simulated download), notes rendered with
`0de6418` - not a publication. `npm run test:e2e` locally: **blocked**
(Chromium executable absent, download fails; 5 launch failures, no
assertion ran) - the CI Browser job is the evidence path.

**Unchanged limitations.** Raon/T4 x2, Qwen/TPU v5e-8 and hosted Raon:
implemented, **not live-verified** (no Kaggle GPU/TPU, gated access or
provider credential here). Raon/TPU: **blocked**, refused without
fallback. Qwen/T4: pre-existing, not re-run live. No live-model tool
calls, Docker locally, Windows, keyless search or browser Python. No
speed/memory/startup figures exist for the new paths.

**Merge plan.** The user authorized a development merge with unverified
paths kept explicitly unverified. After CI passes on the final head:
mark PR #17 ready, merge it with a merge commit, then close PR #16 as
superseded. No tag, no release, no auto-merge, PR #15 untouched. The
merge commit and post-merge CI are recorded in PR #17's comments and a
follow-up log entry.

**Decision - gateway instead of relying on the vLLM key.** Options were (a)
document the limitation, (b) drop the TPU tunnel, (c) put a reverse proxy
in front. (a) leaves a known unauthenticated inference route on a public
URL; (b) removes a requested capability. (c) keeps the feature with a
narrow surface: stdlib-only (no new dependency), exact-path allowlist of
the three routes the chat interface uses, its own key check, HTTP/1.0
connection-delimited streaming so SSE passes through unchanged, and a
fail-closed probe on both the gateway and the public URL. The gateway is
in-process (a kernel thread), so script mode keeps serving until Ctrl+C.

**Decision - status vocabulary.** "Verified" is reserved for executed
live evidence of this repository's code. The preserved Qwen/T4 path gets
its own status rather than inheriting the operator-verified origin cell's
evidence.

## 2026-10-23 - Spark-X2.6-4B: decisions and rejected alternatives

**Decision - official artifacts only.** The published repository has
`Q4_K_M`, `Q8_0` and the full-precision file; it has no `Q5_K_M`/`Q6_K`.
Rather than map a requested quant to the nearest available file (the
pattern Raon's auto-selection uses), Spark's selector fails closed: the
name, size and SHA-256 of the requested artifact must exist in
`SPARK_QUANTIZATIONS`, or the run stops before downloading. Rejected:
falling back to `Q8_0`/third-party quants (silently changes the artifact
and the supply chain), exposing the 8 GB F16 file (not needed for T4 and
not requested).

**Decision - thinking levels ride `reasoning_effort`, gated on the
template.** The template accepts only `high`/`low` and raises otherwise,
while b11719 passes arbitrary strings through. The app therefore exposes
`none|low|high`, sends the field only when
`/props.chat_template_caps.supports_reasoning_effort === true`, and omits
it with a note when the endpoint has not confirmed support. Rejected:
`chat_template_kwargs` transport (a non-OpenAI extension the app does not
model, and per-request `enable_thinking` alone cannot express `low` vs
`high`); a blind `low|medium|high` mapping (every `medium` request would
fail in the template); startup-only control (the product requirement is a
per-profile setting).

**Decision - reuse the existing cell.** Spark gets a `DeploymentConfig`
branch (`KAGGLE_KIT_MODEL=spark`) rather than a second notebook: the
ownership/reuse/restart/conflict rules, key handling, tunnel and runtime
bundle are already tested there. Spark differs only where the evidence
requires it: pinned repository/revision/digests, the b11719 build check,
`--jinja`, no MTP, and its own root/state/key. Qwen's default config and
fingerprint are untouched (tested).

**Decision - prove auth before exposure.** The GPU cell previously relied
on `start_server`'s authenticated smoke test. Spark adds a three-request
gate (anonymous, wrong key, correct key) because the model is the first
public/ungated deployment whose key middleware was read directly; the
gate is a real HTTP server in tests and fails closed before a tunnel.

**Decision - TPU blocked.** No TPU runtime consumes GGUF or the
`trust_remote_code` checkpoint, vendor paths are CUDA/Ascend, and code
search found zero `spark2_5` in vLLM/tpu-inference. A separate Spark
notebook would have no runtime; the TPU cell now refuses the combination
with that evidence and no fallback.

**Status vocabulary.** Spark on T4 x2 is `implemented_not_live_verified`;
Spark on TPU is `blocked`. No row claims `verified`, and the tests assert
that.

## 2026-10-23 - Post-release audit remediation of v0.1.0-dev7

**User Intent.** An independent release audit of the published
`v0.1.0-dev7` (tag commit `25f11996082291bc0c2837f411c4bac216420a41`)
confirmed two code defects and five release-metadata/documentation
defects. The task: verify each finding against the source, fix the
confirmed ones with regression tests that fail before the fix, keep the
published tag and assets untouched, and land the work through a PR with
CI evidence.

**Implementation History.** Finding 1 (HIGH): the capability probe
requested `{base}/v1/props`, but llama.cpp b11719 registers `GET /props`
only at the server root (route table re-read from the pinned tag's
`tools/server/server.cpp` / `server-http.cpp`; zero `/v1/props`
occurrences). Every llama.cpp deployment therefore reported
`templateReasoningEffortSupported: false`, permanently disabling Spark's
thinking-level control and never sending `reasoning_effort`. Fixed in
`shared/api/client.ts`: `props()` now probes the same-origin server root
first (base URL minus the `/v1` suffix, preserving reverse-proxy path
prefixes and trailing-slash normalization) and falls back to `/v1/props`
for servers that mount the metadata under the API prefix; absent
endpoints (404/400) stay `null`, failing servers still surface as errors
and are never re-interpreted as "no capability". The runtime contract for
the levels was re-verified from b11719 `tools/server/server-common.cpp`:
`reasoning_effort:"none"` maps to `enable_thinking=false` and never
reaches the template, `low`/`high` are passed to the template variable -
exactly the catalog's `none|low|high` whitelist.

Finding 2 (MEDIUM): `assertDestinationAllowed` only enforced
`isPrivateAddress` behind the default-off `blockPrivateNetworks`, and
`pinnedFetch`'s literal-IP branch short-circuited with the comment
"destinations.ts judged it" - which, in the default configuration, it
never did. A model proxy call with `baseUrl` `http://169.254.169.254`
really reached the cloud metadata service (reproduced live in the audit
sandbox; the upstream body was echoed in the error). Both module
docstrings already promised the opposite ("refuses them even in the
permissive local configuration" / "Refused at connect time, in every
configuration"), so the fix enforces the documented invariant:
link-local and cloud-metadata literals are refused in
`assertDestinationAllowed` in every configuration (the allow list cannot
rescue them - symmetric to the DNS-answer path, which already refused
allow-listed hostnames resolving into those ranges), and
`pinnedFetch.assertResolvedAddresses` / `createPinnedLookup` refuse the
same literals as a second layer. `unwrapMappedAddress` additionally
sees through the hex spelling (`::ffff:a9fe:a9fe`) that the WHATWG URL
parser produces for `http://[::ffff:169.254.169.254]/`; without it, the
mapped form slipped past every IPv4 range check. Loopback, `localhost`
and private-LAN literals keep working in the default configuration -
the local `llama-server` use case is untouched. Undici skips the DNS
lookup for IP literals entirely (verified against the vendored undici),
so `assertDestinationAllowed` is the production choke point; the
pinned-lookup refusal is defense in depth and unit-tested at the
callback level.

Findings 3-7 (release integrity): the dev7 release notes claimed "No tag
or release is created by this work" while serving as the body of the
created prerelease, and linked `../dev7-audit.md`, which resolves to a
404 from the release page (the file lives at `docs/dev7-audit.md`); both
were corrected in `docs/release-notes/0.1.0-dev7.md` (tag-anchored
absolute URL) and in the published release description (metadata-only
edit; tag, target commit and all six assets untouched). README pointed
at the dev4 release notes as "this development release", showed a dev4
tag example and omitted Spark-X2.6-4B from the catalog and deployment
matrix; corrected without upgrading any status vocabulary (Spark stays
"implemented - not live-verified" on T4 x2 and "blocked" on TPU).
`tools/build_manifest.py` demanded "Node.js 22 or newer" against the
real contract `engines.node >= 20.19` (package.json, launcher
`DEFAULT_NODE_REQUIREMENT`, README) and omitted the tools unittest suite
that `release.yml` really runs; both corrected, with a new consistency
test that reads the contract from `package.json`, `launcher.mjs` and
`release.yml` instead of hardcoding it. `docs/release/environment.json`
carried two unlabeled, incompatible notebook-suite results (105/17
skipped vs 93/0 skipped); each entry now states its run date, head and
`requests` availability, and a tools test requires a distinguishing
`[run ...]` label whenever the same suite is recorded twice.

**Decisions & Lessons.**

**Decision - probe the server root, keep the prefixed fallback.** The
root-first order matches the pinned runtime; the `/v1/props` fallback
keeps unknown compatible servers working and costs one extra request
only when the root route is absent. Rejected: probing only `/v1/props`
(the shipped bug), and probing both unconditionally (a second request
with no purpose once the root answered).

**Decision - metadata/link-local is an absolute refusal, not a policy
mode.** `blockPrivateNetworks` exists to permit `127.0.0.1`/LAN model
servers by default; extending that permissiveness to `169.254.0.0/16`
and the known metadata addresses contradicted both modules' documented
contracts and the DNS path, which already refused those ranges for
resolved hostnames regardless of the allow list. Literal and resolved
addresses now follow one rule.

**Decision - regression tests assert side effects, not strings.** The
SSRF tests assert that the injected transport recorded *zero* outbound
calls, and the probe tests assert the exact URL sequence; the whole set
(21 tests) was run against the pre-fix sources and failed, then passed
after the fix, without editing any test in between.

**Lesson - a `status >= 400` assertion can hide an egress.** The audit's
first smoke run "passed" the metadata check because the real metadata
service answered 401 and the proxy relayed it; only reading the error
body revealed the outbound request. Destination-policy tests must
assert the absence of the request, not the shape of the failure.

**Lesson - test stubs have to mirror the real route table.** The
`/v1/props` bug survived a green suite because the proxy test counted
`endsWith('/props')` and the client test answered 404 for every URL;
stubs that replicate llama.cpp's actual routes (`/props` at the root
only) make the wrong-path probe unrepresentable.

**Limitation.** No Kaggle GPU/TPU session, real model, Docker daemon or
Playwright browser ran here (cost/safety constraints and sandbox
network policy); the browser e2e, Docker sandbox and Windows launcher
jobs of the CI workflow on the PR head are the verification path for
those layers, exactly as for the original dev7 candidate.


## 2026-10-24 - v0.1.0-beta1 reliability/security audit on arena/295bec84-kaggle-kit

### User Intent

Continue the repository-wide release-readiness audit for v0.1.0-beta1: preserve
backward compatibility and security first; test the native tool loop, prompt,
conversion leads, workflow/release tooling and Kaggle deployment surfaces;
fix only reproduced defects; keep evidence and blocked work explicit. No live
model inference, Kaggle tunnel benchmark, deployment, merge, tag or release.

### Baseline and Current GitHub State

The working branch is `arena/295bec84-kaggle-kit`, based on
`1a864791f548e0a5fdb2267d49aefa6df36b3cd0`. Before changes its tree was clean.
At audit time `main` was at the same SHA; latest published version was
`v0.1.0-dev7`. An unrelated open Draft PR #20 already prepares the same beta1
candidate from `arena/02f947f2-kaggle-kit`; its head is
`d32e471194b756b720f389e8a5e98bc269afb7fd`. I reviewed its actual changed-file
list and diff rather than treating its description as evidence: it overlaps
this candidate's nightly fix, conversions, dependency and version/docs, but
does not include this branch's `server/tools/chat.test.ts` calculator argument
mapping regression. Its five CI jobs pass, but those results are for PR #20's
head, not this branch. Keep this distinction explicit and do not infer that
this branch passed CI from the other PR.

Main's scheduled Nightly Release run `40029657246`, on the baseline SHA, failed
in `validate nightly build inputs and artifacts` at `Resolve nightly metadata`;
the publish job was skipped. The `gh run view --log-failed` request returned
EOF before delivering job logs, so failure evidence is the exact failed step
metadata plus the independent local byte-for-byte shell reproduction below.

### Findings and Fixes

- **F1, P1 reliability/release automation — confirmed and fixed.** Both nightly
  jobs contained `VERSION="$(node -p \\"require('./package.json').version\\")"`.
  Executing the workflow line shape under Bash reproduced
  `syntax error near unexpected token '('`, exit 2. Removed the literal
  backslashes from both assignments. Added a Python regression which extracts
  and executes each exact line as stored in the workflow, checks it returns
  the package version, and pins acceptance of `v0.1.0-beta1` against the
  release workflow's regex. No permission, validation or release gate was
  removed. A successful post-fix scheduled GitHub run remains outstanding.
- **F2, calculator conversion leads — not reproduced; no arithmetic edit.**
  Direct execution returns `37.77777777777783` for 100°F→°C and
  `62.1371192237334` for 100 km/h→mph, not the reported erroneous values.
  Added relative-tolerance regressions (1e-6), reverse and supported-category
  conversions, normalization, signed/decimal/zero inputs, invalid units and
  category, non-finite values, and absolute-zero boundaries. Added a separate
  mocked chat-loop assertion that `calculator_convert` forwards `value/from/to`
  in the declared order. No model result is involved.
- **F3, dependency security — confirmed and fixed.** Baseline `npm audit` found
  four advisories on transitive `fast-uri@3.1.8`. Updated only the lockfile
  within the existing dependency range to `3.1.9`; after `npm ci`, `npm audit`
  reports zero vulnerabilities. No declared dependency changed.
- Prepared package, lockfile and application version together for
  `0.1.0-beta1`; README points to the candidate notes. The release workflow
  regex accepts `v0.1.0-beta1`; release artifact validation has no conflicting
  suffix rule. No policy was relaxed. The notes retain the repository's
  `{{SOURCE_SHA}}` build-time placeholder so the release dry-run can render the
  actual commit SHA without a self-referential source hash.

The broader audit reviewed (and did not establish a new defect in) system
prompt canonical/source parity and tool/no-tool prompt selection, native tool
probe/protocol/loop/recovery, approval authorization/bounds/replay, executor
policy, file vault, web/HTTP/MCP tools, pinned fetch/SSRF controls, sandbox
fail-closed policy, and deployment notebook gates. This is not evidence of
real-model behavior. Existing research `system_prompt.txt` remains a separate
candidate and is not silently substituted for the canonical prompt. Existing
storage formats, defaults, credentials and migration behavior are unchanged.

### Version Decision

Prepare `v0.1.0-beta1`, not `dev8`: the reported conversion issue is already
correct in the audited implementation and is now locked by tests; the only
confirmed blocking reliability defect (nightly metadata quoting) is fixed at
its root with a regression; the transitive advisory is resolved. PR #20's
independent draft demonstrates that another branch has already proposed the
same version, so avoid presenting its CI as this branch's evidence. This
branch still needs its own release dry-run and CI before it can be called
acceptance-complete. The beta label does not imply live Kaggle/model
verification.

### Local Verification (2026-10-24)

- `npm ci`: exit 0, 372 packages; `npm audit`: zero vulnerabilities.
- `npm run typecheck`, `npm run lint`: exit 0.
- `npm test`: 48 files, 497 tests passed.
- `npm run build`: exit 0; client and bundled server built.
- `npm run check:integration`: exit 0, 33/33 built-bundle integration checks
  passed against the mock upstream.
- Notebook suite: 105 passed, 0 skipped; tools suite: 32 passed. Python 3.11.2
  venv had `requests` installed from PyPI; no test was skipped for the host's
  missing optional Python package.
- Focused security regression group: 12 Vitest files / 155 tests passed;
  workflow-security unittest: 10 tests passed.
- Offline Qwen evaluation dry-run: 17 cases, 36 automated checks, 45 manual
  criteria validated; canonical prompt equals the research copy and has SHA
  prefix `2f52bd9a1c9c1935`. This was not model inference and produced no score.
- `git diff --check`: clean.
- Local Playwright E2E remains **blocked**, not passed. Standard browser binary
  was absent; an alternate transient Chromium also could not start (exit 127,
  `libnspr4.so` missing; `libnss3.so` and `libnssutil3.so` also missing).
  All five browser tests were blocked before test execution. Docker and Windows
  tests were not run locally. Candidate-branch CI must supply independent
  evidence for browser/Docker/Windows; PR #20 CI is not a substitute.
- Live inference, Kaggle hardware/tunnel, hosted endpoints and external tool
  services were not called, per instruction.

The release dry-run has not yet been run on a committed head at the time of
this entry. Record its exact result in a dated addendum after execution.
The candidate is not fully accepted until its own CI and release dry-run pass;
no merge, tag, release or deployment has occurred.


### Addendum - release dry-run and command-quoting notation correction

On committed candidate `1df130b00c359f646967a42dc60c9fb49c1696a8`,
`PATH=/tmp/kaggle-kit-venv/bin:$PATH tools/release-dry-run.sh
0.1.0-beta1 v0.1.0-beta1` exited 0. Its automated checks (typecheck, lint,
497-test Vitest suite, 105 notebook tests, 32 tools tests), production build,
33/33 built-bundle integration checks, staging, manifest/checksum generation,
release validation and simulated downloaded-asset validation all passed.
The rendered release notes include the exact source SHA. No tag or release was
created. This local dry-run is not publication or live-model evidence.

Notation correction for the F1 line above: the literal workflow source had
two backslash characters total, one before each embedded quote; the inline
example's Markdown escaping rendered four. The finding and reproduction use
the actual workflow text, which the exact-line regression now reads directly.


### Addendum - final-documented candidate dry-run

After recording the first dry-run, repeated
`PATH=/tmp/kaggle-kit-venv/bin:$PATH tools/release-dry-run.sh
0.1.0-beta1 v0.1.0-beta1` on committed HEAD
`a4eb464ecfe0bec96bb558b8755703847cbd3774`. It again exited 0: check
runner (typecheck, lint, Vitest 48 files / 497 tests, notebook 105 tests,
tools 32 tests), build, 33/33 integration, stage/manifest/checksums, staged
validation and simulated-download validation passed; rendered notes contained
that exact SHA. This created no tag or release.


### Addendum - candidate-branch CI results

GitHub PR #21's run `40059116874` on this branch head
`4767acfcd7f89b5f1844547079b45505f96f64b3` completed with all five CI jobs
passing: typecheck/lint/test/build (1m7s), notebook tests (19s), Docker
sandbox integration (24s), Windows launcher (47s), and Browser end-to-end
(48s). CodeRabbit passed. This is evidence for this branch; PR #20's separate
run was not substituted. Local Playwright remains blocked by missing NSS/NSPR
libraries, so browser verification came from CI. No live model/Kaggle check was
run. Merge/tag/release/deployment remain unauthorized. A docs-only evidence
commit follows; its exact head still needs CI and a repeated local dry-run
before final reporting.

## 2026-10-24 - beta1 adversarial audit continuation: tool-call batch integrity

**Scope and starting point.** Continued the beta1 audit on the existing
`arena/295bec84-kaggle-kit` branch, starting from HEAD
`80be4f1a0b00adc73d5b7e86a563cb1ffe1edfd4` (PR #21 open/draft). PR #20
remains a separate branch and was not modified. No credentials, external
services, live model, Kaggle deployment, tunnel, Docker daemon, release
workflow, tag, publication or merge were used. `AGENTS.md` and both historical
logs were read before edits. The log files' pre-append SHA-256 values were
`DESIGN_LOG.md=2d579da9ec0f989eb65db25b3a416f82bf27f0fb3763264dfbeec708ab31de57`
and `AGENTS_LOG.md=70bbf8e71e6fbf7b3edaa44ada6e7ca1be012ebae5f5510da479e498e568dfe3`;
the new text is appended after those exact byte prefixes.

**Confirmed finding F4 - bounded tool-call diagnostics and correlation IDs.**
Two controlled, local mock-upstream reproductions confirmed defects in
`server/tools/chat.ts`:

1. A completion containing 500 valid calls passed the eight-call execution
   limit, but the old diagnostics loop retained one refusal trace for every
   excess call. The server returned **500 trace records** (8 executed, 492
   refusals) and a **182,691-byte serialized result** from a bounded upstream
   response. The per-round execution cap therefore did not also bound the
   user-visible trace/result size.
2. A completion containing two distinct calculator calls with the same
   correlation ID executed **both** and recorded two successful traces. A
   duplicate ID makes the assistant/tool result correlation ambiguous. No
   approval bypass was demonstrated: risky actions still require their normal
   per-operation approval. The defect is malformed-protocol acceptance and
   duplicate-dispatch risk, not an authorization bypass.

**Minimal fix and regression resistance.**

* `appendBoundedFailureTraces` retains at most eight individual diagnostics
  per rejected batch and represents any omitted calls with one aggregate
  failure record. This applies to over-limit calls, malformed calls, and
  tool-call payloads without `finish_reason: "tool_calls"`; valid accepted
  calls still pass through the existing execution and conversation budgets.
* The service now checks valid call IDs for duplicates before dispatch. Any
  duplicate in the batch refuses the entire valid batch and uses the existing
  single bounded protocol-recovery path. No call in that batch is queued or
  executed.
* Permanent regressions in `server/tools/chat.test.ts` cover 500 excess calls,
  500 unannounced calls, duplicate IDs, the bounded aggregate, execution count,
  and serialized response size. Temporary reproduction test code was removed;
  only the production fix and permanent tests remain.

**Post-fix evidence.** In the regression, 500 valid calls result in exactly
8 successful calls plus 8 sampled refusal details and one aggregate refusal
(17 traces total; serialized result <50,000 bytes). A 500-call batch with an
inconsistent finish reason results in nine bounded failure records and no
execution. A duplicate-ID batch records failures only, sends one corrective
request and then returns the supplied direct answer; no calculator trace
succeeds. The test suite verifies these outcomes against injected mock
completions only; this is not a live-model result.

**Broader implementation review and evidence limits.** The continuation
re-read the tool loop and response-size limit; policy/executor/approval and
approval-cancellation flows; file extraction/vault; web/HTTP/MCP destination,
redirect and DNS-pin paths; Docker invocation; prompt/output boundaries;
client Markdown/raw-HTML handling and storage sanitizers; request origin/body
policy; release/nightly workflow tests, manifest and release validation.
The existing suite contains targeted adversarial cases for these boundaries
(local/private DNS, rebinding, redirects, content type, origin, symlink/path
containment, credential fields, stored secrets, untrusted outputs, upload
limits, schema changes, approval replay/rotation/cancellation, and Docker
fail-closed behavior). This review did not reproduce another defect in the
covered local/mock paths; passing tests are not proof of all code paths or of
external deployment behavior. No model prompt can guarantee resistance to
prompt injection. Local model endpoints remain configurable and should be
restricted with the documented allow-list when the proxy is reachable beyond
the user's machine.

**Local verification (working-tree candidate; final commit/CI/dry-run still
pending at the time of this entry).**

* `npm test -- --reporter=dot` - **48 files, 500 tests passed**.
* `npm run typecheck` and `npm run lint` - passed.
* `npm run build` - passed; Vite client and standalone server bundle built.
  Existing PDF.js optional canvas/font warnings appeared in integration; the
  bundle reports 5.6 MB because PDF.js is included. No build failure.
* `npm run check:integration` - **33/33** against the local built application
  and mock upstream.
* `PATH=/tmp/kaggle-kit-venv/bin:$PATH python3 -m unittest discover -s
  notebooks -p 'test_*.py'` - **105 passed, 0 skipped**; same command under
  `tools` - **32 passed**. Two notebook ResourceWarnings reported test sockets
  not closed; suites passed and no production/runtime claim follows.
* `npm audit --json` - info/low/moderate/high/critical/total all **0**.
  Prompt evaluation `python3 research/qwen-system-prompt/eval/run_eval.py
  --dry-run` - 17 cases, 36 automated checks, 45 manual criteria; no model
  output or score. `git diff --check` - clean.
* `npm run test:e2e` - **blocked before assertions**: all five tests failed to
  launch because the Playwright Chromium headless executable is absent. This
  is not an E2E pass. CI is the required browser evidence path.
* The local release dry-run and candidate-branch CI have not yet been run on
  the post-fix committed head. The scheduled post-fix nightly run is also
  outstanding. No merge, tag, release or publication occurred.

**Readiness.** This remediation is locally tested against mocks. The beta1
candidate is not release-ready until its exact committed head passes the local
release dry-run and its own CI jobs; the browser job must be independently
confirmed. The historical PR #20 checks are not a substitute. Live Kaggle,
model, hosted provider, tunnel, Windows runtime, Docker isolation and external
MCP/HTTP behavior remain unverified/out of scope for this offline pass.
