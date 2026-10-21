# Download approval manifest

Date: 2026-10-21. **Nothing in this list has been downloaded or installed.** Sizes and checksums come from
official registries and release metadata (GitHub API, npm, PyPI, ollama.com). Anything not published is marked
**VERIFY** or **ESTIMATE**. No row needs a paid service. No row needs sudo.

Machine: Linux x86_64, CPU only, 30 GB RAM (about 9 GiB available at check time), 89 GB free disk.

## Approval record

- 2026-10-21: C (npm packages) approved and installed. Planner dependency `container-load-planner#3c4fe91` (HTTPS git, MIT) approved and installed. B (Python packages, `.venv/`, 49 packages, 112 MB) approved and installed after a `pip install --dry-run` matched this list.
- A1 and A2 (Ollama tarball and `qwen3:4b`): approved; the user runs the steps below. Not yet downloaded when this was written.
- Not approved: A3, D1, D2, any hosted API.

## Recommended approval set (about 4.1 GB download)

| Approve | Artifact | Why |
|---|---|---|
| [ ] | A1 Ollama tarball (1.51 GB) | local model runtime, no sudo |
| [ ] | A2 `qwen3:4b` (2.5 GB) | first model to try; fits RAM |
| [ ] | B1 to B4 Python packages (about 30 to 40 MB, plus resolved dependencies) | Strands agent service |
| [ ] | C npm packages (about 30 to 45 MB compressed estimate) | MCP server, tests, web build |

Optional, separate approval: A3 `llama3.1:8b` (4.9 GB), D1 MCP Inspector via `npx` (about 80 to 120 MB cache).
Do not download: the Ollama ROCm and MLX archives, `qwen3:8b`, anything tagged `:cloud`.

## A. Local model runtime (you run these; I do not install Ollama or models)

| # | Name and version | Purpose | Source | Size | License | Checksum | Phase |
|---|---|---|---|---|---|---|---|
| A1 | Ollama `v0.40.7` `ollama-linux-amd64.tar.zst` (published 2026-10-18) | run a local model server | https://github.com/ollama/ollama/releases/download/v0.40.7/ollama-linux-amd64.tar.zst | download 1,505,607,169 bytes (1.51 GB). Unpacked: not published, **ESTIMATE 3.5 to 5 GB, VERIFY** | MIT (bundled third-party libs **VERIFY**) | sha256 `7f082e625b4c334df84ed1558fe282d6d8091fe3545790aef30b3a9c50d44d41` (GitHub API digest; the release `sha256sum.txt` redirects to a pre-signed URL and was not fetched) | 0b |
| A2 | model `qwen3:4b` (ID `359d7dd4bcda`) | tool-calling candidate, small | https://ollama.com/library/qwen3 | 2.5 GB listed. RAM at 4k context **ESTIMATE 3.4 to 4.2 GB** | Apache-2.0 | 12-hex ID only; full sha256 **VERIFY** from the registry manifest after pull | 0b |
| A3 | model `llama3.1:8b` (ID `46e0c10c039e`), optional fallback | tool-calling fallback; named in Strands docs | https://ollama.com/library/llama3.1 | 4.9 GB listed. RAM **ESTIMATE 5.8 to 6.8 GB** | Llama 3.1 Community License (custom, not OSI) | 12-hex ID only; **VERIFY** | 0b, only if A2 fails |

Not recommended routes (both need sudo): `curl -fsSL https://ollama.com/install.sh | sh` (creates a system user,
writes `/etc/systemd/system/ollama.service`, runs `systemctl`) and the docs manual
`... | sudo tar x -C /usr`. If anything ever needs sudo, I give you the exact command and stop.

### Exact no-sudo steps for you to run (after you approve A1 and A2)

Run steps 1 to 6 in one shell session. Download only the rows you approved.

