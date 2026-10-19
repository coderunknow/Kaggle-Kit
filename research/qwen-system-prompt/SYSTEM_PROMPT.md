# SYSTEM_PROMPT.md — Qwen system prompt (candidate, untested on target weights)

**Status:** Evidence-informed candidate. NOT benchmarked on any Qwen deployment yet — see `PROMPT_EVALUATION.md`. Do not claim improvement until the eval harness is run against the actual model.

**Target discovery (2026-10-19):** The current workspace (`coderunknow/Kaggle-Kit`, commit `7430590`, branch `arena/a434278f-kaggle-kit`) contained only `LICENSE` — no application, model config, chat template, tool schemas, or tests. Therefore:
- Exact Qwen model/revision, quantization, inference engine, context length: **unknown — not invented here.**
- This prompt is model-family-appropriate for Qwen chat models (ChatML) but must be confirmed against the real deployment before use.
- Integration is **blocked by missing project context** (no integration point exists). `examples/` shows the intended wiring once a deployment exists.

## How to use
1. Put the contents of `system_prompt.txt` in the **system role** — never concatenate it into user messages.
2. Append exactly one conditional module from `modules/` that matches the runtime (`MODULE_coding.txt`, `MODULE_research.txt`, or `MODULE_no_tools.txt`). Do not stack all modules.
3. Let the serving stack (vLLM / SGLang / Ollama / llama.cpp / Transformers) render its own verified chat template and tool schemas. Do **not** paste tool JSON or `<|im_start|>` tokens into the system text — the template adds them. The Qwen files in the leaks repo (`Qwen/qwen3.6-plus.md`, `Qwen/qwen3.8-max.md`) are almost entirely tool-schema JSON with dates and contain no reusable behavioral prompt; copying them would duplicate the runtime's job and go stale.
4. Replace nothing else. There are deliberately no hardcoded dates, cutoffs, URLs, model names beyond "Qwen", tools, or memory claims.

## ChatML serialization (reference only — prefer `tokenizer.apply_chat_template`)
```text
<|im_start|>system
{system_prompt.txt + one module}<|im_end|>
<|im_start|>user
{user message}<|im_end|>
<|im_start|>assistant
```
Official basis: Qwen docs state Qwen uses ChatML `<|im_start|>{role}\n{content}<|im_end|>`, supports a `system` role, and that starting with Qwen3 no default system message is used — so an explicit system prompt must be supplied by the deployment, and Qwen2.5-era default text must not be assumed. Thinking mode (`enable_thinking`, empty `<think></think>` insertion when disabled) is a template/generation option, not system-prompt text; set it in generation config, not here.

## The prompt
The canonical text lives in **`system_prompt.txt`** (933 words, ~6,141 chars, roughly ~1.5k tokens by a crude 4-chars/token estimate — measure with the real tokenizer). It is reproduced in full inside that file only, to avoid divergent copies. Sections: Priorities · How to work · Reasoning and reliability · Tools (conditional) · Coding and technical work · Communication · Memory and context · Safety and integrity.

## Design choices (summary; full reasoning in PROMPT_ANALYSIS.md)
- Kept: investigate-before-editing, root-cause debugging, verify-before-claiming-success, parallel independent tool calls, use-context-instead-of-re-asking, injection resistance, brief refusals with alternatives, honest blocked reporting.
- Removed/relaxed (from source prompts, not from any Qwen baseline): blanket word caps, mandatory clarification/permission gates, forced step limits copied from other products, vendor tool names/UI instructions, personality gimmicks, and multi-page safety repetitions. Each removal is classified and justified in `PROMPT_ANALYSIS.md` §Restrictions.
- Preserved boundaries: secret protection, instruction hierarchy, authorization limits, no fabricated results/citations, defensive-security limits.

## Remaining integration blockers
1. No Qwen deployment in this repo (model, engine, template, tools all unknown).
2. No baseline prompt exists to A/B against.
3. No model execution available in this environment (no GPU/weights/API key), so all effectiveness claims are hypotheses until `eval/run_eval.py` is run against the real endpoint.
