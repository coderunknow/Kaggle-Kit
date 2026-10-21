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
