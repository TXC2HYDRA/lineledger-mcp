# LineLedger — Factory-Floor Co-pilot

A voice-first assistant for a plant manager or line operator, backed by a self-hosted
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server over Streamable HTTP.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track).

The web app simulates the voice-assistant experience in a browser. It is not connected to a
physical Alexa+ device.

## Demo data disclosure

All production, handover, follow-up and stock records are **synthetic demo data**. In the plant profile
the data comes from a seeded simulation of a fictional contract manufacturer, Tarnby Works, with seven
lines and a simulated clock. Nothing is connected to a real factory, PLC, inventory or customer, and no
PLC, OPC UA, Modbus or MQTT integration was built or tested. LineLedger reads and reports; it never
controls equipment, real or simulated. The UI shows "SYNTHETIC DEMO DATA" and the simulated clock at all
times.

Speech input uses the browser's Web Speech API. In Chrome, speech recognition sends audio to the
browser vendor's speech service. This project does not run that service. Text input always works,
and the microphone starts only after you click Listen.

## Zero-cost, local-first

By default: no paid service, no cloud API calls, no credentials in this repository. The optional
language-model agent runs against a local Ollama server on loopback only.

Two AWS integrations are available as opt-in switches (Amazon Bedrock for the agent model, Amazon
DynamoDB as the store). They are off unless you turn them on, and nothing in this repository needs an AWS
account to run, test or judge it. See [AWS integrations](#aws-integrations-optional).

## What it does

The plant profile (`npm run dev:plant`) runs **Tarnby Works**, a fictional contract manufacturer with seven
lines, three shifts and about 100 people, as a live simulation inside the server (`server/sim.ts`,
`plant/plant.json`): breaks, random stops with realistic reason codes, slow cycles and warm-up after
restarts, rejects with reject codes, raw material drawn from stock, and Line 2's heat-sealer temperature.
The story day scripts a sealer overheat on Line 2 (warning at 13:14, trip at 13:23, heater band swapped at
13:58, restart at 14:02) and a coil jam on Line 5, over the random model. The dashboard follows it live
over the MCP session. A plant manager can ask, by typing or speaking:

- "how are the lines doing right now", "is line 2 running", "why is line 2 down", "how long has line 2
  been stopped", "is the sealer temperature normal": live state, reason code, minutes in state, rate,
  pace against the target to date, alarms and the sealer's temperature against its warn and trip limits.
- "shift summary", "shift summary for shift A": output per line; for the shift in progress, against the
  target to date (pace), with on-track, at-risk and behind status.
- "show the trend for the last 10 shifts", "plant events".
- "add handover note for line 2: sealer jaw ran hot again, tripped 13:23": saved in the store (SQLite by
  default, or Amazon DynamoDB), kept across restarts.
- "add follow-up: inspect sealer thermocouple, owner Ravi, due 2026-10-24, line 2", "open follow-ups",
  "close follow-up 3".
- "stock of heater band", "stock of hdpe": live stock, reorder status, suggested order quantity and days of
  cover; "receive 20000 kg hdpe" books a goods receipt (an ERP record, not a machine command).
- "how many 600x400x300 12kg boxes fit in a 20ft container": calls the standalone
  [container-load-planner](https://github.com/TXC2HYDRA/container-load-planner) package
  (MIT, pinned to commit `3c4fe91`).

The web page shows the chat, a live MCP trace of the real JSON-RPC traffic (including the server's pushes),
seven live line cards, a simulated-clock chip and an alarm ticker. Without the plant profile the server
keeps the small two-line seed and no simulation, as the tests use it.

The plant profile has no hand-written demo rows. On a fresh plant database the server first simulates the
seven days before the story day (about 0.1 s, its own random streams, stock back at the starting levels
afterwards), so the shift history and the trend hold simulated shifts for all seven lines; notes and
follow-ups start empty. A plant database made before this change (`data/plant.sqlite`) loses exactly the old
seeded notes, follow-ups and shift rows when the server starts, keeps its own rows and stock, and gets the same
week of history.

## Run it

Requirements: Node 22.12 or newer. No cloud account and no API key.

```bash
npm install
npm run dev:plant         # MCP server with the Tarnby Works plant on http://127.0.0.1:8787/mcp (data/plant.sqlite)
npm run dev:web           # web client on http://127.0.0.1:5173 (proxies /mcp, /api and /agent)
```

Open the web URL, then type a request or click an example button. `npm run dev:server` instead starts the
two-line seed without a simulation.

If port 5173 is busy, run both commands with `WEB_PORT=5273` (the server's Origin allowlist follows
it). `PORT` changes the server port. To reset the demo data, stop the server and delete `data/`.

Plant switches: `LINELEDGER_SIM_SPEED` (simulated seconds per real second, default 120: one simulated hour
in 30 seconds; the story's 14:10 to 16:15 stretch runs as a x300 time-lapse, shown on the clock chip),
`LINELEDGER_SIM_HOLDS=on` (the clock pauses 12 seconds at 12:58, 13:15 and 13:23 so a presenter can speak;
the chip shows HOLD), `LINELEDGER_SIM_SEED` (default 1; the same seed gives the same day at any speed),
`LINELEDGER_SIM_FAULTS=off` (scripted stops only), `LINELEDGER_SIM_STORY=off` (no story). The story day runs
on a fresh plant database: it starts at 12:55 with shift A already simulated from 06:00. A restarted server
resumes where the plant stopped: with every flush (each 15 simulated minutes, and at shutdown) the simulation
saves its whole live state (clock, per-line state and counters, open stops and alarms, random streams, recent
events) in the store, and the same seed then continues the same day. The plant clock does not run while the
server is down. A database from before this was saved continues with the shift after the latest one on
record. `npm run plant:reset` deletes the plant
database to replay the story; `npm run plant:story-check` runs the story day headless and checks its
numbers (Line 2 trips at 13:23, Line 2 shift A good units, plant shift A output, HDPE reorder time,
heater bands left).

### Verify

```bash
npm run typecheck        # server, tests, scripts and web
npm test                 # vitest: MCP client over real HTTP against the LineLedger server, hardening, rule-based planner
npm run test:dynamodb    # the same tests against the DynamoDB store on DynamoDB Local (see AWS integrations)
npm run test:e2e         # Playwright: a real browser against the real server and simulation (see End-to-end tests)
npm run check:contrast   # recomputes WCAG contrast from web/src/style.css
npm run build            # vite build -> dist/web
npm run preflight:mcp    # raw initialize and SDK client both report protocolVersion 2025-11-25
```

## MCP evidence

Spec version: the server negotiates **2025-11-25**. `npm run preflight:mcp` checks it twice: from the
raw `initialize` response on the wire, and from `transport.protocolVersion` in the SDK client.
`tests/server.test.ts` asserts it again.

Where `@modelcontextprotocol/sdk` 1.32.1 is imported and called at runtime:

| File | What it does |
|---|---|
| `server/app.ts` | Creates one `McpServer` and `StreamableHTTPServerTransport` per MCP session (`sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`), routes POST, GET and DELETE on `/mcp` by `Mcp-Session-Id`, handles `resources/subscribe` and sends `notifications/resources/updated` with `server.sendResourceUpdated`. Uses the SDK's `hostHeaderValidation` and `isInitializeRequest`. |
| `server/tools.ts`, `server/tools-sim.ts` | Twelve `server.registerTool(...)` calls in the plant profile (nine in the seed profile) with zod input and output schemas, `structuredContent`, `isError` results and tool annotations, and one `server.registerResource(...)` call. |
| `web/src/mcp.ts` | The browser uses the SDK `Client` with `StreamableHTTPClientTransport` to call the tools. |
| `scripts/mcp-preflight.ts` | Starts a minimal one-tool (`ping`) server on an ephemeral port, separate from the LineLedger server, and runs `initialize`, `tools/list` and `tools/call` through the SDK client. It checks the SDK and protocol version, not the LineLedger tools. |
| `web/src/mcp.ts` (sessions) | The browser keeps its session, subscribes to the factory resources and reconnects once if the server answers 404 for an ended session. |
| `tests/server.test.ts` | A real SDK client talks to the server over HTTP: sessions, push notifications, every tool. |
| `tests/web-client.test.ts` | The browser client against the optional stateless server: no session, no reconnect. |

Transport behaviour: **stateful** Streamable HTTP. `initialize` creates a session and returns its
`Mcp-Session-Id`; later POSTs, the `GET /mcp` event stream (server push) and `DELETE /mcp` (end of session)
must carry it. A missing id gets 400, an unknown or ended one 404. Sessions idle for 30 minutes are closed,
and past 100 sessions the least recently used one is closed. Sessions live in server memory; the data lives
in the store, so a restart loses sessions but not data, and clients reconnect.
`LINELEDGER_MCP_MODE=stateless` restores the earlier one-server-per-POST mode (no push; `GET` and `DELETE`
return 405). The server binds to `127.0.0.1` only, requests are checked for Host and Origin, and request
bodies are limited to 64 KB. A server-side trace tap records every JSON-RPC message in and out, including
the pushed notifications, and streams it to the UI, so the trace panel shows only real traffic.

Tools: `get_shift_summary` (pace fields for the shift in progress), `get_shift_history`, `create_handover_note`,
`list_handover_notes`, `create_follow_up`, `list_follow_ups`, `close_follow_up`, `check_stock` (live stock
and days of cover in the plant profile), `plan_container_load`, and in the plant profile
`get_live_line_status`, `get_factory_events` and `receive_stock` (a goods receipt). No tool starts, stops or
repairs a line.

Resource (subscribable, plant profile): `plant://snapshot`, the whole live plant in one JSON document.
When the simulation changes, subscribed sessions get `notifications/resources/updated` (at most once a
second) and read it again; the trace shows each push followed by the `resources/read`.

When one session creates a handover note or a follow-up or closes a follow-up, the server also sends a
`data_changed` logging notice to every session, so a second browser tab refreshes its lists without a click.
After a server restart the old session id gets a 404; the browser client opens a new session and retries once.

## Architecture

```
browser (web/)  <--stateful MCP session-->  MCP server (server/)  -->  store: SQLite (default)
   chat, trace, live dashboard   (POST, GET push, DELETE)   Express + MCP SDK      or Amazon DynamoDB (LINELEDGER_STORE=dynamodb)
                                                            plant simulation       container-load-planner
                                                            (sim.ts, plant.json)
        |                                    ^
        +--- optional: /agent proxy ---> agent/ (Strands) --MCP client--+
                                           model: local Ollama (default)
                                              or Amazon Nova on Bedrock (LINELEDGER_MODEL_PROVIDER=bedrock)
```

- `server/`: TypeScript MCP server (Express 5, zod 4) with the Tarnby Works simulation (`sim.ts`, seeded,
  stepped one simulated minute at a time, so a seed gives the same day at any speed). It keeps live state in
  memory and writes the shift in progress, finished shifts and stock levels to the store every 15
  simulated minutes and at each shift end, so the existing tools read its output.
- `plant/plant.json`: the plant's single source of truth (lines, stations, cycle times, targets,
  failure and reject parameters, bill of materials, stock, crews, the story day).
  The tools talk to a `Store` interface
  (`server/store.ts`) with two implementations: `store-sqlite.ts` (`node:sqlite`, default) and
  `store-dynamodb.ts` (AWS SDK for JavaScript v3).
- `web/`: Vite + vanilla TypeScript client. The default planner is a deterministic rule-based mapper
  (`web/src/planner.ts`, no LLM) from request text to tool calls.
- `agent/`: optional Python service using Strands Agents with an explicit model (local Ollama by
  default, Amazon Nova on Bedrock as an option), the MCP server's tools, an AWS-environment scrub and a
  loopback-only check.
- `docs/`: UI specification, implementation decisions, download manifest, friction log, product
  feedback and the demo video plan.

## Optional: local-model agent

Status: **works, but not reliable enough to be the default.** With `qwen3:4b-instruct` on CPU only, a
10-prompt spike picked a correct tool for every prompt that needs one, answered in about 3 to 17 s per
turn (36 s for the first call, which loads the model), and made argument or reasoning mistakes on 3 of 10
prompts. Details and the graded table are in `docs/spike-results.md`. The web client therefore defaults to
the rule-based planner.

```bash
python3 -m venv .venv && .venv/bin/python -m pip install -r agent/requirements.txt
npm run test:agent       # 18 tests: AWS env scrub, explicit model, Nova-only and profile guards, loopback-only,
                         # model-call cap, MCP tool discovery, reconnect after a server restart. No AWS call.
```

Running the agent needs a local Ollama server (not installed by this repository). See
`docs/download-approval-manifest.md` for the no-sudo steps. Then:

```bash
npm run dev:agent        # http://127.0.0.1:8788, model qwen3:4b-instruct
```

and press "Planner: rules (no LLM)" in the web client to switch it to "Planner: agent model".

## AWS integrations (optional)

Status, 2026-10-22: code and tests are in this repository. They were run against a local DynamoDB
emulator and with mocked AWS credentials only. **[OWNER: update this line after the live run, for
example "Run against Amazon Bedrock (Nova Lite, us-east-1) and a DynamoDB table on a Free-plan account on
2026-10-23", and link the graded spike table.]**

| Service | Used for | Switch (default first) | Where in the code |
|---|---|---|---|
| Amazon Bedrock, Amazon Nova Lite | The agent's model, through the Strands Agents SDK `BedrockModel` and the Converse API | `LINELEDGER_MODEL_PROVIDER=ollama` / `bedrock` | `agent/service.py` (`build_model`), `agent/guard.py` |
| Amazon DynamoDB | Notes, follow-ups, shift output, stock and id counters in one table | `LINELEDGER_STORE=sqlite` / `dynamodb` | `server/store-dynamodb.ts`, `server/store.ts` |
| Amazon SNS | Email alert when a follow-up is created | `LINELEDGER_NOTIFY=none` / `sns` (+ `LINELEDGER_SNS_TOPIC_ARN`) | `server/notify.ts` |
| Amazon EventBridge + AWS Lambda + SNS | Scheduled shift report (line status, stock to reorder, overdue follow-ups) by email at the end of each shift | `infra/shift-report.yaml`, deployed by `scripts/deploy-report.sh` | `lambda/shift-report.ts`, `server/report.ts` |

Other switches: `LINELEDGER_BEDROCK_MODEL` (default `us.amazon.nova-lite-v1:0`, must start with
`amazon.nova-` or `us.amazon.nova-`), `LINELEDGER_AWS_REGION` (default `us-east-1`),
`LINELEDGER_DYNAMODB_TABLE` (default `lineledger`), `LINELEDGER_DYNAMODB_ENDPOINT` (DynamoDB Local, loopback
only).

Not used on purpose: SQS (nothing slow to queue yet), DynamoDB Streams (the server publishes its own
events, and the table keeps streams off), Kinesis, Amazon MQ and ElastiCache (no workload for them).

### Fallbacks to self-hosted services

An AWS outage, missing credentials or a throttled model never ends in an error page. Each AWS piece has a
self-hosted twin that takes over by itself (`LINELEDGER_FALLBACK=off` turns them all off):

| AWS piece | Falls back to | How |
|---|---|---|
| DynamoDB store | SQLite file (`LINELEDGER_DB`) | `server/store-fallback.ts`: a failed or slow call (8 s) is served by SQLite, DynamoDB is skipped for 30 s and then tried again. Also covers DynamoDB being down or misconfigured at startup. `/api/health` shows `degraded: true`, the page shows "SQLite (fallback)". |
| SNS alerts | `LINELEDGER_NOTIFY=local`: JSONL file `LINELEDGER_ALERT_FILE` plus optional `LINELEDGER_WEBHOOK_URL` (ntfy, Mattermost, Slack-style) | `server/notify.ts`: a failed publish (5 s limit) goes to the local channel. |
| Bedrock model | Local Ollama model (loopback only) | `agent/service.py` (`ask_with_fallback`): a failed Bedrock turn is retried on Ollama; the agent log records which model answered. |
| Agent model, either kind | Rule-based planner | `web/src/main.ts`: if the agent service fails, the same request is answered by the rules. |
| EventBridge + Lambda report | `npm run report` from cron | `scripts/shift-report.ts` builds the same digest and sends it through the configured notifier. Example: `0 6,14,22 * * * cd /path/to/repo && LINELEDGER_NOTIFY=local npm run report`. |

Redis and Celery are not used: SQLite, a JSONL file and cron already cover these jobs without another
server to run. While the primary store is down, new notes and follow-ups exist only in SQLite and the
DynamoDB rows are not shown; the two stores are not synced (noted in `server/store-fallback.ts`).

### Safety rules in the code

- Real AWS is reached only through a project-only profile: `AWS_PROFILE=lineledger`, with
  `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` both inside `~/.aws-lineledger/`. Otherwise the agent
  and the server refuse to start, so the machine's default `~/.aws` profile is never used by accident. Key
  variables (`AWS_ACCESS_KEY_ID` and others) are refused or scrubbed; keys live only in the project file.
- Bedrock: only Amazon Nova model ids. Anthropic and other Marketplace models are rejected at startup
  (they need a card and are not free). `max_tokens` 512, at most 4 model calls per request, token usage
  logged per turn and shown in the chat.
- DynamoDB: one table, provisioned 5 RCU / 5 WCU, no index, stream, backup or replica, created with the AWS
  CLI (`scripts/create-table.sh`), never from the console. Ids come from an atomic counter; closing a
  follow-up is a conditional write. Reads are strongly consistent.
- The IAM user for the project needs only `docs/aws-iam-policy.json` (replace `ACCOUNT_ID`).

### Try the DynamoDB store locally (no AWS account)

```bash
docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.1     # DynamoDB Local, in memory
npm run test:dynamodb                                        # every server and store test on both stores
export LINELEDGER_DYNAMODB_ENDPOINT=http://127.0.0.1:8000
npm run dynamodb:local-table && npm run dynamodb:seed
LINELEDGER_STORE=dynamodb npm run dev:server                 # the page footer shows "store: Amazon DynamoDB"
```

### Run against AWS (owner only, Free-plan account)

```bash
export AWS_CONFIG_FILE=$HOME/.aws-lineledger/config AWS_SHARED_CREDENTIALS_FILE=$HOME/.aws-lineledger/credentials AWS_PROFILE=lineledger
aws sts get-caller-identity                                  # must be the project account
scripts/create-table.sh                                      # creates and checks the table
npm run dynamodb:seed
LINELEDGER_STORE=dynamodb npm run dev:server
LINELEDGER_MODEL_PROVIDER=bedrock npm run dev:agent          # Nova Lite in us-east-1
.venv/bin/python scripts/agent_spike.py > spike-nova-lite.md # 10 prompts, graded by hand afterwards
```

Alerts and the scheduled report (after the table exists; the deploying profile needs more rights than
`docs/aws-iam-policy.json`, so use the account owner for this one command):

```bash
scripts/deploy-report.sh you@example.com                     # topic, Lambda, schedule (06:00, 14:00, 22:00 UTC)
# confirm the subscription in the email AWS sends, then:
aws lambda invoke --function-name lineledger-shift-report /dev/stdout
LINELEDGER_NOTIFY=sns LINELEDGER_SNS_TOPIC_ARN=<TopicArn from the stack output> LINELEDGER_STORE=dynamodb npm run dev:server
```

Teardown after judging: `scripts/deploy-report.sh --delete`, delete the table and the IAM user, check Billing shows no charge, delete
`~/.aws-lineledger/`. The full plan, cost estimate and cut lines are in `docs/aws-integration-plan.md`.
## End-to-end tests

`npm run test:e2e` starts the real server in the plant profile (story day, seed 1, x120, in-memory SQLite)
and the Vite client on their own ports (8790, 5190), then drives Chromium through: the stateful session and
live push; the scripted Line 2 sealer trip, with the chat explaining it and the trace showing the pushes;
the operator questions through the rule-based planner; a check that nothing on the page controls a line;
persistence across a reload with a new session; reconnecting after the server ends the session; and the
container-load planner. With `LINELEDGER_TEST_DYNAMODB_ENDPOINT` set, the server runs on the DynamoDB store
instead. First run: `npx playwright install chromium`.

## Limits

- Microphone input and speech output: not tested outside a headless browser run.
- The simulation is a planning-grade model, not a digital twin: independent lines (no buffer between
  Line 2 and Line 3), exponential failures, lognormal repairs, micro-stops folded into a slower cycle, stops
  counted to the minute. All of its numbers are synthetic and were tuned, not measured.
- The simulation runs inside the server process. A real deployment would receive machine data from an
  edge gateway (OPC UA, Modbus or MQTT to an ingest endpoint); no such ingest was built.
- The plant percent in the shift summary adds different products (brackets, crates, kits) weighted by
  target. It is a target-weighted figure, not a physical quantity.
- MCP sessions live in one server process's memory, so the server cannot be scaled out or run on
  serverless as is; use `LINELEDGER_MCP_MODE=stateless` for that, which gives up server push.
- Speech recognition accuracy in a loud factory is not claimed.
- Production `vite preview` and a full real-keyboard pass are not tested.

## License

MIT. See [LICENSE](LICENSE).
