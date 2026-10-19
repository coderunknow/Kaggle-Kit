#!/usr/bin/env python3
"""Baseline-vs-candidate eval harness.

Modes:
  --dry-run   Validate structure only (no model). Checks prompt files exist,
              eval cases parse, and prints the blocker for live runs.
  --endpoint  OpenAI-compatible base URL (e.g. http://localhost:8000/v1 for vLLM)
              with env MODEL=<exact model id>. Runs every case under BOTH
              --baseline-file and --candidate-file system prompts, saves raw
              outputs to results.jsonl for rubric scoring. Never compare
              across different models/engines/settings.
"""
import argparse, json, os, pathlib, sys

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent

def dry_run():
    ok = True
    for f in [ROOT/"system_prompt.txt", ROOT/"SYSTEM_PROMPT.md", HERE/"eval_cases.json"]:
        print(("OK  " if f.exists() else "MISS"), f); ok &= f.exists()
    cases = json.loads((HERE/"eval_cases.json").read_text())["cases"]
    print(f"OK   {len(cases)} eval cases, categories={sorted({c['category'] for c in cases})}")
    prompt = (ROOT/"system_prompt.txt").read_text()
    for bad in ["<|im_start|>", "web_search", "2026-", "cutoff"]:
        if bad in prompt: print(f"WARN prompt contains '{bad}' — should be runtime-injected"); ok = False
    print("BLOCKER: no model executed. No GPU/weights/endpoint in this environment; "
          "effectiveness is UNVERIFIED until run with --endpoint on the real deployment.")
    return 0 if ok else 1

def live(args):
    import urllib.request
    model = os.environ.get("MODEL")
    if not model: sys.exit("Set MODEL=<exact model id> (do not substitute another model).")
    cases = json.loads((HERE/"eval_cases.json").read_text())["cases"]
    systems = {"baseline": pathlib.Path(args.baseline_file).read_text() if args.baseline_file else "",
               "candidate": pathlib.Path(args.candidate_file).read_text()}
    out = open(HERE/"results.jsonl", "w")
    for name, system in systems.items():
        for c in cases:
            body = json.dumps({"model": model, "temperature": 0, "messages":
                ([{"role":"system","content":system}] if system else []) +
                [{"role":"user","content":c["prompt"]}]}).encode()
            req = urllib.request.Request(args.endpoint.rstrip("/")+"/chat/completions",
                data=body, headers={"Content-Type":"application/json",
                **({"Authorization":f"Bearer {os.environ['API_KEY']}"} if os.environ.get("API_KEY") else {})})
            with urllib.request.urlopen(req, timeout=120) as r:
                text = json.loads(r.read())["choices"][0]["message"]["content"]
            out.write(json.dumps({"config":name,"case":c["id"],"output":text})+"\n")
            print(f"{name} {c['id']} done")
    print("Saved eval/results.jsonl — score each row 0/1/2 against the case 'pass' criterion; compare totals per category.")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--endpoint"); ap.add_argument("--baseline-file"); ap.add_argument("--candidate-file",
        default=str(ROOT/"system_prompt.txt")); a = ap.parse_args()
    sys.exit(dry_run() if a.dry_run or not a.endpoint else live(a))
