# Devpost text: LineLedger

Draft for the author to review and paste into Devpost. Items marked [VERIFY], [AUTHOR TO CONFIRM] or [ONLY IF SPIKE PASSES] need a decision or a check before submitting. Delete this line before pasting.

## Project name

LineLedger

## Tagline

Factory-Floor Co-pilot: ask for the shift summary, leave a handover note or check stock by typing or speaking, backed by a self-hosted MCP server.

## Project description

LineLedger is a voice-first assistant prototype for a plant manager or line operator. At a shift change the useful questions are short ones: how did each line do against target, what did the last shift leave behind, which follow-ups are still open, is a material running low, and how many boxes fit in a container. LineLedger answers these in a web app, by text or by voice.

Each request is mapped to one of eight tools on a self-hosted Model Context Protocol (MCP) server. The server stores handover notes and follow-ups in SQLite, so they survive a restart. The web app shows the real JSON-RPC messages between the client and the server in a live trace panel, next to a shift dashboard.

The server, database and web app run on one machine and use no paid service or cloud account. (The optional browser speech recognition may send audio to the browser vendor; see the data disclosure below.) All production, handover and stock data is synthetic. The voice experience is simulated in a browser; it is not an Alexa+ device skill.

## Key features

- An MCP server written in TypeScript (`@modelcontextprotocol/sdk` 1.32.1) using stateless Streamable HTTP. It negotiates protocol version 2025-11-25; the preflight script and the tests check this.
- Eight tools: `get_shift_summary`, `create_handover_note`, `list_handover_notes`, `create_follow_up`, `list_follow_ups`, `close_follow_up`, `check_stock`, `plan_container_load`.
- Every tool has a zod input schema and output schema and returns `structuredContent`. Invalid input comes back as an `isError` result.
- Handover notes and follow-ups persist in SQLite (`node:sqlite`).
- `plan_container_load` calls a separate open-source package, container-load-planner (MIT), which counts how many identical boxes fit in a container on a uniform grid, limited by geometry and payload weight. It is a calculator, not a packing optimiser, and the 20ft and 40ft container sizes in the planner are fixed example values, not carrier specifications.
- Server hardening: Origin allowlist (requests with no Origin header, such as non-browser clients, are allowed) and Host check, 64 KB request body limit, 405 on GET and DELETE for `/mcp`, bound to 127.0.0.1.
- A live MCP trace panel fed by a server-side trace tap, so it shows only messages that actually reached the server (the tap keeps the latest 500).
- A dark Bento Grid web interface with chat, a shift dashboard, handover and follow-up panels, and a voice-state strip (idle, listening, thinking, speaking, error). State is shown with text and an icon, not colour alone. `npm run check:contrast` checks 25 colour pairs against WCAG contrast thresholds.
- Voice input starts only after the user clicks Listen. Typing always works. Spoken replies can be stopped.
- A "SYNTHETIC DEMO DATA" badge is always visible.
- A deterministic rule-based planner (no language model) is the default way requests are turned into tool calls.

## How it works

1. The web client (Vite and vanilla TypeScript) takes a typed or spoken request.
2. The planner turns the request into a single tool call. The default planner is rule-based: regular expressions and keyword rules in `web/src/planner.ts`, with no language model.
3. The client sends the call through a same-origin proxy (the Vite dev server proxies `/mcp`, `/api` and `/agent`), so no CORS setup is needed.
4. The MCP server receives it over Streamable HTTP. The server is stateless: each POST creates a new server and transport, and state lives in SQLite, not in MCP sessions.
5. The tool reads or writes SQLite. For `plan_container_load` it calls the container-load-planner package (pinned to commit `3c4fe91`).
6. A trace tap on the server records each JSON-RPC message in and out. The UI reads it from `/api/trace` and `/api/trace/stream` and shows it in the trace panel.
7. The result is shown in the chat and the dashboard, and can be read aloud with browser speech synthesis.

