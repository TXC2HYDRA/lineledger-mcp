# Devpost text: LineLedger

Draft for the author to review and paste into Devpost. Items marked [VERIFY] or [AUTHOR TO CONFIRM] need a decision or a check before submitting. Delete this line before pasting.

## Project name

LineLedger

## Tagline

Factory-Floor Co-pilot: ask for the shift summary, leave a handover note or check stock by typing or speaking, backed by a self-hosted MCP server.

## Project description

LineLedger is a voice-first assistant prototype for a plant manager or line operator. At a shift change the useful questions are short ones: how did each line do against target, what did the last shift leave behind, which follow-ups are still open, is a material running low, and how many boxes fit in a container. LineLedger answers these in a web app, by text or by voice.

Each request is mapped to a tool on a self-hosted Model Context Protocol (MCP) server. Behind the server runs a seeded simulation of Tarnby Works, a fictional contract manufacturer with seven lines, three shifts and about 100 people: breaks, random stops with reason codes, slow cycles, rejects, raw material drawn from stock, and a temperature sensor on Line 2's heat sealer. A scripted story day overheats that sealer until Line 2 trips at 13:23, while the rest of the plant keeps its own random stops. The operator asks "why is line 2 down", "is the sealer temperature normal" or "shift summary" and gets answers from live, changing data. LineLedger only reads the plant: no tool starts, stops or repairs a line. The server keeps a stateful MCP session per client and pushes resource updates over it, so the dashboard follows the plant without polling. Handover notes, follow-ups, stock and shift results are stored (SQLite by default), so they survive a restart. The web app shows the real JSON-RPC messages between the client and the server, including the pushed notifications, in a live trace panel next to the dashboard.

The server, database and web app run on one machine and use no paid service or cloud account. (The optional browser speech recognition may send audio to the browser vendor; see the data disclosure below.) All production, handover and stock data is synthetic. The voice experience is simulated in a browser; it is not an Alexa+ device skill.

## Key features

- An MCP server written in TypeScript (`@modelcontextprotocol/sdk` 1.32.1) using stateful Streamable HTTP: one session per client (`Mcp-Session-Id`), a `GET /mcp` event stream for server push, `DELETE /mcp` to end a session, idle sessions closed after 30 minutes. It negotiates protocol version 2025-11-25; the preflight script and the tests check this. A stateless mode remains as an option.
- Twelve tools in the plant profile: `get_shift_summary` (with pace against the target to date for the shift in progress), `get_shift_history`, `create_handover_note`, `list_handover_notes`, `create_follow_up`, `list_follow_ups`, `close_follow_up`, `check_stock` (live stock and days of cover), `plan_container_load`, `get_live_line_status`, `get_factory_events` and `receive_stock` (a goods receipt). Without the plant profile the server offers the original nine tools on a small seed.
- A subscribable MCP resource, `plant://snapshot` (the whole live plant). Subscribed sessions get `notifications/resources/updated` when the plant changes (at most once a second), then read it again.
- The plant simulation (`server/sim.ts`, `plant/plant.json`): seven lines with their stations, ideal cycle times and targets; shifts A and B on all lines and C on the two molding lines; planned breaks; stops drawn from each line's time between failures and repair time with a reason mix (including a deliberate share of "unclassified"); slow cycles, micro-stops and warm-up after restarts; rejects with reject codes; materials drawn by bill of materials. Seeded and stepped one simulated minute at a time, so seed 1 gives the same story day at any speed. A simulated clock (x120, with a x300 time-lapse stretch) is always on screen. All of it is synthetic.
- Every tool has a zod input schema and output schema and returns `structuredContent`. Invalid input comes back as an `isError` result.
- Handover notes, follow-ups, stock and shift results persist in SQLite (`node:sqlite`) by default.
- `plan_container_load` calls a separate open-source package, container-load-planner (MIT), which counts how many identical boxes fit in a container on a uniform grid, limited by geometry and payload weight. It is a calculator, not a packing optimiser, and the 20ft and 40ft container sizes in the planner are fixed example values, not carrier specifications.
- Server hardening: Origin allowlist (requests with no Origin header, such as non-browser clients, are allowed) and Host check, 64 KB request body limit, 400 for a request without a session id and 404 for an unknown or ended one, a cap on open sessions, bound to 127.0.0.1. The web client and the agent open a new session and retry once when theirs has ended.
- A live MCP trace, shown as a dashboard tile with a message count and a full JSON-RPC drawer. It is fed by a server-side trace tap, so it shows only messages that actually reached the server (the tap keeps the latest 500).
- A Bento Grid web interface with translucent glass cards, a dark and a light theme (toggle in the top bar, remembered in the browser), a left sidebar that can be closed (open: one long page whose links scroll to Home, Assistant, Follow-ups, Handover and Container load; closed: a one-screen dashboard), a plant-output hero metric, per-line cards, chat, output-versus-target bars, a shift trend chart, handover, follow-up and container-load panels, and a voice-state strip (idle, listening, thinking, speaking, error). State is shown with text and an icon, not colour alone. `npm run check:contrast` checks 194 colour pairs against WCAG contrast thresholds, in both themes, with the translucent glass surfaces composited over the page.
- Voice input starts only after the user clicks Listen. Typing always works. Spoken replies can be stopped.
- A "SYNTHETIC DEMO DATA" badge is always visible.
- A deterministic rule-based planner (no language model) is the default way requests are turned into tool calls.

