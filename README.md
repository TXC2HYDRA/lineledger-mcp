# LineLedger — Factory-Floor Co-pilot

A voice-first assistant for a plant manager or line operator, backed by a self-hosted
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server over Streamable HTTP.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track).

The web app simulates the voice-assistant experience in a browser. It is not connected to a
physical Alexa+ device.

## Demo data disclosure

All production, handover, follow-up and stock records are **synthetic demo data**. Nothing is
connected to a real factory, real inventory or real customers. The project does not monitor live
equipment. The UI shows "SYNTHETIC DEMO DATA" at all times.

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

Two production lines run as a live **simulation** inside the server (`server/sim.ts`): three stations per
line, random faults and repairs, raw material drawn from stock, shifts that finish and are recorded. The
dashboard follows it in real time over the MCP session. A plant manager can ask, by typing or speaking:

- "line status": live state of each line (running, down, starved, stopped), units to date against the
  pro-rated target, each station and its fault, material on hand.
- "simulate a fault on line 2 sealer", "clear fault on line 2", "stop line 1", "start line 1",
  "receive 2500 kg hdpe", "factory events": drive the simulation through MCP tools.

- "shift summary": output versus target per line for the last finished shift (the simulation writes a new
  one at the end of every simulated shift), with on-track, at-risk and behind status.
