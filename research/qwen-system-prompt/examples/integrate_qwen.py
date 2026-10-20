"""Integration example — adapt ONLY after verifying your real deployment.

Prereqs to confirm first (none existed in this repo at research time):
exact model id/revision, engine (Transformers/vLLM/SGLang/Ollama/llama.cpp),
its chat template, tool schemas, context limits. Do not copy limits from here.
"""
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
SYSTEM = (ROOT / "system_prompt.txt").read_text()
CODING = (ROOT / "modules/MODULE_coding.txt").read_text()  # pick ONE module

def build_messages(user_text: str, *, with_coding_tools: bool) -> list[dict]:
    # System text only. Template + tool schemas are rendered by the engine —
    # never paste <|im_start|> or tool JSON into this string.
    system = SYSTEM + ("\n\n" + CODING if with_coding_tools else "")
    return [{"role": "system", "content": system},
            {"role": "user", "content": user_text}]

# Transformers (verify against your tokenizer's template):
#   text = tokenizer.apply_chat_template(build_messages("Hello", with_coding_tools=False),
#                                        tokenize=False, add_generation_prompt=True)
# vLLM / OpenAI-compatible servers: pass build_messages(...) as `messages`
# and your REAL tool definitions via the API `tools` field.
if __name__ == "__main__":
    print(build_messages("Give me a short intro to LLMs.", with_coding_tools=False))
