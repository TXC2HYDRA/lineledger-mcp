# Product feedback: LineLedger

LineLedger is a simulated voice co-pilot for a plant manager, backed by a self-hosted MCP server. All data is synthetic. It is a web app with a simulated voice experience, not an integration with a physical Alexa+ device.

## Tools used

- **MCP TypeScript SDK 1.32.1**: server (stateless Streamable HTTP, nine tools with zod input and output schemas) and the browser client.
- **Strands Agents Python SDK (partly)**: an `agent/` service wired to a local Ollama model, with guards against accidental AWS or Bedrock use. Its guard tests pass (3 tests), including discovery of MCP tools over Streamable HTTP (the test asserts three tool names, not all nine). A 10-prompt spike against a local model got 7 prompts fully right, so I treat the agent as an experiment and do not claim it is reliable (see `docs/spike-results.md`).
- **Vite**, **node:sqlite**, **vitest**, **headless Chrome** (to drive the dev page), and the **Web Speech API** (mic starts only after a click; typing always works).

We did **not** use the Alexa+ developer console or a physical Alexa+ device. No AWS service is called; the only AWS-listed technology we use is the Strands Agents SDK, running locally.

## What worked

- The pinned stack worked on the first run. `npm install`, typecheck and the preflight passed, and 2025-11-25 was negotiated.
- The SDK's `registerTool` with zod schemas (called from our `registerTools`) gave typed `structuredContent`, and invalid input returned `isError` from the SDK for schema failures; our own code adds `isError` only for unknown references.
- The SDK's browser client ran in a Vite build and called the server through a same-origin proxy with no CORS setup.
- The Strands MCP client discovered tools over Streamable HTTP with `MCPClient(url=...)` (the test checks three named tools).

## What needs work

1. **Origin is not checked by `createMcpExpressApp()`.** It validates Host only, while the transport spec says servers must validate Origin. I added my own allowlist in `server/app.ts`. Suggestion: add an `allowedOrigins` option beside `allowedHosts`.
2. **The negotiated protocol version is hard to see.** It is only visible as `transport.protocolVersion`. Suggestion: return it from `connect()` or add `client.getNegotiatedProtocolVersion()`.
3. **No documented way to trace JSON-RPC on the HTTP transport.** I wrapped `transport.send` per request and recorded `req.body` for the live trace panel. Suggestion: a documented observer hook on `StreamableHTTPServerTransport`.
4. **Strands connects to MCP at `Agent` construction.** A unit test with no server running failed with "Failed to start MCP client". Suggestion: connect lazily, or document an offline construction mode.
5. **Bedrock is the default model.** `Agent()` with no model builds a Bedrock model, so a "local only" project can look for AWS credentials by accident. I added an explicit `OllamaModel`, a scrubbed AWS environment and a startup assertion. Suggestion: a loud warning or opt-in when the default is used.
6. **Deprecated import warning.** `streamablehttp_client` warns in mcp 1.30.0 ("Use `streamable_http_client` instead"). Passing `MCPClient(url=...)` avoided it; the docs should point there.
7. **Bundle size.** The browser client pulls in zod and the JSON-schema validator, about 312 kB of JS in our build.

## Onboarding experience

[AUTHOR TO CONFIRM] Setup with the pinned versions worked on the first run. I read the SDK source to find out what the Express helper validates and where the negotiated version appears. The eager MCP connect in Strands came up when I wrote a test; the default Bedrock model came up while reading the Strands behaviour (see `docs/implementation-decisions.md`). Not tested: microphone and speech in a real browser, a production `vite preview` run, a real-keyboard pass, and local model tool-calling and latency. Chrome's speech recognition sends audio to the browser vendor's service, which this project does not run.

## Would I build again and why

[AUTHOR TO CONFIRM] Suggested draft: Yes, for tools that wrap an existing operational data store behind a small, typed interface. MCP made the tool contract (names, schemas, annotations) explicit and testable with a real client, independent of the UI or planner. I would want the Origin, tracing and lazy-connect gaps above closed first.

Strands with a local Ollama model worked end to end against the MCP server. Measured on a CPU-only laptop: the default `qwen3:4b` is a thinking model whose template ignores `think: False`, so it exhausted a 512-token cap and failed; `qwen3:4b-instruct` answered in about 3 to 17 s but invented arguments on 3 of 10 prompts (a shift date, an author, nested container fields) and fixes to the prompt moved failures around instead of removing them. Flat tool arguments helped a small model more than prompt rules did. See `docs/spike-results.md`.

## Optional feature requests

Each is taken from the friction log (`docs/friction-log.md`).

1. **Origin allowlist in `createMcpExpressApp()`**
   - Task: serve a local MCP server to a browser client.
   - Expected: the helper protects against DNS rebinding, including Origin.
   - Actual: Host validation only (SDK 1.32.1).
   - Workaround: custom Origin middleware, bound to 127.0.0.1.
   - Suggestion: an `allowedOrigins` option.

2. **Transport message observer**
   - Task: show real JSON-RPC traffic in the UI.
   - Expected: a hook for messages in and out.
   - Actual: none on `StreamableHTTPServerTransport`.
   - Workaround: wrap `transport.send` and record `req.body`.
   - Suggestion: documented `onMessage` / `onSend` hooks.

3. **Negotiated version on the client**
   - Task: prove 2025-11-25 was negotiated.
   - Expected: it is returned by `connect()`.
   - Actual: only `transport.protocolVersion`.
   - Workaround: check the raw `initialize` response and the transport property (`scripts/mcp-preflight.ts`).
   - Suggestion: `client.getNegotiatedProtocolVersion()`.

4. **Lazy MCP start in Strands**
   - Task: unit-test the model guard without a model or MCP server.
   - Expected: construction succeeds offline.
   - Actual: `Agent(...)` raised "Failed to start MCP client".
   - Workaround: start the real MCP server (in-memory SQLite) in the test.
   - Suggestion: connect on first use, or an offline mode.
