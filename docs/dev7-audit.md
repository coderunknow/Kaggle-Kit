# dev7 audit and feasibility record — 2026-10-21

## Baseline and scope

Read the complete AGENTS.md (115 lines), AGENTS_LOG.md (987 lines) and
DESIGN_LOG.md (1510 lines) before editing. Live GitHub inspection confirmed
`main` at `3b5cec8ebeda2f985f27f65249d43c34f19d59a9`, package version
`0.1.0-dev6`, prereleases dev1–dev6, no dev7 tag/release, and PR #15 open
(nightly workflow and workflow-security tests). Main CI run 39594402934
succeeded. Work stays on the Arena-bound branch
`arena/4327fa8e-kaggle-kit`, which starts at that main commit. PR #15 and
release publication workflows are not changed or merged.

Inspection prioritized profile setup, connection identity, gateway/reducer,
server routes, tool catalog/selection, execution/approval/continuation,
web network policy, files and Docker. Also inspected deployment configuration,
launcher, CI/release scripts, verification metadata and existing E2E coverage.
The existing suites exercise broader repository behavior. This is not proof
that every line or every environment is defect-free.

## Confirmed findings and changes

- **Stale editor test after changing a key.** `testIsCurrent` compared only
  configuration fields, which exclude the typed credential. A green result
  survived a key edit. The editor now compares the exact ephemeral typed-key
  snapshot too. The new component regression fails when the old expression
  is restored. Credentials remain out of fingerprints and persistent records.
- **DNS and total public-web duration were unbounded.** `request.setTimeout`
  is an inactivity timeout; it does not bound awaited DNS or a steadily
  trickling response/redirect chain. Both public-page and Brave operations now
  have a 12-second whole-operation deadline and cancellation race, preserving
  the checked/pinned socket path. Tests cover stalled DNS and cancellation
  during DNS. DNS itself cannot be cancelled by Node's promise resolver; a
  late resolver cannot initiate a request with the aborted operation signal.
- **Malformed Brave shape treated as empty or threw an incidental TypeError.**
  Previously `{}` became zero results, while non-array `web.results` failed
  at `.flatMap`. Explicit array validation now yields a provider-format error;
  explicit empty arrays remain successful empty results. Fixtures validate
  real URL/snippet preservation and credential-bearing URL exclusion. These
  are parser fixtures, not live-provider verification.
- **Already-cancelled Docker request could spawn Docker.** The run now checks
  cancellation before spawning; disabled/unpinned configurations still fail
  closed. Regression verifies rejection before dispatch. No host fallback.
- Browser testing of the new mode switch exposed author `.field` layout
  overriding the native `hidden` attribute. An explicit `[hidden]` CSS rule
  fixes visibility and keyboard accessibility; the 360px browser test covers it.

One suspicion was rejected: preferring an old nonempty key when constructing
an editor-save fingerprint did **not** cause a different fingerprint because
that function intentionally stores key presence only, with reducer invalidation
on actual key changes. No speculative fingerprint rewrite was retained.

## Setup and authorization

Basic mode focuses the profile form and tool page; Advanced exposes the
existing system prompt, timeout and tool integration controls. Inference,
preferences and data tabs remain accessible. Mode is an in-memory view choice,
not a security boundary or a new persistence schema. Hidden fields stay mounted,
so switching mode does not reset unsaved values. Existing profiles, credentials,
conversations and advanced integration data keep their formats.

New profiles show ordered setup guidance and endpoint-type-specific help without
inventing URLs, keys or model IDs. Empty discovery explains manual entry; only
actual successful inference produces Connected. The effective normalized URL
remains visible. A connected active profile offers Start chatting.

“Allow reviewed keyless built-ins” is a separate explicit profile-level grant
requiring Save. It selects calculator/conversion, uploaded-file tools,
diagnostics and public-page retrieval. It does not grant HTTP/MCP/Python/search,
change budgets or persistence, or bypass the exact native protocol probe.
Presets only intersect the existing allowlist; they cannot expand it. Chat only
disables the loop; advanced configuration is not deleted. A preset narrowing
the profile selection must be saved; conversation selection remains bounded by
the saved profile. Ordinary chat remains available without native tool calling.

## Keyless public-web search: incomplete, not simulated

No default search mechanism was selected or implemented. Page retrieval is not
search, and optional credential-based Brave is not a keyless solution. The UI
and release notes state the missing capability explicitly.

Evidence inspected directly through GitHub, rather than assuming that a public
HTML page permits scraping:

