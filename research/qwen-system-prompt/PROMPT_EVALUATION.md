# PROMPT_EVALUATION.md

## What was actually executed (2026-10-19, this environment)
| Test | Result |
|---|---|
| Inventory generation (`build_inventory.py` on clone @ `dfa2e28`) | ✅ 1,310 records written to `PROMPT_INVENTORY.json` |
| Prompt hygiene checks (`run_eval.py --dry-run`) | See run output in repo session; checks: files exist, 19 cases parse, core prompt contains no hardcoded tool names/dates/ChatML tokens |
| Model benchmark (baseline vs candidate on Qwen) | ❌ **NOT RUN — blocker:** workspace has no Qwen deployment, no weights, no GPU, no API endpoint/key. No scores are claimed. |

## Methodology (for when the deployment exists)
1. Fix one configuration: exact model id+revision, engine+version, quantization, chat template, temperature 0, same max tokens, same tools. Record all of it in the results header.
2. Baseline = deployment's current system prompt (or empty system, if none — Qwen3 default). Candidate = `system_prompt.txt` + the one matching module.
3. Run `eval/run_eval.py --endpoint <base-url>` with `MODEL=` set; it writes raw outputs to `eval/results.jsonl`. Never swap model/engine mid-comparison.
4. Score each output 0 (fail) / 1 (partial) / 2 (pass) against the case's `pass` criterion in `eval/eval_cases.json`, blind to config where possible. Report per-category totals, regressions, and token counts (real tokenizer, not estimates).
5. Repeat the coding cases by actually executing generated code/tests; a plausible-looking answer is not a pass.

## Test set (19 cases, `eval/eval_cases.json`)
Reasoning ×2 · Coding ×2 (executable) · Instruction following ×2 (exact-format) · Ambiguity ×2 · Prompt injection ×2 · Unnecessary-refusal ×2 · Honesty/no-fabrication ×2 · Research ×1 · Tool use ×1 · Context/memory ×1 · Safety boundary ×1 · Communication efficiency ×1.

## Hypotheses (labelled, unverified)
- H1: Candidate reduces redundant clarification questions (ambig/memory cases) vs verbose leaked-style prompts.
- H2: Candidate reduces fabricated success claims (honest/tool cases) vs no-system-prompt baseline.
- H3: Candidate's shorter length improves exact-format adherence (follow cases) vs mega-prompt baselines.
Each hypothesis is falsified if its category score does not improve at equal settings. Until then, **the final prompt is a candidate, not a proven improvement.**

## Known limitations
No live model results; judge-based scoring has variance (mitigate: temperature 0, blind scoring, double-score disagreements); 19 cases cover breadth, not statistical power — expand per-category before production rollout.
