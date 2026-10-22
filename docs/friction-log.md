# Friction log

Real observations from building LineLedger. Each entry: task, steps, expected vs actual, workaround, suggestion.

## 1. Origin validation is not part of `createMcpExpressApp()` (SDK 1.32.1)

- Task: stand up a local Streamable HTTP MCP server that a browser client can call.
- Steps: read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js`; it installs `hostHeaderValidation` / `localhostHostValidation` only. No `Origin` check.
- Expected: the helper protects against DNS rebinding as the transport spec describes (servers MUST validate `Origin`).
- Workaround: add our own Origin allowlist middleware in `server/` (Phase 2) and bind to 127.0.0.1.
- Suggestion: add an `allowedOrigins` option to `createMcpExpressApp()` next to `allowedHosts`.

## 2. Protocol version proof needs two checks

- Task: prove the server negotiates spec 2025-11-25.
- Steps: the SDK client hides the negotiated version in the result of `connect()`; it is exposed as `transport.protocolVersion`.
- Workaround: `scripts/mcp-preflight.ts` checks the raw `initialize` response on the wire and `transport.protocolVersion` from the SDK client. Both print 2025-11-25.
- Suggestion: surface the negotiated version in the `Client.connect()` return value or `client.getNegotiatedProtocolVersion()`.

## 3. Pinned stack worked first try

- `npm install` (145 packages, 0 vulnerabilities per `npm audit`), `tsc --noEmit` clean, preflight PASS with SDK 1.32.1, Express 5.3.0, zod 4.6.7 and the `zod/v4` import path. Nothing to report as friction; recorded so the log is not only complaints.

## 4. v1 client in a browser build (answers VERIFY item D3)

- Task: call the MCP server from the Vite web client.
- Steps: imported `Client` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` 1.32.1 in `web/src/mcp.ts`, built with Vite 8.3.5 (`npm run build`: 254 modules, 312 kB JS), drove the dev page with headless Chrome over the DevTools protocol.
- Result: `initialize` negotiated 2025-11-25 and `tools/list` and `tools/call` worked through the same-origin Vite proxy, with no CORS setup. No hand-written fetch client was needed. Not tested: a production `vite preview` run.
- Friction: the client bundle pulls in zod and the JSON-schema validator, so the web bundle is about 312 kB.

## 5. A stateless server needs its own trace tap

- Task: show real JSON-RPC traffic in the UI.
- Steps: the SDK exposes no hook for "message in / message out" on the HTTP transport. I wrapped `transport.send` per request and recorded `req.body` before `handleRequest`.
- Suggestion: a documented `onMessage` / `onSend` observer on `StreamableHTTPServerTransport` for logging and tracing.

## 6. Port 5173 was already taken on this machine

- The Vite default port was held by another project's dev server. `WEB_PORT` and `PORT` env vars now select the ports and the server's Origin allowlist follows `WEB_PORT`.

## 7. Strands starts the MCP connection when the Agent is constructed

- Task: unit-test the "model must be Ollama" guard without a model server.
- Steps: `Agent(model=..., tools=[MCPClient(url=...)])` raised `Failed to load tool ... Failed to start MCP client` because the MCP server was not running.
- Workaround: the guard test starts the real MCP server (in-memory SQLite) first. The test asserts that the Strands MCP client discovers three of the tools (`get_shift_summary`, `check_stock`, `plan_container_load`) over Streamable HTTP.
- Suggestion: lazy MCP start until the first call, or a documented offline mode for construction.

## 8. Deprecated import in the older Strands/MCP docs path

- `mcp.client.streamable_http.streamablehttp_client` warns "Use `streamable_http_client` instead" in mcp 1.30.0. Passing `MCPClient(url=...)` to Strands avoids the deprecated call.