Optional local-model agent: the repository also contains a small Python service (`agent/`) built on the Strands Agents SDK with a local Ollama model (`qwen3:4b-instruct`). The web app has a switch for choosing it instead of the rule-based planner. The service has guards so it cannot fall back to a cloud model: an explicit Ollama model, a scrubbed AWS environment, a loopback-only host, and a startup assertion with tests. In a 10-prompt spike on a CPU-only laptop, the model chose a suitable tool for each prompt that needed one and answered in about 3 to 17 s per turn after the first call, but 3 of 10 prompts had wrong or invented arguments or a misleading reply. Treat this part as an experiment; the rule-based planner is the tested path.

## Tracks and mini challenges

**Primary track: Alexa+.** LineLedger is a voice-first assistant experience built as a web app with a simulated voice interface. It was not built with the Alexa+ developer console and does not run on a physical Alexa+ device.

**Mini challenge: Open Source.** The container-load calculation lives in a separate, standalone MIT-licensed package, and LineLedger uses it as a pinned dependency. [VERIFY] Check the challenge rules on whether this package qualifies as a contribution (for example, when it was created and published).

- GitHub username: TXC2HYDRA
- Contribution URL: https://github.com/TXC2HYDRA/container-load-planner
- Project repository URL: https://github.com/TXC2HYDRA/lineledger-mcp

**[AUTHOR TO CONFIRM that the challenge rules accept a local-only entry; otherwise delete]** AWS Builder mini challenge. The agent service in `agent/` uses the Strands Agents SDK with a local Ollama model (`qwen3:4b-instruct`) and calls the LineLedger MCP server over Streamable HTTP. In the model spike on 2026-10-22, 7 of 10 prompts were handled correctly, 1 had correct tool results but a misleading spoken sentence, and 2 failed (an invented shift date, and one missing tool call). Mean latency was 12.9 s per turn on a CPU-only laptop. No AWS service is used or called anywhere in the project, and the agent is configured so it cannot reach one (scrubbed AWS environment, explicit Ollama model, loopback-only hosts, startup assertion). Graded results are in `docs/spike-results.md`.

## Data disclosure and limits

- All data is synthetic: production counts, line names, handover notes, stock levels and suppliers. Nothing is connected to a real factory, real inventory or real customers.
- This is a simulated voice experience in a web app. There is no integration with a physical Alexa+ device or the Alexa+ developer console.
- The project does not monitor live equipment.
- Speech recognition uses the browser's Web Speech API. In Chrome this sends audio to the browser vendor's speech service, which this project does not run. Typing works without it.
- Speech has not been tested in a real browser with a microphone, and no claim is made that it works reliably in factory noise.
- Not tested: production `vite preview`, a full real-keyboard pass, and local-model tool-calling and latency.
- No AWS service or other paid cloud API is used or called. The project needs no cloud credentials.
- `node:sqlite` is an experimental Node feature and prints an ExperimentalWarning at startup.

What was tested: `npm test` (18 tests, including a real MCP client over HTTP, hardening checks and the planner), `npm run test:agent` (3 tests, the agent guards), `npm run typecheck`, `npm run build`, and `npm audit` (0 vulnerabilities).

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
- [ ] [VERIFY] https://github.com/TXC2HYDRA/lineledger-mcp is public, and the submission branch (`hydra-build/app`, or main after merging) holds the code you are submitting.
- [ ] [VERIFY] GitHub shows an MIT license for both repositories (check the license badge in the repository sidebar).
- [ ] [VERIFY] Form values: GitHub username `TXC2HYDRA`; contribution URL `https://github.com/TXC2HYDRA/container-load-planner`; project repository URL `https://github.com/TXC2HYDRA/lineledger-mcp`.
- [ ] [VERIFY] A fresh clone follows the Setup steps and `npm test` passes, with the counts quoted in this text (19 tests, 3 agent tests).
- [ ] [VERIFY] The Alexa+ track and the Open Source mini challenge are selected on Devpost; the AWS Builder challenge is selected only if the spike passed and its paragraph is filled with measured results.
- [ ] [AUTHOR TO CONFIRM] The "would we build this again" answer is in your own words.
- [ ] Submit before 2026-10-23 12:00 PM PT.
