#!/usr/bin/env python3
"""
Run the system prompt evaluation against a live OpenAI-compatible endpoint.

The runner is intentionally dumb: it sends exactly the same request twice per
case, once with an empty system prompt (the application's default) and once with
the candidate prompt, and applies the objective checks declared in
`eval_cases.json`. Anything that needs judgement is marked `manual` and is *not*
scored automatically, because a regex cannot judge writing quality.

Usage
-----
    # check the suite without a model (what the sandbox can do)
    python3 research/qwen-system-prompt/eval/run_eval.py --dry-run

    # run it against a deployment
    python3 research/qwen-system-prompt/eval/run_eval.py \
        --base-url https://<tunnel>.trycloudflare.com/v1 \
        --api-key "$QWEN_API_KEY" \
        --model Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf \
        --out results/run-2026-10-19.json

The script never invents a result. If no endpoint is given it exits with the
`dry-run` status and says so; a run that fails records the failure instead of a
score.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent


# --------------------------------------------------------------------------
# Suite validation
# --------------------------------------------------------------------------

REQUIRED_CASE_FIELDS = ("id", "category", "prompt", "pass_criteria", "failure_mode")
VALID_CHECK_TYPES = {
    "contains",
    "absent",
    "regex_any",
    "regex_all",
    "regex_absent",
    "absent_regex",
    "max_words",
    "bullet_count",
}


def load_suite(path: Path) -> Dict[str, Any]:
    suite = json.loads(path.read_text(encoding="utf-8"))
    errors: List[str] = []
    ids = set()
    for case in suite.get("cases", []):
        for field in REQUIRED_CASE_FIELDS:
            if field not in case:
                errors.append(f"{case.get('id', '<no id>')}: missing field {field}")
        if case.get("id") in ids:
            errors.append(f"{case['id']}: duplicate id")
        ids.add(case.get("id"))
        if not case.get("prompt") and not case.get("history"):
            errors.append(f"{case.get('id')}: no prompt and no history")
        for check in case.get("auto_checks", []):
            if check.get("type") not in VALID_CHECK_TYPES:
                errors.append(f"{case['id']}: unknown check type {check.get('type')}")
            if check.get("type") in ("regex_any", "regex_all", "regex_absent", "absent_regex"):
                patterns = check.get("value")
                patterns = patterns if isinstance(patterns, list) else [patterns]
                for pattern in patterns:
                    try:
                        re.compile(pattern)
                    except re.error as error:
                        errors.append(f"{case['id']}: bad regex {pattern!r}: {error}")
    if errors:
        raise SystemExit("the suite is invalid:\n  - " + "\n  - ".join(errors))
    return suite


# --------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------

def words(text: str) -> List[str]:
    return re.findall(r"\S+", text)


def bullet_lines(text: str) -> List[str]:
    return [line for line in text.splitlines() if re.match(r"^\s*(?:[-*•]|\d+[.)])\s+\S", line)]


def run_check(check: Dict[str, Any], answer: str) -> Tuple[bool, str]:
    kind = check["type"]
    value = check.get("value")

    if kind == "contains":
        ok = str(value) in answer
        return ok, f"contains {value!r}"
    if kind == "absent":
        ok = str(value) not in answer
        return ok, f"must not contain {value!r}"
    if kind == "regex_any":
        patterns = value if isinstance(value, list) else [value]
        ok = any(re.search(pattern, answer, re.IGNORECASE | re.MULTILINE) for pattern in patterns)
        return ok, f"matches any of {patterns}"
    if kind == "regex_all":
        patterns = value if isinstance(value, list) else [value]
        minimum = int(check.get("min", 1))
        total = sum(
            len(re.findall(pattern, answer, re.IGNORECASE | re.MULTILINE)) for pattern in patterns
        )
        return total >= minimum, f"at least {minimum} match(es) of {patterns} (found {total})"
    if kind in ("regex_absent", "absent_regex"):
        patterns = value if isinstance(value, list) else [value]
        found = [p for p in patterns if re.search(p, answer, re.IGNORECASE | re.MULTILINE)]
        return not found, f"matches none of {patterns} (matched {found})"
    if kind == "max_words":
        count = len(words(answer))
        return count <= int(value), f"at most {value} words (found {count})"
    if kind == "bullet_count":
        count = len(bullet_lines(answer))
        return count == int(value), f"exactly {count and value} bullets (found {count})"
    return False, f"unimplemented check {kind}"


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def chat_completion(
    base_url: str,
    api_key: str,
    model: str,
    messages: List[Dict[str, str]],
    temperature: float,
    max_tokens: int,
    timeout: float,
) -> Dict[str, Any]:
    url = base_url.rstrip("/") + "/chat/completions"
    body = json.dumps(
        {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
    ).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def answer_text(payload: Dict[str, Any]) -> str:
    choice = (payload.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content") or ""
    # llama.cpp can return reasoning separately; the visible answer is content.
    return content if isinstance(content, str) else str(content)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def summarise(results: List[Dict[str, Any]], variant: str) -> Dict[str, Any]:
    cases = [r for r in results if r["variant"] == variant and r["status"] == "ok"]
    scored = [c for c in cases if c["checks"]]
    passed = [c for c in scored if all(check["ok"] for check in c["checks"])]
    return {
        "cases_run": len(cases),
        "cases_scored": len(scored),
        "cases_passed": len(passed),
        "pass_rate": round(len(passed) / len(scored), 3) if scored else None,
        "failed_case_ids": [c["id"] for c in scored if not all(check["ok"] for check in c["checks"])],
        "errors": [c["id"] for c in results if c["variant"] == variant and c["status"] != "ok"],
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=HERE / "eval_cases.json")
    parser.add_argument("--prompt", type=Path, default=HERE.parent / "SYSTEM_PROMPT.md")
    parser.add_argument("--base-url", default=os.environ.get("QWEN_BASE_URL", ""))
    parser.add_argument("--api-key", default=os.environ.get("QWEN_API_KEY", ""))
    parser.add_argument("--model", default=os.environ.get("QWEN_MODEL", "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"))
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true", help="validate the suite and stop")
    args = parser.parse_args(argv)

    suite = load_suite(args.cases)

    document = args.prompt.read_text(encoding="utf-8")
    match = re.search(r"<!-- BEGIN PROMPT -->\n(.*?)\n<!-- END PROMPT -->", document, re.S)
    if not match:
        raise SystemExit("SYSTEM_PROMPT.md has no BEGIN/END PROMPT block")
    candidate = match.group(1).strip()

    checks_total = sum(len(case.get("auto_checks", [])) for case in suite["cases"])

    if args.dry_run or not (args.base_url and args.api_key):
        print("EVALUATION NOT EXECUTED")
        print(f"  cases:            {len(suite['cases'])}")
        print(f"  auto checks:      {checks_total}")
        print(f"  manual criteria:  {sum(len(c['pass_criteria']) for c in suite['cases'])}")
        print(f"  candidate prompt: {len(candidate)} characters, sha256 {hashlib.sha256(candidate.encode()).hexdigest()[:16]}")
        print("\n  No endpoint was provided (--base-url/--api-key or QWEN_BASE_URL/QWEN_API_KEY).")
        print("  The suite is valid; no model output was produced and no score is claimed.")
        return 0

    results: List[Dict[str, Any]] = []
    for case in suite["cases"]:
        for variant, system_prompt in (("baseline", ""), ("candidate", candidate)):
            messages: List[Dict[str, str]] = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            for turn in case.get("history", []):
                messages.append({"role": turn["role"], "content": turn["content"]})
            if case.get("prompt"):
                messages.append({"role": "user", "content": case["prompt"]})

            started = time.time()
            try:
                payload = chat_completion(
                    args.base_url,
                    args.api_key,
                    args.model,
                    messages,
                    args.temperature,
                    args.max_tokens,
                    args.timeout,
                )
                answer = answer_text(payload)
                checks = []
                for check in case.get("auto_checks", []):
                    ok, description = run_check(check, answer)
                    checks.append({"ok": ok, "check": description})
                results.append(
                    {
                        "id": case["id"],
                        "category": case["category"],
                        "variant": variant,
                        "status": "ok",
                        "elapsed_s": round(time.time() - started, 2),
                        "answer": answer,
                        "checks": checks,
                        "usage": payload.get("usage"),
                        "finish_reason": (payload.get("choices") or [{}])[0].get("finish_reason"),
                        "manual_criteria": case["pass_criteria"],
                    }
                )
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
                results.append(
                    {
                        "id": case["id"],
                        "category": case["category"],
                        "variant": variant,
                        "status": "error",
                        "error": f"{type(error).__name__}: {error}",
                        "checks": [],
                        "manual_criteria": case["pass_criteria"],
                    }
                )

    report = {
        "suite_version": suite.get("suite_version"),
        "executed_on": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "endpoint": args.base_url,
        "model": args.model,
        "parameters": {
            "temperature": args.temperature,
            "max_tokens": args.max_tokens,
            "repeats": 1,
        },
        "prompt_sha256": hashlib.sha256(candidate.encode()).hexdigest(),
        "prompt_characters": len(candidate),
        "summary": {
            "baseline": summarise(results, "baseline"),
            "candidate": summarise(results, "candidate"),
        },
        "manual_review_required": True,
        "note": (
            "Only the declared auto_checks are scored. `manual_criteria` in each case must be "
            "reviewed by a human; the pass rates above are not a quality verdict on their own."
        ),
        "results": results,
    }

    target = args.out or HERE / "results" / f"run-{time.strftime('%Y%m%d-%H%M%S')}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(json.dumps(report["summary"], indent=2))
    print(f"\nwrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