## How it works

1. The web client (Vite and vanilla TypeScript) takes a typed or spoken request.
2. The planner turns the request into a single tool call. The default planner is rule-based: regular expressions and keyword rules in `web/src/planner.ts`, with no language model.
3. The client sends the call through a same-origin proxy (the Vite dev server proxies `/mcp`, `/api` and `/agent`), so no CORS setup is needed.
4. The MCP server receives it over Streamable HTTP on the client's session. The page opened that session at load (`initialize`), subscribed to the factory resources and keeps a `GET /mcp` event stream open for server push.
5. The tool reads or writes the store or reads the live plant. For `plan_container_load` it calls the container-load-planner package (pinned to commit `3c4fe91`).
6. The plant advances twice a second of real time. When it changes, the server sends `notifications/resources/updated` for `plant://snapshot` to subscribed sessions; the page reads the resource again and redraws the line cards, the clock chip and the alarm ticker.
7. A trace tap on the server records each JSON-RPC message in and out. The UI reads it from `/api/trace` and `/api/trace/stream` and shows it in the trace panel.
8. The result is shown in the chat and the dashboard, and can be read aloud with browser speech synthesis.

Optional local-model agent: the repository also contains a small Python service (`agent/`) built on the Strands Agents SDK with a local Ollama model (`qwen3:4b-instruct`). The web app has a switch for choosing it instead of the rule-based planner. The service has guards so it cannot fall back to a cloud model: an explicit Ollama model, a scrubbed AWS environment, a loopback-only host, and a startup assertion with tests. In a 10-prompt spike on a CPU-only laptop, the model chose a suitable tool for each prompt that needed one and answered in about 3 to 17 s per turn after the first call, but 3 of 10 prompts had wrong or invented arguments or a misleading reply. Treat this part as an experiment; the rule-based planner is the tested path.

## Tracks and mini challenges

**Primary track: Alexa+.** LineLedger is a voice-first assistant experience built as a web app with a simulated voice interface. It was not built with the Alexa+ developer console and does not run on a physical Alexa+ device.

**Mini challenge: Open Source.** A new, additional open-source project, `container-load-planner`, created on 2026-10-21 (inside the submission period) under the MIT license, separate from the LineLedger repository. What I did: extracted the container-load calculation into its own package and published it with tests (49, run with `node --test`), CI, a license and install instructions. How it works: it counts how many identical boxes fit in a container on a uniform grid, keeping the box upright by default or trying all rotations when asked, and reports whether geometry or payload weight is the limit. It is a calculator, not a packing optimiser, and the 20ft and 40ft sizes are fixed example values. LineLedger depends on it, pinned to a commit, and calls it from the `plan_container_load` tool. Why it matters: a small, dependency-free TypeScript function that other logistics tools can reuse, with documented limits so nobody mistakes it for a carrier-grade loader.

- GitHub username: TXC2HYDRA
- Contribution URL: https://github.com/TXC2HYDRA/container-load-planner
- Project repository URL: https://github.com/TXC2HYDRA/lineledger-mcp

**Mini challenge: AWS Builder.** [VERIFY] Check the official rules on whether this qualifies. The challenge text lists the Strands SDK among the qualifying technologies, and LineLedger uses it. The `agent/` service is built on the Strands Agents SDK (1.61.1) and lets a local Ollama model (`qwen3:4b-instruct`) call the LineLedger MCP server's tools over Streamable HTTP. The model runs on this machine. No AWS service is called and no AWS credentials are needed; the service has guards so it cannot reach one (scrubbed AWS environment, explicit Ollama model, loopback-only hosts, startup assertion, 3 tests). The integration is documented in `agent/`, `docs/friction-log.md`, `docs/product-feedback.md` and `docs/spike-results.md`. In the model spike on 2026-10-22, 7 of 10 prompts were handled correctly, 1 had correct tool results but a misleading spoken sentence, and 2 failed (an invented shift date, and one missing tool call). Mean latency was 12.9 s per turn on a CPU-only laptop. The rule-based planner stays the default path; the agent is optional. The repository also contains opt-in code for Amazon Bedrock (Amazon Nova as the agent's model, through the Strands `BedrockModel`) and Amazon DynamoDB (as the store), both off by default and tested against mocks and a local DynamoDB emulator. [AUTHOR TO CONFIRM] Say here whether you ran them against a live AWS account; if not, say they are built but not run on AWS. See the README section "AWS integrations" and `docs/aws-integration-plan.md`.

## Data disclosure and limits

