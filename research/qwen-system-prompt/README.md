# Qwen system prompt research

Evidence-driven construction of a system prompt for the deployment in this
repository: `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` on `llama-server`, 8 192-token
context, one system message, **no tools**.

| File | What it is |
| --- | --- |
| [`SYSTEM_PROMPT.md`](SYSTEM_PROMPT.md) | the final prompt, its target configuration, the evidence per block and the deliberate omissions. Canonical copy: `shared/prompts/qwen.ts` |
| [`PROMPT_INVENTORY.json`](PROMPT_INVENTORY.json) / [`.csv`](PROMPT_INVENTORY.csv) | per-file inventory of the primary source repository: path, URL, blob SHA-1, classification, provenance, coverage, compatibility, strengths, risks |
| [`SOURCE_EVIDENCE.md`](SOURCE_EVIDENCE.md) | revisions, provenance classes, what was verified and what was not, per-source confidence |
| [`PROMPT_ANALYSIS.md`](PROMPT_ANALYSIS.md) | behavioural analysis of the corpus, the restriction removals with their classification, conflicts, runtime dependencies |
| [`PROMPT_EVALUATION.md`](PROMPT_EVALUATION.md) | evaluation protocol, what ran, what is blocked, and the unverified hypotheses |
| [`corpus_analysis.json`](corpus_analysis.json) | machine-readable census behind every number in the analysis |
| [`build_inventory.py`](build_inventory.py) | regenerates the inventory from a clone (standard library only) |
| [`analyze_corpus.py`](analyze_corpus.py) | regenerates the theme census and the recurring-directive extraction |
| [`inspected_files.json`](inspected_files.json) | coverage registry: which files were read in full, which at section level |
| [`eval/eval_cases.json`](eval/eval_cases.json) | 17 cases, 36 objective checks, 45 manual criteria |
| [`eval/run_eval.py`](eval/run_eval.py) | baseline-vs-candidate runner against a live endpoint; `--dry-run` validates without a model |

## Reproduce

```bash
git clone https://github.com/asgeirtj/system_prompts_leaks /tmp/sp_leaks
python3 research/qwen-system-prompt/build_inventory.py --repo /tmp/sp_leaks
python3 research/qwen-system-prompt/analyze_corpus.py --repo /tmp/sp_leaks
python3 research/qwen-system-prompt/eval/run_eval.py --dry-run
```

The inspected revision is recorded in `SOURCE_EVIDENCE.md`. The clone is not
part of this repository and nothing from it is copied into the product: the
prompt in `SYSTEM_PROMPT.md` is original text, written from the behavioural
patterns the analysis extracted.

## Honest status

* Inventory and analysis: **done**, with coverage stated per file.
* Prompt and integration: **done**, tested through the application.
* Model evaluation: **not run** — no GPU, no weights, no endpoint. No score is
  claimed anywhere.