```bash
# 1. work dir
mkdir -p "$HOME/Downloads/ollama-0.40.7" && cd "$HOME/Downloads/ollama-0.40.7"

# 2. download A1 (1,505,607,169 bytes)
curl -fL --retry 3 -C - -o ollama-linux-amd64.tar.zst \
  https://github.com/ollama/ollama/releases/download/v0.40.7/ollama-linux-amd64.tar.zst

# 3. verify size and checksum; STOP and delete the file if either check fails
test "$(stat -c %s ollama-linux-amd64.tar.zst)" = 1505607169 && echo size-OK
echo '7f082e625b4c334df84ed1558fe282d6d8091fe3545790aef30b3a9c50d44d41  ollama-linux-amd64.tar.zst' | sha256sum -c -

# 4. extract into your home directory (zstd and GNU tar are installed)
mkdir -p "$HOME/.local" && zstd -dc ollama-linux-amd64.tar.zst | tar -xf - -C "$HOME/.local"
ls -l "$HOME/.local/bin/ollama" && ls "$HOME/.local/lib/ollama" && du -sh "$HOME/.local/lib/ollama"
export PATH="$HOME/.local/bin:$PATH" && ollama -v

# 5. start the server: loopback only, CPU only, cloud features OFF, one model in memory
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS="$HOME/.ollama/models" \
OLLAMA_NO_CLOUD=1 OLLAMA_VULKAN=0 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 \
OLLAMA_CONTEXT_LENGTH=8192 \
nohup ollama serve > "$HOME/ollama-serve.log" 2>&1 &
sleep 3 && ollama -v && grep -i 'cloud' "$HOME/ollama-serve.log"   # expect: Ollama cloud disabled: true

# 6. pull ONE approved model, never sign in, never pull a :cloud tag
ollama pull qwen3:4b
ollama list
ollama run qwen3:4b 'Say hi in three words'
ollama ps          # PROCESSOR should read 100% CPU; note SIZE and CONTEXT
free -m
```

Notes: `OLLAMA_VULKAN=0` and `OLLAMA_CONTEXT_LENGTH` are from the Ollama docs and are **VERIFY** on v0.40.7.
Never run `ollama signin`. Stop the server with `pkill -u "$USER" -x ollama`. Full rollback (deletes all pulled
models): `rm -rf "$HOME/.local/bin/ollama" "$HOME/.local/lib/ollama" "$HOME/.ollama"`. After a good run you may
delete the tarball to free 1.5 GB.

## B. Python packages (agent service, installed into `.venv/` inside the project, git-ignored)

| # | Name and version | Purpose | Source | Size | License | Checksum | Phase |
|---|---|---|---|---|---|---|---|
| B1 | `strands-agents[ollama]==1.61.1` (uploaded 2026-10-15) | Strands agent framework | https://pypi.org/project/strands-agents/1.61.1/ | wheel 886,728 bytes | Apache-2.0 | wheel sha256 `ee0720a0dacdfa2fc745f7260a58d9868067d7bd16c2cfbcb7631475fc0258dd` | 0b |
| B2 | `mcp==1.30.0` (uploaded 2026-09-07); satisfies `mcp<2.2,>=1.23.0` | Python MCP client used by Strands. Pinned below 2.x to avoid advisory-affected 2.1.1 and keep `streamablehttp_client` | https://pypi.org/project/mcp/1.30.0/ | wheel 234,581 bytes | MIT | wheel sha256 `666edb5009503e1047c9d60346a756f94b261f05cc2625f23d41c728ffc484d0` | 0b |
| B3 | `ollama` Python client `0.6.3` (via the B1 extra) | talk to the local server | https://pypi.org/project/ollama/0.6.3/ | wheel 16,603 bytes | MIT | wheel sha256 `6a20bc42c1a5f889295d7ec490d35e5132fc31f339561530f43a8abd4dbfe508` | 0b |
| B4 | `starlette` 1.9.0, `sse-starlette` 3.5.0, `uvicorn` 0.54.0 | small SSE chat endpoint for the agent service. Likely already pulled in by `mcp` (**VERIFY**), so no extra rows to install | PyPI | starlette wheel 80,335; sse-starlette 17,407; uvicorn 87,427 bytes | BSD-3-Clause | see PyPI | 1, 2 |
| B5 | Transitive dependencies (resolver-chosen). Known heavy items: `botocore` 1.43.116 (16,111,072 bytes), `boto3` (140,042 bytes), `cryptography` 50.0.2 (4,753,050 bytes) | Strands depends on boto3 even when only Ollama is used. Installing boto3 makes no AWS call; the guards in `docs/implementation-decisions.md` D4 make sure the agent never does | PyPI | **ESTIMATE** wheels 28 to 40 MB; installed venv 170 to 260 MB. **VERIFY** with `pip install --dry-run` after approval | mixed, mostly Apache-2.0, MIT, BSD (**VERIFY**) | n/a | 0b |

