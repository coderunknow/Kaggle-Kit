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
