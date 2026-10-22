# Local-model spike: Strands + Ollama + LineLedger MCP

Date: 2026-10-22. Machine: HP ProBook 440 G11, CPU only, about 30 GB RAM shared with other applications.
Runtime: Ollama 0.40.7, loopback only, `OLLAMA_NO_CLOUD=1`, `OLLAMA_NUM_PARALLEL=1`, context 8192.
Model: `qwen3:4b` (ID `359d7dd4bcda`, 2.5 GB). Agent: Strands Agents 1.61.1, `agent/service.py`.
Zero-cost rule held: no AWS call, no hosted API, no sign-in.

## Result: the first configuration failed; a larger token cap works but is slow

### Run 1: `agent/service.py` as committed (`max_tokens=512`, `think: False`)

Ten prompts through `POST /chat`, one per tool plus one off-topic prompt.

- 9 of 10 returned HTTP 502. The single clean request that I inspected failed with
  `MaxTokensReachedException` after about 120 s.
- The one "pass" (the off-topic weather prompt, where no tool is expected) is not evidence of tool calling.
- This run was also contaminated: abandoned requests stayed queued in Ollama, so its per-request
  timings (44 to 95 s) are not reliable.

Cause, from the model metadata: `qwen3:4b` is a thinking model. Its chat template always opens a
`<think>` block, so `think: False` does not stop the reasoning. The reasoning tokens use up the
512-token cap before the model emits a tool call or an answer. The reasoning text also appears in
the reply content, ending in `</think>`.

### Run 2: scratch experiment, `max_tokens=3000`, `think: True`, one prompt at a time, idle model

| Prompt | Time | Tool call | Outcome |
|---|---|---|---|
| What is the shift summary? | 70.6 s | `get_shift_summary {}` | Correct one-sentence answer from the tool data |
| How much HDPE stock do we have? | 53.3 s | `check_stock {"query": "HDPE"}` | Correct answer, reorder advice from the tool data |
| How many 600x400x300 12kg boxes fit in a 20ft container? | 370.6 s | none | Hit the 3000-token cap; no answer |

Only 3 prompts were run in this configuration. The other 7 prompts were not run, so create, list and
close tools, and the off-topic case, are NOT TESTED with a working configuration.

## What this means

- Strands + Ollama + the LineLedger MCP server connect and the model can pick the right tool with the
  right arguments (2 of 3 prompts in run 2).
- On this CPU, `qwen3:4b` takes about 1 to 6 minutes per turn. That is far too slow for a voice
  assistant, and tool-call reliability is not established.
- The rule-based planner remains the default and is the demo path. The model is an optional extra.
- Nothing in `agent/` was changed after the spike. `max_tokens=512` in `agent/service.py` makes every
  request fail with this model tag, so it needs a fix before the agent can be demonstrated.

## Candidate next step

Try `qwen3:4b-instruct` (the non-thinking 2507 variant, about 2.5 GB, not yet downloaded). It should answer
without a reasoning block, so the 512-token cap and the latency should be much better. This needs a
separate download approval and a fresh 10-prompt run.
