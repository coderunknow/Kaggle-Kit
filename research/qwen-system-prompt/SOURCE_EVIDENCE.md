# SOURCE_EVIDENCE

Provenance, revisions, and what could and could not be verified. Confidences
here are about **where a file came from**, not about whether its instructions
are good; the latter is `PROMPT_ANALYSIS.md`.

Inspection date: **2026-10-19**. Research revision: **1**.

---

## 1. The target system (evidence before any research)

The mission requires the target to be established from the code, not from the
model family name. Everything below is read from this repository at
`5ba50cd7a66aa0bcd42b72f2828d9222e126a415` plus the `llama.cpp` documentation.

| Property | Value | Where it comes from |
| --- | --- | --- |
| Model repo | `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF` | `notebooks/qwen3_8_27b_api.py` → `DeploymentConfig.repo` |
| Model file | `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf`, `min_model_bytes = 11_000_000_000` | same |
| Quantization | IQ3_S (GGUF), GSQ-RCO variant, MTP speculative head | same |
| Inference engine | `llama-server`, official CUDA build `b11719` (`b11718`, `b11717` fallbacks), CUDA 12.8 | same |
| API surface | `GET /v1/models`, `POST /v1/chat/completions` | `shared/api/client.ts`, `notebooks/...` smoke tests |
| Context | `ctx_size = 8192`, `batch 512`, `ubatch 128`, KV cache `q8_0`, `parallel 1` | `DeploymentConfig` |
| Output | `max_tokens` default 1024, UI range 1–32768 | `shared/api/requests.ts`, `shared/api/validation.ts` |
| Roles | `system` \| `user` \| `assistant` only | `shared/api/types.ts` → `ChatRole` |
| Tools | **none** — no tool/function field is typed, built or forwarded | `shared/api/types.ts`, `shared/api/requests.ts`, `server/proxy.ts` |
| Reasoning | `--reasoning-effort medium` at start-up; separate `reasoning_content`/`reasoning` fields are parsed and displayed | `notebooks/...` `server_command()`, `shared/api/types.ts` |
| Chat template | taken from the GGUF metadata by the server (`--jinja`) | `notebooks/...`; verified against `llama.cpp` (`tools/server/README.md`, §2 below) |
| System prompt injection | `profile.systemPrompt.trim()` pushed as the first message, only when non-empty | `src/state/useChat.ts` → `buildHistory()` |
| Streaming | off by default; enabled only after a real SSE probe; a Quick Tunnel usually fails that probe | `docs/chat-interface.md`, `server/proxy.ts` |

Multiple configurations exist in the deployment script (a variant chain with
8192/MTP/reasoning, 4096, 4096-without-reasoning). The application supports all
of them: the prompt makes no claim about context size or reasoning mode, so it
works for every variant. The **primary** configuration is the first variant.

**No capability above is assumed from a benchmark or from another Qwen product.**
Where the model's own properties are unknown (exact tokenizer, template
dialect, long-context behaviour), the documents say unknown.

---

## 2. Additional sources consulted

| Source | URL / revision | Why it is relevant | What was verified |
| --- | --- | --- | --- |
| `llama.cpp` server documentation | `github.com/ggml-org/llama.cpp`, `tools/server/README.md` @ `31288c9c66e59377f7788d920678a565bb89dd37` (2026-10-19) | the only authoritative statement about `--jinja`, `--reasoning-format`, `--reasoning-effort` and where the chat template comes from | `--jinja` uses the Jinja engine and the template from model metadata by default; `--reasoning-effort LEVEL` is passed *to the chat template*; `--reasoning-format` defaults to `auto` and can place thoughts in `message.reasoning_content` |
| This repository's own docs | `docs/chat-interface.md`, `docs/security.md`, `docs/kaggle-deployment.md` | the behaviour the prompt must fit | request lifecycle, unreachable-tools design, key handling, Quick Tunnel streaming limitation |

