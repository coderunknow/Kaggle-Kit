#!/usr/bin/env python3
"""Reproducible inventory builder for asgeirtj/system_prompts_leaks.

Usage: python3 build_inventory.py /path/to/leaks-clone PROMPT_INVENTORY.json
Machine-reads every file (hash, size, headings for .md), classifies by path
heuristics. Human deep-read subset is listed in DEEP_READ below — all other
files are marked inspected_level=machine_full_text, NOT human line-by-line.
Never upgrade that label without actually reading the file.
"""
import hashlib, json, pathlib, re, sys
from collections import Counter

DEEP_READ = {
 "README.md","Qwen/qwen3.6-plus.md","Qwen/qwen3.8-max.md","Cursor/cursor.md",
 "DeepSeek/deepseek-chat.md","Kimi/kimi-2.6.md","Google/gemini-3-pro.md",
 "Google/gemini-cli.md","Microsoft/vscode-copilot-agent.md","Mistral/mistral-code.md",
 "Pi/instructions.md","Anthropic/claude-code/agents/general-purpose.md",
 "Anthropic/claude-code/claude-code-sonnet-4.6.md","OpenAI/Codex/gpt-5.5.md",
 "OpenAI/Codex/codex-full.md","Anthropic/anthropic_reminders.md",
 "Perplexity/perplexity-ai.md","xAI/grok-4.5.md","OpenAI/gpt-5.5-instant.md",
 "Notion/notion-ai.md","Misc/hermes.md","GLM/README.md",
 "Anthropic/official/README.md",
}
PROVENANCE = {
 "Anthropic/official": ("officially_published","Anthropic publishes claude.ai prompts at platform.claude.com/docs/en/release-notes/system-prompts; repo Anthropic/official/README.md states archive source. Cross-check 2026-10-19."),
}
def provenance(rel):
    for k,v in PROVENANCE.items():
        if rel.startswith(k): return v
    if rel.startswith("Anthropic/claude-constitution"):
        return ("officially_published","Anthropic constitution is publicly published by Anthropic; verify edition in file header.")
    return ("community_reported_unverified","Present in community collection; no independent extraction methodology in file. Filename/branding is not proof of authenticity.")

def category(rel, suffix):
    r=rel.lower()
    if suffix in {".py",".js",".mjs",".ts",".tsx",".jsx",".sh"}: return "application_code"
    if suffix in {".json",".yaml",".yml",".xml",".xsd"}: return "structured_config_or_tool_schema"
    if "/skills/" in r or r.endswith("skill.md"): return "skill"
    if "/commands/" in r: return "slash_command"
    if "/agents/" in r or "subagent" in r: return "subagent_prompt"
    if "/prompts/reminders" in r or "reminder" in r: return "injected_reminder"
    if "/prompts/" in r: return "component_prompt"
    if "/artifact-types/" in r or "/dots/skills" in r: return "skill"
    if suffix in {".py",".js",".mjs",".ts",".tsx",".jsx",".sh"}: return "application_code"
    if suffix in {".json",".yaml",".yml",".xml",".xsd"}: return "structured_config_or_tool_schema"
    if "tool" in pathlib.Path(r).name: return "tool_definition_or_prompt"
    if suffix==".md": return "system_prompt_or_instruction"
    return "other"

def provider(rel):
    top=rel.split("/")[0]
    return {"Anthropic":"Anthropic","OpenAI":"OpenAI","Google":"Google","xAI":"xAI","Meta":"Meta","Microsoft":"Microsoft","Qwen":"Alibaba/Qwen","Kimi":"Moonshot AI","DeepSeek":"DeepSeek","Cursor":"Cursor","Mistral":"Mistral AI"}.get(top, top)

def compat(cat, rel):
    if cat in {"application_code","structured_config_or_tool_schema"}: return ("not_applicable","Not a prompt; excluded from prompt synthesis except as runtime evidence.")
    if "Qwen/" in rel: return ("direct_reference_only","Qwen-chat tool schemas/dates; do NOT reuse: target deployment tools unverified, files are tool lists with almost no behavioral prompt.")
    if cat=="skill": return ("conditional_module_only","Reusable only if target implements equivalent skill/tool; do not inject wholesale.")
    return ("pattern_source_only","Extract behavioral patterns only; provider tools, branding, product UI and policies do not transfer to Qwen runtime.")

def main():
    src=pathlib.Path(sys.argv[1]); out=sys.argv[2]; sha=sys.argv[3] if len(sys.argv)>3 else "unknown"
    files=sorted(p for p in src.rglob("*") if p.is_file() and ".git" not in p.parts)
    rows=[]
    for p in files:
        rel=str(p.relative_to(src)); data=p.read_bytes()
        text=data.decode("utf-8",errors="ignore") if p.suffix.lower() in {".md",".txt",".json",".yaml",".yml",".jinja"} else ""
        heads=[l.strip()[:160] for l in text.splitlines() if l.strip().startswith("#")][:12]
        cat=category(rel,p.suffix.lower()); prov,ev=provenance(rel); comp,comp_note=compat(cat,rel)
        rows.append({
          "path":rel,"source_url":f"https://github.com/asgeirtj/system_prompts_leaks/blob/{sha}/{rel}",
          "provider":provider(rel),"product_or_model_from_path":pathlib.Path(rel).stem,
          "category":cat,"suffix":p.suffix.lower(),"bytes":len(data),
          "sha256":hashlib.sha256(data).hexdigest(),
          "headings_sample":heads,
          "source_commit":sha,"provenance":prov,"provenance_evidence":ev,
          "inspected_level":"human_deep_read" if rel in DEEP_READ else ("machine_full_text" if text else "machine_metadata_only"),
          "full_file_machine_read":bool(text),"qwen_compatibility":comp,"compatibility_note":comp_note,
          "confidence":"high_metadata_low_content_authenticity" if prov!="officially_published" else "high_for_official_subset",
          "unresolved":"Authenticity/version not independently verified." if prov!="officially_published" else "Verify against live Anthropic page at reuse time.",
        })
    dup=Counter(r["sha256"] for r in rows)
    for r in rows: r["exact_duplicate_copies"]=dup[r["sha256"]]
    pathlib.Path(out).write_text(json.dumps({"repository":"https://github.com/asgeirtj/system_prompts_leaks","commit":sha,"inspection_date":"2026-10-19","total_files":len(rows),"records":rows},indent=1))
    print(f"{len(rows)} files; categories={Counter(r['category'] for r in rows)}; deep_read={sum(1 for r in rows if r['inspected_level']=='human_deep_read')}")

if __name__=="__main__": main()
