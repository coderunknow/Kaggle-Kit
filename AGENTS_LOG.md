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

---

## 2026-10-19 – The release `v0.1.0-dev1` (published)

**Task.** Merge pull request #1, tag the result as `v0.1.0-dev1` and publish
a prerelease whose assets are built, verified and uploaded by a workflow of
the repository.

**The merge.**

* Pull request #1 was merged into `main` with a merge commit,
  `4f5446d2f6c69826f2bb51a7706cf4d62c9b41c7`, on 2026-10-19 at 05:09 UTC.
  The checks of the head commit `b722bb1` were green (the job
  `typecheck, lint, test and build` and the job `notebook tests`).
  The check of the third party bot `Kilo Code Review` ended in
  `action_required`, because the bot has no credits left. It is not a check
  of the repository, it was reported as it is and it was not counted as a
  passing check.
* The first run of the release workflow failed in the step that stages the
  assets: the rule `release/` of the `.gitignore` had also hidden
  `docs/release/environment.json`, so the file with the tested and the
  untested environments was never committed. The failure happened before a
  release was created, nothing was published.
* Pull request #3 with the fix was merged into `main` with a merge commit,
  `04c88d2c6d7e7bbbd5c8ac4409cbb1c5941efe55`, on 2026-10-19 at 05:17 UTC.
  The tag was moved to this commit, because a tag has to point at a commit
  with a working release automation. The old target (`4f5446d`, tag object
  `892f860`) is written into the message of the new tag object, so the
  correction is traceable.

**The published release.**

* <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev1> -
  a prerelease, not a draft, published at 2026-10-19T05:18:18Z, built from
  the commit `04c88d2c6d7e7bbbd5c8ac4409cbb1c5941efe55`.
* The workflow run that published it:
  <https://github.com/coderunknow/Kaggle-Kit/actions/runs/39203797957> - all
  steps succeeded, including the publication and the verification of the
  published assets.
* The assets: `v0.1.0-dev1-notebook.ipynb` (83 561 bytes), `v0.1.0-dev1-app.zip`
  (867 555), `v0.1.0-dev1-source.zip` (538 355), `manifest.json` (1 901),
  `SHA256SUMS` (439) and `verification-report.json` (7 799). The SHA-256 of
  every file is in the entry of `DESIGN_LOG.md`.

**Checks that were run.**

* In the workflow of the release: typecheck, lint, 155 tests in 16 files, the
  build, 14 of 14 integration checks, 39 notebook tests, 15 tests of the
  release tools, the validation of the staged assets and the comparison of the
  published assets with the built ones. All passed.
* The continuous integration of the two merge commits was green.

**Bugs and problems found while doing it.**

1. The rule `release/` of the `.gitignore` matched `docs/release/` as well
   and hid the file with the tested and the untested environments. The rule
   is anchored to the root now, and the tools of the release have a test that
   proves that they do not contain a secret themselves.
2. The step that publishes the release changed into the directory of the
   assets before it read the release notes from `docs/release-notes/`. The
   notes are rendered before the change of the directory now. The problem was
   found while the failure was reproduced locally; the first run of the
   workflow had stopped before that step.
3. The test of the scanner of secrets contained a literal that looked like a
   key, so the scan reported the test file itself. The value is built from
   fragments at runtime now.
4. The log of the runs of the workflow could not be read from this
   environment: the host that serves the logs of a run is not reachable. The
   outcome of the run was read from the API of the runs, of the jobs and of
   the steps, and the digests of the published files were read from the API
   of the release.

**Not verified.** The assets of the release could not be downloaded from this
environment, the host that serves the files of a release is not reachable
here; the comparison of the published files with the built files comes from
the run of the workflow. The behaviour on a real Kaggle GPU runtime, with a
real model, a real Quick Tunnel and in a real browser is not verified by the
checks above.

---

## 2026-10-19 – v0.1.0-dev2 on `arena/4ad4bf62-kaggle-kit`

**Task.** Ship `v0.1.0-dev2`: turn the `dev1` chat client into a polished
workspace, audit the repository for real defects, fix them without broad
rewrites, and publish the prerelease through the existing workflow.

