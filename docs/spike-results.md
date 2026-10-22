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

## Run 3: `qwen3:4b-instruct` (ID `0edcdef34593`, 2.5 GB), committed settings, 10 prompts, idle model

Same service as run 1 (`max_tokens=512`), model swapped by `LINELEDGER_MODEL`. The first model was deleted
before this pull. No reasoning text leaked into any reply. The model used 3.9 GB of RAM, 100% CPU.
The script's automatic check only compares the tool name (10 of 10, average 12.3 s). Graded by hand against
the arguments and the reply:

| # | Prompt | Time | Verdict |
|---|---|---|---|
| 1 | shift summary | 36.1 s (includes model load) | Correct |
| 2 | How is line 2 doing this shift? | 7.0 s | **Wrong.** The model invented `shift_date: 2023-10-25, shift: A`, so the tool returned nothing for line 2 and the reply said "no output" |
| 3 | add handover note, line 2 | 9.1 s | Partly wrong. Text and line are right, but it invented the author "Asha (shift A)"; the tool requires an author and the user gave none |
| 4 | show handover notes | 13.3 s | Correct |
| 5 | add follow-up (title, owner, due, line) | 11.9 s | Correct |
| 6 | list open follow-ups | 12.8 s | Correct |
| 7 | close follow-up 1 | 7.0 s | Correct action; the reply adds an unsupported detail ("Ravi completed the check") |
| 8 | stock of HDPE | 7.3 s | Correct |
| 9 | 600x400x300 12kg boxes in a 20ft container | 16.0 s | **Failed.** Arguments did not match the tool schema (`depth`/`weight` instead of `length`/`weightKg`, no `maxPayloadKg`), so there was no answer; the model asked the user for dimensions |
| 10 | weather in Pune (no tool) | 2.6 s | Correct: declined, no tool call |

Strict tally: 7 correct, 1 partly wrong, 2 failed. Median 10.5 s, mean 12.3 s per turn on CPU only.
One run of 10 prompts at temperature 0 on one machine: this shows the approach works, not that it is reliable.

## Runs 4 and 5: prompt and tool changes, same 10 prompts

Run 4 added three rules to the system prompt (omit optional arguments, author "Operator" when none is
given, state only what the tool returned) and put the standard 20ft and 40ft container sizes in the
container tool's description. Result: the invented author was fixed (prompt 3 now correct), but prompt 2
still invented a shift date and prompt 9 sent the same invalid container call as before. Only the tool
name matched in both, so the script still printed 10 of 10.

Run 5 made two more changes: the system prompt now says never to pass `shift_date` or `shift`, and
`plan_container_load` accepts a flat form (`container_type` "20ft" or "40ft" plus `box_length_mm`,
`box_width_mm`, `box_height_mm`, `box_weight_kg`) besides the nested objects. Graded by hand:

| # | Prompt | Time | Verdict |
|---|---|---|---|
| 1 | shift summary | 36.2 s | Correct |
| 2 | How is line 2 doing this shift? | 7.8 s | **Wrong.** Still invented `shift_date: 2023-10-15, shift: "A"` despite the explicit rule |
| 3 | add handover note | 8.1 s | Correct (author "Operator") |
| 4 | show handover notes | 13.7 s | Correct |
| 5 | add follow-up | 13.5 s | Correct |
| 6 | list open follow-ups | 17.1 s | Correct |
| 7 | close follow-up 1 | 9.6 s | Correct; facts match the stored record (owner Ravi, closed 2026-10-22) |
| 8 | stock of HDPE | 3.3 s | **Failed.** No tool call; the model said it had no stock data. This prompt called `check_stock` correctly in runs 3 and 4 |
| 9 | 600x400x300 12kg boxes in a 20ft container | 16.6 s | Tool call correct with the flat form (315 boxes, grid 9 x 5 x 7). The spoken reply is misleading: it says "only 2350 can be loaded by payload limit", but payload would allow 2350, so geometry is the limit |
| 10 | weather in Pune (no tool) | 3.3 s | Correct: declined, no tool call |

Strict tally for run 5: 7 correct, 1 partly wrong (prompt 9: right numbers, confusing sentence), 2 failed.
Mean 12.9 s per turn. The overall count did not improve between run 3 and run 5; the failures moved
(container improved, stock regressed). A prompt tweak that fixes one prompt can break another, and 10
prompts at temperature 0 is too small a sample to tell fixes from noise.

## What this means

- Strands + Ollama + the LineLedger MCP server connect and the model can pick the right tool with the
  right arguments (2 of 3 prompts in run 2).
- `qwen3:4b` (thinking) takes about 1 to 6 minutes per turn on this CPU and fails at the committed token cap.
  `qwen3:4b-instruct` answers in about 3 to 16 s warm, and chose a correct tool for 10 of 10 prompts,
  but 3 of 10 had wrong or invented arguments. That is usable for a demo, not a reliable product.
- Fixes tried afterwards are described under "Runs 4 and 5" below. They help in places and move failures
  around, so the model is not reliable enough to be the default.
- The rule-based planner remains the default and is the demo path. The model is an optional extra.
- The only code change after the spike is the default model in `agent/service.py`, now `qwen3:4b-instruct`.
  `max_tokens=512` is enough for this model.
