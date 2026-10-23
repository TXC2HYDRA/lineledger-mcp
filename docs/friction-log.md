# Friction log

Real observations from building LineLedger. Each entry has the fields the hackathon asks for: task, steps, expected vs actual, severity, workaround, suggestion. Severity is our own rating (Low, Medium, High, or None when nothing went wrong).

## 1. Origin validation is not part of `createMcpExpressApp()` (SDK 1.32.1)

- Task: stand up a local Streamable HTTP MCP server that a browser client can call.
- Steps: read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js`.
- Expected: the helper protects against DNS rebinding as the transport spec describes (servers MUST validate `Origin`).
- Actual: it installs `hostHeaderValidation` / `localhostHostValidation` only. No `Origin` check.
- Severity: Medium. A safe default is missing and it is easy to miss.
- Workaround: add our own Origin allowlist middleware in `server/` and bind to 127.0.0.1. Tests cover a bad Origin (403) and a bad Host (403).
- Suggestion: add an `allowedOrigins` option to `createMcpExpressApp()` next to `allowedHosts`.

## 2. Protocol version proof needs two checks

- Task: prove the server negotiates spec 2025-11-25.
- Steps: connected with the SDK client and looked for the negotiated version.
- Expected: `Client.connect()` returns it, or a getter exists.
- Actual: it is only exposed as `transport.protocolVersion`.
- Severity: Low.
- Workaround: `scripts/mcp-preflight.ts` checks the raw `initialize` response on the wire and `transport.protocolVersion` from the SDK client. Both print 2025-11-25.
- Suggestion: surface the negotiated version in the `Client.connect()` return value or add `client.getNegotiatedProtocolVersion()`.

## 3. Pinned stack worked first try

- Task: install and verify the pinned stack.
- Steps: `npm install` (145 packages), `tsc --noEmit`, the preflight, with SDK 1.32.1, Express 5.3.0, zod 4.6.7 and the `zod/v4` import path.
- Result: 0 vulnerabilities per `npm audit`, typecheck clean, preflight PASS.
- Severity: None. Recorded so the log is not only complaints.

## 4. v1 client in a browser build

- Task: call the MCP server from the Vite web client.
- Steps: imported `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` 1.32.1 in `web/src/mcp.ts`, built with Vite (`npm run build`), drove the dev page with headless Chrome over the DevTools protocol.
- Expected: it works in a browser without a hand-written client.
- Actual: it works. `initialize` negotiated 2025-11-25, and `tools/list` and `tools/call` worked through the same-origin Vite proxy with no CORS setup. The client bundle pulls in zod and the JSON-schema validator, so the web bundle is about 318 kB.
- Severity: Low (bundle size only).
- Workaround: none needed. Not tested: a production `vite preview` run.
- Suggestion: a lighter browser entry point for the client that does not require the full validator.

## 5. A stateless server needs its own trace tap

- Task: show real JSON-RPC traffic in the UI.
- Steps: looked for a message-in / message-out hook on the HTTP transport.
- Expected: a documented observer.
- Actual: the SDK exposes none.
- Severity: Medium. It forced a wrapper around `transport.send`.
- Workaround: wrap `transport.send` per request and record `req.body` before `handleRequest` (`server/` trace tap, 500 entries in memory).
- Suggestion: a documented `onMessage` / `onSend` observer on `StreamableHTTPServerTransport` for logging and tracing.

## 6. Port 5173 was already taken on this machine

- Task: run the dev web client.
- Steps: `npm run dev:web`.
- Expected: it starts on the Vite default port 5173.
- Actual: another project's dev server held the port.
- Severity: Low.
- Workaround: `WEB_PORT` and `PORT` env vars select the ports, and the server's Origin allowlist follows `WEB_PORT`.
- Suggestion: none for the tools. Documented in the README.

## 7. Strands starts the MCP connection when the Agent is constructed

- Task: unit-test the "model must be Ollama" guard without a model server.
- Steps: `Agent(model=..., tools=[MCPClient(url=...)])` with no MCP server running.
- Expected: construction succeeds offline.
- Actual: it raised `Failed to load tool ... Failed to start MCP client`.
- Severity: Medium.
- Workaround: the guard test starts the real MCP server (in-memory SQLite) first. The test asserts that the Strands MCP client discovers three of the tools (`get_shift_summary`, `check_stock`, `plan_container_load`) over Streamable HTTP.
- Suggestion: lazy MCP start until the first call, or a documented offline mode for construction.

## 8. Deprecated import in the older Strands/MCP docs path

- Task: connect Strands to the MCP server over Streamable HTTP.
- Steps: used `mcp.client.streamable_http.streamablehttp_client`.
- Expected: no warning.
- Actual: mcp 1.30.0 warns "Use `streamable_http_client` instead".
- Severity: Low.
- Workaround: passing `MCPClient(url=...)` to Strands avoids the deprecated call.
- Suggestion: point the docs at the new name.

## 9. A thinking model ignores `think: False` through Strands and Ollama

- Task: run the optional agent with the default local model `qwen3:4b`.
- Steps: `OllamaModel(..., max_tokens=512, additional_args={"think": False})`, ten prompts through `POST /chat` (see `docs/spike-results.md`, run 1).
- Expected: no reasoning, a quick tool call.
- Actual: 9 of 10 requests returned HTTP 502 with `MaxTokensReachedException`. The model's template always opens a `<think>` block, so the reasoning used the 512-token cap before any tool call. A larger cap (3000) worked but took 53 to 370 s per turn on CPU.
- Severity: High for the default model. The agent could not answer within a usable time.
- Workaround: switch to the non-thinking `qwen3:4b-instruct` (3 to 17 s per turn after the first call).
- Suggestion: a warning or error from the Strands Ollama provider when `think: False` is requested for a model whose template ignores it, and the model-selection docs should say which models honour it.

## 10. A small local model fills nested tool schemas badly

- Task: have `qwen3:4b-instruct` call `plan_container_load`, which took nested `container` and `item` objects.
- Steps: spike runs 3 to 5 (`docs/spike-results.md`).
- Expected: arguments that match the schema.
- Actual: the model sent `depth` / `weight` instead of `length` / `weightKg` and left out the payload, so there was no answer. It also invented a `shift_date` for `get_shift_summary` despite an explicit rule in the system prompt.
- Severity: Medium. A prompt change that fixed one prompt broke another, so 7 of 10 prompts stayed correct across runs.
- Workaround: the tool now also accepts a flat form (`container_type` 20ft/40ft plus `box_length_mm`, `box_width_mm`, `box_height_mm`, `box_weight_kg`). This fixed the container prompt. The shift date problem remains.
- Suggestion: tool authors should prefer flat, enum-based arguments for small models. A way to give examples inside a tool schema would help.

## 11. The SDK client does not start a new session after a 404

- Task: add an optional stateful mode (sessions) to the server and keep the browser working across a server restart.
- Steps: initialize a session with `Client` and `StreamableHTTPClientTransport` (SDK 1.32.1), drop the session on the server (DELETE), then call a tool twice.
- Expected: the client sees 404 for its session id and starts a new session, as the 2025-11-25 transport spec describes under Session Management.
- Actual: both calls failed with `StreamableHTTPError` code 404 ("Session not found"). The client kept sending the dead session id.
- Severity: Medium. In stateful mode a server restart leaves every open page broken until it reloads.
- Workaround: `web/src/mcp.ts` catches the 404 (and a failed fetch on a dead socket), reconnects with a new `Client`, retries once, and shares one reconnect between concurrent calls. Covered by `tests/stateful.test.ts`.
- Suggestion: have the transport or client re-initialize on 404 when a session id was in use, or expose an option for it.