**Starting point.** `main` at `8c72dd9` (merge of PR #4), `v0.1.0-dev1`
published, all checks green. The audit ran against that commit, not against the
summary of an earlier session.

**What was done.**

* Rebuilt the client shell: `App`, `ChatView`, `Sidebar`, `SettingsPanel`,
  `Composer`, `MessageItem`, `Markdown`, `ProfileForm`, `PreferencesSettings`,
  `ui` and the stylesheet. New local modules: `useDraft`, `useFocusTrap`,
  `useMediaQuery`, `clipboard`, `export`, `promptStarters`, `version`.
* Added the conversation workspace (date groups, search, rename, two-step
  delete, active connection), the context bar, the export, the theme switch,
  the prompt starters, the draft per conversation, code-block labels and copy,
  the edit/resend/regenerate/retry/stop set, the jump-to-latest control and the
  four-tab modal settings drawer with a real tab list and a focus trap.
* Fixed thirteen defects with regression tests: drafts, Ctrl+Enter, truncated
  streams, an ignored error event, the dropped first message, pre-save writes
  to the secret store, an active-profile switch on edit, the capability cache
  keyed by URL only, the health payload leak, the unstable drawer close
  handler, forced scrolling, hidden row actions while pending, the missing
  message-region id and the crowded status pill below 560 px.
* Added the streaming fallback for a `409` (only when no token arrived), the
  proxy health banner with a 30 s poll and a visibility check, and the
  connection help that separates the local app address from the upstream API
  address, including `KAGGLE_KIT_ALLOWED_HOSTS`, a PowerShell example and when
  a restart is required.
* Updated every version reference to `0.1.0-dev2` (package, lockfile, release
  workflow, tools, tests, docs) and wrote
  `docs/release-notes/0.1.0-dev2.md` with the `{{SOURCE_SHA}}` placeholder.
* Updated `README.md`, `docs/chat-interface.md`, `docs/security.md` and
  `docs/troubleshooting.md`.

**Checks.**

* `npm run typecheck`, `npm run lint`: passed.
* `npm test`: 24 files, 202 tests, all passed.
* `npm run build`: passed; `dist/server/index.js` 56.4 kb.
* `npm run check:integration`: 14 of 14.
* Notebook tests: 39 (7 skipped). Release tools: 15.
* `tools/release-dry-run.sh 0.1.0-dev2`: the staged release validates. The
  validator only accepts six assets, the `{{SOURCE_SHA}}` placeholder and a
  report whose checks passed and whose `notTested` list is non-empty.

**Not verified.**

* No real browser: no Chromium, Firefox, Playwright or `libnss3` was available
  in the sandbox, and the Playwright CDN was unreachable. Layout, fonts, real
  scrolling and the visual result were validated only in jsdom.
* No Kaggle GPU, no model download, no real llama.cpp inference, no
  Cloudflare Quick Tunnel. Those checks remain stubs and a mock upstream.
* The release assets of this version are not downloaded here after
  publication; the workflow's own verification step compares them.

---

## 2026-10-19 – publication record of v0.1.0-dev2

**The published release.**

* <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev2> -
  a prerelease, published at 2026-10-19T10:05:47Z.
* Pull request [#5](https://github.com/coderunknow/Kaggle-Kit/pull/5) was
  merged with `--merge`; the merge commit is
  `475ba25e08cf5e4b2ac2d463ff725df1022d76a2`, and the tag
  `v0.1.0-dev2` (tag object `68b315f5ca28c742a12fa1fbefbfa99ecce68023`)
  points at exactly that commit.
* The release workflow
  [run 39234842770](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39234842770)
  succeeded in every step, including the publication and the verification of
  the published assets. The merge commit was green in
  [run 39234827441](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39234827441).
* The assets: `v0.1.0-dev2-notebook.ipynb` (83 561 bytes),
  `v0.1.0-dev2-app.zip` (914 010), `v0.1.0-dev2-source.zip` (594 182),
  `manifest.json` (1 901), `SHA256SUMS` (439) and
  `verification-report.json` (7 684). The SHA-256 of every file is in the
  entry of `DESIGN_LOG.md`.

**Checks that ran in the release workflow.** Typecheck, lint, 202 tests in 24
files, the build, 14 of 14 integration checks, 39 notebook tests (7 skipped),
15 tests of the release tools, the validation of the staged assets and the
comparison of the published assets with the built ones. All passed.

**Notes.**

* The external "Kilo Code Review" check reported `action_required` because the
  third-party account has insufficient credits; it produced no code finding
  and did not block the merge.
* The assets and the logs of the run could not be downloaded from this
  environment (`release-assets.githubusercontent.com` and the log host are not
  reachable). The evidence for the file comparison is the successful
  "Verify the published release" step of the workflow and the digests that the
  GitHub API reports for the assets.
* Not verified: a real Kaggle GPU, the model download, real inference, a real
  Quick Tunnel and a real browser.

---

## 2026-10-19 – v0.1.0-dev3 on `arena/785a0566-kaggle-kit`

**Task.** Ship `v0.1.0-dev3`: evidence-based connection diagnosis, one
connection configuration for Settings and chat, and a one-command Windows
start, without changing the Kaggle model, the notebook configuration or the
stored profile/chat formats.

**Implementation.**

* New `shared/connection.ts`: credential resolution, effective URL, config
  and credential fingerprints, `resolveConnectionView`
  (`missing/untested/connected/failed/stale`), stage order and labels,
  `connectionFailureResult`.
* `shared/domain.ts`: six stages and six states; `requestedBaseUrl`,
  `baseUrlChanged`, `testedAt`, `configFingerprint`.
* `server/proxy.ts`: staged test with `completeStages`, real inference as the
  only success condition, strict SSE probe. `server/app.ts`: empty model
  resolves to the first reported model; streaming error bodies are redacted.
* `src/state/appState.ts`: invalidation on profile/config/key changes,
  `capabilities/clear`, `connection/invalidate`.
* `ProfileForm`, `SettingsPanel`, `Sidebar`, `App`, `ChatView`, `useChat`,
  `InferenceSettings`: one shared resolution; requested vs effective URL;
  editor-local draft tests; same error labels in both surfaces.
* `scripts/start-windows.ps1` + `tools/launcher.mjs`:
  Node/npm/version/project checks, install only when a build is needed,
  build only when output is missing, free-port handling, `/api/health`
  readiness, browser, clean shutdown.
* `tools/check-kaggle-connection.ps1`: hidden-input key, `/v1/models`, real
  inference, real SSE, sanitized JSON.
* Version `0.1.0-dev3`; release notes; docs; release workflow and dry-run
  bundle the launcher.

**Checks (real output).**

* `npm run typecheck` – passed.
* `npm run lint` – passed.
* `npm test` – **26 files, 241 tests**, all passed.
* `npm run build` – passed; `dist/server/index.js` 65.8 kB.
* `npm run check:integration` – **14/14**.
* Notebook tests – **39** (7 skipped). Release tools – **18**.
* `tools/release-dry-run.sh 0.1.0-dev3` – passed on `67cc56f`; assets staged,
  validated, release notes rendered with the commit, simulated publication
  verified.
* Launcher E2E on Linux: ready in <1 s, `/api/health` 200, browser skipped,
  SIGTERM stopped the child and freed port 8787; with 8787 occupied it moved
  to 8788; `--port 8787` exited 1 with a conflict message.
* CI: PR run 39264877308 green; merge commit CI run 39265050445 green;
  release run 39265201384 green, including the publication and the
  verification of the published assets.

**Publication.**

* PR [#7](https://github.com/coderunknow/Kaggle-Kit/pull/7) merged with
  `--merge` at 2026-10-19T14:00:18Z; merge commit
  `ea4aa427367fa441b87d39c7d256ec0147b21c84`.
* Tag `v0.1.0-dev3` points at that commit. Release
  <https://github.com/coderunknow/Kaggle-Kit/releases/tag/v0.1.0-dev3> is a
  prerelease with six assets; the digests are in `DESIGN_LOG.md`.

**Not verified.**

* Real Kaggle endpoint: **not run**. The sandbox blocks outbound TLS
  (`SSL_ERROR_SYSCALL`) and the user deferred the local check, so no
  `/v1/models`, real inference or streaming result is claimed.
* The PowerShell scripts on a real Windows machine: only static tests were
  possible here. The Node launcher was executed on Linux.
* Real GPU inference, a real Quick Tunnel, a real browser.
* Release assets could not be downloaded in this sandbox (EOF from
  `release-assets.githubusercontent.com`); the digests come from the GitHub
  API and the workflow's download-and-verify step.

## 2026-10-20 – v0.1.0-dev4 candidate on `arena/c1f569d9-kaggle-kit`

**Scope.** Implemented the opt-in secure tool loop, seven tool categories,
model-specific native capability probe, per-call approvals, bounded execution,
conversation settings, profile-scoped tool configuration, SecretStore v2,
retention-aware Brave handling, and accessible activity timeline. Ordinary
OpenAI-compatible streaming/non-streaming chat remains available when tools
are disabled or capability is not verified. Older profile/conversation data
loads with conservative defaults.

**Security and compatibility work.**

* The native probe must see a valid correlated `tool_calls` response, accept a
  synthetic tool result and finish with the exact probe sentinel. It never
  executes the probed function; support is not inferred from endpoint, model
  family or `--jinja`.
* MCP connection target changes (URL, headers, transport or timeout) clear
  discovery metadata and grants. Profile saves cannot introduce MCP tool names,
  descriptions or schemas from browser input: they retain only server-discovered
  metadata and apply the user's selection/permission changes. Grant requires at
  least one selected discovered tool.
* Tool URLs use checked/pinned public DNS; redirect handling, schema/argument
  limits, approval single-use/expiry, denied-operation replay refusal, secret
  redaction, transient Brave-content export/persistence redaction, file-vault
  cleanup, and cancellation-state uncertainty are covered in code/tests.
* Stored sanitizer helper accepts the type-predicate parameter `validEntries`;
  SecretStore v2 is `{ version: 2, secrets, toolProfiles }`, migrates valid v1,
  checks both maps as plain records, and maintains restrictive file mode.
* Docker was unavailable (`docker --version`: command not found). Python
  execution therefore remains fail-closed and runtime isolation is unverified.
  No live Kaggle model, provider account, external MCP server or public tunnel
  was tested. The pre-existing model proxy still does not DNS-pin its upstream;
  that limitation is documented.

**Validation on the working tree.**

* `npm ci` – succeeded; 368 packages installed, 0 vulnerabilities reported.
* `npm run check` – passed TypeScript client/server typecheck and ESLint;
  Vitest **42 files, 332 tests passed**.
* `python3 -m unittest discover -s notebooks -p 'test_*.py'` – **39 passed,
  7 skipped**.
* `python3 -m unittest discover -s tools -p 'test_*.py'` – **18 passed**.
* `npm run build` – passed; production client and standalone server bundle
  built. Vite reported the existing large-chunk advisory; PDF.js emitted
  missing optional canvas/font-data warnings in the text-PDF tests.
* `npm run check:integration` – **19/19** loopback mock-upstream checks passed,
  including ordinary inference, stream delivery/cancellation, PDF/DOCX
  extraction and request policy.
* `git diff --check` – passed before the release dry-run.
* `tools/release-dry-run.sh 0.1.0-dev4` – pending on the committed candidate;
  no tag or publication has been made.

## 2026-10-20 – Final security review and pre-dry-run validation

* Hardened tool argument parsing against JSON numbers that overflow to Infinity;
  HTTP tool arguments are recursively rejected when field names look like
  credentials. Public-web URLs with credential-like query names are rejected,
  and those URLs are omitted from citations.
* Focused security regression run: **6 files, 47 tests passed**.
* Final `npm run check`: typecheck and ESLint passed; Vitest **42 files,
  344 tests passed**.
* Notebook tests: **39 passed, 7 skipped**. Release-tool tests: **18 passed**.
* `docs/release/environment.json`, `package.json` and `package-lock.json` parse
  as JSON. `git diff --check` passed after the security and documentation edits.
* Production build, integration suite, and release dry-run will be rerun against
  the committed candidate. Docker is unavailable; model/provider behavior and
  external endpoint rights remain unverified. No tag or publication exists.

## 2026-10-20 – Release dry-run result

* `tools/release-dry-run.sh 0.1.0-dev4 v0.1.0-dev4` – exit 0 on source
  commit `80b9a9203b890707d0866e3a6c9044fad7d87e89`. Typecheck, lint, 344
  Vitest tests, 39 notebook tests (7 skipped), 18 release-tool tests, build,
  and **19/19** integration checks passed.
* The script generated app, notebook and source archives, manifest, checksums
  and a verification report; release and simulated-downloaded-asset validation
  both passed. It does not run GitHub release automation or publish/tag assets.
* The report explicitly records that Kaggle/live-model behavior, Docker
  isolation, live provider rights, external services and real-browser
  accessibility remain unverified. Vite/PDF.js and the integration host-list
  warnings are non-failing and were retained as limitations.

## 2026-10-20 – v0.1.0-dev4 audit completion and release preparation

**Branch and commits.** Work continued on `arena/bef31f06-kaggle-kit`,
branched from `0fce9deb15e6e59550a594d725a14c4e1f411102` (the head of PR #9
from the previous session; CI was green, no tag or release existed). The
review-bot checks on PR #9 were billing/quota notices, not code findings.

**Audit method.** Re-read the tool implementation module by module (shared
catalog/types, server executor/policy/chat, web/files/http/mcp/code/
calculator, proxy probe, SecretStore v2, frontend settings/timeline/
persistence) and re-ran the full baseline before editing: `npm run check`
(42 files, 344 tests) passed on the untouched tree.

**Gaps fixed (commit `63c8c31c4bec0ceeeafa77656017bb06659ed322`).**

* Qwen prompt: derived `qwen-selfhosted-tools-v1` tool-use variant, profile
  editor insert button, and server-side neutralization of the base prompt's
  no-tools sentence inside the tool loop, with tests.
* Streaming protocol: `ToolCallAccumulator` fragment assembly in
  `shared/api/stream.ts` plus an independent streamed stage in the harmless
  capability probe (`streamingSupported`), with unit/integration tests.
  Tool rounds remain non-streaming so approvals can pause; this is
  documented instead of implied otherwise.
* Settings: maximum tool input bytes and sandbox timeout/memory/CPU/
  process/output controls with server-matching bounds.
* Mock upstream gained deterministic native tool calls; the built-bundle
  integration check grew from 19 to 28 checks and now covers the probe, an
  automatic calculator loop and a denied single-use approval end to end.
* Troubleshooting gained a Tools section; README, chat-interface and
  security docs were aligned with the streaming/prompt behaviour; release
  notes and `docs/release/environment.json` refreshed (356 tests, 28/28).

**Checks executed on `63c8c31` (real output).**

* `npm run typecheck` – passed. `npm run lint` – passed.
* `npm test` – **42 files, 356 tests passed**.
* `python3 -m unittest discover -s notebooks -p 'test_*.py'` – **39 passed,
  7 skipped**. `python3 -m unittest discover -s tools -p 'test_*.py'` –
  **18 passed**.
* `npm run build` – passed (Vite chunk-size advisory only).
* `npm run check:integration` – **28/28 passed**.
* `git diff --check` – passed.
* `tools/release-dry-run.sh 0.1.0-dev4 v0.1.0-dev4` – exit 0 on `63c8c31`;
  staged notebook/app/source archives, manifest, checksums and the
  verification report passed staged and simulated-download validation.

**Not verified.** No live Kaggle endpoint, deployed-model tool round trip
(streaming or not), model weights, tunnel, Docker runtime (CLI absent:
`docker: command not found`), Brave account, live MCP/HTTP service, or
real-browser/Windows run was available. These remain recorded as release
limitations; nothing in this session executed them.

**Release state at time of writing.** This log entry is committed on top of
`63c8c31`; the resulting commit is re-verified (full checks + dry-run)
before the branch is pushed, a PR is opened against `main` (superseding
PR #9, which contains only the pre-audit commit), and tag `v0.1.0-dev4` is
pushed so `.github/workflows/release.yml` builds and publishes the
prerelease. The release workflow builds from the tagged commit and does
not require a merge to `main` first. The PR is intentionally left open and
unmerged.

## 2026-10-20 – v0.1.0-dev4 publication record

* Pushed `arena/bef31f06-kaggle-kit` and opened PR
  [#10](https://github.com/coderunknow/Kaggle-Kit/pull/10) against `main`;
  left open and unmerged as instructed. CI on the PR branch is green
  (`typecheck, lint, test and build`, `notebook tests`). The Kilo check
  reports "fail" for the same out-of-credits reason as on PR #9; it
  produced no findings. PR #9 was closed as superseded with an explanatory
  comment.
* Re-ran `tools/release-dry-run.sh 0.1.0-dev4 v0.1.0-dev4` on the final
  commit `0d3a7424730b7454abfc234bd9bb192627da5795` — exit 0, release valid
  in both staged and simulated-download validation.
* Created and pushed lightweight tag `v0.1.0-dev4` at `0d3a742`. Release
  workflow [run 39414208382](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39414208382)
  completed successfully: source validation, build, integration check,
  staging, staged-artifact validation, prerelease publication and
  published-release verification all passed.
* Verified via the GitHub API: release `v0.1.0-dev4` is a non-draft
  prerelease published 2026-10-20T11:21:27Z targeting `0d3a742`, with the
  six expected assets. A local `gh release download` attempt failed with
  EOF from `release-assets.githubusercontent.com` (the known sandbox
  limitation also recorded for dev3); checksum evidence therefore comes
  from the workflow's verification step and the matching asset sizes.
* This entry is a docs-only commit after the tag; the tag was not moved.

## 2026-10-20 – Audit remediation record (pre-dev5)

* Audited from baseline `f4656bc` on `arena/bef31f06-kaggle-kit`; PR #10 left
  open and unmerged, `v0.1.0-dev4` tag/release untouched at `0d3a742`.
* Audit commits: `8c2f91c` workflow injection removal + action pinning +
  `tools/test_workflow_security.py`; `9cd9ecb` DNS-pinned upstream fetch for
  all proxy paths (+ redirect validation on non-streaming chat); `56b06f5`
  named sandbox containers with force-remove cleanup and stdin-fed code,
  loopback-only self-origin, credential-fingerprint-bound approvals, real
  Docker sandbox integration script + CI jobs (sandbox, windows-launcher);
  `aa3ccba` Vite code splitting (710,229 B → 307,923 B entry) + Playwright
  e2e + docs corrections; `527d923` static symlink refusal; `f143b44`
  notebook llama.cpp SHA-256 pinning (digests from the GitHub API for
  b11719/b11718/b11717 ubuntu-cuda-12.8) + owner-only key/state files;
  `6e8f928` operation-specific approval summaries; `365326a`, `0523518`,
  `95dc19b`, `6f726ee`, `4d4a202`, `ae50ebb` e2e harness fixes driven by CI
  (mock readiness probe 401, duplicate Settings buttons, wrong mock text,
  settings tab role, denial text counted twice).
* Failures encountered and resolved: 8 `server/proxy.test.ts` failures after
  pinning (global-fetch stubs bypassed by undici) fixed with a documented
  test-only fetch seam; one ESLint unused-variable in the sandbox script;
  five Playwright iterations in CI (no local browser: the Chromium download
  is blocked in this sandbox, failure tails were mirrored into check-run
  annotations for API diagnosis); PEP 668 blocked `pip install requests`
  until `--break-system-packages` was used to reproduce the 7 gated notebook
  tests (all pass; the historical "39 passed, 7 skipped" reading is corrected
  in DESIGN_LOG).
* `npm audit --json`: 0 vulnerabilities across 425 dependencies.
* Local sandbox has no Docker and no browser; those paths are verified by
  the new CI jobs instead (`docker sandbox integration`, `Browser
  end-to-end`, `windows launcher` — all green on `ae50ebb`, run 39421344630,
  except the Kilo credits check which produces no findings).
* Prepared `v0.1.0-dev5` (version bump + release notes) because the fixes
  change the distributed app and notebook; publication follows the full
  check suite and release dry-run on the final commit.

## 2026-10-20 – v0.1.0-dev5 publication record

* Ran the complete required check suite on final HEAD `df699bd` (results in
  DESIGN_LOG), then `tools/release-dry-run.sh 0.1.0-dev5 v0.1.0-dev5` —
  exit 0, "The release v0.1.0-dev5 is valid" for both staged artifacts and
  the simulated download validation.
* Pushed branch; CI run 39421934675 fully green except Kilo credits.
  Created/pushed lightweight tag `v0.1.0-dev5` at `df699bd`; release workflow
  run 39422153705 completed successfully (build, staging, validation,
  publication, published-release verification).
* Verified through the GitHub API: prerelease `v0.1.0-dev5` published
  2026-10-20T12:26:56Z targeting `df699bd`, six assets matching dry-run
  sizes; `v0.1.0-dev4` still targets `0d3a742` with its original six assets;
  PR #10 `OPEN`, `mergedAt: null`. Direct asset download from this sandbox
  remains blocked (release-assets host EOF), so checksum evidence is the
  workflow verification step plus exact size parity.
* Also ignored Playwright artifacts (`test-results/`, `playwright-report/`,
  `e2e-output.txt`) in this docs-only post-tag commit.

## 2026-10-20 – v0.1.0-dev6 audit, implementation and release-candidate validation

**Branch and base.** Work runs on `arena/acff7542-kaggle-kit`, branched from
`ad7995b6829325c3bd002215255939af52da06e0` — the actual current `main`
(merge of PR #11; PR #10 with dev4/dev5 work is already merged and was not
reopened or repeated). Implementation commit: `ff569f6` (bounded tool-call
recovery + selection-recovery opt-in, tool-catalog byte budget and notice,
live-model benchmark `tools/model-benchmark.mjs`, notebook `LLAMA_API_KEY`
env fallback instead of the argv key, refusal of unauthenticated builds,
cloudflared pinned to 2026.10.2 with its published SHA-256, docs and version
bump to 0.1.0-dev6).

**Audit evidence.** Full tool-lifecycle re-read on current `main`; catalog
size measured (built-ins 3,728 B ≈ 1,036 estimated tokens; a single
configured schema can reach the 24 KB sanitizer bound, so the aggregate
needed a hard cap); llama.cpp b11717–b11719 `common/arg.cpp` verified
through the GitHub API (`--api-key-file` exists; `--api-key` reads
`LLAMA_API_KEY`); cloudflared digest taken from the GitHub releases API for
tag 2026.10.2. Details and the defect list are in the DESIGN_LOG entry of
the same date. Dev5 protections were re-verified by their existing tests and
left untouched.

**Checks executed (real output).**

* Baseline before edits: typecheck + lint + Vitest 43 files/373 tests green.
* `npm run typecheck` — passed. `npm run lint` — passed (after fixing two
  lint errors in the new benchmark files).
* `npm test` — **44 files, 398 tests passed**.
* `npm run build` — passed. `npm run check:integration` — **29/29** against
  the built bundle, including the new bounded-recovery check.
* `python3 -m unittest discover -s notebooks -p 'test_*.py'` — **46 passed,
  0 skipped** with `requests` installed (`pip install requests
  --break-system-packages`); without it, 46 ran / 7 skipped earlier in the
  session.
* `python3 -m unittest discover -s tools -p 'test_*.py'` — **25 passed**.
* `npm audit --json` — 0 vulnerabilities. `git diff --check` — passed.
* `npm run test:e2e` — **blocked**: `browserType.launch: Executable doesn't
  exist … chromium_headless_shell-1194`; `npx playwright install` cannot
  reach the download host from this sandbox (same limitation recorded for
  dev5). The CI `Browser end-to-end` job is the verification path.
* Benchmark smoke runs (mock upstream, not a real model): model mode 6/6
  passed, exit 0, report leak-check clean; integration mode against a closed
  port reported 3 skipped, exit 0; `--api-key` on argv was rejected with
  exit 2 semantics.
* `tools/release-dry-run.sh 0.1.0-dev6 v0.1.0-dev6` — exit 0 on `ff569f6`;
  staged notebook (89,165 B), app zip (2,154,558 B), source zip (837,737 B),
  manifest, checksums and verification report; "The release v0.1.0-dev6 is
  valid" in both staged and simulated-download validation. No tag was
  created and nothing was published.

**Not verified.** No live Kaggle endpoint, deployed model, tunnel, Docker
runtime, Brave account, live MCP/HTTP service or real browser was available;
real-model tool behaviour is explicitly *not* claimed to have improved — the
new benchmark is the instrument for the operator to establish that. The
`LLAMA_API_KEY` fallback and the pinned cloudflared download are verified
against published sources/digests and unit tests, not on Kaggle hardware.

**Release state at time of writing.** This docs commit follows `ff569f6`;
the branch is then pushed and a **new PR against `main`** is opened for
v0.1.0-dev6. The PR is left open and unmerged; no `v0.1.0-dev6` tag is
created and no release is published (explicitly out of scope for this task).

## 2026-10-20 – v0.1.0-dev6 PR record

* Pushed `arena/acff7542-kaggle-kit` and opened PR
  [#13](https://github.com/coderunknow/Kaggle-Kit/pull/13) against `main`
  (base `ad7995b`, head at the time `b0db270`); left open and unmerged as
  instructed. No `v0.1.0-dev6` tag was created and no release was published.
* CI on `b0db270` (run 39439485725): `typecheck, lint, test and build`,
  `notebook tests`, `docker sandbox integration`, `Browser end-to-end`
  (Playwright/Chromium — the locally blocked e2e path), `windows launcher`
  and CodeRabbit all passed. `Kilo Code Review` reports
  `fail`/`action_required` as on PRs #9–#11 (billing/quota gate); it
  produced no code findings.
* This docs-only commit follows `b0db270`; the release dry-run
  (`tools/release-dry-run.sh 0.1.0-dev6 v0.1.0-dev6`) is re-executed on the
  resulting commit and its exit status is reported in the PR conversation /
  completion report. A successful dry run is not a published release.

## 2026-10-21 — Selective salvage of PR #12 into a post-dev6 hardening branch

* Task: audit PR #12 (done earlier the same day; recommendation: do not
  merge), then selectively port its verified, still-missing fixes onto the
  current `main` (`c52d262`, the published `v0.1.0-dev6` merge commit) as a
  follow-up PR. No version change, no release, no merge in this task.
* Branch: `arena/5860d26a-kaggle-kit`, created from `origin/main` at
  `c52d262` with no other commits (the Arena session binding requires all
  work to stay on this branch, so it *is* the follow-up branch).
* Scope ported (details and reasons in the DESIGN_LOG entry of the same
  date): notebook tunnel-orphan stop, truthful approval-failure states,
  fresh server-state read, probe `max_tokens` 192 + length diagnostics +
  word-boundary token + `protocolVerified`/`roundTripVerified`, capability
  retention (server + reducer), empty-model-ID resolution for tool paths,
  ordinary-chat prompt neutralization, contextual job cancellation
  (server endpoints + client drop paths), structured validation-failure
  feedback (`failureKind`, bounded `expectedSchema`, `callId`) inside the
  unchanged bounded recovery, optional `model_revision`/`model_sha256`
  weight pinning, two `operationSummary` corrections, research-docs
  consistency fixes.
* Scope excluded on purpose: argv API-key fallback, default-on keyword
  heuristics, catalog design B, a second benchmark CLI, duplicate dev6
  release records, diagnostics UI, multi-version cloudflared fallback
  (deferred with reasons), and auto-cancelling jobs when a new turn starts
  (deferred, behaviour change).
* Verification on the implementation commit (real output): typecheck 0,
  lint 0, Vitest **44 files / 417 tests** 0, build 0, integration
  **31/31** 0, notebooks **58 / 0 skipped** 0, tools **25** 0,
  `npm audit` 0 vulnerabilities, `git diff --check` clean, benchmark smoke
  vs the mock exit 0 (synthetic-results-only, labelled). Diff at commit
  time: 26 files, +1425/−60 before the log entries.
* A forbidden-content scan of the diff (`allow_cli_api_key_fallback`,
  `detectMissedToolCall`, `benchmark-tool-calling`, `MAX_ACTIVE_TOOLS`)
  found 0 matches.
* Not verified: real-model tool calling (no live benchmark collected), the
  digest mechanism against the real Hugging Face host (fixtures only), and
  browser e2e locally (CI covers it). Mock evidence is never presented as
  real-model evidence.
* The PR record (number, URL, CI state) is appended in a follow-up
  docs-only commit, as in the dev6 cycle.

## 2026-10-21 — Post-dev6 hardening PR record

* Follow-up PR: **#14** — https://github.com/coderunknow/Kaggle-Kit/pull/14
  (base `main` @ `c52d262`, head `arena/5860d26a-kaggle-kit` @ `41837b9`:
  implementation commit `699a821` + this log cycle).
* CI on the implementation head (run 39589875835): `typecheck, lint, test
  and build`, `notebook tests`, `docker sandbox integration`, `Browser
  end-to-end`, `windows launcher` and CodeRabbit all **passed**.
  `Kilo Code Review` reports `action_required` — "Insufficient credits to
  run review" — the same billing/quota gate as on PRs #9–#13; it produced
  no code findings. `mergeable=MERGEABLE`, `mergeStateStatus=UNSTABLE`
  (the Kilo gate only), matching the state in which PR #13 was merged.
* Local verification repeated on this head before the push: typecheck 0,
  lint 0, Vitest 44 files / 417 tests 0, build 0, integration 31/31 0,
  notebooks 58 / 0 skipped 0, tools 25 0, npm audit 0 vulnerabilities,
  `git diff --check` clean, `tools/release-dry-run.sh 0.1.0-dev6
  v0.1.0-dev6` exit 0 ("The release v0.1.0-dev6 is valid", notes rendered
  with `41837b9`) — the dry run proves the tree stays release-valid; no tag
  was created and no release was published, as the task requires.
* Not verified (unchanged): real-model tool calling (no live benchmark
  collected; all benchmark evidence is mock/synthetic and labelled as
  such), the HF digest mechanism against the real host (fixtures only),
  local browser e2e (the CI job covers it).
* PR #12 stays open until this PR exists with its preserved changes safely
  committed here; it is then closed with a comment referencing this record,
  without deleting its branch. This entry is that record; the close comment
  outcome is reported in the task completion report.

## 2026-10-21 — dev7 partial implementation and verification

- Baseline: complete repository-memory documents read before edits; live main
  `3b5cec8ebeda2f985f27f65249d43c34f19d59a9`, package dev6, no dev7 tag/release.
  Work stays on `arena/4327fa8e-kaggle-kit`; PR #15 inspected and untouched.
- Implementation: `d80a2e3829b8f17e1e37e5cfe71a464fa2d55fec` — guided setup,
  Basic/Advanced without value loss, reviewed keyless grant and narrowing-only
  presets, empty discovery guidance, connected-profile chat action, typed-key
  editor test invalidation, total web deadline/cancellation including DNS,
  malformed Brave payload validation, pre-cancelled Docker dispatch refusal,
  browser/component/unit regressions, dev7 version/docs/verification metadata.
- Reproduced old credential-edit and Docker-cancellation failures by temporarily
  restoring their old expressions/guard, running focused tests (exit 1), then
  restoring fixes. Rejected the suspected old-key fingerprint-order defect
  (presence-only fingerprint); did not retain that speculative change.
- Search is **not implemented**: SearXNG API/limiter documentation does not prove
  public-instance permission or availability, and outbound search hosts are
  unavailable (DuckDuckGo curl TLS exit 35). No placeholder or guessed citations.
- Browser Python is **not implemented**: inspected Pyodide 314.0.7 docs/license,
  actual downloaded npm archive 6,488,647 bytes. Same-origin worker privileges
  and missing lifecycle bridge remain undemonstrated safety requirements, not
  reasons to ship an insecure demo. Optional strict Docker retained.
- Verification against implementation SHA: typecheck 0, lint 0, Vitest 45 files /
  431 tests 0, build 0, built integration 31/31 0, notebook 58/no-skips 0, tools
  25 0, npm audit 0 vulnerabilities, diff-check 0. Exact required scripts also
  repeated by the release dry run. Initial notebook run skipped 7 until requests
  was installed; final run has no skips.
- Provisioned Chromium 153 via @sparticuz/chromium@153.0.0 outside repo, plus its
  NSS/NSPR libs via LD_LIBRARY_PATH. `npm run test:e2e`: 5 passed on built app /
  local mock, exit 0. Initial missing-binary/dependency failures resolved locally;
  no browser/runtime dependency added to application or workflow. New 360px test
  caught/fixed CSS overriding hidden; new Basic grant/probe/calculator/continuation
  E2E passes. This is real browser integration but **not** a live-model test.
- `tools/release-dry-run.sh 0.1.0-dev7 v0.1.0-dev7`: exit 0 at `d80a2e3`; both
  validators valid, source SHA rendered into notes. App 2,166,718 bytes, notebook
  91,914, source 875,918. No tag or publication; generated assets remain ignored.
- Residual: keyless search outstanding; safe browser Python deferred; no live
  model/Kaggle/provider/MCP/HTTP or local Docker/Windows run. Existing CI jobs
  retained; PR/CI confirmation appended separately. Detailed evidence and
  concrete follow-up: `docs/dev7-audit.md`. Candidate must remain draft/open,
  not represented as acceptance-complete or bug-free.


## 2026-10-22 - v0.1.0-dev7 continuation: deployment matrix, catalog, tool audit

**Branch and starting point.** Continued the dev7 candidate on
`arena/948908bc-kaggle-kit`. Live GitHub showed PR #16 open/draft at
`3abb618` (`arena/4327fa8e-kaggle-kit`) and `main` at `2b73983` (merge of
PR #15, untouched including `nightly-release.yml`). The histories are
unrelated, so the candidate was merged with `--allow-unrelated-histories`
(commit `3a09178`), taking the PR branch versions of conflicting dev7
files; PR #15's files were verified preserved. The merge initially staged
add/add conflict *markers* in six documentation files as if resolved;
they were removed (commit `a300560`) by restoring the PR-branch versions
after proving both append-only logs were exact byte-prefix extensions of
`main`, then re-applying the new documentation on the clean base. This
session's branch binding prevents pushing to PR #16's own branch, so the
work is proposed from this branch as its continuation; PR #16 itself was
not modified from here.

**What was implemented (commits `81dcd84`, `55d32ec`, `aa74926`, `2a546c9`).**

* Model catalog `shared/model-catalog/catalog.ts` (renamed from
  `shared/models/` - the weights rule `models/` in .gitignore swallowed
  the source until the rename) with Qwen/Raon/custom entries, gated-access
  notes, per-combination statuses + evidence, discovery matching and
  honest availability states; ProfileForm catalog browser + deployment
  badges; InferenceSettings catalog apply (general vs coding/math) and
  opt-in `top_k`/`min_p`/`repetition_penalty` end to end (wire type,
  request builder omitted-reporting, shared browser/proxy validation).
  Unset stays unsent; old profiles load unchanged; Qwen defaults clear
  Raon extensions (no cross-profile leak).
* Raon on T4 x2 inside the existing cell (`KAGGLE_KIT_MODEL=raon`): pinned
  GGUF revision/digests from official HF metadata, quantization selection
  by per-device headroom (Q4_K_M on T4), KRAFTON llama.cpp branch built
  from pinned commit `fb895662...`, served alias, flag-filtered model-card
  startup sampling, HF token only in the huggingface.co request header
  with fail-before-download when gated access is missing, separate
  root/state/key. The default Qwen deployment is unchanged - including a
  byte-identical reuse fingerprint, proven by test.
* `notebooks/tpu_deployment.py`: Qwen bf16 (`Qwen/Qwen3.8-27B` @
  `1d4bf0f2...`) via `vllm-tpu==0.28.0`, TP=8, eight-TPU requirement with
  no CPU fallback, MTP refused (documented output corruption), key via
  `VLLM_API_KEY` env + verified auth enforcement, real-inference smoke
  test, pinned tunnel, runtime bundle. Raon x TPU raises
  `UnsupportedDeploymentError` with the kernel evidence before installing
  anything.
* Tool/stream defects, each reproduced failing first: streamed
  `delta.reasoning` (vLLM/Raon) was dropped; conflicting streamed
  tool-call id/name on one index merged two calls; abort could not wake a
  silent SSE read (and a cancelled stream yielded a trailing event).
  Mock upstream + gateway + built-bundle integration now cover
  reasoning separation.
* Docs: deployment matrix + operator live-verification procedure,
  catalog/inference docs, security boundaries, troubleshooting entries,
  rewritten dev7 release notes and environment metadata, audit
  continuation with the fresh keyless-search reassessment.

**Search decision.** Reassessed 2026-10-22 from primary sources (SearXNG
search-API docs, DuckDuckGo API text, Marginalia API/license pages;
sandbox `curl` to candidate hosts re-confirmed `SSL_ERROR_SYSCALL`).
No credential-free provider met the authorization/reliability bar, so
keyless search ships nothing and, per the user's reassessment mandate,
does not block review readiness; it stays honestly absent in UI/docs.
Browser Python remains deferred (no proven isolation/bridge).

**Checks executed on the candidate (real output).**

* `npm run typecheck`, `npm run lint` - exit 0.
* `npm test` - **47 files, 448 tests passed** (merge baseline 45/431).
* `npm run build` - passed (entry 310.00 kB / 94.61 kB gzip).
* `npm run check:integration` - **33/33** against the built bundle.
* `python3 -m unittest discover -s notebooks` - **86 passed, 0 skipped**
  (requests installed); `-s tools` - **25 passed**.
* Benchmark smoke vs the local mock - 6/6, synthetic results labelled.
* `npm audit --json` - 0 vulnerabilities; `git diff --check` clean.
* `npm run test:e2e` - **blocked**: Chromium binary absent and the
  Playwright download host unreachable (recorded download failure). The
  CI Browser job is the verification path; not reported as passed.

**Not verified.** Everything live: Raon T4 inference (no GPU, no gated
access), Qwen TPU execution (no TPU), Raon hosted API (no credential; no
endpoint is hardcoded), real-model tool behaviour, Docker runtime,
public tunnels, Windows launcher, real browser. No token, speed, memory
or startup figure for any new path is claimed. The PR stays draft for
those reasons; no merge, tag, release or auto-merge was performed.


## 2026-10-22 - Correction to the preceding entry (tools test count)

The 2026-10-22 entry above reports the tools suite as 25 tests. Reviewing
the final diff found that the merge had taken PR #16's older
`tools/test_workflow_security.py`, dropping PR #15's two
nightly-workflow test methods (the workflow file itself was preserved).
The `main` version of that one test file was restored; the suite now
runs **27 passed**. No other count in the entry changes. This note is
appended, not edited into the entry, per the append-only rule.


## 2026-10-22 - Final audit and development-merge preparation of PR #17

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


## 2026-10-22 - CI evidence for the final-audit head `faff1e5`

* PR run [39796243480](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39796243480)
  on `faff1e508e853c34bdbeee79f6d0562931f8d20e`: **completed / success**.
  All five jobs ran every step successfully, confirmed through the jobs
  API: `typecheck, lint, test and build` (type check, lint, tests, build,
  built-bundle integration, whitespace), `notebook tests` (notebook +
  release-tool suites), `docker sandbox integration` (real Docker),
  `windows launcher` (PowerShell launcher readiness) and
  `Browser end-to-end` ("Run browser end-to-end tests" = success).
  The run log host returned no content to this sandbox, so per-test
  counts for CI come from the step conclusions, not from log text.
* Push run [39796236571](https://github.com/coderunknow/Kaggle-Kit/actions/runs/39796236571)
  on the same SHA: four jobs success; its `Browser end-to-end` job
  (119884031367) stayed `queued` for over 30 minutes without starting
  (no runner picked it up) and could not be re-run from this
  integration ("cannot be rerun" / HTTP 403). It is **not** counted as
  passed. This entry's commit retriggers CI on a new head.

## 2026-10-23 - Spark-X2.6-4B deployment path (uncommitted work session)

* **Sources verified from primary material, not memory:** official
  `XHToken/Spark-X2.6` repo at `X2.6` (`ec963733…`, Apache-2.0,
  deployment README only); HF API metadata for
  `XHToken/Spark-X2.6-4B-GGUF` revision `fe31f8d6…` (ungated, arch
  `spark2_5`, ctx 1048576; `Q4_K_M` 3,543,441,312 B sha256
  `91cb2811…cbd9`, `Q8_0` 4,375,021,824 B sha256 `145c2aa6…8b81`,
  full-precision 8,229,921,024 B); `chat_template.jinja`
  (`enable_thinking` default true, `reasoning_effort` accepts only
  `high`/`low`, tool markup `<tool_call><arg_key>/<arg_value>`);
  llama.cpp `b11719` source (`LLM_ARCH_SPARK2_5`, `src/models/spark2-5.cpp`,
  per-request `reasoning_effort` translation in
  `tools/server/server-common.cpp`, `/props.chat_template_caps`, and the
  key middleware in `tools/server/server-http.cpp`).
* **Only Q4_K_M and Q8_0 exist upstream** - Q5_K_M/Q6_K are rejected with
  an error naming the available files; no fallback, no third-party
  conversion. Spark on TPU is blocked with evidence (0 `spark2_5` hits in
  vllm/tpu-inference).
* **Implemented:** catalog entry + thinking-level metadata; request
  policy that sends `none|low|high` only when the server reports
  `supports_reasoning_effort`; `KAGGLE_KIT_MODEL=spark` with pinned GGUF,
  b11719 build check, required `--jinja`, own state/key/runtime bundle;
  anonymous/wrong-key 401/403 gate before any tunnel; Spark TPU refusal.
* **Tests:** catalog (Spark metadata/levels/sampling), request builder
  (level whitelist, unsupported-template omission, unchanged other
  models), InferenceSettings (selector enabled/disabled, stored `medium`
  warning), ProfileForm (draft-only fill, no overwrite), notebook
  (pins, quantization fail-closed, build-number gate, `--jinja` refusal,
  runtime bundle, auth gate against a real HTTP server), TPU (blocked
  reasons distinct from Raon).
* **Not live-verified:** no Kaggle T4 session was available. The GPU path
  is "implemented - not live-verified"; nothing here proves model output,
  speed, memory, or that b11719 parses Spark's tool-call format - native
  tool calling stays disabled until the real probe passes.

## 2026-10-23 - Post-release audit remediation of v0.1.0-dev7 (this branch)

**Context.** An independent adversarial audit of the published
`v0.1.0-dev7` (tag commit `25f11996082291bc0c2837f411c4bac216420a41`,
release identity and all six asset digests verified; `notebook.ipynb` and
`source.zip` byte-reproduced) confirmed seven defects. This session
re-verified every finding against the source, fixed the code defects with
regression tests, corrected the release documentation and edited the
published release description (metadata only - tag, target commit and all
six assets untouched). The DESIGN_LOG entry of the same date carries the
decisions and rejected alternatives.

**Findings re-verified and fixed here.**
* HIGH - the `/props` capability probe requested `{base}/v1/props`;
  llama.cpp b11719 registers `GET /props` only at the server root
  (re-checked in the pinned tag's `tools/server/server.cpp` and
  `server-http.cpp`: zero `/v1/props` occurrences). Consequence: Spark's
  thinking-level control stayed permanently disabled and
  `reasoning_effort` was never sent on any llama.cpp deployment. Fixed in
  `shared/api/client.ts` (root-first probe, `/v1/props` fallback, absent
  endpoint stays `null`, failing server stays an error). The b11719
  contract for the levels was re-read from `tools/server/server-common.cpp`:
  `none` maps to `enable_thinking=false` (never reaches the template),
  `low`/`high` go to the template variable.
* MEDIUM - the model proxy reached cloud metadata through literal IPs in
  the default configuration (`http://169.254.169.254` really egressed in
  the audit sandbox; upstream body echoed in the error). Root cause:
  `assertDestinationAllowed` enforced nothing by default and the
  `pinnedFetch` literal branch trusted a judgement that never happened.
  Fixed in `server/destinations.ts` (link-local/metadata literals refused
  in every configuration, allow list included) and `server/pinnedFetch.ts`
  (second layer in `assertResolvedAddresses` and `createPinnedLookup`),
  plus hex-mapped IPv6 unwrapping (`::ffff:a9fe:a9fe`, the spelling the
  WHATWG URL parser produces). Verified that undici skips the lookup for
  IP literals, so `assertDestinationAllowed` is the production choke
  point; every proxy route goes through `resolveTarget` first. Loopback
  and LAN literals keep working by default (tests included).
* Release integrity - the dev7 notes' "No tag or release is created by
  this work" and the `../dev7-audit.md` link (404 from the release page;
  the file is `docs/dev7-audit.md`) were corrected in
  `docs/release-notes/0.1.0-dev7.md` (tag-anchored URL, `{{SOURCE_SHA}}`
  placeholder kept) and in the published release description. README
  dev4 remnants fixed and Spark-X2.6-4B added to the catalog/matrix text
  with the unchanged honest statuses. `tools/build_manifest.py` now
  states the real Node floor (20.19, matching `engines` and the
  launcher) and lists the tools unittest suite that `release.yml` runs;
  `docs/release/environment.json` labels its two notebook-suite runs
  (2026-10-22 final-audit head with `requests` = 93/0; 2026-10-23 dev7
  head without `requests` = 105/17-skipped).

**Local verification (real outputs of this session, sandbox Linux x86_64,
Node v22.22.3, Python 3.11.2, venv with requests 2.34.2).**
* Before-fix proof: with only the three source files reverted (`git
  checkout` + re-apply of the saved patch, tests unchanged), 21 of the
  new Vitest regressions failed and 3 of the 4 new tools-suite tests
  failed; after re-applying the fixes all passed. No test was weakened.
* `npm run typecheck`: exit 0. `npm run lint`: exit 0.
* `npx vitest run`: 48 files / 493 tests passed, 0 failed (baseline 466;
  +27 new: client props-contract 7 new tests absorbing the old
  missing-endpoint test (net +6), destinations literal-policy 3,
  pinnedFetch literal-policy 3, proxy probe-sequence 5 incl. the
  end-to-end `reasoning_effort` body check, proxy literal-address
  refusals 10 asserting zero outbound calls, plus stub hardening).
* `npm run build`: exit 0. `npm run check:integration`: 33/33.
* `python3 -m unittest discover -s notebooks -p "test_*.py"`: Ran 105
  tests, OK, 0 skipped. `... -s tools ...`: Ran 31 tests, OK (baseline
  27; +4 consistency tests).
* `tools/release-dry-run.sh 0.1.0-dev7 v0.1.0-dev7`: recorded in the PR
  conversation (runs after the commit so `git archive` sees this head).
* NOT run locally (environment, unchanged from the dev7 cycle):
  Playwright browser e2e (Chromium download blocked), Docker sandbox
  integration (no docker CLI), Windows launcher (no Windows), anything
  against real Kaggle GPU/TPU hardware, real models or real tunnels. The
  CI workflow's browser/docker/windows jobs on the PR head are the
  verification path, as documented in `docs/release/environment.json`.

**Untouched by design.** The published tag `v0.1.0-dev7`, its target
commit and all six release assets; the historical README inside
`v0.1.0-dev7-app.zip` (only a future release asset can replace it);
`notebooks/`, `src/`, tool-calling, streaming and secret-store code (no
defect found there by the audit); the KRAFTON-codeload and
Qwen-GGUF-default digest-pin risks stay documented open risks - both are
deliberate, disclosed product decisions whose change needs live-download
evidence this session must not produce.


## 2026-10-24 - beta1 audit continuation on arena/295bec84-kaggle-kit

### Confirmed baseline and GitHub evidence

- Active local branch: `arena/295bec84-kaggle-kit`, HEAD/base
  `1a864791f548e0a5fdb2267d49aefa6df36b3cd0`; initially clean. No branch
  switch, commit, push, merge, tag or release performed at this point.
- Queried GitHub directly. `main` latest nightly run `40029657246` is a
  scheduled failure on the baseline. Job `validate nightly build inputs and
  artifacts` failed at step `Resolve nightly metadata`; later checks and
  staging were skipped; publish job was skipped. `gh run view ... --log-failed`
  returned an EOF while downloading logs. Do not claim the unavailable hosted
  logs were inspected. Reproduced the same malformed Bash assignment locally
  with exit 2 before changing the workflow.
- Reviewed open Draft PR #20's current metadata and actual diff. It is based on
  the other branch `arena/02f947f2-kaggle-kit`, head
  `d32e471194b756b720f389e8a5e98bc269afb7fd`; its actual files overlap the
  workflow fix, calculator conversion tests, fast-uri update and beta1 docs,
  but do not include this branch's `server/tools/chat.test.ts` argument-order
  regression. Its five checks (Browser E2E, Docker sandbox, notebook tests,
  typecheck/lint/test/build, Windows launcher) pass on that head only. No
  result from PR #20 is attributed to this branch.

### Changes made

- `.github/workflows/nightly-release.yml`: remove escaped quotes in both
  `VERSION=$(node -p ...)` command substitutions.
- `tools/test_workflow_security.py`: execute the two exact assignment lines
  read from the workflow; assert output matches package metadata; pin beta1 in
  both the test's accepted shape and the release workflow regex.
- `server/tools/calculator.test.ts`: relative-tolerance conversion examples,
  reverse/category/normalization/edge-case regressions. Calculator production
  implementation unchanged; no reported defect reproduced.
- `server/tools/chat.test.ts`: deterministic tool-loop case checks declared
  calculator conversion arguments are forwarded as `value/from/to` and result
  is returned. Mock only; not model evidence.
- `package-lock.json`: fast-uri 3.1.8→3.1.9 lockfile-only; `npm ci` refreshed
  installed tree. package/lock/app versions align at `0.1.0-beta1`; README and
  beta release-note input added/updated. `{{SOURCE_SHA}}` remains a deliberate
  template token for dry-run rendering (replacing it in tracked source would
  create an incorrect/circular hash).
- `docs/release/environment.json`: append dated test evidence and latest local
  E2E blocker, preserving earlier historical entries.
- Before appending to these two logs, SHA-256 was recorded as
  `DESIGN_LOG.md=271b4d5ab79af700da52492c5e2959bc3faea680e132f049115e04004d428102`
  and `AGENTS_LOG.md=ceea997ebe91735f9ada8b72360d12de9d44eae6e9ab5fd2a08f9a66e57e30cd`.
  Rechecked immediately before append; both matched. This entry is appended
  only; prior content was not changed.

### Exact Verification Results

- `npm ci`: 372 packages added/audited; 0 vulnerabilities; `npm audit` later
  reports all severity counts zero.
- `npm run typecheck`: pass; `npm run lint`: pass.
- `npm test`: 48 files, 497 passed.
- `npm run build`: pass; production client and bundled standalone server.
- `npm run check:integration`: pass, 33/33.
- Python notebook tests (3.11.2 venv with requests installed from PyPI): 105
  pass / 0 skipped. Python tools tests: 32 pass / 0 skipped.
- Focused security subset: 12 Vitest files / 155 passed; workflow Python tests
  10 passed. Exact nightly assignment regression ran both workflow lines.
- Prompt eval `--dry-run`: exit 0; 17 cases / 36 automatic / 45 manual
  criteria; canonical text matches research prompt, SHA prefix
  `2f52bd9a1c9c1935`; no endpoint/model output/score.
- Conversion direct outputs: `100°F→°C=37.77777777777783`,
  `100 km/h→mph=62.1371192237334`; no arithmetic defect reproduced.
- E2E: attempted five browser tests with temporary @sparticuz/chromium
  executable; all blocked before tests because `/tmp/chromium` cannot load
  `libnspr4.so` (also missing NSS shared libs). Not a test pass. Docker and
  real Windows were not run locally. Live model/Kaggle work was not attempted.
- `git diff --check`: pass.

**Still pending at this append:** commit the candidate on this branch, run
`tools/release-dry-run.sh 0.1.0-beta1 v0.1.0-beta1` against the committed
source archive, push only `arena/295bec84-kaggle-kit`, open one unmerged PR if
appropriate, and report this branch's own CI. Keep any candidate acceptance
status partial until local release dry-run and branch CI are confirmed. No
publication or deployment is authorized.


## 2026-10-24 - beta1 release dry-run result and notation correction

On commit `1df130b00c359f646967a42dc60c9fb49c1696a8`, ran
`PATH=/tmp/kaggle-kit-venv/bin:$PATH tools/release-dry-run.sh
0.1.0-beta1 v0.1.0-beta1`: exit 0. The release check runner passed typecheck,
lint, 497 Vitest tests, 105 notebook tests and 32 tools tests; production
build passed; integration returned 33/33; notebook, app and source archives,
report, manifest and SHA256SUMS were staged; both staged-release and simulated
download validation said `The release v0.1.0-beta1 is valid.` The rendered
notes contain SHA `1df130b00c359f646967a42dc60c9fb49c1696a8`. No tag/release was
created. Run this again after final evidence/log append so the exact final HEAD
is also covered.

Append-only notation correction: the F1 inline sample in the prior entry
shows four backslashes because of the string literal used to append it. The
original workflow line contained two literal backslash characters (one before
each inner quote), reproduced from the actual file. The test executes actual
workflow text and is unaffected.


## 2026-10-24 - final-documented candidate dry-run repeated

Repeated the full command on committed candidate
`a4eb464ecfe0bec96bb558b8755703847cbd3774` after appending the earlier result:
`PATH=/tmp/kaggle-kit-venv/bin:$PATH tools/release-dry-run.sh
0.1.0-beta1 v0.1.0-beta1` exited 0. Check runner (typecheck/lint, 497 Vitest,
105 notebook, 32 tools), build, 33/33 built-bundle integration checks, archive
staging, manifest/SHA256SUMS, artifact validation and simulated downloaded
validation all passed; the rendered notes contain the candidate SHA. This did
not create a tag or release. A further documentation-only append is pending to
record this repeat and final branch CI remains pending.


## 2026-10-24 - branch CI completed (PR #21)

After pushing `4767acfcd7f89b5f1844547079b45505f96f64b3` and opening Draft
PR #21, watched GitHub run `40059116874`. All five jobs passed: Browser E2E
(48s), Docker sandbox integration (24s), notebook tests (19s), typecheck/lint/
test/build (1m7s), Windows launcher (47s). CodeRabbit passed too. This is
independent verification on the session branch; the already-open PR #20 run
was not used as a substitute. Local browser still cannot launch; no live model
or Kaggle test ran. PR #21 remains unmerged/Draft. A docs-only CI evidence
append follows; repeat CI and release dry-run on the resulting exact head.

## 2026-10-24 - beta1 adversarial audit continuation

- Continued on `arena/295bec84-kaggle-kit` from `80be4f1`; PR #21 remains
  separate from PR #20. Before appending, SHA-256 was
  `DESIGN_LOG.md=2d579da9ec0f989eb65db25b3a416f82bf27f0fb3763264dfbeec708ab31de57`,
  `AGENTS_LOG.md=70bbf8e71e6fbf7b3edaa44ada6e7ca1be012ebae5f5510da479e498e568dfe3`.
  Only appended bytes; previous content remains an exact prefix.
- Reproduced two defects using injected mock completions: 500 valid calls
  yielded 500 traces / 182,691 serialized bytes despite the eight-call cap;
  two calls with a duplicate ID both executed. Fixed with bounded sampled plus
  aggregate refusal traces and whole-batch refusal on duplicate correlation
  IDs; bounded recovery remains the existing one-attempt policy. No approval
  bypass reproduced.
- Added permanent regressions for excess calls, mismatched finish reason,
  duplicate IDs, execution count, and serialized result bound. Final local
  Vitest at this working-tree state: **48 files / 500 passed**.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:integration`
  (33/33), notebook tests (105/0 skipped), tools tests (32), npm audit
  (0 vulnerabilities), offline prompt evaluation dry-run (17/36/45), and
  `git diff --check` passed. Playwright local: blocked before assertions,
  5 launch failures, missing Chromium headless executable; no pass claimed.
- Updated beta1 release-note input and environment evidence. Final committed
  release dry-run and this branch's post-fix CI are pending; scheduled nightly
  rerun and all live deployment/provider/Docker/Windows environments are
  unverified. No external call, live model, Kaggle deployment, tag, release,
  merge, or publication occurred. Full detailed evidence is in `DESIGN_LOG.md`.

### beta1 audit: committed-head dry-run and CI

- `f1671d7dde24fea095fb8b50379fd3fc61341ee3` release dry-run exited 0:
  typecheck/lint; 48 files / 500 Vitest tests; notebook 105; tools 32; build;
  integration 33/33; staged and simulated-download artifact validation both
  valid. No tag/release. Manifest artifact SHA-256 values and sizes are recorded
  in `DESIGN_LOG.md`; they are local hashes, not published asset digests.
- GitHub run `40060535716` on that exact PR #21 commit: all five jobs passed,
  including hosted Browser E2E, real-Docker sandbox, Windows launcher, notebook
  suite and typecheck/lint/test/build/integration. Informational Node 20 and
  `ubuntu-latest` migration annotations only. PR #20 remains distinct.
- PR #21 stays open/draft. The scheduled post-fix Nightly Release run is still
  outstanding and was not triggered; no publication, merge, tag or deployment.
  Final documentation-only head gets its own CI/dry-run check after commit.

## 2026-10-24T05:03:27Z - beta1 fail-closed publication and batch preflight

**Exact tested code SHA and branch.** `6c0d6cfe08bec53edf459c4e180e33d2cf1d27b4`
(`fix: gate publishers and preflight tool batches`) on
`arena/295bec84-kaggle-kit`; base `main` at
`1a864791f548e0a5fdb2267d49aefa6df36b3cd0`. PR #21 head was advanced from
`8f57dfb16a6066a84fd46066d3393f7f8de3c44e` to this SHA and pushed only to the
session branch. Before this append, `DESIGN_LOG.md` SHA-256 was
`6d2b2a1a7030a0e32fff8f6089a8bd97faa56384581c82e0985c59879441238f` and
`AGENTS_LOG.md` SHA-256 was
`c5669aa89f6351ddf0bbb87874165e37f9f6d45196408369f02f783501446106`; this
entry is appended after those byte prefixes.

**Findings and changes.**

- F1: nightly metadata quoting defect is fixed in both jobs; workflow tests
  execute the actual assignments/validation with hostile IDs/attempts. The
  schedule cannot reach the Nightly publisher; manual Nightly and Release
  publication require their correct `workflow_dispatch` event and explicit
  boolean `true`, default false. Release `v*` tag-push behavior is preserved;
  write permissions are scoped to publisher jobs. Event matrix, command-location,
  action pinning, shell-boundary and permission tests are included.
- F2: historical Fahrenheit and speed conversion errors did not reproduce;
  factors/arithmetic were not changed. An independently reproduced malformed
  null-unit input raised `TypeError`; the calculator now rejects invalid direct
  values/units/expressions through `CalculatorInputError`. Unit aliases and
  numeric boundaries have regression coverage.
- F3: `npm audit --json` after the pre-existing lockfile-only
  `fast-uri@3.1.9` correction reported zero vulnerabilities (all severity
  counts zero). No package change was made in this continuation.
- F4: model tool-call batches are rejected as a whole for structural/schema
  failures or duplicate IDs; every in-budget accepted call is preflighted
  before dispatch. Empty/non-array protocol payloads are rejected and trace
  output remains bounded. Regression evidence is mock-only.

**Commands and local status on the committed code SHA.**

- `npx vitest run server/tools/calculator.test.ts server/tools/chat.test.ts --reporter=dot`: PASS, 53/53; `npm run typecheck`: PASS.
- `python3 -m unittest tools.test_workflow_security -v`: PASS, 14/14.
- `npm test -- --reporter=dot`: PASS, 48 files / 506 tests.
- `npm run lint`, typecheck, `npm run build`, and `npm run check:integration`: PASS; integration 33/33 against local mock upstream. Build emitted non-fatal optional PDF.js canvas/font warnings.
- `PATH=/tmp/kaggle-kit-venv/bin:$PATH python3 -m unittest discover -s notebooks -p 'test_*.py' -v`: PASS, 105/105, no skips. Same command under `tools`: PASS, 36/36. Notebook test sockets emitted non-fatal `ResourceWarning`s.
- `npm audit --json`: PASS, 0 vulnerabilities; `npm ls fast-uri --all`: `ajv@8.20.0 -> fast-uri@3.1.9`.
- `python3 research/qwen-system-prompt/eval/run_eval.py --dry-run`: suite validation PASS, 17 cases / 36 automated checks / 45 manual criteria; no endpoint, model output or score.
- PyYAML `BaseLoader` parse of `.github/workflows/nightly-release.yml`, `release.yml`, `ci.yml`: PASS. `git diff --check`: PASS.
- `PATH=/tmp/kaggle-kit-venv/bin:$PATH tools/release-dry-run.sh 0.1.0-beta1 v0.1.0-beta1`: PASS on exact committed SHA. Check runner, build, 33/33 integration, staging, manifest/checksum, staged validation and simulated downloaded-asset validation all passed. Ignored artifacts were backed up/restored. No tag/release/upload.

**Hosted evidence and PR state.** GitHub Actions PR run `40064511238` on exact
SHA `6c0d6cfe08bec53edf459c4e180e33d2cf1d27b4`: all five jobs PASS (Browser
E2E 57s, Docker sandbox 25s, notebook tests 24s, typecheck/lint/test/build
1m3s, Windows launcher 53s). Push run `40064507267` also passed all five.
CodeRabbit passed. Kilo Code Review concluded `ACTION_REQUIRED`, title
“Insufficient credits to run review”; Copilot reported insufficient remaining
quota. Neither is approval. PR #21 was marked Ready for review and remains
OPEN; `reviewDecision` is empty and `mergeStateStatus` is `UNSTABLE`.

**Policy, tests not run, and side effects.** `main.protected` is reported false
and repository rulesets list is empty, but detailed branch-protection API
returns 403. `gh pr checks 21 --required` says no required checks were reported
for the topic branch; inaccessible policy is not inferred. No merge or review
bypass was attempted. Local Playwright was not rerun: the earlier attempt was
blocked before assertions by the absent Chromium binary; hosted Browser E2E
passed on this exact SHA. No local Docker or real Windows runtime was run.
No post-fix Nightly schedule run or workflow dispatch (especially no
publication-enabled dispatch), live model inference, Kaggle deployment/tunnel,
external provider/MCP/HTTP call, tag, release, upload, package publication,
deployment or merge occurred. Confirmed `git ls-remote --tags origin
refs/tags/v0.1.0-beta1` returned no ref and `gh release view v0.1.0-beta1`
returned “release not found”.

**PR #20 comparison.** Re-fetched PR #20 at
`d32e471194b756b720f389e8a5e98bc269afb7fd` and compared its tree and semantic
changes to PR #21. Beta version/package metadata, `fast-uri` lockfile update,
nightly fix, conversion examples and prior release/test evidence are retained
in PR #21; PR #21 adds the chat and workflow hardening. No unique useful
implementation was found missing. PR #20 remains OPEN because PR #21 has not
merged; no PR was closed. PR #21 also remains OPEN/Ready because the quota-bound
review check is unresolved and repository merge policy cannot be confirmed.

## 2026-10-24T05:07:39Z - final documentation-head dry-run and CI

**Exact final source/evidence SHA:**
`e50c4198aba81ea2c99fde141c30e19865f45d18` on
`arena/295bec84-kaggle-kit`; code implementation remains at
`6c0d6cfe08bec53edf459c4e180e33d2cf1d27b4`. Immediately before this append,
`DESIGN_LOG.md` SHA-256 was
`4329c40c63e4b87fb5046d7aabc3286ec543b148f91c9546563fb2ae07ee463e`,
`AGENTS_LOG.md` SHA-256 was
`aaca00047483236d6026d1441011c8d9831751fc463e25d78e786e668cfce0c0`, and
`docs/release/environment.json` SHA-256 was
`2462b84f1e946d87826d3aedc3aec9cea32721a3bd6152fe9e6a38457149211f`.
This entry is appended after the exact log prefixes.

**Local dry-run:**
`PATH=/tmp/kaggle-kit-venv/bin:$PATH tools/release-dry-run.sh 0.1.0-beta1 v0.1.0-beta1`
on exact SHA `e50c4198aba81ea2c99fde141c30e19865f45d18` exited 0. The script's
check runner passed typecheck, lint, full Vitest, notebook and release-tool
tests; production build passed; built-bundle/mock integration was 33/33; the
notebook, app and source ZIPs, report, manifest and checksums staged; both
staged and simulated downloaded-asset validation passed. Rendered release notes
contained the exact SHA. Generated files were local only; existing ignored
artifacts were backed up/restored. No upload, tag or release occurred.

**Hosted CI:** PR run `40064899655` on exact SHA
`e50c4198aba81ea2c99fde141c30e19865f45d18`: all five GitHub Actions jobs
PASS (Browser E2E 57s; Docker sandbox 19s; notebook tests 23s;
typecheck/lint/test/build 53s; Windows launcher 56s). Push run `40064896180`
also passed all five. CodeRabbit passed. Kilo Code Review was
`ACTION_REQUIRED`; check-run output says “Review could not start because the
account has insufficient credits.” This is not a completed review or approval.

**Final state and blockers.** At this recheck PR #21 is OPEN/Ready at the exact
SHA, `mergeStateStatus=UNSTABLE`, review decision empty, with no human approval.
Kilo review is still blocked by credits. The main branch API reports
`protected=false` and rulesets list is empty, but branch-protection detail still
returns HTTP 403; no merge-policy inference is made. `gh pr checks --required`
reports no required checks for the topic branch, which does not resolve the
inaccessible policy. PR #20 remains OPEN because PR #21 has not merged. No
merge, self-approval, review bypass or settings change occurred.

No Nightly schedule test or workflow dispatch was run; manual publication input
was never true. No live model, Kaggle deployment/tunnel, external provider/MCP/
HTTP call, tag, release, upload, package publication or deployment occurred.
No remote `v0.1.0-beta1` tag or GitHub release exists. Local Playwright was not
rerun (prior attempt blocked before assertions by absent Chromium); hosted
Browser E2E passed on this SHA. Live inference and Kaggle behavior remain
NOT RUN, not verified by mock tests or hosted UI/Docker/Windows jobs.

## 2026-10-24T05:33:11Z - CodeRabbit follow-up fixes and exact-source validation

**Repository/PR preflight.** Work remained on `arena/295bec84-kaggle-kit`.
Before changes, local HEAD, remote branch, and PR #21 all identified
`c199b1fbbb08fa35ab6d79bf6bfc75e1e5136f4`; PR #21 was OPEN/Ready, base
`main`, and not a draft. The topic branch has no configured Git upstream, so
pushes used the explicit authorized branch name. The committed fixes below
are exact source SHA `2ecf50031996c03a10150a3121647a4ab8691754`.

**Findings and fixes (four review findings).**

1. `README.md` showed the stale `v0.1.0-dev7` tag example while the candidate
   package/release notes are beta1. Updated only the example to
   `v0.1.0-beta1`; no tag was created.
2. `.github/workflows/release.yml` described a false “defaults to validation
   only” behavior. Manual dispatch with the default false skips the only job;
   validation happens only on the preserved tag-push path or explicit manual
   publication. Updated the input description to say manual publication needs
   `publish_release: true` and the default is false. No workflow trigger,
   permission, secret, or publication gate changed.
3. `server/tools/chat.ts` emitted an “additional tool calls” aggregate trace
   when the model said `finish_reason=tool_calls` but the payload was empty,
   null, or absent. When there are no representative calls, the handler now
   emits one generic failed `tool_call_batch` trace without an incorrect
   additional-call count. `server/tools/chat.test.ts` covers all three shapes
   and confirms execution is not invoked.
4. `tools/test_workflow_security.py` used substring membership to prove
   publication commands were in guarded jobs; duplicate commands outside the
   job could evade that assertion. Added source-offset mapping/job spans and
   compare every command match position against the guarded job bounds. A
   synthetic workflow regression has one command inside the publisher and a
   second outside it.

**Failing-first evidence.** Before fixes, `npx vitest run
server/tools/chat.test.ts --reporter=dot` failed the three new empty/null/missing
payload cases because the old trace claimed “1 additional tool call(s)”. The
first `python3 -m unittest tools.test_workflow_security -v` run also failed the
new stale-tag and release-description assertions and errored because the
source-span helper had not yet been implemented. These were expected
regression failures; after the fixes, focused Vitest passed 2 files / 55 tests
(calculator and chat), and the workflow-security suite passed 17/17.

**Local checks on exact source SHA `2ecf50031996c03a10150a3121647a4ab8691754`.**

- `npm run typecheck && npm run lint && npm test -- --reporter=dot`: PASS;
  TypeScript, ESLint, and 48 Vitest files / 508 tests.
- `PATH=/tmp/kaggle-kit-venv/bin:$PATH python -m unittest discover -s notebooks -p 'test_*.py' -v`: PASS, 105/105.
- Same command with `-s tools`: PASS, 39/39 (including 17 workflow-security tests).
- `npm audit --json`: PASS, zero vulnerabilities in all severities.
- `python3 research/qwen-system-prompt/eval/run_eval.py --dry-run`: PASS
  validation of 17 cases / 36 automated checks / 45 manual criteria. No
  endpoint was supplied; no inference, model output, or score was produced.
- PyYAML 6.0.3 `BaseLoader` in `/tmp/kaggle-kit-venv` parsed CI (5 jobs),
  Nightly Release (2), and Release (1); release environment JSON parsing and
  `git diff --check` passed. The system Python lacked PyYAML on the first
  attempt; the isolated venv parse succeeded without changing project deps.
- `PATH=/tmp/kaggle-kit-venv/bin:$PATH tools/release-dry-run.sh
  0.1.0-beta1 v0.1.0-beta1`: PASS on the exact source SHA. The checks runner,
  production build, 33/33 built-app/mock-upstream integration checks, staging,
  manifest/checksums, staged validation, and simulated downloaded-asset
  validation all passed. The rendered notes contained the exact SHA. Ignored
  `dist/`, `release/`, `downloaded/`, `checks.json`, and `release-notes.md`
  were backed up and restored. Optional PDF.js canvas/font warnings were
  non-fatal. No upload or publication was part of this script.
- `npm audit` found no advisories; no dependency suppression or extra project
  dependency was introduced by these fixes.

**Exact-source hosted evidence.** Push run
`40066555290` (https://github.com/coderunknow/Kaggle-Kit/actions/runs/40066555290)
and PR run `40066557948`
(https://github.com/coderunknow/Kaggle-Kit/actions/runs/40066557948) both ran
on exact SHA `2ecf50031996c03a10150a3121647a4ab8691754` and passed all five GitHub
Actions jobs: Docker sandbox integration, notebook/release-tool tests,
typecheck/lint/test/build/integration, Browser E2E, and Windows launcher.
Hosted Browser E2E passed; local Playwright was NOT RUN because the local
Chromium browser cache is absent. Kilo Code Review failed with
`action_required` / “Insufficient credits to run review”; the review check is
not an approval. The earlier CodeRabbit review is `COMMENTED`, not approval;
its green check is not a new human review. Its included allowance was exhausted,
so no repeat review was requested.

**Current blockers and side effects.** Fresh PR #21 state after this push:
OPEN, Ready (not draft), head `2ecf50031996c03a10150a3121647a4ab8691754`,
`mergeStateStatus=UNSTABLE`, empty `reviewDecision`, no review requests and no
human approval. `gh pr checks --required` reported no required checks on the
topic branch, which does not resolve merge policy. The effective branch-rules
endpoint returned HTTP 403 (“Resource not accessible by integration”); the
rulesets endpoint returned an empty list. Do not infer policy is absent from
these results. No merge, self-approval, review bypass, or policy/settings
change occurred. PR #20 freshly remains OPEN/Draft at
`d32e471194b756b720f389e8a5e98bc269afb7fd`; it was not closed because PR #21
has not merged. `git ls-remote` returned no `v0.1.0-beta1` tag and GitHub
reported no such release. No workflow dispatch, tag, release, asset upload,
package/image publication, deployment, live model inference, Kaggle tunnel, or
external provider/MCP/HTTP test occurred. All hosted integration evidence is
mock or test-environment evidence, not live integration proof.

The local and release-dry-run results in this section are tied to source SHA
`2ecf50031996c03a10150a3121647a4ab8691754`; any later log-only commit requires
fresh exact-HEAD verification before it can be reported as the final head.

### Append-only policy-evidence correction (same audit timestamp)

Correction to the wording above: the fresh effective branch-rules request
`GET /repos/coderunknow/Kaggle-Kit/rules/branches/main` returned `[]`; the
rulesets list returned length 0. `GET /branches/main` returned
`protected:false`. The **branch-protection detail** endpoint and
`/branches/main/protection/required_pull_request_reviews` each returned HTTP
403 (`Resource not accessible by integration`). Thus the effective-rules
endpoint did not return 403; detailed review/protection policy remains
inaccessible. None of these results is used as permission to merge: PR #21 has
no approval, Kilo's review check is credit-blocked, and the standing acceptance
rule forbids merging while review or policy is unresolved.

## 2026-10-24T08:19:00Z - PR #21 final policy and review-thread checkpoint

This append-only checkpoint records a fresh pre-merge audit of PR #21 at source
SHA `bb65378b57b7e8e2d97abc70641d55d32f1d35da` (base `main` SHA
`1a864791f548e0a5fdb2267d49aefa6df36b3cd0`). The isolated audit clone was
clean; the original local checkout at the base SHA, with its 14 tracked edits
and untracked beta1 release note, was left untouched.

- Re-read the changed tool-call batch/preflight paths, calculator conversion
  changes, release/nightly publication gates, and workflow-security assertions.
  No new defect was confirmed. The four current CodeRabbit findings were
  checked against this exact source and fixed: manual Release wording, beta1
  tag example, empty/missing/null tool-call trace wording, and positional
  publisher-job assertions. Factual replies were added and all four threads
  resolved; these author replies are not approvals. `python3 -m unittest
  tools.test_workflow_security -v` passed 17/17 on the exact source. Earlier
  full local checks and exact-SHA CI results are recorded above.
- Refreshed PR #21: OPEN/Ready, exact head `bb65378...`, base `1a86479...`,
  mergeable, `UNSTABLE`, empty review decision, no review requests, and no
  merge-queue entry. Both PR run `40066780614` and push run `40066776488` passed
  all five CI jobs. Kilo Code Review is the only non-success status and reports
  `ACTION_REQUIRED` because of insufficient credits; CodeRabbit's green status
  and the author replies are not approvals.
- Refreshed effective policy evidence: `GET /branches/main` reports
  `protected:false`; applicable branch rules are `[]`; parent-inclusive
  rulesets count is 0; `gh pr checks 21 --required` reports no required checks;
  the PR has no merge-queue entry. On that positive evidence, this audit found
  no enforced approval count, eligible-independent-reviewer requirement,
  required status check, stale-approval rule, or merge-queue requirement.
  The detailed classic protection endpoint still returns HTTP 403, so its
  hidden detail was not inspected; no policy/settings change or bypass was
  made. The sole collaborator visible is the PR author/admin, and no
  self-approval was submitted.
- The PR description was changed only to replace its obsolete “open and draft”
  sentence with “open and ready for review”; other technical/history text was
  preserved. GitHub reports `UNSTABLE` while the only non-success check is the
  credit-blocked Kilo status; that status is not reported as required by the
  available effective-policy checks.

This is a pre-merge record, not a claim that merge has happened. The next
operation is the ordinary GitHub merge mechanism only after the appended-log
head's exact CI is green; no admin/bypass option is authorized. No tag, release,
publication, workflow dispatch, deployment, or live model call occurred.
