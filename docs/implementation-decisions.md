# Implementation decisions (Phase 0)

Date: 2026-10-21 (IST). Evidence was gathered by read-only research (official docs, GitHub source,
npm and PyPI metadata). Nothing was installed, no model was downloaded, and no AWS or other cloud
service was contacted. Items marked **VERIFY** were not established from an official source.
Each research result was re-checked by an independent verifier; corrections are folded in below.

## Constraints

- Zero money spent. No AWS API calls, cloud deployments, paid model APIs or remote inference.
- Local-first. Synthetic demo data only. No credentials in the repository.
- Public repository only after explicit approval.

## D1. MCP SDK: pin `@modelcontextprotocol/sdk@1.32.1` (v1.x)

Facts (npm and official README, 2026-10-21):

- `@modelcontextprotocol/sdk` latest is `1.32.1` (published 2026-10-05), the only dist-tag. License MIT.
  Node `>=18`. Peer dependencies: `zod ^3.25 || ^4.0`, `@cfworker/json-schema ^4.1.1`.
- Protocol: `LATEST_PROTOCOL_VERSION = '2025-11-25'` at tag `1.32.1`
  (`SUPPORTED_PROTOCOL_VERSIONS` also lists 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07).
  The first 1.x release with 2025-11-25 as latest is `1.24.1`. This meets the hackathon minimum.
- The v1 README calls v1.x "the maintenance line" and says it receives bug fixes and security updates
  for at least six months after the v2 release (2026-07-27), so not before about 2027-01-27.
- `1.32.1` is clear of all seven TypeScript SDK advisories published 2026-09-30 to 2026-10-15
  (six affect the 1.x package and are fixed by 1.30.1, 1.31.0 and 1.32.0). Do not pin lower.

Alternative considered, not chosen: the **v2 split packages** (`@modelcontextprotocol/server`,
`client`, `node`, `express`, all `2.x`, Apache-2.0, zod 4 only). v2 is the current stable line
(2.0.0 on 2026-07-27, five stable releases since) and implements spec 2026-07-28 while its
`createMcpHandler` also serves 2025-11-25 clients statelessly. Not chosen because: the fixed stack
names `@modelcontextprotocol/sdk`; v2 is about ten weeks old with a new API surface; the 2-day
schedule favors the well-documented v1 API. Never mix v1 and v2 packages. Revisit only if v1 blocks.
If v2 is adopted later, the Inspector 2.11.0 and `@modelcontextprotocol/ext-apps` 2.0.3 line up with it.