Consequence of the `llama.cpp` evidence: the client must not serialize roles
itself. A prompt containing `<|im_start|>` would be escaped or double-templated,
so `shared/prompts/qwen.test.ts` asserts the absence of template tokens. This is
the "keep model-specific serialization separate from behavioural instructions"
requirement, satisfied by construction.

**Not consulted, and why:** vendor documentation for Anthropic, OpenAI, Google
and Alibaba is outside the sandbox's network allowlist (only GitHub, npm and
PyPI are reachable). Every statement about those vendors in these documents is
therefore either (a) drawn from the collected files, (b) drawn from the
collection's own documentation, or (c) explicitly marked as unverified. No
vendor doc was paraphrased from memory and presented as verified.

---

## 3. Primary repository

| Field | Value |
| --- | --- |
| URL | `https://github.com/asgeirtj/system_prompts_leaks` |
| Default branch | `main` |
| Inspected commit | `dfa2e2855f65a8982b3360d6bd12eeabc049355f` |
| Commit date | 2026-10-16 08:29:37 +0000 |
| Commit subject | `Update claude-code skills` |
| Commit count at inspection | 864 (first commit `12d58bd`, 2025-05-03) |
| Clone method | `git clone`, then `git fetch --unshallow` to obtain history |
| Working tree | clean; the clone is read-only for this research |
| Local path used | `/tmp/sp_leaks` (not part of this repository) |

History checks that mattered:

* `Qwen/qwen3.8-max.md` was created on 2026-08-05 (`0e9f220`) and has not been
  modified since; `Qwen/qwen3.6-plus.md` was renamed on the same day
  (`dcd8a17`). There is no earlier Qwen behavioural prompt in the history.
* `Anthropic/official/` was renamed from `Official/` on 2026-08-17 (`3974e7e`)
  and has been appended to since (e.g. `f6eb40f`, 2026-09-01).
* The repository structure was reorganised on 2026-06-04 (`7b23d35`,
  "promote vendors from Misc, normalize filenames"), so path-based version
  claims before that date are unreliable.

---

## 4. Provenance classification

Classification is mechanical (`build_inventory.py` → `provenance()`) and was
reviewed by hand for the files read in full.

| Class | Files | Rule | Confidence in content |
| --- | --- | --- | --- |
| `officially_published` | 42 | under `Anthropic/official/`, dated, matching the vendor's practice of publishing system prompts for released models | **High** for the older entries (Claude 3/3.5 era), which correspond to the vendor's published prompt pages; **medium** for the 2026 entries, which could not be diffed against the vendor site from here |
| `extracted_with_documented_method` | 6 | under `Anthropic/raw/`, paired with a curated file of the same model | Medium: the pair exists, the extraction procedure does not |
| `community_contributed` | 1,237 | everything else in the collection | Medium for content plausibility, **low for any version claim** |
| `not_a_prompt` | 19 | schemas, scripts, READMEs, funding metadata | not applicable |

**Confidence in *content* is deliberately separated from *provenance*.** A
prompt can be plausibly real and still be from a different version than its
filename suggests (see §5), and an "official" label says nothing about whether
its instructions suit this deployment.

---

## 5. Verification performed, and what remains unverified

**Performed**

1. **Reproduction of every count.** `build_inventory.py` and
   `analyze_corpus.py` are in this directory and regenerate
   `PROMPT_INVENTORY.{json,csv}` and `corpus_analysis.json` from a clone; the
   numbers in `PROMPT_ANALYSIS.md` come from those files.
2. **Duplicate detection.** Exact duplicates by SHA-256 (128 files) and
   near-duplicates by MinHash over 5-word shingles with Jaccard ≥ 0.8 (14
   clusters). The clusters are consistent with version ladders, which is a
   sanity check on the method rather than proof of it.
3. **Structural consistency checks.** Files claiming the same model were
   compared by size and by normalised text similarity; where they differ, the
   inventory records a variant rather than merging them.
