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
