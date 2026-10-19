#!/usr/bin/env python3
"""
Quantitative census of the collected prompt corpus.

The inventory answers "what is in the repository". This script answers "what do
the prompts actually tell a model to do", by counting directive themes across
every prompt-carrying file and by recording the strongest example of each theme
with a `path:line` reference so that every claim in PROMPT_ANALYSIS.md can be
traced back to source text.

Usage
-----
    python3 research/qwen-system-prompt/analyze_corpus.py --repo /path/to/clone

Outputs `corpus_analysis.json` next to this script.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Pattern, Sequence, Tuple

HERE = Path(__file__).resolve().parent

PROMPT_CATEGORIES = {"system_prompt", "instruction_fragment", "subagent_instruction", "agent_instruction"}

# --------------------------------------------------------------------------
# Theme definitions
#
# Every theme is a (name, group, regex, description). The regexes are written
# to match the *instruction*, not the topic: "you must test" is a directive,
# "tests are useful" is not.
# --------------------------------------------------------------------------

THEMES: Tuple[Tuple[str, str, str, str], ...] = (
    # A. reasoning and problem solving
    ("reasoning_explicit", "A_reasoning", r"\b(think (?:step[- ]by[- ]step|carefully|through)|reason (?:carefully|through)|work through)\b", "asks for explicit, deliberate reasoning"),
    ("decompose", "A_reasoning", r"\b(break (?:it |the (?:problem|task) )?down|sub-?tasks?|sub-?problems?|decompos\w+)\b", "asks to split a task into parts"),
    ("edge_cases", "A_reasoning", r"\b(edge[- ]cases?|corner cases?|boundary conditions?|failure modes?)\b", "asks to consider edge cases"),
    ("compare_options", "A_reasoning", r"\b(trade-?offs?|compare (?:the )?(?:options|approaches|alternatives)|alternatives?)\b", "asks to weigh alternatives"),
    ("self_correction", "A_reasoning", r"\b(self[- ]correct\w*|revise (?:your|the) (?:answer|conclusion|plan)|if you (?:realise|realize|discover) (?:you|that you))\b", "asks to revise wrong conclusions"),
    ("constraints_first", "A_reasoning", r"\b(constraints?|requirements? (?:first|before)|dependencies)\b", "asks to establish constraints"),
    # B. instruction adherence
    ("clarify_sparingly", "B_instruction", r"\b(?:avoid|don't|do not|never) (?:ask(?:ing)? (?:the user )?(?:unnecessary|unneeded) )?(?:clarif\w+|questions?)\b|\bonly ask (?:a )?clarif\w+", "limits clarification questions"),
    ("ask_when_needed", "B_instruction", r"\bif (?:the (?:request|task|intent|query) is )?(?:unclear|ambiguous)|(?:ask|clarify) (?:the user )?(?:for|if)\b.{0,40}\b(?:unclear|ambiguous|missing)", "asks when the request is genuinely ambiguous"),
    ("assumption_stated", "B_instruction", r"\b(state|stating|make|making|document) (?:your |an |the )?assumptions?\b|\bstate (?:what|that) you assumed\b", "requires assumptions to be stated"),
    ("format_request_followed", "B_instruction", r"\b(follow (?:the )?(?:user's|their|requested) (?:format|instructions|requirements|constraints)|user's (?:instructions|requirements) (?:take|have) precedence)\b", "explicit precedence for user requirements"),
    ("no_reexplaining", "B_instruction", r"\bdo not re-?(?:derive|litigate|explain|repeat|re-?read)\b", "stops repetition of settled work"),
    # C. coding and engineering
    ("read_before_edit", "C_coding", r"\b(read (?:the |a )?file|inspect (?:the )?(?:code|repository|codebase)|understand (?:the )?(?:code|codebase|architecture))\b", "investigates the code before changing it"),
    ("root_cause", "C_coding", r"\b(root cause|not a symptom|underlying (?:cause|issue)|reproduce (?:the )?(?:bug|issue|failure))\b", "demands root cause analysis"),
    ("run_tests", "C_coding", r"\b(run (?:the )?(?:tests?|checks?|linters?|type ?check)|npm test|pytest)\b", "requires running tests"),
    ("verify_claims", "C_coding", r"\b(verify (?:your|the|that)|confirm (?:it|that|the) (?:works|passes)|do not claim|don't claim|only claim)\b", "requires verification before claiming success"),
    ("regression_check", "C_coding", r"\b(regressions?|did not break|doesn't break|didn't break|breaking change|break (?:other|anything))\b", "checks for regressions"),
    ("report_blockers", "C_coding", r"\b(if you (?:cannot|can't|are unable to)|report (?:what|that) (?:you|was)|blocked|unfinished|what remains)\b", "reports incomplete work accurately"),
    ("match_style", "C_coding", r"\b(match (?:the )?(?:surrounding|existing|current) (?:code|style|conventions?|idiom)|reads like the surrounding|existing conventions?|follow (?:the )?(?:existing|project) (?:style|conventions?))\b", "fits existing conventions"),
    # D. tool use and autonomy
    ("tool_guidance", "D_tools", r"\b(tool calls?|use the .{0,30}tool|call the .{0,30}tool)\b", "discusses tool use"),
    ("tool_failure", "D_tools", r"\b(tool (?:call )?(?:fails|failed|error|returns an error)|if the tool|retry the tool|after (?:two|2|three|3) (?:failed )?attempts)\b", "handles tool failures"),
    ("parallel_tools", "D_tools", r"\b(parallel|in a single (?:response|message|block)|simultaneous(?:ly)? (?:tool )?calls?)\b", "batches independent tool calls"),
    ("autonomy_persistence", "D_tools", r"\b(autonom\w+|persist|keep working|bias (?:towards|toward) action|carry (?:the )?(?:task|work) (?:to|through) (?:completion|completely)|until (?:the )?(?:task|goal|work) is (?:complete|done))\b", "works autonomously to completion"),
    ("permission_judgment", "D_tools", r"\b(ask (?:the user )?for permission|without asking|reversible|irreversible|authori[sz]ation|confirm (?:before|with))\b", "defines when to seek permission"),
    ("verify_tool_effect", "D_tools", r"\b(verify (?:the )?(?:effect|result|output|change|outcome)|check (?:that )?(?:it|the change|the result) (?:worked|succeeded|took effect)|confirm (?:the )?(?:change|result) (?:worked|is live))\b", "verifies the effect of actions"),
    # E. knowledge and factual reliability
    ("search_when_current", "E_knowledge", r"\b(search|web_search|browse)\b.{0,60}\b(current|latest|up[- ]to[- ]date|verify|recent|news|cutoff)\b|\bsearch (?:first|the web|for current)", "searches for current information"),
    ("cite_sources", "E_knowledge", r"\b(cite|citation|sources? (?:for|should|must)|link (?:to|the) sources?)\b", "requires source attribution"),
    ("uncertainty_honest", "E_knowledge", r"\b(uncertain\w*|not sure|don't know|do not know|acknowledge (?:uncertainty|what you don't)|if unsure)\b", "permits explicit uncertainty"),
    ("no_fabrication", "E_knowledge", r"\b(do not (?:fabricate|invent|make up|hallucinate)|never (?:fabricate|invent|make up)|don't make up)\b", "forbids invented facts"),
    ("cutoff_awareness", "E_knowledge", r"\b(knowledge (?:cutoff|cut-off|base)|training data (?:ends|is current))\b", "declares a knowledge cutoff"),
    # F. communication
    ("conciseness", "F_communication", r"\b(be (?:concise|brief)|concise\w*|brevity|keep (?:it|responses?) (?:short|brief))\b", "asks for brevity"),
    ("verbosity_cap", "F_communication", r"\b(\d{1,4} words? or less|no more than \d{1,4} words|under \d{1,4} words)\b", "hard word limit"),
    ("formatting_rules", "F_communication", r"\b(bullet|markdown|headers?|numbered lists?|formatting)\b", "regulates formatting"),
    ("no_disclaimers", "F_communication", r"\b(no (?:unsolicited )?(?:disclaimers?|warnings?|caveats?)|avoid (?:unnecessary )?(?:disclaimers?|apologies)|do not (?:add|introduce) (?:unsolicited )?(?:warnings|disclaimers|approval))\b", "suppresses boilerplate disclaimers"),
    ("anti_sycophancy", "F_communication", r"\b(sycophan\w+|flatter\w*|do not (?:praise|compliment)|push back|disagree when|honest(?:y)? about|avoid (?:forced )?enthusiasm)\b", "resists flattery and false agreement"),
    ("no_apology_loop", "F_communication", r"\b(apolog\w+|no protracted apologies|avoid unnecessary apologies)\b", "regulates apologies"),
    ("refusal_style", "F_communication", r"\b(refus\w+|decline\w*|will not (?:help|assist|provide))\b", "defines refusal behaviour"),
    # G. memory and context
    ("memory_use", "G_memory", r"\b(memor\w+|memory (?:file|tool|listing|directory))\b", "memory feature"),
    ("context_management", "G_memory", r"\b(context (?:window|management|length|limit)|summari[sz]e the conversation|compaction)\b", "context management"),
    ("track_progress", "G_memory", r"\b(todo|progress (?:update|tracking)|keep track|checklist)\b", "tracks progress"),
    # H. safety, security, instruction hierarchy
    ("injection_resistance", "H_safety", r"\b(prompt injection|jailbreak|injected instructions?|untrusted (?:content|input|text)|ignore (?:any )?(?:previous|prior) instructions?)\b", "prompt injection resistance"),
    ("instruction_hierarchy", "H_safety", r"\b(higher priority|lower priority|takes precedence|overrides?|system (?:message|turn)s? (?:are|is) (?:system|trusted))\b", "explicit instruction hierarchy"),
    ("credential_protection", "H_safety", r"\b(credential\w*|secrets?|api keys?|passwords?|sensitive (?:data|information))\b", "credential handling"),
    ("authorization_boundary", "H_safety", r"\b(authori[sz]ed|unauthori[sz]ed|permission (?:mode|to)|consent)\b", "authorization boundary"),
    ("harm_policy", "H_safety", r"\b(harmful|illegal|weapons?|malware|self-harm|csam|sexual content)\b", "harm policy"),
    ("identity_lock", "H_safety", r"\b(you are (?:still )?(?:claude|chatgpt|grok|gemini|kimi|qwen)|even if .{0,40}(?:role|persona)|stay in character)\b", "identity anchoring"),
    # Restrictions / friction
    ("capability_denial", "R_restriction", r"\b(you (?:do not|don't|cannot|can't) (?:have access|access|browse|run|execute)|no internet access|you have no (?:ability|access))\b", "claims a missing capability"),
    ("product_policy_only", "R_restriction", r"\b(this isn't permitted in|not permitted in (?:claude|chatgpt)|thumbs-down|report (?:it|this) to (?:us|anthropic|openai))\b", "policy tied to a specific product's UI"),
    ("ui_artifact_directive", "R_restriction", r"\b(artifact|canvas|<antml:|render component)\b", "UI/artifact specific instruction"),
    ("copyright_clause", "R_restriction", r"\b(copyright\w*|song lyrics|public domain)\b", "copyright clause"),
    ("personality_mandate", "R_restriction", r"\b(warm tone|enthusiastic|playful|friendly and engaging|curious and|you are (?:intellectually )?curious)\b", "personality mandate"),
    ("date_hardcoded", "R_restriction", r"\b(current date|today'?s date|the current time is|current actual time)\b", "hardcoded date"),
)


def compile_themes() -> List[Tuple[str, str, Pattern[str], str]]:
    return [(name, group, re.compile(pattern, re.IGNORECASE), description) for name, group, pattern, description in THEMES]


def load_inventory(path: Path) -> Dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def iter_prompt_files(inventory: Dict[str, object], repo: Path) -> Iterable[Tuple[Dict[str, object], str]]:
    for entry in inventory["entries"]:  # type: ignore[index]
        if entry["category"] not in PROMPT_CATEGORIES:
            continue
        path = repo / entry["path"]
        try:
            yield entry, path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue


def first_example(text: str, pattern: Pattern[str], limit: int = 160) -> str:
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = pattern.search(line)
        if match:
            snippet = line.strip()
            if len(snippet) > limit:
                start = max(0, match.start() - 40)
                snippet = snippet[start : start + limit].strip()
                snippet = ("…" if start else "") + snippet + "…"
            return f"L{line_number}: {snippet}"
    return ""


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, default=HERE / "PROMPT_INVENTORY.json")
    parser.add_argument("--out", type=Path, default=HERE / "corpus_analysis.json")
    args = parser.parse_args(argv)

    repo = args.repo.resolve()
    inventory = load_inventory(args.inventory)
    themes = compile_themes()

    total_prompt_files = 0
    group_counts: Counter[str] = Counter()
    file_theme_hits: Dict[str, Counter[str]] = {}
    examples: Dict[str, List[str]] = defaultdict(list)
    provider_hits: Dict[str, Counter[str]] = defaultdict(Counter)
    directory_hits: Dict[str, Counter[str]] = defaultdict(Counter)

    for entry, text in iter_prompt_files(inventory, repo):
        total_prompt_files += 1
        path = str(entry["path"])
        provider = str(entry["provider"])
        top = path.split("/")[0]
        hits: Counter[str] = Counter()
        for name, group, pattern, _ in themes:
            matches = pattern.findall(text)
            if matches:
                hits[name] += len(matches)
                group_counts[group] += 1
                provider_hits[provider][name] += 1
                directory_hits[top][name] += 1
                if len(examples[name]) < 6:
                    sample = first_example(text, pattern)
                    if sample:
                        examples[name].append(f"{path} {sample}")
        file_theme_hits[path] = hits

    # Coverage per theme: in how many files does the theme appear at all?
    theme_file_counts: Counter[str] = Counter()
    for hits in file_theme_hits.values():
        for name in hits:
            theme_file_counts[name] += 1

    theme_report = []
    for name, group, pattern, description in themes:
        count = theme_file_counts[name]
        theme_report.append(
            {
                "theme": name,
                "group": group,
                "description": description,
                "regex": pattern.pattern,
                "files_mentioning": count,
                "share_of_prompt_files": round(count / total_prompt_files, 3) if total_prompt_files else 0.0,
                "total_matches": sum(hits[name] for hits in file_theme_hits.values()),
                "examples": examples[name],
            }
        )

    # Group level summary: share of prompt files that touch a group at all.
    group_summary: Dict[str, object] = {}
    for group in sorted({theme[1] for theme in THEMES}):
        files = sum(
            1
            for hits in file_theme_hits.values()
            if any(name for name, g, _, _ in themes if g == group and hits.get(name))
        )
        group_summary[group] = {
            "files": files,
            "share": round(files / total_prompt_files, 3) if total_prompt_files else 0.0,
        }

    # Provider profile: which themes dominate in which vendor's prompts.
    provider_profile = {
        provider: {"files_with_theme": dict(sorted(counter.items(), key=lambda kv: -kv[1])[:12])}
        for provider, counter in sorted(provider_hits.items())
    }
    directory_profile = {
        top: {"files_with_theme": dict(sorted(counter.items(), key=lambda kv: -kv[1])[:12])}
        for top, counter in sorted(directory_hits.items())
    }

    # Restriction census: the specific lines that suppress capability.
    restriction_patterns = {
        "ask_permission": r"\b(ask (?:the user )?for permission|ask before|confirm before|requires? (?:user )?approval|explicit confirmation|without asking)\b",
        "no_need_to_ask": r"\b(do not ask (?:the user )?for (?:permission|confirmation)|don't ask for permission|no need to ask|do not stop to ask)\b",
        "no_clarifying_questions": r"\b(do not ask (?:the user )?(?:clarifying|follow-up) questions?|don't ask clarifying|avoid (?:asking )?(?:unnecessary )?clarifying questions?)\b",
        "word_limit": r"\b(\d{2,4} words? or less|no more than \d{2,4} words|under \d{2,4} words)\b",
        "no_web_access": r"\b(you (?:do not|don't) have (?:access to )?(?:the )?(?:internet|web)|no internet access|do not (?:search|browse) the (?:web|internet))\b",
        "refuse_coding": r"\b(do not (?:write|provide) (?:code|malware)|cannot (?:write|provide) code|does not write,? explain,? or work on malicious code)\b",
        "hide_instructions": r"\b(?:never|do not|don't) (?:reveal|disclose|mention|divulge|share)\b[^.]{0,40}\b(?:prompt|instructions|guidelines)\b",
        "no_opinion": r"\b(do not (?:express|share|give) (?:personal )?opinions?|never (?:express|share) opinions?|not partisan|do not endorse)\b",
        "always_disclaimer": r"\b(always (?:include|add|begin) (?:a )?(?:disclaimer|with a disclaimer)|must (?:include|add) a disclaimer)\b",
        "deny_inner_life": r"\b(you (?:do not|don't) have (?:feelings|emotions)|not (?:sentient|conscious)|never (?:claim|imply) to be (?:human|sentient))\b",
    }
    restriction_report = {}
    for label, pattern in restriction_patterns.items():
        compiled = re.compile(pattern, re.IGNORECASE)
        files = []
        occurrences = 0
        for entry, text in iter_prompt_files(inventory, repo):
            found = compiled.findall(text)
            if found:
                files.append(str(entry["path"]))
                occurrences += len(found)
        restriction_report[label] = {
            "files": len(files),
            "share_of_prompt_files": round(len(files) / total_prompt_files, 3) if total_prompt_files else 0.0,
            "occurrences": occurrences,
            "examples": files[:8],
        }

    # Directive frequency: normalised directive sentences that recur across
    # many files. This is the systematic surrogate for reading every prompt in
    # full: it surfaces the instructions a vendor considered worth repeating,
    # and it shows how much of a prompt corpus is boilerplate.
    directive_pattern = re.compile(
        r"\b(must|never|always|do not|don't|avoid|only|prefer|required|should)\b", re.IGNORECASE
    )
    sentence_split = re.compile(r"(?<=[.!?])\s+")
    directive_counts: Counter[str] = Counter()
    directive_files: Dict[str, set] = defaultdict(set)
    for entry, text in iter_prompt_files(inventory, repo):
        path = str(entry["path"])
        for sentence in sentence_split.split(text.replace("\n", " ")):
            sentence = re.sub(r"\s+", " ", sentence).strip()
            if len(sentence) < 25 or len(sentence) > 220:
                continue
            if not directive_pattern.search(sentence):
                continue
            # Only directives addressed to the model, not schema prose.
            if not re.match(
                r"(?i)^(?:you|do not|don't|never|always|avoid|prefer|only|when the user|if the user|when you|if you|the assistant|claude|must|should)",
                sentence,
            ):
                continue
            key = re.sub(r"[^a-z0-9 ]", "", sentence.lower())
            key = re.sub(r"\s+", " ", key).strip()
            if len(key) < 20:
                continue
            directive_counts[key] += 1
            directive_files[key].add(path)

    def is_schema_boilerplate(sentence: str) -> bool:
        vocabulary = (
            "type string",
            "description",
            "enum",
            "properties",
            "required",
            "json",
            "yaml",
            "parameter",
            "schema",
            "mime",
            "field",
            "tab id",
            "tabscontext",
            "calendar",
            "email address",
        )
        hits = sum(1 for token in vocabulary if token in sentence)
        return hits >= 2 or "{" in sentence or "}" in sentence

    recurring = [
        {
            "directive": key,
            "occurrences": count,
            "distinct_files": len(directive_files[key]),
            "example_files": sorted(directive_files[key])[:3],
        }
        for key, count in directive_counts.most_common(600)
        if len(directive_files[key]) >= 3 and not is_schema_boilerplate(key)
    ][:40]

    output = {
        "generated_on": "2026-10-19",
        "source_revision": inventory["primary_repository"]["commit_sha"],  # type: ignore[index]
        "prompt_files_analyzed": total_prompt_files,
        "method": (
            "Regex census over every file classified as a system prompt, instruction fragment, "
            "subagent instruction or agent instruction. Counts are of *files that contain at least one "
            "match*, not of matches, so a single verbose file cannot dominate the result. Regexes are "
            "deliberately broad: a theme count is evidence that the theme is discussed, not proof that "
            "it is implemented well."
        ),
        "theme_report": sorted(theme_report, key=lambda item: -item["files_mentioning"]),
        "group_summary": group_summary,
        "provider_profile": provider_profile,
        "directory_profile": directory_profile,
        "restriction_census": restriction_report,
        "recurring_directives": recurring,
        "recurring_directives_method": (
            "Sentences of 25-220 characters that contain a modal directive are normalised "
            "(lowercase, punctuation removed) and counted. Only sentences that appear in at "
            "least three distinct prompt files are reported, so product-specific one-offs are "
            "excluded by construction."
        ),
    }
    args.out.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"prompt files analysed: {total_prompt_files}\n")
    print(f"{'theme':26} {'group':16} {'files':>6} {'share':>6}")
    for item in output["theme_report"]:
        print(f"{item['theme']:26} {item['group']:16} {item['files_mentioning']:>6} {item['share_of_prompt_files']:>6.0%}")
    print("\nrestriction census")
    for label, item in restriction_report.items():
        print(f"  {label:18} {item['files']:>4} files ({item['share_of_prompt_files']:.0%})")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