- "add handover note for line 2: sealer jaw ran hot": saved in the store (SQLite by default, or Amazon DynamoDB), kept across restarts.
- "add follow-up: re-check guard, owner Ravi, due 2026-10-22, line 1", "open follow-ups", "close follow-up 3".
- "stock of hdpe": stock level, reorder status and suggested purchase quantity.
- "how many 600x400x300 12kg boxes fit in a 20ft container": calls the standalone
  [container-load-planner](https://github.com/TXC2HYDRA/container-load-planner) package
  (MIT, pinned to commit `3c4fe91`).

The web page shows the chat, a live MCP trace of the real JSON-RPC traffic, and a dashboard.

## Run it

Requirements: Node 22.12 or newer. No cloud account and no API key.

```bash
npm install
npm run dev:server        # MCP server on http://127.0.0.1:8787/mcp (SQLite in data/, git-ignored)
npm run dev:web           # web client on http://127.0.0.1:5173 (proxies /mcp, /api and /agent)
```

Open the web URL, then type a request or click an example button.

If port 5173 is busy, run both commands with `WEB_PORT=5273` (the server's Origin allowlist follows
it). `PORT` changes the server port. To reset the demo data, stop the server and delete `data/`.

Simulation switches: `LINELEDGER_SIM_SPEED` (simulated seconds per real second, default 60, so an
8-hour shift takes 8 minutes), `LINELEDGER_SIM_FAULTS=off` (only faults you inject, good for a scripted
demo), `LINELEDGER_SIM_SEED` (same seed, same run), `LINELEDGER_SIM=off` (no simulation). Plant time starts
with the shift after the latest one on record. Line 2 starts with HDPE below its reorder point and stops
when it runs out, about 3 minutes in at the default speed; "receive 2500 kg hdpe" restarts it.

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
| `server/tools.ts`, `server/tools-sim.ts` | Fifteen `server.registerTool(...)` calls with zod input and output schemas, `structuredContent`, `isError` results and tool annotations, and two `server.registerResource(...)` calls. |
| `web/src/mcp.ts` | The browser uses the SDK `Client` with `StreamableHTTPClientTransport` to call the tools. |
| `scripts/mcp-preflight.ts` | Starts a minimal one-tool (`ping`) server on an ephemeral port, separate from the LineLedger server, and runs `initialize`, `tools/list` and `tools/call` through the SDK client. It checks the SDK and protocol version, not the LineLedger tools. |
| `web/src/mcp.ts` (sessions) | The browser keeps its session, subscribes to the factory resources and reconnects once if the server answers 404 for an ended session. |
| `tests/server.test.ts` | A real SDK client talks to the server over HTTP: sessions, push notifications, every tool. |

Transport behaviour: **stateful** Streamable HTTP. `initialize` creates a session and returns its
`Mcp-Session-Id`; later POSTs, the `GET /mcp` event stream (server push) and `DELETE /mcp` (end of session)
must carry it. A missing id gets 400, an unknown or ended one 404. Sessions idle for 30 minutes are closed,
and past 100 sessions the least recently used one is closed. Sessions live in server memory; the data lives
in the store, so a restart loses sessions but not data, and clients reconnect.
`LINELEDGER_MCP_MODE=stateless` restores the earlier one-server-per-POST mode (no push; `GET` and `DELETE`
return 405). The server binds to `127.0.0.1` only, requests are checked for Host and Origin, and request
bodies are limited to 64 KB. A server-side trace tap records every JSON-RPC message in and out, including
the pushed notifications, and streams it to the UI, so the trace panel shows only real traffic.

Tools (15): `get_shift_summary`, `get_shift_history` (feeds the dashboard trend chart), `create_handover_note`,
`list_handover_notes`, `create_follow_up`, `list_follow_ups`, `close_follow_up`, `check_stock`,
`plan_container_load`, and for the simulation `get_line_status`, `get_factory_events`, `inject_fault`,
`clear_fault`, `set_line_running`, `receive_stock`.

Resources (subscribable): `factory://status` (the same data as `get_line_status`) and `factory://events`.
When the simulation changes, subscribed sessions get `notifications/resources/updated` (at most once a
second per resource) and read the resource again.

## Architecture

```
browser (web/)  <--stateful MCP session-->  MCP server (server/)  -->  store: SQLite (default)
   chat, trace, live dashboard   (POST, GET push, DELETE)   Express + MCP SDK      or Amazon DynamoDB (LINELEDGER_STORE=dynamodb)
                                                            simulation (sim.ts)    container-load-planner
        |                                    ^
        +--- optional: /agent proxy ---> agent/ (Strands) --MCP client--+
                                           model: local Ollama (default)
                                              or Amazon Nova on Bedrock (LINELEDGER_MODEL_PROVIDER=bedrock)
```

- `server/`: TypeScript MCP server (Express 5, zod 4) with the production-line simulation
  (`sim.ts`, seeded, stepped in one-minute plant-time steps, writes finished shifts and stock to the store).
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
npm run test:agent       # 15 tests: AWS env scrub, explicit model, Nova-only and profile guards, loopback-only,
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

Other switches: `LINELEDGER_BEDROCK_MODEL` (default `us.amazon.nova-lite-v1:0`, must start with
`amazon.nova-` or `us.amazon.nova-`), `LINELEDGER_AWS_REGION` (default `us-east-1`),
`LINELEDGER_DYNAMODB_TABLE` (default `lineledger`), `LINELEDGER_DYNAMODB_ENDPOINT` (DynamoDB Local, loopback
only).

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

Teardown after judging: delete the table and the IAM user, check Billing shows no charge, delete
`~/.aws-lineledger/`. The full plan, cost estimate and cut lines are in `docs/aws-integration-plan.md`.

## End-to-end tests

`npm run test:e2e` starts the real server (simulation on, random faults off, in-memory SQLite) and the Vite
client on their own ports (8790, 5190), then drives Chromium through: the stateful session and live push,
a fault and its repair with the JSON-RPC trace, chat commands for the simulation and stock (including the
heater-band spare part), persistence across a reload with a new session, reconnecting after the server
ends the session, and the container-load planner. With `LINELEDGER_TEST_DYNAMODB_ENDPOINT` set, the server
runs on the DynamoDB store instead. First run: `npx playwright install chromium`.

## Limits

- Microphone input and speech output: not tested outside a headless browser run.
- The simulation is a teaching model, not a digital twin: serial lines without buffers, exponential
  failures, fixed cycle times. All of its numbers are synthetic.
- MCP sessions live in one server process's memory, so the server cannot be scaled out or run on
  serverless as is; use `LINELEDGER_MCP_MODE=stateless` for that, which gives up server push.
- Speech recognition accuracy in a loud factory is not claimed.
- Production `vite preview` and a full real-keyboard pass are not tested.

## License

MIT. See [LICENSE](LICENSE).
