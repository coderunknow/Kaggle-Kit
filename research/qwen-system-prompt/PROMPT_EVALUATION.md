# PROMPT_EVALUATION

What was actually executed, what was only prepared, and what remains
unverified. Nothing in this file is a model-quality claim: **no inference was
run**, because the environment has no GPU, no model file and no endpoint.

---

## 1. Configurations under comparison

| | Baseline | Candidate |
| --- | --- | --- |
| Application | this repository, commit under test | same commit |
| Model | `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` | identical weights and file |
| Runtime | `llama-server` b11719, `--ctx-size 8192`, `--jinja`, `--reasoning-effort medium` | identical |
| System message | **none** (profile field empty; `buildHistory()` omits it) | `SYSTEM_PROMPT.md` as the single system message |
| Sampling | `temperature 0.7`, `top_p 0.95`, `max_tokens 1024`, no penalties, no streaming | identical |
| Tools | none | none |

The only intended difference is the presence of the system message. Anything
else that changes between runs invalidates the comparison; the runner records
`temperature`, `max_tokens`, endpoint and the prompt SHA-256 in every result
file so that a mismatch is visible afterwards.

---

## 2. Executed in this environment

### 2.1 Repository test suite (real, not simulated)

```
npm test          → 11 test files, 96 tests passed (85 before this work)
npm run typecheck → tsc for client and server, no errors
npm run lint      → eslint ., no findings
```

New tests added by this work:

| Test | What it proves |
| --- | --- |
| `shared/prompts/qwen.test.ts` (9 tests) | the prompt has no chat-template tokens, no tool/function schema, no date, no cutoff claim, no other vendor's identity, stays under the context budget, keeps its safety clauses, and is character-identical to `SYSTEM_PROMPT.md` |
| `src/components/App.test.tsx` "inserted from the profile editor…" | clicking the button in the profile editor puts the prompt into the field, and after saving, the request that reaches `/api/proxy/chat` has it as `messages[0]` with role `system`, exactly once, followed by the user turn |
| `src/components/App.test.tsx` "sends no system message when the profile has no prompt" | the baseline path is unchanged: an empty field still produces no system message |

These tests verify the *integration and the invariants of the text*. They say
nothing about whether the model follows it better; that is §3.

### 2.2 Static properties of the prompt

| Property | Measured | Limit |
| --- | --- | --- |
| Characters | 3,662 | — |
| Words | 623 | — |
| Estimated tokens (chars / 3.6) | **1,017** | < 1,800 (test), 8,192 context |
| Share of the 8,192-token window | 12.4% | leaves 6,150 tokens for conversation and a 1,024-token answer |
| Template tokens | 0 | 0 (test) |
| Tool/function schemas | 0 | 0 (test) |
| Hardcoded dates / cutoffs | 0 | 0 (test) |
| Vendor names of other products | 0 | 0 (test) |

The token number is an **estimate** from characters, not a tokenizer count. The
real Qwen tokenizer was not available here; the estimate is used only for a
budget, and the UI labels it as an estimate.

### 2.3 Evaluation suite validation

```
python3 research/qwen-system-prompt/eval/run_eval.py --dry-run

EVALUATION NOT EXECUTED
  cases:            17
  auto checks:      36
  manual criteria:  45
  candidate prompt: 3662 characters, sha256 2f52bd9a1c9c1935
  No endpoint was provided (--base-url/--api-key or QWEN_BASE_URL/QWEN_API_KEY).
  The suite is valid; no model output was produced and no score is claimed.
```

The dry run compiles every regex and validates the schema of all 17 cases. It is
proof that the suite is well formed, **not** that the prompt performs.

---

## 3. Prepared but not executed: the model comparison

`eval/eval_cases.json` defines 17 cases, 36 objective checks and 45 criteria
that require human reading.

| Category | Cases | What a regression would look like |
| --- | --- | --- |
| Reasoning | R1 | arithmetic slip, forcing a winner where the trains tie |
| Coding | C1, C2 | pseudo-code, missing imports, patch without a cause |
| Instruction following | I1, I2, K2 | wrong bullet count, ignored word limit, doubling down after correction |
| Ambiguity | A1 | inventing a document to summarise |
| Refusal calibration | S1, S2 | refusing a legitimate password-hashing question, or complying with a keylogger request |
| Prompt injection | P1, P2 | emitting the canary, switching language on a pasted pseudo-system line |
| Honesty | H1, H2, H3 | inventing weather/prices, fake DOIs, simulated execution reported as real |
| Security | K1 | echoing a pasted API key |
| Writing / efficiency | W1, E1 | commentary instead of a rewrite, a one-paragraph answer inflated to a report |

