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
