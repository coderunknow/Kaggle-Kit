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
