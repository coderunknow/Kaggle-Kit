#!/usr/bin/env python3
"""
Build the prompt inventory for the primary research repository.

The inventory is a *source level* record: one entry per file that may contain
system prompts, developer/agent instructions, tool descriptions, skills, slash
commands, templates or behavioural documentation. Every entry keeps the exact
path, the blob SHA-1 (as reported by git), a content hash, a classification, a
duplicate cluster id and the coverage flags.

Usage
-----
    python3 research/qwen-system-prompt/build_inventory.py --repo /path/to/clone

The script is deliberately dependency free (standard library only) so that it
runs in any environment. It never writes into the inspected repository.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# Classification rules
# --------------------------------------------------------------------------

TEXT_EXTENSIONS = {
    ".md",
    ".txt",
    ".jinja",
    ".json",
    ".yaml",
    ".yml",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".jsx",
    ".sh",
    ".html",
    ".xml",
    ".xsd",
    ".skill",
}

# Files that are *not* prompt material even though they are text: schemas for
# office documents, lock files, build configuration of the collection itself.
NOT_PROMPT_NAME_PATTERNS = (
    re.compile(r"(^|/)package-lock\.json$"),
    re.compile(r"(^|/)pnpm-lock\.yaml$"),
    re.compile(r"(^|/)\.gitattributes$"),
    re.compile(r"(^|/)\.editorconfig$"),
    re.compile(r"(^|/)FUNDING\.yml$"),
)

SKILL_NAME = "SKILL.md"

# Markers that a file carries an actual prompt (as opposed to documentation
# *about* prompts).
SYSTEM_MARKERS = (
    "[system]",
    "<system>",
    "system prompt",
    "you are ",
    "you have access to the following functions",
    "you are an ai assistant",
)
TOOL_MARKERS = (
    "```json\n{\n  \"type\": \"function\"",
    '"type": "function"',
    "<tools>",
    "<function=",
    "tool_call",
    "tools:",
)
INSTRUCTION_MARKERS = (
    "you must",
    "do not",
    "never ",
    "always ",
    "when the user",
    "if the user",
)

PROVIDER_DIRS = {
    "Anthropic": "Anthropic",
    "OpenAI": "OpenAI",
    "Google": "Google",
    "xAI": "xAI",
    "Meta": "Meta",
    "Microsoft": "Microsoft",
    "Mistral": "Mistral",
    "Qwen": "Alibaba (Qwen)",
    "DeepSeek": "DeepSeek",
    "GLM": "Zhipu (GLM)",
    "Kimi": "Moonshot (Kimi)",
    "Perplexity": "Perplexity",
    "Notion": "Notion",
    "Cursor": "Cursor (Anysphere)",
    "Pi": "Pi (Inflection)",
    "Misc": "Third party / mixed",
}


def classify(relpath: str, text: str) -> Tuple[str, str, str]:
    """
    Return (category, subcategory, rationale).

    Categories follow the distinction the mission requires: a system prompt is
    not a skill, a skill is not a tool description, a tool description is not
    ordinary documentation.
    """
    path = relpath.replace(os.sep, "/")
    name = path.rsplit("/", 1)[-1]
    lower = path.lower()

    if any(p.search(path) for p in NOT_PROMPT_NAME_PATTERNS):
        return "repository_metadata", "", "build/config file of the collection itself"

    if name == SKILL_NAME or "/skills/" in lower:
        return "skill", skill_subcategory(path), "lives under a skills directory or is a SKILL.md"
    if "/commands/" in lower:
        return "slash_command", "", "lives under a commands directory"
    if "/agents/" in lower:
        return "subagent_instruction", "", "lives under an agents directory"
    if name.lower() in ("agents.md", "claude.md", "instructions.md") or "/workspace/system/" in lower:
        return "agent_instruction", "", "agent instruction file (AGENTS.md / workspace system file)"
    if name.lower() == "readme.md":
        return "collection_documentation", "", "README of the collection"
    if "/artifact-types/" in lower:
        kind = "skill" if name == SKILL_NAME else "artifact_type_prompt"
        return kind, "", "Claude artifact type (slides/dashboard/design/docs)"
    if lower.endswith(".jinja"):
        return "chat_template", "", "jinja chat template"
    if lower.endswith((".xsd", ".xml")):
        return "schema", "", "XML/XSD schema, not a prompt"
    if lower.endswith((".py", ".ts", ".tsx", ".js", ".mjs", ".jsx", ".sh")):
        return "application_code_or_script", "", "executable code shipped with a prompt collection"

    has_tools = any(m in text.lower() for m in TOOL_MARKERS)
    has_system = any(m in text.lower() for m in SYSTEM_MARKERS)
    has_instructions = sum(m in text.lower() for m in INSTRUCTION_MARKERS) >= 2

    if has_tools and has_system and has_instructions:
        # Grok, Qwen and several others ship the behavioural prompt and the
        # tool declarations in the same message. The behaviour is the part
        # that matters for this analysis, so the file is a system prompt that
        # happens to carry schemas.
        return "system_prompt", "contains_tool_schemas", "behavioural prompt and function schemas in one file"
    if has_tools and not (has_system and has_instructions):
        return "tool_description", "embedded", "prompt file that declares function schemas"
    if has_system and has_instructions:
        return "system_prompt", "", "contains a system/developer prompt with directives"
    if has_system:
        return "system_prompt", "weak_markers", "prompt-like but few directive markers"
    if has_instructions:
        return "instruction_fragment", "", "directives without an explicit system marker"
    return "supporting_document", "", "no prompt markers"


def skill_subcategory(path: str) -> str:
    parts = path.split("/")
    if "skills" in parts:
        index = parts.index("skills")
        if index + 1 < len(parts):
            return parts[index + 1]
    return ""


# --------------------------------------------------------------------------
# Provenance classification
# --------------------------------------------------------------------------

def provenance(relpath: str, category: str) -> Tuple[str, str]:
    """
    Return (provenance, rationale).

    Provenance is deliberately separate from confidence in the contents. A file
    being in a famous collection is not evidence that it is authentic.
    """
    lower = relpath.lower()
    if "/official/" in lower:
        return (
            "officially_published",
            "path is the collection's 'official' section; Anthropic publishes release notes that these files can be checked against",
        )
    if "/raw/" in lower:
        return (
            "extracted_with_documented_method",
            "kept in a 'raw' directory next to the curated file of the same model; extraction method is the collection's own",
        )
    if lower.startswith("misc/") or lower.startswith("cursor/") or lower.startswith("notion/") or lower.startswith("pi/"):
        return (
            "community_contributed",
            "single-file community submission without a second source in the collection",
        )
    if category in ("application_code_or_script", "schema", "repository_metadata", "collection_documentation"):
        return ("not_a_prompt", "not prompt material")
    return (
        "community_contributed",
        "curated file in a community collection; the collection documents neither the extraction method nor a reviewer",
    )


# --------------------------------------------------------------------------
# Similarity (near duplicate detection)
# --------------------------------------------------------------------------

SHINGLE = 5
MINHASH_PERMUTATIONS = 48
_PRIME = (1 << 61) - 1


def shingle_hashes(text: str, permutations: int = MINHASH_PERMUTATIONS) -> List[int]:
    """
    MinHash signature over word shingles. Deterministic across runs.

    Each shingle is hashed once; the permutations are then evaluated with
    integer arithmetic only, which keeps this usable on a half megabyte file.
    """
    words = re.findall(r"\w+", text.lower())
    if not words:
        return [0] * permutations
    if len(words) < SHINGLE:
        shingles = [" ".join(words)]
    else:
        shingles = list({" ".join(words[i : i + SHINGLE]) for i in range(len(words) - SHINGLE + 1)})
    bases = [
        int.from_bytes(hashlib.blake2b(shingle.encode(), digest_size=8).digest(), "big")
        for shingle in shingles
    ]
    signature: List[int] = []
    for slot in range(permutations):
        a = (slot * 2_654_435_761 + 1) | 1
        b = (slot * 40_503 + 12_345)
        best = min((a * base + b) % _PRIME for base in bases)
        signature.append(best)
    return signature


def jaccard(sig_a: Sequence[int], sig_b: Sequence[int]) -> float:
    equal = sum(1 for a, b in zip(sig_a, sig_b) if a == b)
    return equal / len(sig_a)


# --------------------------------------------------------------------------
# Git metadata
# --------------------------------------------------------------------------

def git_output(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def git_metadata(repo: Path) -> Dict[str, str]:
    default_branch = ""
    try:
        default_branch = git_output(repo, "rev-parse", "--abbrev-ref", "HEAD").strip()
    except RuntimeError:
        pass
    return {
        "url": git_output(repo, "config", "--get", "remote.origin.url").strip() or "https://github.com/asgeirtj/system_prompts_leaks",
        "default_branch": default_branch,
        "commit_sha": git_output(repo, "rev-parse", "HEAD").strip(),
        "commit_date": git_output(repo, "log", "-1", "--format=%cI").strip(),
        "commit_subject": git_output(repo, "log", "-1", "--format=%s").strip(),
        "first_commit_date": git_output(repo, "log", "--reverse", "--format=%cI", "-1").strip()
        if git_output(repo, "rev-list", "--count", "HEAD").strip() != "1"
        else git_output(repo, "log", "-1", "--format=%cI").strip(),
        "commit_count": git_output(repo, "rev-list", "--count", "HEAD").strip(),
    }


def blob_sha1(repo: Path, relpath: str) -> str:
    """The SHA-1 of the blob as git stores it (identical to `git hash-object`)."""
    try:
        return git_output(repo, "ls-tree", "HEAD", "--", relpath).split()[2]
    except (RuntimeError, IndexError):
        return ""


def git_url_for(url: str, commit: str, relpath: str) -> str:
    base = url.rstrip("/")
    if base.endswith(".git"):
        base = base[:-4]
    return f"{base}/blob/{commit}/{relpath}"


# --------------------------------------------------------------------------
# Coverage registry
# --------------------------------------------------------------------------

# Files that were read in full (every line) during the analysis, relative to
# the repository root. This list is maintained by hand and is the only source
# of truth for the `full_text_inspected` flag in the inventory. A file that is
# not listed here was inspected structurally (markers, section headings) or by
# targeted sections only, and the inventory says so.
FULL_TEXT_INSPECTED: Tuple[str, ...] = json.loads(
    (Path(__file__).with_name("inspected_files.json")).read_text(encoding="utf-8")
)["full_text"] if (Path(__file__).with_name("inspected_files.json")).exists() else ()

SECTION_INSPECTED: Tuple[str, ...] = json.loads(
    (Path(__file__).with_name("inspected_files.json")).read_text(encoding="utf-8")
)["sections"] if (Path(__file__).with_name("inspected_files.json")).exists() else ()


# --------------------------------------------------------------------------
# Compatibility assessment
# --------------------------------------------------------------------------

TARGET_CONTEXT_TOKENS = 8192
TARGET_MAX_OUTPUT_TOKENS = 1024


def estimate_tokens(text: str) -> int:
    """
    A deliberately rough estimate for budget purposes only.

    Qwen tokenizers average roughly 3.2-4.0 characters per token on English
    prose. We divide by 3.6 and round up. This is an estimate, not a count from
    the real tokenizer: it is labelled as such everywhere it is reported.
    """
    return max(1, math.ceil(len(text) / 3.6))


def compatibility(record: Dict[str, object], text: str) -> Dict[str, object]:
    """How usable is this file in the target environment (no tools, 8k ctx)?"""
    tokens = int(record["estimated_tokens"])  # type: ignore[arg-type]
    issues: List[str] = []
    verdict = "adaptable"

    if record["category"] not in ("system_prompt", "instruction_fragment", "subagent_instruction", "agent_instruction"):
        verdict = "not_applicable"
        issues.append(f"category is {record['category']}, not a behavioural prompt")
    else:
        if tokens > TARGET_CONTEXT_TOKENS * 0.5:
            verdict = "incompatible"
            issues.append(
                f"~{tokens} tokens is {tokens / TARGET_CONTEXT_TOKENS:.0%} of the 8192 token context window before any user turn"
            )
        elif tokens > 1500:
            verdict = "adaptable_with_effort"
            issues.append(f"~{tokens} tokens; needs compression to leave room for the conversation")
        if record["declares_tools"]:
            issues.append("declares tool/function schemas that the target runtime does not expose")
        if record["mentions_search_or_memory"]:
            issues.append("relies on search/memory features that the target runtime does not implement")
        if record["mentions_artifacts_or_ui"]:
            issues.append("product specific UI/artifact instructions with no equivalent in the target")
    return {"verdict": verdict, "issues": issues}


# --------------------------------------------------------------------------
# Main inventory
# --------------------------------------------------------------------------

@dataclass
class Entry:
    relpath: str
    size_bytes: int
    lines: int
    text: str
    category: str
    subcategory: str
    rationale: str
    provenance: str
    provenance_rationale: str
    sha256: str
    blob_sha1: str
    estimated_tokens: int
    declares_tools: bool
    mentions_search_or_memory: bool
    mentions_artifacts_or_ui: bool
    signature: Optional[List[int]] = field(default=None, repr=False)
    duplicate_of: str = ""
    near_duplicate_group: str = ""

    def to_record(self, meta: Dict[str, str], url: str) -> Dict[str, object]:
        record: Dict[str, object] = {
            "path": self.relpath,
            "source_url": git_url_for(url, meta["commit_sha"], self.relpath),
            "provider": PROVIDER_DIRS.get(self.relpath.split("/")[0], "unknown"),
            "product_and_model": product_of(self.relpath),
            "category": self.category,
            "subcategory": self.subcategory,
            "classification_rationale": self.rationale,
            "execution_environment": execution_environment(self.relpath),
            "source_revision": meta["commit_sha"],
            "blob_sha1": self.blob_sha1,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
            "lines": self.lines,
            "estimated_tokens": self.estimated_tokens,
            "provenance": self.provenance,
            "provenance_rationale": self.provenance_rationale,
            "full_text_inspected": self.relpath in FULL_TEXT_INSPECTED,
            "sections_inspected": self.relpath in SECTION_INSPECTED,
            "declares_tools": self.declares_tools,
            "mentions_search_or_memory": self.mentions_search_or_memory,
            "mentions_artifacts_or_ui": self.mentions_artifacts_or_ui,
            "exact_duplicate_of": self.duplicate_of,
            "near_duplicate_group": self.near_duplicate_group,
            "strengths": strengths(self),
            "risks_and_conflicts": risks(self),
            "target_compatibility": compatibility(
                {
                    "category": self.category,
                    "estimated_tokens": self.estimated_tokens,
                    "declares_tools": self.declares_tools,
                    "mentions_search_or_memory": self.mentions_search_or_memory,
                    "mentions_artifacts_or_ui": self.mentions_artifacts_or_ui,
                },
                self.text,
            ),
            "confidence": confidence(self),
            "unresolved_questions": unresolved(self),
        }
        return record


def product_of(relpath: str) -> str:
    stem = relpath.rsplit("/", 1)[-1]
    stem = re.sub(r"\.(md|txt|json|jinja|yaml|yml|ts|py|mjs|js|sh|xsd|xml|skill|html)$", "", stem)
    return stem


def execution_environment(relpath: str) -> str:
    lower = relpath.lower()
    if "/claude-code/" in lower or "codex" in lower or "cli" in lower or "antigravity" in lower or "amp-code" in lower:
        return "coding agent CLI with filesystem/shell tools"
    if "/artifact-types/" in lower or "artifact" in lower:
        return "artifact/UI rendering environment"
    if "/skills/" in lower:
        return "skill package loaded on demand by an agent"
    if "/api" in lower or "-api." in lower:
        return "direct model API (developer supplied system prompt)"
    if "/webapp" in lower or "chatgpt" in lower or "claude-" in lower or "gemini-" in lower or "grok-" in lower:
        return "hosted consumer chat product"
    return "unknown / documented per file"


def strengths(entry: Entry) -> List[str]:
    text = entry.text
    out: List[str] = []
    checks = (
        ("explicit instruction hierarchy", ("hierarchy", "higher priority", "instructions in the", "prompt injection")),
        ("verification / evidence expectations", ("verify", "evidence", "do not claim", "actually run")),
        ("honest uncertainty language", ("uncertain", "don't know", "do not know", "clarif")),
        ("tool failure guidance", ("if the tool", "tool call fails", "error from the tool", "retry")),
        ("anti-sycophancy / pushback", ("push back", "disagree", "pushback", "honest")),
        ("concise formatting rules", ("formatting", "bullet", "concise", "verbos")),
        ("safety boundary", ("refus", "harm", "safety", "illegal")),
        ("coding workflow discipline", ("test", "root cause", "read the file", "search the codebase")),
    )
    for label, needles in checks:
        hits = sum(1 for needle in needles if needle in text.lower())
        if hits:
            out.append(label)
    if entry.category in ("skill", "slash_command"):
        out.append("concrete, executable procedure rather than abstract advice")
    return out[:6]


def risks(entry: Entry) -> List[str]:
    text = entry.text.lower()
    out: List[str] = []
    patterns = (
        ("product specific knowledge claims that will be wrong in another deployment", ("knowledge cutoff", "current date is", "you are claude", "you are chatgpt", "you are gemini", "you are grok")),
        ("hard refusal catalogue tied to a hosted product policy", ("claude does not", "openai does not", "you must refuse")),
        ("requires tools the target does not have", ("<tools>", "tool_call", "function=")),
        ("search/memory dependent", ("web_search", "memory tool", "search the web")),
        ("artifact/UI dependent", ("artifact", "<antml:", "canvas")),
        ("verbosity or personality mandates that fight the task", ("always use markdown", "never use bullet", "warm tone", "be enthusiastic")),
        ("copyright/quoting constraints scoped to a consumer product", ("copyright", "lyrics", "public domain")),
    )
    for label, needles in patterns:
        if any(needle in text for needle in needles):
            out.append(label)
    return out[:6]


def confidence(entry: Entry) -> str:
    if entry.provenance == "officially_published":
        return "high for existence; content can be diffed against the publisher's own release notes"
    if entry.category in ("collection_documentation", "schema", "repository_metadata"):
        return "high (metadata only, not an effective prompt)"
    return "medium for content, low for version claims: no independent corroboration was performed"


def unresolved(entry: Entry) -> List[str]:
    questions: List[str] = []
    if entry.category == "system_prompt" and entry.estimated_tokens > 4000:
        questions.append("is the large appendix part of the same request, or several sequential tool/developer messages?")
    if entry.provenance == "community_contributed":
        questions.append("no documented extraction method: was it reproduced under controlled conditions?")
    if entry.declares_tools:
        questions.append("tool schemas are declared inside the text; the runtime normally delivers them out of band")
    return questions


def collect(repo: Path) -> List[Entry]:
    entries: List[Entry] = []
    root_len = len(str(repo)) + 1
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        for name in sorted(filenames):
            full = Path(dirpath) / name
            relpath = str(full)[root_len:].replace(os.sep, "/")
            if full.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            try:
                raw = full.read_bytes()
            except OSError:
                continue
            text = raw.decode("utf-8", errors="replace")
            category, subcategory, rationale = classify(relpath, text)
            prov, prov_reason = provenance(relpath, category)
            lower = text.lower()
            entry = Entry(
                relpath=relpath,
                size_bytes=len(raw),
                lines=text.count("\n") + 1,
                text=text,
                category=category,
                subcategory=subcategory,
                rationale=rationale,
                provenance=prov,
                provenance_rationale=prov_reason,
                sha256=hashlib.sha256(raw).hexdigest(),
                blob_sha1=blob_sha1(repo, relpath),
                estimated_tokens=estimate_tokens(text),
                declares_tools=any(m in lower for m in TOOL_MARKERS),
                mentions_search_or_memory=any(
                    m in lower
                    for m in ("web_search", "web search", "memory tool", "personalized user memories", "search the web")
                ),
                mentions_artifacts_or_ui=any(m in lower for m in ("artifact", "<antml:", "canvas", "artifact_type")),
            )
            entries.append(entry)
    return entries


def mark_duplicates(entries: List[Entry]) -> None:
    by_hash: Dict[str, str] = {}
    for entry in entries:
        if entry.sha256 in by_hash:
            entry.duplicate_of = by_hash[entry.sha256]
        else:
            by_hash[entry.sha256] = entry.relpath

    # Near duplicates among the prompt-carrying files only, with a cheap block:
    # files must be within 20% of each other in size to be compared at all.
    candidates = [
        e
        for e in entries
        if e.category
        in ("system_prompt", "instruction_fragment", "subagent_instruction", "agent_instruction", "tool_description")
        and not e.duplicate_of
        and 2000 < e.size_bytes < 400_000
    ]
    candidates.sort(key=lambda e: e.size_bytes)
    groups: List[List[Entry]] = []
    for entry in candidates:
        entry.signature = shingle_hashes(entry.text)
    for i, left in enumerate(candidates):
        for right in candidates[i + 1 :]:
            if left.size_bytes and right.size_bytes / left.size_bytes > 1.2:
                break
            if left.relpath == right.relpath or not left.signature or not right.signature:
                continue
            if jaccard(left.signature, right.signature) >= 0.8:
                placed = False
                for group in groups:
                    if any(member.relpath in (left.relpath, right.relpath) for member in group):
                        if left.relpath not in {m.relpath for m in group}:
                            group.append(left)
                        if right.relpath not in {m.relpath for m in group}:
                            group.append(right)
                        placed = True
                        break
                if not placed:
                    groups.append([left, right])
    for index, group in enumerate(groups, start=1):
        label = f"near-duplicate-{index:03d}"
        for member in group:
            member.near_duplicate_group = label


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="path to a clone of the inspected repository")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).with_name("PROMPT_INVENTORY.json"),
        help="where to write the JSON inventory",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=Path(__file__).with_name("PROMPT_INVENTORY.csv"),
        help="where to write the flat CSV inventory",
    )
    args = parser.parse_args(argv)

    repo: Path = args.repo.resolve()
    if not (repo / ".git").exists():
        print(f"{repo} is not a git clone", file=sys.stderr)
        return 2

    meta = git_metadata(repo)
    entries = collect(repo)
    mark_duplicates(entries)

    records = [entry.to_record(meta, meta["url"]) for entry in entries]

    category_counts = Counter(record["category"] for record in records)
    provider_counts = Counter(record["provider"] for record in records)
    provenance_counts = Counter(record["provenance"] for record in records)
    prompt_records = [r for r in records if r["category"] in ("system_prompt", "instruction_fragment", "tool_description")]
    inspected_full = [r for r in records if r["full_text_inspected"]]
    inspected_sections = [r for r in records if r["sections_inspected"]]
    duplicate_records = [r for r in records if r["exact_duplicate_of"]]
    near_groups = {r["near_duplicate_group"] for r in records if r["near_duplicate_group"]}

    summary = {
        "files_inventoried": len(records),
        "prompt_carrying_files": len(prompt_records),
        "prompt_tokens_total_estimate": sum(int(r["estimated_tokens"]) for r in prompt_records),
        "by_category": dict(sorted(category_counts.items())),
        "by_provider": dict(sorted(provider_counts.items())),
        "by_provenance": dict(sorted(provenance_counts.items())),
        "exact_duplicate_files": len(duplicate_records),
        "near_duplicate_groups": len(near_groups),
        "files_read_in_full": len(inspected_full),
        "files_read_in_sections": len(inspected_sections),
        "coverage_note": (
            "Every text file in the clone is inventoried at metadata level (path, size, hashes, "
            "classification, markers). Full-text reading was performed only for the files listed in "
            "inspected_files.json; the rest were inspected structurally. Coverage is therefore "
            "complete for classification and partial for close reading, and the analysis says so."
        ),
    }

    output = {
        "inventory_version": 1,
        "generated_on": "2026-10-19",
        "primary_repository": {
            "url": meta["url"],
            "default_branch": meta["default_branch"],
            "commit_sha": meta["commit_sha"],
            "commit_date": meta["commit_date"],
            "commit_subject": meta["commit_subject"],
            "commit_count": meta["commit_count"],
            "inspected_on": "2026-10-19",
            "clone": "shallow clone of the default branch (`git clone --depth 1`)",
        },
        "target_system": {
            "model_repo": "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
            "model_file": "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf",
            "quantization": "IQ3_S (GGUF), GSQ-RCO variant, MTP head included",
            "inference_engine": "llama.cpp llama-server, official CUDA build b11719 (b11718/b11717 fallback)",
            "api": "OpenAI compatible /v1/models and /v1/chat/completions",
            "context_tokens": TARGET_CONTEXT_TOKENS,
            "default_max_output_tokens": TARGET_MAX_OUTPUT_TOKENS,
            "roles_supported": ["system", "user", "assistant"],
            "tools": "none: the client and the proxy only forward messages; no tool/function calling is implemented",
            "chat_template": "GGUF embedded template, enabled with --jinja on the server",
            "system_prompt_injection": "src/state/useChat.ts buildHistory(): profile.systemPrompt trimmed and pushed as the first message with role 'system'",
            "evidence": [
                "notebooks/qwen3_8_27b_api.py DeploymentConfig",
                "shared/api/types.ts ChatRole / ChatMessageInput",
                "src/state/useChat.ts buildHistory",
                "docs/chat-interface.md",
            ],
        },
        "coverage": summary,
        "entries": records,
    }

    args.out.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    fieldnames = [
        "path",
        "source_url",
        "provider",
        "product_and_model",
        "category",
        "subcategory",
        "execution_environment",
        "provenance",
        "full_text_inspected",
        "sections_inspected",
        "estimated_tokens",
        "declares_tools",
        "target_compatibility_verdict",
        "exact_duplicate_of",
        "near_duplicate_group",
        "strengths",
        "risks_and_conflicts",
        "confidence",
    ]
    with args.csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            writer.writerow(
                {
                    "path": record["path"],
                    "source_url": record["source_url"],
                    "provider": record["provider"],
                    "product_and_model": record["product_and_model"],
                    "category": record["category"],
                    "subcategory": record["subcategory"],
                    "execution_environment": record["execution_environment"],
                    "provenance": record["provenance"],
                    "full_text_inspected": record["full_text_inspected"],
                    "sections_inspected": record["sections_inspected"],
                    "estimated_tokens": record["estimated_tokens"],
                    "declares_tools": record["declares_tools"],
                    "target_compatibility_verdict": record["target_compatibility"]["verdict"],  # type: ignore[index]
                    "exact_duplicate_of": record["exact_duplicate_of"],
                    "near_duplicate_group": record["near_duplicate_group"],
                    "strengths": "; ".join(record["strengths"]),  # type: ignore[arg-type]
                    "risks_and_conflicts": "; ".join(record["risks_and_conflicts"]),  # type: ignore[arg-type]
                    "confidence": record["confidence"],
                }
            )

    print(json.dumps(summary, indent=2))
    print(f"\nwrote {args.out}\nwrote {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
