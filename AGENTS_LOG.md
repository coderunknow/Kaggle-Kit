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


## 2026-10-19 – Branch `arena/3d0a4491-kaggle-kit` – system prompt research

**Task.** Research the leaked system-prompt corpus, extract reusable behavioural
engineering, and produce and integrate an optimized system prompt for the Qwen
deployment in this repository, with tests and honest coverage reporting.

**Starting point.** The repository on this branch was empty apart from
`LICENSE`; the application lives on `arena/b94557e7-kaggle-kit`. That branch was
fast-forwarded into this one so that the prompt could be integrated against the
real code instead of being written blind. `npm install` was run and the baseline
suite (85 tests) passed before any change.

**What was added.**

* `research/qwen-system-prompt/` – the research deliverable:
  `SYSTEM_PROMPT.md` (the prompt, its target table, per-block evidence, the
  deliberate omissions, optional appendices), `PROMPT_INVENTORY.json`/`.csv`
  (1 304 files classified; 313 prompt-carrying; 128 exact duplicates; 14
  near-duplicate clusters), `SOURCE_EVIDENCE.md` (revision
  `dfa2e2855f65a8982b3360d6bd12eeabc049355f`, provenance classes, what was and
  was not verified), `PROMPT_ANALYSIS.md` (behavioural findings with `path:line`
  citations, restriction classifications R1–R15, conflicts, runtime
  dependencies), `PROMPT_EVALUATION.md` (protocol, executed checks, blocked
  model run, hypotheses H1–H7), `README.md`, `corpus_analysis.json`,
  `inspected_files.json`, `build_inventory.py`, `analyze_corpus.py`, and
  `eval/eval_cases.json` + `eval/run_eval.py`.
* `shared/prompts/qwen.ts` – the prompt and a token estimate, single source of
  truth for the application.
* `shared/prompts/qwen.test.ts` – 9 tests: no template tokens, no tool schemas,
  no dates or cutoffs, no foreign vendor identity, context budget, required
  safety clauses, and character-level parity with `SYSTEM_PROMPT.md`.
* `src/components/ProfileForm.tsx` – an "Insert the recommended Qwen prompt"
  button and a character/token estimate next to the system prompt field.
* `src/components/App.test.tsx` – two end-to-end tests: the inserted prompt
  becomes the first request message exactly once, and an empty field still
  sends no system message.
* `docs/chat-interface.md` – documents the button, the token hint and where the
  text lives.

**Bugs and problems found while doing it.**

1. The inventory classifier first counted prompt files that embed tool schemas
   (Grok, Qwen) as `tool_description`, which under-reported behavioural prompts
   by 38 files. Fixed: a file with a system prompt *and* directives *and*
   schemas is a `system_prompt` with subcategory `contains_tool_schemas`.
2. The first MinHash implementation re-hashed every shingle once per
   permutation; on a 500 KB file that was unusable. Rewritten to hash each
   shingle once and apply the permutations arithmetically (20 s for the whole
   corpus).
3. Two restriction regexes were too broad (`do not use` matched by a
   "no web" pattern) and reported 129 files for a rule that actually applies to
   8. Narrowed and re-run; the corrected numbers are what the documents quote.

**Checks that were run.**

* `npm run typecheck` – passed.
* `npm run lint` – passed.
* `npm test` – 96 tests in 11 files, all passed.
* `python3 research/qwen-system-prompt/eval/run_eval.py --dry-run` – suite
  valid, 17 cases / 36 checks / 45 manual criteria; **no model run**.
* `python3 research/qwen-system-prompt/build_inventory.py --repo /tmp/sp_leaks`
  and `analyze_corpus.py --repo /tmp/sp_leaks` – completed in ~20 s and ~38 s.

**Not verified.** No inference was executed: no GPU, no model file and no
endpoint exist in this environment. The prompt's effect on answer quality is
therefore a set of labelled hypotheses, not a measured improvement. The
inventoried corpus's authenticity was not confirmed against vendor
documentation, which is unreachable from the sandbox.


---

## 2026-10-19 – Release `v0.1.0-dev1` (preparation on the pull request branch)

**Task.** Merge pull request #1, tag the result as `v0.1.0-dev1` and publish
a prerelease whose assets are built, verified and uploaded by a workflow in
the repository.

**State of the branch when the work started.** Pull request #2 (the research
of the system prompts) had been merged into `main` in the meantime, so the
branch of pull request #1 conflicted. The conflict was only in
`AGENTS_LOG.md` and `DESIGN_LOG.md`. Both files are append only, so both
entries were kept: the entry of the remediation first, the entry of the
research after it. `src/components/ProfileForm.tsx` and
`src/components/App.test.tsx` merged without a conflict and now contain the
insert button of the recommended Qwen prompt *and* the manual model id.

**What was added.**

* `.github/workflows/release.yml` – the release automation. It builds the
  assets from the tagged commit, validates them, publishes them to a
  prerelease and verifies the upload. The details are in the entry of
  `DESIGN_LOG.md`.
* `tools/build_notebook.py`, `tools/build_manifest.py`,
  `tools/build_release_report.py`, `tools/validate_release.py`,
  `tools/run_checks.py` and `tools/release-dry-run.sh` – the tools of the
  release. They only use the standard library of Python 3.
* `tools/test_release_tools.py` – 13 tests that prove that the validator
  refuses a release that is incomplete, corrupt, inconsistent or that carries
  a secret, and that the generator of the notebook refuses a source with a
  literal key.
* `docs/release/environment.json` and `docs/release-notes/0.1.0-dev1.md` – the
  environments that were tested and the ones that were not, and the release
  notes of the version.
* `server/app.ts` – the streaming request of the proxy does not follow a
  redirect of the upstream any more, like every other request of the server.
  A redirect could have sent the prompt and the key to a host that is not
  allowed to see them.
* `server/app.streaming.test.ts` – the regression test of that change. It
  starts a second server as the target of the redirect and proves that the
  target is not reached. The test fails against the old implementation.
* `package.json` and `shared/api/client.ts` – the version is `0.1.0-dev1`,
  it has to match the tag.

**Checks that were run.**

* `npm run typecheck` – passed.
* `npm run lint` – passed, no findings.
* `npm test` – 155 tests in 16 files, all passed.
* `npm run build` – passed.
* `npm run check:integration` – 14 of 14.
* `python3 -m unittest discover -s notebooks -p "test_*.py"` – 39 tests.
* `python3 -m unittest discover -s tools -p "test_*.py"` – 13 tests.
* `tools/release-dry-run.sh` – the staged release was valid.

**Bugs and problems found while doing it.**

1. The first version of the secret scan of the release flagged the test
   fixture `API_KEY = 'test-key-not-to-be-persisted'` and the example
   `sk-test-ABC123SECRET` of the research corpus. A test fixture is not a
   secret. The scan now only counts a value as a secret when it is at least
   32 characters long and looks like a random token (it has to contain a
   digit, a small and a large letter and its entropy has to be high enough).
   A scan of the whole tree with a low threshold was used to confirm that the
   only hits are these fixtures.
2. The first version of the validator took the *name* of the assignment
   instead of its value, so it would never have found a secret. The test
   `test_refuses_an_archive_with_a_secret` found it.
3. The variable of the release notes shadowed the list of the notes in the
   validator, so the check of the published assets ended with an
   `AttributeError`. The test of a published asset that differs found it.

**Not verified.** The release has not been published at the time of this
entry; the merge, the tag and the published assets are recorded in a later
entry. The behaviour on a real Kaggle GPU runtime, with a real model, a real
Quick Tunnel and a real browser is not verified by the checks above.