- All data is synthetic: production counts, line names, handover notes, stock levels and suppliers. Nothing is connected to a real factory, real inventory or real customers.
- This is a simulated voice experience in a web app. There is no integration with a physical Alexa+ device or the Alexa+ developer console.
- The project monitors a simulated plant only. Its data is generated by a seeded simulator for a fictional company, Tarnby Works, with seven lines and a simulated clock (x120, with a x300 time-lapse stretch). No real PLC, OPC UA, Modbus or MQTT integration was built or tested, and LineLedger never controls equipment.
- Speech recognition uses the browser's Web Speech API. In Chrome this sends audio to the browser vendor's speech service, which this project does not run. Typing works without it.
- Speech has not been tested in a real browser with a microphone, and no claim is made that it works reliably in factory noise.
- Not tested: production `vite preview` and a full real-keyboard pass. The local-model agent had one 10-prompt spike (7 correct, 1 partly wrong, 2 failed, about 13 s per turn on CPU); it is an experiment, not the tested path. See `docs/spike-results.md`.
- By default no AWS service or other paid cloud API is used or called, and the project needs no cloud credentials. The optional AWS code paths (Bedrock, DynamoDB) run only when switched on with a separate project profile. [AUTHOR TO CONFIRM] whether they were run live.
- The simulation is a planning-grade model with tuned, synthetic numbers, not a digital twin. The plant percent in the shift summary adds different products weighted by target; it is not a physical quantity.
- `node:sqlite` is an experimental Node feature and prints an ExperimentalWarning at startup.

What was tested: `npm test` (50 tests on SQLite, including a real MCP client over HTTP, stateful sessions and server push, every tool in both profiles, the plant simulation and its story day, hardening checks and the planner; 90 with `npm run test:dynamodb`, which repeats the server, store and simulation tests on the DynamoDB store), `npm run test:e2e` (7 Playwright tests: a real browser against the real server running the plant story), `npm run plant:story-check` (the story day's numbers), `npm run test:agent` (15 tests: agent guards and session recovery), `npm run typecheck`, `npm run build`, and `npm audit` (0 vulnerabilities).

## Setup

```bash
git clone https://github.com/TXC2HYDRA/lineledger-mcp.git && cd lineledger-mcp   # Node 22.12 or newer, no API key; npm install needs internet to fetch packages, including the planner from GitHub
npm install
npm run dev:server    # MCP server on http://127.0.0.1:8787/mcp
npm run dev:web       # web client on http://127.0.0.1:5173
npm test              # optional: run the tests
```

Open http://127.0.0.1:5173 and type a request or use the example buttons. See the README for details (ports, the microphone, verified commands).

## What we learned (friction notes)

Taken from `docs/friction-log.md`:

- The pinned SDK first-run preflight passed first try.
- `createMcpExpressApp()` validates Host only and has no Origin option, so we added our own Origin allowlist.
- The negotiated protocol version is only visible through `transport.protocolVersion`, so the preflight checks both the raw `initialize` response and the SDK client.
- There is no documented hook for tracing JSON-RPC on the HTTP transport, so we wrapped `transport.send` and recorded the request body to build the trace tap.
- Strands constructs and starts the MCP client when the Agent is created, so the guard test starts the real MCP server first.
- `streamablehttp_client` is deprecated in mcp 1.30.0; passing `MCPClient(url=...)` to Strands avoids it.
- Strands' default `Agent()` builds a Bedrock model, which triggers an AWS credential lookup, so the agent service guards against it.

Would we build this again, and why: [AUTHOR TO CONFIRM] Suggested draft: "Yes, for the MCP part. A small stateless server with typed tools was quick to build and easy to test, and the trace panel made the protocol visible. I would want to test speech on a real device and in a noisy environment before saying more about the voice side." Edit or replace with your own view.

## Before you submit

- [ ] [VERIFY] container-load-planner: CI is green and it has 49 tests. This comes from the author and has not been checked by us. Open the repository Actions tab and run the tests locally.
- [ ] [VERIFY] The pinned commit `3c4fe91` still exists in the planner repository and matches `package.json`.
- [ ] [VERIFY] Video: uploaded, set to public (or unlisted as the rules allow), and the link opens while logged out. The video must show only synthetic data, use no third-party logos or trademarks, and use no music.
- [ ] [VERIFY] https://github.com/TXC2HYDRA/lineledger-mcp is public, and the `main` branch holds the code you are submitting (last verified from a clean clone at `5d9834c`).
- [ ] [VERIFY] GitHub shows an MIT license for both repositories (check the license badge in the repository sidebar).
- [ ] [VERIFY] Form values: GitHub username `TXC2HYDRA`; contribution URL `https://github.com/TXC2HYDRA/container-load-planner`; project repository URL `https://github.com/TXC2HYDRA/lineledger-mcp`.
- [ ] [VERIFY] A fresh clone follows the Setup steps and `npm test` passes, with the counts quoted in this text (50 tests, 7 end-to-end tests, 15 agent tests).
- [ ] [VERIFY] The Alexa+ track and the Open Source mini challenge are selected on Devpost. Select the AWS Builder challenge only after you have read its official rules and they accept an entry that uses the Strands SDK with a local model and no AWS service call. Otherwise delete its paragraph above.
- [ ] [AUTHOR TO CONFIRM] The "would we build this again" answer is in your own words.
- [ ] Submit before 2026-10-23 12:00 PM PT.
