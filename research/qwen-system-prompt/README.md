# Qwen System Prompt Research

Start here: **SYSTEM_PROMPT.md** (usage + blockers) → `system_prompt.txt` (the prompt) → `modules/` (pick one).
Evidence: `SOURCE_EVIDENCE.md` · Analysis: `PROMPT_ANALYSIS.md` · Inventory: `PROMPT_INVENTORY.json` (regenerate: `python3 build_inventory.py <leaks-clone> PROMPT_INVENTORY.json <sha>`) · Evaluation: `PROMPT_EVALUATION.md` + `eval/run_eval.py --dry-run`.
Status: candidate prompt, **not yet benchmarked** on a real Qwen deployment (none exists in this repo).
