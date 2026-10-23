"""Sends the 10 spike prompts to a running agent service and writes a table to grade by hand.

    npm run dev:server                                   # fresh data: delete data/ first
    LINELEDGER_MODEL_PROVIDER=bedrock npm run dev:agent  # or the default local Ollama agent
    .venv/bin/python scripts/agent_spike.py > spike-run.md

The script only records what happened (time, tool calls with arguments, reply, tokens). The Verdict
column stays empty: grade each row against the tool arguments and the reply, as in docs/spike-results.md.
Standard library only. Talks to 127.0.0.1 only.
"""
import json
import os
import sys
import urllib.error
import urllib.request

AGENT = os.environ.get("LINELEDGER_AGENT_URL", f"http://127.0.0.1:{os.environ.get('AGENT_PORT', '8788')}/chat")
if not AGENT.startswith(("http://127.0.0.1:", "http://localhost:")):
    sys.exit(f"refusing non-loopback agent URL: {AGENT}")

PROMPTS = [
    "shift summary",
    "How is line 2 doing this shift?",
    "add handover note for line 2: sealer jaw ran hot",
    "show handover notes",
    "add follow-up: re-check guard, owner Ravi, due 2026-10-22, line 1",
    "list open follow-ups",
    "close follow-up 1",
    "stock of HDPE",
    "How many 600x400x300 12kg boxes fit in a 20ft container?",
    "What is the weather in Pune?",
]


def ask(text: str) -> dict:
    request = urllib.request.Request(AGENT, data=json.dumps({"text": text}).encode(),
                                     headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code}: {error.read().decode(errors='replace')[:300]}"}
    except OSError as error:
        return {"error": f"{type(error).__name__}: {error}"}


def cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> None:
    rows, seconds, tokens, model = [], [], 0, None
    for i, prompt in enumerate(PROMPTS, 1):
        r = ask(prompt)
        print(f"{i}/{len(PROMPTS)} {prompt!r}: {r.get('seconds', '-')} s", file=sys.stderr, flush=True)
        if "error" in r:
            rows.append(f"| {i} | {cell(prompt)} | - | - | ERROR: {cell(r['error'])} | - | |")
            continue
        model = f"{r.get('provider', '?')} {r.get('model', '?')}"
        calls = "; ".join(f"`{c['name']} {json.dumps(c['input'], separators=(',', ':'))}`" for c in r["tool_calls"]) or "none"
        usage = r.get("usage") or {}
        tokens += usage.get("totalTokens", 0)
        seconds.append(r["seconds"])
        rows.append(f"| {i} | {cell(prompt)} | {r['seconds']} s | {cell(calls)} | {cell(r['reply'])} | {usage.get('totalTokens', '-')} | |")
    print(f"## Agent spike: {model}\n")
    print("| # | Prompt | Time | Tool calls | Reply | Tokens | Verdict |")
    print("|---|---|---|---|---|---|---|")
    print("\n".join(rows))
    if seconds:
        print(f"\nMean {sum(seconds) / len(seconds):.1f} s per answered turn over {len(seconds)} turns. Total tokens {tokens}.")


if __name__ == "__main__":
    main()
