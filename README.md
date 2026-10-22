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

No paid service, no cloud API calls, no credentials in this repository. The optional language-model
agent runs against a local Ollama server on loopback only.

## What it does

A plant manager can ask, by typing or speaking:

- "shift summary": output versus target per line, with on-track, at-risk and behind status.
- "add handover note for line 2: sealer jaw ran hot": saved in SQLite, kept across restarts.
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

### Verify

```bash
npm run typecheck        # server, tests, scripts and web
npm test                 # vitest: MCP client over real HTTP against the LineLedger server, hardening, rule-based planner
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
| `server/app.ts` | Creates an `McpServer` and a `StreamableHTTPServerTransport` per POST to `/mcp`, calls `server.connect(transport)` and `transport.handleRequest(...)`. Uses the SDK's `hostHeaderValidation`. |
| `server/tools.ts` | Nine `server.registerTool(...)` calls with zod input and output schemas, `structuredContent`, `isError` results and tool annotations. |
| `web/src/mcp.ts` | The browser uses the SDK `Client` with `StreamableHTTPClientTransport` to call the tools. |
| `scripts/mcp-preflight.ts` | Starts a minimal one-tool (`ping`) server on an ephemeral port, separate from the LineLedger server, and runs `initialize`, `tools/list` and `tools/call` through the SDK client. It checks the SDK and protocol version, not the nine LineLedger tools. |
| `tests/server.test.ts` | A real SDK client talks to the server over HTTP. |

Transport behaviour: stateless Streamable HTTP, `GET` and `DELETE` on `/mcp` return 405 with
`Allow: POST`, the server binds to `127.0.0.1` only, requests are checked for Host and Origin, and
request bodies are limited to 64 KB. A server-side trace tap records every JSON-RPC message in and
out and streams it to the UI, so the trace panel shows only real traffic.

Tools: `get_shift_summary`, `get_shift_history` (feeds the dashboard trend chart), `create_handover_note`, `list_handover_notes`, `create_follow_up`,
`list_follow_ups`, `close_follow_up`, `check_stock`, `plan_container_load`.

## Architecture

```
browser (web/)  --same-origin proxy-->  MCP server (server/)  -->  SQLite (node:sqlite)
   chat, trace, dashboard                Express + MCP SDK          container-load-planner
        |                                    ^
        +--- optional: /agent proxy ---> agent/ (Strands + local Ollama) --MCP client--+
```

- `server/`: TypeScript MCP server (Express 5, zod 4, `node:sqlite`).
- `web/`: Vite + vanilla TypeScript client. The default planner is a deterministic rule-based mapper
  (`web/src/planner.ts`, no LLM) from request text to tool calls.
- `agent/`: optional Python service using Strands Agents with an explicit local Ollama model, the
  MCP server's tools, an AWS-environment scrub and a loopback-only check.
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
npm run test:agent       # 3 tests: AWS env scrub, explicit OllamaModel, loopback-only, MCP tool discovery
```

Running the agent needs a local Ollama server (not installed by this repository). See
`docs/download-approval-manifest.md` for the no-sudo steps. Then:

```bash
npm run dev:agent        # http://127.0.0.1:8788, model qwen3:4b-instruct
```

and press "Planner: local model" in the web client.

## Limits

- Microphone input and speech output: not tested outside a headless browser run.
- Speech recognition accuracy in a loud factory is not claimed.
- Production `vite preview` and a full real-keyboard pass are not tested.

## License

MIT. See [LICENSE](LICENSE).