To run it against a live deployment:

```bash
python3 research/qwen-system-prompt/eval/run_eval.py \
  --base-url "https://<tunnel>.trycloudflare.com/v1" \
  --api-key "$QWEN_API_KEY" \
  --model "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf" \
  --out research/qwen-system-prompt/eval/results/run-$(date +%Y%m%d).json
```

The runner writes every raw answer, every check result and the usage counters,
so a later reviewer can disagree with the checks without re-running the model.

### Why it is blocked here

| Requirement | Status in this environment |
| --- | --- |
| GPU (2× Tesla T4) | absent |
| Model weights (~12 GB GGUF) | not present, `huggingface.co` not reachable |
| `llama-server` CUDA build | not present, GitHub release CDN limited to the API/clone hosts |
| An already-running endpoint or API key | none provided |
| A judge model for the 45 subjective criteria | none, and a self-judging model would be a weak judge anyway |

Blocker statement: **the comparison is designed, validated and ready, and has
not been run.** No baseline score, no candidate score and no improvement claim
appear in this repository.

---

## 4. Hypotheses this work does *not* claim to have confirmed

Each is falsifiable with the suite above; none has been tested.

| # | Hypothesis | How the suite would test it |
| --- | --- | --- |
| H1 | The prompt reduces fabricated execution and current-data claims (H1, H3) | baseline is expected to *sometimes* answer "the weather is…" without a tool; the candidate should refuse to invent |
| H2 | The prompt reduces invented citations (H2) | count DOIs in baseline vs candidate output |
| H3 | The prompt improves instruction adherence on format and length (I1, I2) | both variants usually follow explicit formatting; a small model at IQ3_S is where the prompt is expected to help |
| H4 | The prompt does **not** meaningfully improve multi-step arithmetic (R1) | arithmetic is a capability, not a behaviour; no difference expected |
| H5 | The "no tools" paragraph reduces helpfulness on tasks where the user wants execution help | watch H3/C1 for over-refusal; this is the main risk of the prompt |
| H6 | 1,017 tokens of prompt costs noticeable latency at IQ3_S on two T4s | measure `elapsed_s` in the result file; prompt processing dominates only on long conversations |
| H7 | A 27B model at IQ3_S adheres to a 1k-token prompt as well as to a 300-token one | requires a third variant; not yet defined |

H5 is the hypothesis with the most downside: telling a model "you cannot run
code" can leak into refusing to *discuss* code. If a run shows that, the fix is
to narrow the sentence to "you cannot execute commands in this conversation",
not to delete the boundary.

---

## 5. Statistical honesty

* **One sample per case is not evidence of a difference.** llama.cpp does not
  expose a per-request seed through this API, so repeated runs differ. The
  protocol says: run the suite at least three times and compare the failure
  sets, not the raw pass rate.
* **36 auto-checks are not a benchmark.** They are targeted probes for the
  failure modes that this prompt is supposed to prevent. A 100% pass rate would
  mean "no obvious failure on these probes", not "good model".
* **Regex checks can be gamed by the model, and by me.** `absent "..."` in C1
  would also reject an ellipsis inside a comment; `max_words` counts code
  tokens as words. The manual criteria exist for exactly this reason, and the
  runner marks `manual_review_required: true`.
* **No comparison across quantizations, engines or models was made.** The
  mission forbids silently swapping a variable; the suite pins the endpoint and
  the model name in the result file rather than trying to normalise them.

---

## 6. What would make this evaluation complete

1. A Kaggle session with the deployment script running, or any machine with a
   CUDA build and the GGUF file.
2. Three full runs of both variants, saved under `eval/results/`.
3. A human pass over the 45 manual criteria, recorded per case.
4. A decision on R6 (runtime date injection) before evaluating H1/H3 again,
   because the baseline has no date and the candidate has none either; adding it
   changes both arms.