4. **Target-runtime checks.** The `llama.cpp` facts in §2 were read from the
   project's own README at a pinned commit, not inferred.
5. **Prompt properties enforced in CI.** `shared/prompts/qwen.test.ts` fails the
   build if the prompt gains template tokens, tool schemas, a date, a cutoff
   claim, another vendor's identity, or if it drifts from this directory's
   `SYSTEM_PROMPT.md`.

**Not performed, and therefore not claimed**

* **No independent corroboration of any leaked prompt.** No vendor document was
  reachable to diff against, so no file is asserted to be authentic, complete or
  current. The inventory's `confidence` fields say this per file.
* **No inspection of the collection's commit diffs for content tampering.** The
  history was used for dates and renames only.
* **No full reading of 1,304 files.** 19 were read end to end, 15 at section
  level, and all 318 prompt-carrying files went through the regex census. The
  coverage numbers are in `PROMPT_INVENTORY.json` → `coverage`, and
  `inspected_files.json` is the registry that produces them.
* **No model execution.** There is no GPU, no model file and no API key in this
  environment. See `PROMPT_EVALUATION.md`.

---

## 6. Unresolved authenticity and version questions

| # | Question | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Do the 2026-dated `Anthropic/official/` prompts match what the vendor actually serves? | Structure and tone are consistent with the older, independently known entries; no vendor page was reachable | **Unresolved.** Treated as plausible, not verified |
| 2 | Is `OpenAI/gpt-5.5-api.md`'s "Knowledge cutoff: 2024-06 [*sic*]" the model's cutoff or a copy-paste artefact? | It appears identically in `gpt-5.4-api.md` and `gpt-5.5-api.md` while both declare 2026 dates | **Unresolved.** The metadata is not usable as capability evidence |
| 3 | Are the huge Claude Code / Codex files one system message or several developer messages concatenated by the collector? | They contain sections that the product documents as separate (skills, MCP instructions, session context) | **Unresolved.** The analysis treats them as documents, never as a single insertable prompt |
| 4 | Does `Qwen/qwen3.8-max.md` reflect the model this repository deploys? | It is the *Qwen app* prompt (tools: `code_interpreter`, `web_search`, `web_extractor`), not a local GGUF persona | **No.** Relevant as family evidence only; nothing was copied from it |
| 5 | Are near-duplicate clusters really model-version differences? | Dated filenames and monotonic growth in the official series | **Probable, not proven.** No diff was attributed to a specific model change |
| 6 | Do the skill files (`Anthropic/claude-code/skills/*`, 886 files) belong to the system prompt? | They are loaded on demand by the product, not injected per request | **No.** Classified separately and excluded from the behavioural analysis |

---

## 7. Repository map (what was classified as what)

```
Anthropic   622 files  prompts, official prompts, raw extractions, claude-code, skills,
                       artifact types, integrations
Meta        470 files  muse-agent workspace (system prompt + skills), muse-code, sparks
OpenAI      124 files  chatgpt web prompts, API prompts, Codex, dots, tools
Google       25 files  gemini app/API/CLI, jules, workspace, notebooklm
xAI          16 files  grok app prompts and tool-heavy agent prompt
Misc         24 files  smaller third-party assistants and CLI agents
Microsoft     5 files  copilot CLI/Word/macOS/github.com/VS Code
Perplexity    5 files  consumer, deep research, computer, comet, voice
Qwen          2 files  tool schemas + identity line (no behavioural prompt)
Kimi          2 files  K3 agent prompt, K2.6
Mistral       2 files  code and medium
DeepSeek      1 file   date + search schema
GLM           1 file   README stating the model has no system prompt
Pi            1 file   minimal coding harness prompt
Cursor        1 file   cursor.md
Notion        1 file   notion-ai.md
```

Source paths in the table above are directories; per-file URLs, blob SHA-1s and
classifications are in `PROMPT_INVENTORY.json` (`source_url` is
`https://github.com/asgeirtj/system_prompts_leaks/blob/<commit>/<path>`).
