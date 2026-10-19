# PROMPT_ANALYSIS.md — synthesis by behavioral function

Evidence base: 23 deep-read files + machine inventory of 1,310 files @ `dfa2e28`. Patterns below cite the deep-read exemplars; they recur across variants (verified by headings/keyword sampling, not by reading every near-duplicate).

## Strongest reusable patterns (kept, rewritten in original wording)
| Pattern | Seen in (exemplars) | Why it works | In final prompt |
|---|---|---|---|
| Read codebase/context before editing; follow local patterns | Codex `gpt-5.5.md`/codex-full, Cursor, Gemini CLI | Prevents speculative patches & style churn | Coding section |
| Verify effect; run tests; report real results incl. failures | Claude Code, Codex, Copilot CLI | Converts "done" claims into evidence | Tools + Coding |
| Use provided context instead of re-asking; penalties for redundant questions | GPT-5.5 Instant personal-context rules | Cuts friction; context is there to be used | How to work |
| Parallelize independent tool calls; batch searches | Codex, Gemini CLI context-efficiency | Fewer turns, less context burn | Tools |
| Root-cause before patch; scoped edits; structured parsers over string hacks | Codex engineering judgment | Maintainability | Coding |
| Injection awareness: flag suspicious tool/pasted content | Claude Code system notes, reminders doc | Real attack surface in agent loops | Priorities + Safety |
| Resourceful before asking; come back with answers | Hermes SOUL.md, Pi instructions | Autonomy within authorization | How to work |
| Direct, filler-free communication | Hermes, Pi, Copilot CLI | Token efficiency, usability | Communication |

## Weak / non-transferable patterns (excluded)
- **Vendor runtime scaffolding:** Cursor's MCP/IDE tool catalogue, Notion's workspace concepts, Codex's `multi_tool_use.parallel` syntax, Qwen-chat's `<function=...>` XML calling format. These belong to the serving stack/tool schemas, not a portable system prompt. Pasting them into Qwen breaks or duplicates the real template.
- **Personality products:** ChatGPT personality variants, Grok personas, Hermes "soul" continuity-via-files. Persona is a product choice, not capability; the final prompt keeps only "direct, substantive, has a point of view when evidence supports it."
- **Mega-prompts (300–580k chars):** The largest Claude/Codex files bundle product policy, UI copy, skill catalogues, and tool docs. Length is mostly product surface, not reasoning quality; it burns context and creates internal conflicts. No evidence in-repo that longer = better.
- **Step/turn caps copied as virtue** (e.g. Kimi's 25-step limit): a runtime budget control. Enforce in the orchestrator if needed, not as behavioral text the model must self-police.

## Restrictions audit (§7 of mission) — classification
| Restriction found in sources | Class | Decision & rationale |
|---|---|---|
| Hard word caps on routine output (Copilot CLI "≤100 words") | 1 Unnecessary limitation | Removed. Arbitrary brevity truncates complex answers; replaced with "match depth to task." |
| Ask-permission / ask-first gates for ordinary tool use | 1 | Removed except for irreversible/external actions (Hermes' internal-vs-external distinction kept). Permission mode belongs to runtime config (Claude Code does this correctly at system level). |
| Blanket "never generate/guess URLs" style prohibitions | 1→3 partial | Relaxed to: don't fabricate citations/URLs as verified; linking well-known docs when confident is legitimate work. |
| Forced clarification when context already answers | 1 | Removed; inverted into an explicit rule to use context. |
| Multi-page repeated safety blocks (Mistral, Grok exemplars repeat near-identical bans) | 2/5 | Compressed to one brief, complete safety section. Repetition costs context without adding coverage; severity preserved. |
| Refusal-first framing for dual-use security work | 2 Task-specific + 4 boundary | Kept the Claude Code calibration: authorized/defensive/CTF/educational = assist; destructive/malicious = refuse that part. Not relaxed further. |
| "Never claim you browsed/executed" honesty rules | 4 Integrity boundary | **Preserved verbatim in spirit** (`MODULE_no_tools.txt` makes it explicit). This is anti-fabrication, not capability suppression. |
| Secret/credential protection, no committing secrets | 4 Security boundary | Preserved. |
| Product-specific content policies (image ID rules, copyright blocks, voice-mode rules) | 2 Task-specific | Excluded from core; belong in deployment policy if the product needs them. |
| Date/cutoff/identity hardcoding ("You are Qwen3.8, cutoff 2026") | 3 Runtime fact | Excluded from prompt text; inject from verified deployment config at runtime. Stale hardcodes are a top cause of confident wrong answers. |

**Net effect:** core prompt is 933 words vs tens/hundreds of thousands of chars in flagship leaks — every retained line maps to a behavior above. Untested hypothesis: shorter + non-conflicting improves instruction adherence on mid-size Qwen models. Must be A/B tested (see evaluation).

## Qwen-specific findings
- The repo's only Qwen files contain **no behavioral system prompt** — just date lines and tool JSON (`web_search`, `web_extractor`, `code_interpreter`, image tools, `bio` memory). Conclusion: there is no leaked "Qwen personality" to recover; the deployable asset is discipline borrowed from coding-agent prompts, rendered in ChatML.
- Qwen3+ ships **no default system prompt** (official docs), so supplying one is necessary and this deliverable fills a real gap; Qwen2.5's old default ("You are a helpful assistant") must not be assumed present.
- Tool-calling format differs per engine (Transformers Jinja vs Ollama vs vLLM). Hence: prompt text stays tool-format-agnostic; schemas stay in the template where they belong.

## Conflicts resolved
Identity ("you are X built by Y") ×17 vendors → neutral Qwen line. Verbose-vs-concise contradictions (Perplexity long-answer mode vs Copilot 100-word cap) → task-matched depth. "Always search first" (Notion) vs "never call tools without declarations" (Gemini) → conditional tool use keyed to actual runtime provision.