- [SearXNG search API at 8137186](https://github.com/searxng/searxng/blob/81371861f67226091d1c4df2e3908a11d3b54eb9/docs/dev/search_api.rst)
  documents GET/POST `/search` and `format=json`, but explicitly says many public
  instances disable formats and return 403. This is software documentation,
  not permission from a public instance operator or its upstream providers.
- [SearXNG limiter at the same revision](https://github.com/searxng/searxng/blob/81371861f67226091d1c4df2e3908a11d3b54eb9/searx/limiter.py)
  explains bot blocking, CAPTCHA and rate limits. No evasion is appropriate.
- A direct `curl -I --max-time 12 https://html.duckduckgo.com/html/` failed
  with exit 35 (`SSL_ERROR_SYSCALL`). This sandbox permits outbound access only
  to GitHub, npm and PyPI hosts. DuckDuckGo response behavior, automation terms
  and usable live search results could not be verified here. No policy
  assurance or search success is inferred from this failure.

Remaining blocker: verify a specific credential-free public search source's
access policy and usable responses in a network-capable environment. Then add
bounded requests through the existing pinned network controls, deterministic
request/parser/error tests, actual source provenance, and a separately labelled
live smoke test. No random public SearXNG instance, proxy rotation, identity
spoofing or speculative scraping dependency was added. External availability,
blocking and rate limits can never be promised away.

## Browser Python: deferred, not claimed infeasible in principle

Candidate: Pyodide `314.0.7` (published 2026-09-14 per the GitHub release API).
[Worker documentation inspected at f45d58d](https://github.com/pyodide/pyodide/blob/f45d58d65de40251cc136c07c206328d91029bde/docs/usage/webworker.md)
requires a module worker and demonstrates real asynchronous execution and
message correlation. The repository LICENSE is MPL-2.0; bundled Python/packages
have their own notices and would also need distribution review.

Costs measured from the actual downloaded, pinned npm archive (not a guessed
CDN transfer): `pyodide-314.0.7.tgz` **6,488,647 bytes**, npm unpacked metadata
**13,879,282 bytes**. It includes `pyodide.asm.wasm`, module loader,
`python_stdlib.zip` and the package lock. GitHub release metadata separately
reports core archive **6,757,104 bytes**, full package distribution
**337,536,678 bytes**. Optional scientific packages would add downloads; the
npm archive size is not a measurement of application startup or browser memory.
No runtime dependency or executable runtime asset was added to Kaggle-Kit.

[JavaScript interop documentation](https://github.com/pyodide/pyodide/blob/f45d58d65de40251cc136c07c206328d91029bde/docs/usage/type-conversions.md)
exposes JavaScript globals to Python (`import js`). A worker avoids UI blocking
and direct DOM access, but does not by itself deny origin privileges, network
or IndexedDB. Overwriting `fetch` is not a demonstrated isolation boundary.
Workers also provide no portable strict per-program memory limit.

The app's real lifecycle is server start → model calls → prepare/validate →
single-use credential/settings-bound approval → executor → result → model
continuation. There is no authenticated, correlation-bound browser-result
transport. Adding a runtime demo would not integrate that lifecycle. Safe
implementation needs a separate-origin/opaque-origin sandbox with enforceable
network/storage restrictions, pinned self-hosted assets/CSP, a reviewed execution
bridge, cancellation/timeout/recovery, output bounds, and actual browser tests
proving isolation and approval/continuation behavior. None is demonstrated here.

Thus no browser mode is offered, no code is sent to a third-party executor,
and no automatic runtime download occurs. Digest-pinned, approval-gated,
network-disabled Docker remains optional Advanced functionality. No decision
between two proven execution modes was needed because only the existing Docker
architecture is implemented. Its live runtime is not available locally.

## Verification interpretation

Unit/component tests and deterministic built-app integration are not live-model
or public-provider evidence. Browser E2E runs real Chromium against the built
app and a local mock model. Docker runtime and Windows execution are delegated
to existing CI jobs, not reported as locally passed. See the append-only logs,
release environment metadata and PR for exact final command results.

**This candidate is partial dev7 work, not acceptance-complete:** keyless search
is missing and browser Python is deferred. Keep the PR draft/open for review;
do not tag, publish or represent this as a completed search-enabled release.

---

## dev7 continuation - 2026-10-22 (deployment matrix, catalog, tool audit)

Everything above this section is the 2026-10-21 record and is unchanged.
This continuation was implemented on the merged candidate (the merge
initially left conflict markers in six documentation files; they were
removed by restoring the PR-branch versions after verifying the
append-only logs were exact byte-prefix extensions - see the fix commit).

### Starting point re-verified live

PR #16 was still open/draft at `3abb618` on `arena/4327fa8e-kaggle-kit`;
`main` was `2b73983` (merge of PR #15, which is untouched - its
`nightly-release.yml` and workflow-security files are preserved). The two
histories are unrelated, so the candidate was merged with
`--allow-unrelated-histories`, taking the PR branch's versions of the
conflicting dev7 files. Baseline before implementation: 431 Vitest tests
green on the merged tree.

### Deployment matrix evidence

Primary sources checked 2026-10-22 (not summaries): KRAFTON model card
(`krafton-ai/Raon-1-mini-preview` README), Hugging Face API metadata for
`KRAFTON/Raon-1-mini-preview-gguf` (revision `fe24f24e...`, per-file
sizes and LFS SHA-256 ids), GitHub API branch head of
`krafton-ai/llama.cpp@raon-1-mini-preview` (`fb895662...`), Hugging Face
API for `Qwen/Qwen3.8-27B` (safetensors, `Qwen3_5ForConditionalGeneration`,
revision `1d4bf0f2...`, Apache-2.0, ungated), PyPI `vllm-tpu` metadata,
and kaggle-cli `kernels.md` confirming accelerator id `TpuV5E8`.

| Combination | Status | What the evidence actually proves |
| --- | --- | --- |
| Qwen / T4 x2 | Verified (pre-existing) | Shipped cell + 86 notebook tests; dev7 changes are additive and the default fingerprint is byte-identical to before (tested), so rerun/reuse semantics are preserved. No new live GPU run in this environment. |
| Raon / T4 x2 | Implemented - not live-verified | Pinned revision/digests, sizing rule (per-device share <=70% -> Q4_K_M 19,686,434,304 B on T4; Q8_0/Q6_K/Q5_K_M/IQ4_XS figures in code), KRAFTON-branch source build, gated-token failure before any request, alias + flag-filtered startup sampling - all unit-tested. Needs gated access + a real T4 session (procedure in the deployment guide, section 12). |
| Qwen / TPU v5e-8 | Implemented - not live-verified | bf16 checkpoint lineage is the official `Qwen/Qwen3.8-27B` (not the GGUF), vllm-tpu 0.28.0 carries the gated-DeltaNet Pallas kernels this hybrid needs, MTP corruptions on that stack are documented in public Kaggle runs and therefore refused in code. Needs a real `TpuV5E8` session. |
| Raon / TPU v5e-8 | Blocked | GGUF is not TPU-consumable; vendor runtimes are CUDA-only; no `raon1` kernels in documented vllm-tpu/tpu-inference or SGLang-TPU support; no upstream execution proof. The cell refuses before installing anything. This is a research result, not a claim of support. |
| Raon hosted API | Implemented - not live-verified | Ordinary separate profile; no hardcoded base URL/model/token; discovery + staged real-inference test decide Connected. Weights are Apache-2.0 but hosted terms are separate (vendor docs); no provider credential existed here, so the official service itself was not called. |

No tok/s, memory, or startup figure for any new path is reported anywhere:
none was measured. Community Kaggle numbers for Qwen on v5e-8 (~130 tok/s
bf16) are third-party evidence for feasibility, not results of this code.

### Catalog, discovery, and Raon inference behavior

`shared/model-catalog/catalog.ts` is the single catalog source (the
directory is not `shared/models/` because the weights rule `models/` in
.gitignore would swallow the source - renaming beat weakening that rule).
Catalog state is kept apart from endpoint state in types and UI copy:
selection edits drafts only, availability is `advertised /
not_advertised / unknown` strictly from discovery, and every deployment
row carries its evidence string. Raon defaults follow the model card
exactly (temperature 1.0, top_p 0.95, top_k 20, min_p 0.0,
repetition_penalty 1.0, frequency_penalty 0, presence_penalty 1.5
general / 0 coding-math; thinking on and `truncate_history_thinking=false`
are deployment/startup properties). `top_k`/`min_p`/`repetition_penalty`
are opt-in end to end (wire type -> request builder with omitted-reporting
-> shared validation used by browser and proxy -> bounded UI controls);
unset means unsent, including for every pre-existing profile. No speed
claim is made from the 4.3B active-parameter figure anywhere in the UI.

### Tool-calling audit: defects reproduced, then fixed

The full lifecycle was re-traced (profile/credential/model identity,
capability cache keys by URL+credential-hash+model, catalog byte budget,
argument validation, single-use credential-fingerprinted approvals,
contextual cancellation, bounded recovery, stale-test invalidation). The
dev4-dev6 protections held under their existing tests. Three new defects
were each reproduced with a failing test first:

1. **Streamed reasoning dropped for vLLM endpoints.**
   `extractDelta` read only `reasoning_content`; vLLM streams
   `delta.reasoning` (Raon/Qwen thinking models), so chain-of-thought
   silently vanished on exactly the new deployments. Fix: canonical field
   wins when both exist, reasoning never merges into `content`. Covered
   in stream unit tests, a gateway test, deterministic mock frames, and
   two new built-bundle integration assertions.
2. **Conflicting streamed tool-call identity merged two calls.**
   `ToolCallAccumulator` kept the first id/name per index and concatenated
   a second, different call's arguments into it - a fabricated correlation.
   Fix: a conflicting id/name poisons the entry; it is reported as
   overflow and never handed back for execution.
3. **Abort could not wake a silent SSE stream.**
   `parseSseStream` checked the signal only between chunks, so timing out
   a stream that never sends data hung until the server spoke (this also
   bounded the streamed tool-probe's deadline). Fix: abort cancels the
   reader; a cancelled stream no longer yields a trailing partial event.

Mock/integration evidence after the fixes (deterministic, loopback):
built-bundle integration 33/33 including probe, streamed fragments,
calculator round trip, denied approval + replay refusal, bounded
corrective round, contextual cancellation; benchmark smoke vs the mock
6/6 with synthetic results labelled as such. **No live-model tool call
was executed** (no endpoint/credential/hardware here); live Qwen/Raon/
hosted tool tests remain operator work with `tools/model-benchmark.mjs`,
whose layers distinguish protocol/selection/arguments from real
execution. Synthetic results were never described as real execution.

### Keyless search reassessment (fresh, 2026-10-22)

Re-checked from primary sources instead of inheriting the earlier
conclusion:

* **SearXNG (software vs public instances).** The official Search API doc
  (fetched from the searxng repository) still states many public
  instances disable json/csv/rss and return 403 for unset formats. The
  docs authorize querying *an instance*, they do not grant this
  application rights on any public operator's instance or its upstream
  engines. No default instance can be chosen honestly.
* **DuckDuckGo.** No official web-search API exists; the Instant Answer
  endpoint explicitly "is not a full search results API" (vendor text),
  and HTML scraping is a terms/bot-protection problem, which this project
  does not do.
* **Marginalia.** A documented API exists, but the shared `public` key is
  for experimentation with a shared, frequently-hit rate limit; a real
  key needs registration (bot abuse), and results are CC-BY-NC-SA 4.0 -
  a non-commercial, share-alike results license that conflicts with a
  general-purpose default and with this app's retention model. Its index
  also deliberately covers the non-commercial small web, not general web
  search.
* **Live verification from here is impossible:** both
  `https://html.duckduckgo.com/html/` and a public SearXNG JSON query fail
  from this sandbox with `SSL_ERROR_SYSCALL` (exit 35), re-confirmed
  2026-10-22; outbound access is limited to GitHub/npm/PyPI hosts.

**Decision (user-authorized reassessment):** keyless search is deferred
and does **not** block this development release's readiness for review.
The scope, UI, release notes and this audit all state it is absent; page
retrieval is never presented as search; optional Brave (own key, own
retention confirmation) remains the only search provider. A future
integration needs a provider whose published terms authorize this use
without a key (or an operator-run instance story), then the usual bar:
bounded pinned requests, provenance-bearing results, parser/security
tests, and a separately labelled live smoke test.

### Verification on the continuation head (real output)

* `npm run typecheck`, `npm run lint` - exit 0.
* `npm test` - **47 files, 448 tests passed** (431 at the merge baseline;
  +17: catalog 7, ProfileForm catalog UI 3, requests/validation 3,
  stream 3, gateway 1).
* `npm run build` - passed (entry 310.00 kB / 94.61 kB gzip).
* `npm run check:integration` - **33/33** against the built bundle.
* `python3 -m unittest discover -s notebooks` - **86 passed, 0 skipped**
  (58 pre-existing + 12 Raon + 16 TPU).
* `python3 -m unittest discover -s tools` - **25 passed**.
* `tools/model-benchmark.mjs` vs the local mock - 6/6 (script mechanics
  with synthetic results, labelled as such; not a real model).
* `npm audit --json` - **0 vulnerabilities**; `git diff --check` clean.
* `npm run test:e2e` - **blocked locally**: the Playwright Chromium
  binary is absent and its download host is unreachable from this sandbox
  (download failure recorded). The CI Browser end-to-end job on the final
  head is the verification path; jsdom component tests cover the new UI
  logic meanwhile. This is reported as not-run, not passed.

### Status superseding the 2026-10-21 closing

The earlier "partial candidate" verdict is superseded as follows:
application code, catalog/UI, deployments, regression fixes, docs and
version metadata are implemented and locally verified as above. The
candidate is **kept in draft**, for two explicit reasons that local tests
cannot remove: (1) Raon on T4 x2 and Qwen on TPU v5e-8 still need their
live Kaggle executions (section 12 of the deployment guide) before anyone
calls them verified; (2) Raon on TPU is a known upstream incompatibility.
Browser Python remains deferred for the isolation reasons above. No tag,
release, merge, or auto-merge is performed by this work.
