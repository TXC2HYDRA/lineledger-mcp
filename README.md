# LineLedger — Factory-Floor Co-pilot

A voice-first assistant for a plant manager or line operator, backed by a self-hosted
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server over Streamable HTTP.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track).

> **Status: Phase 1 (install and preflight) done.** There is no application yet. This README only lists
> commands that have been run. Setup and run instructions will be added as each phase is verified.

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

## Verified so far

```bash
node -v      # v22.23.3
node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(':memory:'); d.exec('create table t(a)'); d.prepare('insert into t values (?)').run(1); console.log(d.prepare('select a from t').all().length); d.close()"
# prints 1 (Node 22 prints an ExperimentalWarning for node:sqlite)
```

```bash
npm install            # 145 packages, 0 vulnerabilities (npm audit)
npm run typecheck      # clean
npm run preflight:mcp  # PASS: raw initialize and SDK client both negotiate protocolVersion 2025-11-25;
                       # tools/list, tools/call ping work; GET and DELETE /mcp return 405
```

## License

MIT. See [LICENSE](LICENSE).