Import paths (v1.32.1, `.js` suffix required):

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
```

Tool registration: `server.registerTool(name, { title, description, inputSchema, outputSchema? }, handler)`
with a raw zod shape; invalid arguments return an `isError: true` result.

Security: `createMcpExpressApp()` in 1.32.1 validates the **Host** header only. The spec says servers MUST
validate **Origin**. Phase 1 adds an Origin check (allow only the local web client origin). Bind to
`127.0.0.1` only.

## D2. Stateless Streamable HTTP

One `McpServer` plus one `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST
request; GET and DELETE on `/mcp` return 405. Persistent state lives in SQLite, not in MCP sessions.
Reasons: simplest for a single-process demo, and the stateful path has an open client gotcha
(no re-initialize after a 404, issue #1708). `scripts/mcp-preflight.ts` is written to this pattern.

## D3. Browser client

Serve the web client and proxy `/mcp` through the same origin (Vite proxy) to avoid CORS.
The v1 client is fetch-based, but no official page states v1 client browser support (source-level
evidence only). **VERIFY** in Phase 2. Fallback: a small hand-written Streamable HTTP client
(initialize, tools/list, tools/call over `fetch`) following the spec.
If CORS is ever needed with sessions on: expose `Mcp-Session-Id`. **VERIFY** with a real cross-origin test.

## D4. Agent framework: Strands Agents (Python) with a local Ollama model

- `strands-agents` `1.61.1` with the `[ollama]` extra (extra requires `ollama>=0.4.8,<1.0.0`; the research
  found `ollama 0.6.3`). Apache-2.0. Python `>=3.10`; system Python is 3.12.3.
- `strands-agents 1.61.1` requires `mcp<2.2,>=1.23.0`. Plain pip would resolve `mcp 2.1.1`, which lies inside
  the range of five python-sdk advisories (one is an unbounded-session resource issue for servers using
  Streamable HTTP; the others concern server auth and resource issues). Our agent only uses the MCP client,
  but we pin `mcp==1.30.0` (patched, satisfies the cap) which also keeps `streamablehttp_client`
  (removed in mcp 2.x). Use `MCPClient(url='http://127.0.0.1:PORT/mcp')` or the transport callable. **VERIFY**
  against the installed package.
- **Default-model trap.** `Agent()` and `Agent(model=None)` build a Bedrock model, and a string `model`
  is treated as a Bedrock model ID. Building the client runs the AWS credential lookup (environment,
  `~/.aws`, instance metadata) at construction; the first Bedrock request follows at inference.
  This machine has `~/.aws/credentials`, so the risk is real. Mandatory guards for the agent service:
  1. Always construct `Agent(model=OllamaModel(host='http://127.0.0.1:11434', model_id=...))`.
  2. Start the service with a scrubbed environment: no `AWS_*` variables,
     `AWS_EC2_METADATA_DISABLED=true`, `AWS_CONFIG_FILE=/dev/null`, `AWS_SHARED_CREDENTIALS_FILE=/dev/null`.
  3. A startup assertion that `isinstance(agent.model, OllamaModel)`, plus a unit test for it.
- Telemetry is opt-in (nothing is exported unless `StrandsTelemetry().setup_*_exporter()` is called).
  Based on reading specific source files, not a full audit. **VERIFY** with a `grep` of the installed package
  for network use, and by running the spike with egress limited to loopback if feasible.
- TypeScript Strands (`@strands-agents/sdk` 1.21.0, Node `>=22`) documents an MCP Streamable HTTP client and an
  OpenAI `baseURL` override but has **no Ollama provider** and an open P1 bug (#3190) when Ollama is used
  through the Vercel provider. Not chosen.
- AWS Builder entry is **conditional**: kept only if the Phase 0b spike passes. If it fails, use the
  deterministic rule-based planner (labelled "no LLM") and drop the AWS Builder mini challenge. No Bedrock,
  no AWS SDK, no cloud usage claims.
- Kiro and Kiro Crew: skipped (free terms not verified from official documentation).

## D5. Ollama (local model runtime)

- Latest release `v0.40.7` (2026-10-18), MIT. The install script (`https://ollama.com/install.sh`) needs sudo,
  creates a system user and a systemd unit. The docs manual route also needs sudo. **Do not use either.**
- No-sudo route: the same official tarball `ollama-linux-amd64.tar.zst` (1,505,607,169 bytes, sha256
  `7f082e625b4c334df84ed1558fe282d6d8091fe3545790aef30b3a9c50d44d41` from the GitHub API digest) extracted into
  `$HOME/.local`. Running from `$HOME/.local` without root is supported by code reading only. **VERIFY**.
- This machine has an Intel Arc iGPU with Vulkan drivers. Start the server with `OLLAMA_VULKAN=0` for a
  predictable CPU path (per docs.ollama.com/gpu; **VERIFY** the variable on v0.40.7).
- **Cloud features are on by default** in v0.40.7. Start the server with `OLLAMA_NO_CLOUD=1`, never run
  `ollama signin`, never pull a `:cloud` tag. Bind to `127.0.0.1:11434`.
- Ollama's default context is 4k tokens on machines under 24 GiB of VRAM. Raise it with `OLLAMA_CONTEXT_LENGTH`
  (documented). Whether `options={'num_ctx': N}` passes through Strands is **VERIFY**.

## D6. Model choice (for approval)

- First choice: `qwen3:4b` (about 2.5 GB, Apache-2.0). Fits the ~9 GiB of free RAM with margin and
  runs faster on CPU. Qwen3 emits "thinking" tokens by default, which costs CPU time. **VERIFY** how to
  turn thinking off in the spike.
- Fallback: `llama3.1:8b` (about 4.9 GB, Llama 3.1 Community License, not OSI). The Strands Ollama docs name
  only `llama3.1` and `mistral` for tool use.
- Tool-calling reliability of either model through Strands is unknown until the Phase 0b spike.
- Hardware: CPU only (Core Ultra 7 155H, 22 logical CPUs, 30 GB RAM, about 9 GiB available at check time
  because other applications use about 22 GB). Expect roughly 10 to 30 seconds per tool turn (estimate).

## D7. TypeScript toolchain

- `typescript` `latest` is `7.0.2` (native port); the SDK README documents TypeScript `>=6.0`.
  Pin `typescript@6.0.3` (latest 6.x) to stay on the documented range. Revisit later.
- `zod` `4.6.7`, `express` `5.3.0`, `tsx` `4.23.15`, `vite` `8.3.5` (Node `^20.19 || >=22.12`),
  `vitest` `5.0.5` (Node `^22.12 || ^24 || >=26`), `@types/node` `22.20.5` (matches Node 22),
  `@types/express` `5.0.6`. `express 5.3.0` and `zod 4.6.7` were published within the last two weeks and are
  not yet exercised with the pinned MCP SDK. **VERIFY** in the first run of `npm run preflight:mcp`.

## D8. `node:sqlite`

Works on the installed Node v22.23.3 without any download. Tested with an in-memory database
(create table, insert, select, close). Node prints
`ExperimentalWarning: SQLite is an experimental feature and might change at any time`. Recorded, not hidden.

## D9. Design system

Bento Grid (primary), Swiss Design (secondary), solid-surface dark palette. Text contrast ratios were
recomputed locally and match the plan. Correction: `#334155` borders are only 1.81:1 on the background,
below the 3:1 needed for control boundaries. `--color-border-strong: #64748B` (3.16 to 3.93:1) is used for
controls. See `docs/ui-spec.md`.

## D10. Repository and publication

- Local git repository only until approved. The research PDF in `docs/` is excluded from git
  (`docs/*.pdf`) because it contains private planning notes.
- Owner is the personal GitHub account **TXC2HYDRA**. Git identity inside `~/Nachiket/Personal/` comes from
  `~/.gitconfig-personal` (personal name and email, personal SSH key). The `gh` CLI is logged into a different,
  employer-linked account, so `gh repo create` is not used. The repository is created under TXC2HYDRA and
  pushed over SSH with the personal key.
- `LICENSE` is MIT with holder "LineLedger contributors". Replace with a legal name if wanted.

## Open VERIFY list

1. First real run of `npm run preflight:mcp` after approved installs (v1 API shapes, `zod/v4` import path,
   Express 5.3.0 and zod 4.6.7 compatibility).
2. v1 MCP client in a browser build; CORS only if the same-origin proxy is dropped.
3. Strands 1.61.1 with `mcp==1.30.0` and `MCPClient` over Streamable HTTP, end to end with a real Ollama.
4. Ollama from `$HOME/.local` without sudo; `OLLAMA_VULKAN=0` and `OLLAMA_NO_CLOUD=1` take effect (log line
   `Ollama cloud disabled: true`).
5. Model tool-calling reliability and latency; disabling Qwen3 thinking; context length control.
6. Whether Strands makes any network call other than the configured loopback hosts.
7. Exact on-disk sizes (Ollama unpacked, model blobs, venv, node_modules): all estimates until measured.
8. Inspector 2.11.0 license file and first-run behavior (writes under `$HOME/.mcp-inspector`).