Install command (I run it after you approve B; no sudo; `python3-venv` is present):

```bash
python3 -m venv .venv
.venv/bin/python -m pip install 'strands-agents[ollama]==1.61.1' 'mcp==1.30.0'
.venv/bin/python -c "from strands import Agent; from strands.models.ollama import OllamaModel; from strands.tools.mcp import MCPClient" && echo imports-ok
```

Rule for all agent code: never call `Agent()` without an explicit `OllamaModel` (a bare `Agent()` builds a
Bedrock model and runs AWS credential lookup). Run the service with a scrubbed environment (see D4).

## C. npm packages (project root, exact pins already in `package.json`)

npm does not publish compressed tarball sizes, so only unpacked sizes are listed.

| # | Name and version | Purpose | Unpacked size | License | Phase |
|---|---|---|---|---|---|
| C1 | `@modelcontextprotocol/sdk` 1.32.1 | MCP server and client | 4,490,363 bytes (701 files) | MIT | 1 |
| C2 | `zod` 4.6.7 | schema validation | 6,148,944 bytes | MIT | 1 |
| C3 | `express` 5.3.0 | HTTP server | 76,638 bytes (plus its dependencies) | MIT | 1 |
| C4 | `@types/express` 5.0.6 | types | 7,576 bytes | MIT | 1 |
| C5 | `@types/node` 22.20.5 | types matching Node 22 | 2,438,360 bytes | MIT | 1 |
| C6 | `typescript` 6.0.3 (latest 6.x; 7.0.2 is the latest tag but the SDK documents `>=6.0`) | compiler | about 30 MB (**VERIFY** for 6.x) | Apache-2.0 | 1 |
| C7 | `tsx` 4.23.15 | run TypeScript | 396,881 bytes plus about 11.6 MB esbuild | MIT | 1 |
| C8 | `vite` 8.3.5 | web build and dev server (Node `^20.19 || >=22.12`) | 2,383,283 bytes plus about 31 MB native dependencies | MIT (transitive `lightningcss` is MPL-2.0) | 2 |
| C9 | `vitest` 5.0.5 | tests (Node `^22.12 || ^24 || >=26`) | 2,817,789 bytes plus about 2 to 3 MB | MIT | 1 |
| C10 | Transitive dependencies (resolver-chosen) | | **ESTIMATE** 30 to 45 MB compressed, 90 to 130 MB in `node_modules`; native binaries alone about 69 MB. **VERIFY** | mixed permissive | 1, 2 |

Install command (I run it after you approve C; creates `package-lock.json`, then `npm audit`):

```bash
npm install
npm audit
```

Registry checksums (sha512) for each version are recorded in `package-lock.json` after install.

## D. Optional

| # | Name and version | Purpose | Size | License | Notes |
|---|---|---|---|---|---|
| D1 | `@modelcontextprotocol/inspector` 2.11.0 via `npx` (on demand, not a dependency) | manual check of the MCP server | 6,056,775 bytes unpacked; npx cache **ESTIMATE 80 to 120 MB** | "SEE LICENSE IN LICENSE" (**VERIFY** the file in the tarball) | First run writes under `$HOME/.mcp-inspector`, prints a URL with an API token and opens a browser (`MCP_AUTO_OPEN_ENABLED=false` stops that). Command: `npx @modelcontextprotocol/inspector@2.11.0 --server-url http://localhost:3000/mcp --transport http` |
| D2 | `fastapi` 0.156.4 | convenience layer for the agent service | wheel 147,143 bytes | MIT | Not needed. Published one day ago. Skip. |

## Totals

- Network download, recommended set: 1.51 GB (A1) + 2.5 GB (A2) + about 0.03 to 0.04 GB Python wheels
  + about 0.03 to 0.045 GB npm tarballs = **about 4.1 to 4.2 GB**. With A3 as well: about 9.0 to 9.1 GB.
- Disk after install, **ESTIMATE**: Ollama unpacked 3.5 to 5 GB + model 2.5 GB + venv 0.17 to 0.26 GB
  + `node_modules` 0.09 to 0.13 GB = about 6.3 to 8 GB, plus 1.5 GB while the tarball is kept. Against 89 GB free.
- RAM at run time, **ESTIMATE**: about 4 to 5.3 GB with `qwen3:4b`; about 6.5 to 8.3 GB with an 8B model. One
  model only. Close other applications before the spike.
