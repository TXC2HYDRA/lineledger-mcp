# LineLedger — Factory-Floor Co-pilot

A voice-first assistant for a plant manager or line operator, backed by a self-hosted
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server over Streamable HTTP.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track).

> **Status: work in progress.** Server and web client run. Agent mode and docs are pending.
> This README only lists commands that have been run.

## Demo data disclosure

All production, handover and purchasing records in this project are **synthetic demo data**.
Nothing is connected to a real factory, real inventory or real customers. The project does not
monitor live equipment and does not integrate with a physical Alexa+ device.

## Zero-cost, local-first

The project is built and demoed without any paid service. It makes no calls to cloud APIs and
needs no cloud credentials. The language model, when used, runs locally.

## Planned architecture

- `server/`: TypeScript MCP server (`@modelcontextprotocol/sdk` 1.32.1, Express, zod, `node:sqlite`).
- `packages/container-load/`: standalone, MIT-licensed container-load calculation library.
- `web/`: Vite + vanilla TypeScript client with a live MCP trace panel and shift dashboard.
- `agent/`: small Python service (Strands Agents SDK with a local Ollama model), with a deterministic
  rule-based planner as fallback.
- `docs/`: UI specification, implementation decisions, product feedback and friction log.

See `docs/implementation-decisions.md` for the verified versions and the reasoning, and
`docs/ui-spec.md` for the design system.

## Run it

Requirements: Node 22.12 or newer. No cloud account, no API key.

```bash
npm install
npm run dev:server        # MCP server on http://127.0.0.1:8787/mcp (SQLite in data/, git-ignored)
npm run dev:web           # web client on http://127.0.0.1:5173 (proxies /mcp and /api to the server)
```

If port 5173 is busy, run both with `WEB_PORT=5273` (the server's Origin allowlist follows it).
`PORT` changes the server port. Open the web URL, then type or use the example buttons.
The microphone starts only after you click Listen (browser Web Speech API; text always works).

## Verified commands

```bash
npm run typecheck      # clean (server, tests, scripts, web)
npm test               # vitest: MCP client over real HTTP, hardening, planner (see test output below)
npm run check:contrast # recomputes WCAG contrast from web/src/style.css: 25 pairs pass
npm run build          # vite build -> dist/web
npm run preflight:mcp  # raw initialize and SDK client both report protocolVersion 2025-11-25
```

MCP tools (`server/tools.ts`): `get_shift_summary`, `create_handover_note`, `list_handover_notes`,
`create_follow_up`, `list_follow_ups`, `close_follow_up`, `check_stock`, `plan_container_load`.
`plan_container_load` calls the standalone [container-load-planner](https://github.com/TXC2HYDRA/container-load-planner)
package (MIT, pinned to commit `3c4fe91`, installed over HTTPS and built by its `prepare` script).

## License

MIT. See [LICENSE](LICENSE).
