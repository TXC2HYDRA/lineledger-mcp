> **Implementation status, 2026-10-23 (added after the build; the design below is kept as written).**
> Built: the seven-line Tarnby Works plant (`plant/plant.json`, `server/sim.ts`) with the shifts, breaks,
> stop and reject model, warm-up, bill of materials, Line 2 sealer sensor and the story day (seed 1 passes
> `npm run plant:story-check`); `LINELEDGER_PLANT=1` profile; `get_live_line_status`, pace fields,
> `days_cover`; the planner rules; the seven-card UI with the clock chip and alarm ticker; and, from Tier 2,
> stateful MCP sessions with `plant://snapshot` subscription push (no polling).
> Not built: the separate simulator process and both ingest channels (WebSocket telemetry, signed
> webhooks). The simulation runs inside the server instead (decision D13 in `implementation-decisions.md`).
> Also not built: the other Tier 2 items (OEE and downtime tools, material forecast, buffer B23, backfill,
> PLC layer, reconciliation).
> Changed: no MCP tool controls a line (the first in-server version had fault and start/stop tools; they
> were removed). Numbers in this document are design targets; the shipped values are in `plant/plant.json`
> and the story check output.

# Simulation context: Tarnby Works plant simulator, ingest and MCP

Handoff document for whoever builds the plant simulation, and for their Claude. It records the design agreed in the brainstorm session of 2026-10-22/23 and the scope changes the author made afterwards. Read it top to bottom once, then use sections 5 to 14 as the build reference.

Status: **design only. No code for this work exists yet.** Every number below is a design target from a model, not a measured result. Numbers marked "frozen after calibration" will change once the simulator runs.

Revision note: this version replaces the first draft. Changes since the first draft: seven lines instead of three; both a WebSocket telemetry channel and a signed webhook channel (the first draft had webhook only); a two-hour Tier 1 scope with the rest moved to Tier 2; an open-source stack mapping; a layered "how a real startup plant integrates" model.

## 0. Read this first

### 0.1 Deadline and scope

- Devpost deadline: 2026-10-23 12:00 PM PDT, which is **2026-10-24 00:30 IST**. Unconfirmed: the Devpost rules page returned HTTP 403 earlier.
- The author's constraint: **the simulation must be done within about 2 hours.** With two people working in parallel that is feasible only for Tier 1 (section 0.2). One person alone needs about 3.5 hours for Tier 1.
- Remaining time budget after Tier 1: video about 2.5 h, docs and submit about 1 h. Check the clock before starting and move the Tier 2 cut-off accordingly.
- The author submits on Devpost personally. The submission is a public video under 3:00 plus a written description.

### 0.2 Scope tiers

| | Tier 1 (the 2-hour target) | Tier 2 (only if time remains) |
|---|---|---|
| Plant | **7 lines**, 3 shifts, about 100 people, one scripted story on L2 plus one scripted background stop on L5 | Buffer coupling B23 (L2 to L3 starvation), 7-day backfill |
| Transports | **Both**: WebSocket for telemetry, signed webhooks for business events. One shared `applyEvents()` | PLC register layer in the sim (`sim/plc.ts`), MES `shift_end` reconciliation, outage with replay demo |
| Events | `count_report`, `state_change`, `fault`, `fault_clear`, `sensor` (WS); `shift_start`, `shift_end`, `quality_check`, `material_level` (webhook) | `micro_stop`, changeover, bad-material batch |
| MCP tools | `get_live_line_status` (new), pace fields on `get_shift_summary`, `days_cover` on `check_stock` | `get_oee`, `explain_downtime`, `get_material_forecast`, `get_shift_brief`, prompt `shift_handover` |
| MCP transport | Stays **stateless** in Tier 1. Dashboard polls `GET /api/plant/snapshot` every 2 s. | **Stateful** sessions, resource subscription, `notifications/resources/updated` push (the author confirmed stateful as the target design; the 2-hour budget defers it) |
| UI | 7 compact line cards with state badge (text plus icon), sim-clock chip, link chip, alarm ticker | Floor tile with stations and buffer bar |
| Tests | Ingest (signature, duplicate, WebSocket hello), pace fields, new tool | Subscription, sessions, determinism hash |

Plainly: stateful MCP alone is about 1.25 h, which is more than half of the 2-hour budget. It is not in Tier 1. The Devpost and README claims must match the tier that actually ships (section 16).

### 0.3 What we are building, in one paragraph

LineLedger is a voice-first factory-floor co-pilot (TypeScript MCP server plus a Vite web client). Today it runs on a tiny hand-written seed and reads like a toy. We add a **separate simulator process** that plays a fictional small contract manufacturer, **Tarnby Works**, with seven lines. The simulator behaves like two real systems: an **edge gateway** that streams high-rate machine telemetry over a **WebSocket**, and an **MES/ERP** that sends business events as **HMAC-signed webhooks** with retries. The server de-duplicates and stores both, keeps shift rollups in the tables the existing tools already read, and the MCP tools answer from live, changing data.

### 0.4 Hard constraints (do not break)

1. Runs on one laptop. No paid service, no cloud account, no credentials in the repo.
2. All data is synthetic and labelled so. Company name is invented. "Realistic" never means pretending to be a real company. The server rejects any WebSocket hello or webhook batch that does not declare `synthetic: true`.
3. The simulator is **read-only toward machines in the story**. LineLedger never controls equipment. No tool writes back to a machine, and no channel carries commands to the gateway.
4. The existing nine tools and their tests must keep working. Extra lines and stock exist only when `LINELEDGER_PLANT=1` (section 4.2). Tests use the in-memory seed.
5. Honest claims. The README and Devpost text currently say things that become false (section 16). Update them in the same change.
6. Workflow rules for this repo and this author:
   - No AI attribution lines in commits or PR bodies (no `Co-Authored-By`, no "Generated with").
   - Personal projects use GitHub account `TXC2HYDRA` over the personal SSH key. Never use the `gh` CLI.
   - Push to the **same-named remote branch**, not `main`, then open a prefilled GitHub compare URL for the author to click Create.
   - Work on a feature branch (suggested: `feat/sim-plant`). The branch at the time of writing is `ui/light-glass`.

### 0.5 Corrections to the original brief (the repo wins)

- The server is **stateless** today (`server/app.ts:38-41`: new `McpServer` and transport per POST; `GET` and `DELETE` on `/mcp` return 405 at `app.ts:65`, asserted at `tests/server.test.ts:76`). Going stateful is Tier 2. The old decision record D2 in `docs/implementation-decisions.md` (not read during the brainstorm) must be rewritten when that happens.
- The seed is wired into tests, docs and the old video script. `openDb()` seeds in memory and tests assert 2 lines, 14 history shifts, L1 at 1002 units and 83.5% (`tests/server.test.ts:93`), 2 notes and 2 follow-ups. Do not reseed. Extra lines load only behind `LINELEDGER_PLANT=1`.
- `get_shift_summary` compares produced units to the **full-shift target** (`server/tools.ts:95`, thresholds 95 and 80 percent). Mid-shift that marks every line "behind". We add pace fields (section 9.1).
- The planner (`web/src/planner.ts`, 107 lines) is regex rules, **one request to one tool call**, first match wins. "why is line 2 down" currently hits the shift-summary rule through `lines?`. New questions need new rules placed before it (section 10).
- The seed was incoherent: a "sealer jaw" and "heater band" on Line 2, which is a poly crate line. The plant gives Line 2 a real heat sealer so the old notes make sense.
- The first brief said "3 to 6 lines". The author has now asked for **at least 7 lines**, so we follow that. Headcount stays inside the brief's 40 to 120.
- `packages/` in the repo root is untracked. It holds a local copy of `container-load-planner`. Do not commit it by accident.
- `shift_output` allows shift `'C'` but no seed data uses it. History is A and B only.
- The server has no WebSocket support today and Node 22 has no built-in WebSocket **server**. A server needs the `ws` package (section 7.2). Node 22's global `WebSocket` is a client, so the simulator needs no dependency.

### 0.6 Not verified yet (check these first)

- `web/src/main.ts` was **not read**. The UI estimates assume its render code can take a snapshot object and loop over lines. Check before the UI step.
- `docs/implementation-decisions.md` and `server/trace.ts` were not read in detail.
- `npm ls ws` was not run. Vite may already pull `ws` in transitively, but do not rely on a transitive dependency: add it to `package.json` explicitly if it is missing.
- SDK 1.32.1 API names for subscriptions (Tier 2) are from memory: `registerCapabilities({ resources: { subscribe: true } })`, `setRequestHandler(SubscribeRequestSchema, ...)`, `sendResourceUpdated`.
- Brainstorm defaults not explicitly confirmed by the author: accelerated clock (×120) and a separate plant profile.
- The company name "Tarnby Works" has not been checked for collisions.
- Open-source project names in section 2.3 are from general knowledge, not checked in this session. Verify before naming any of them in public text.

## 1. Terms

| Term | Meaning |
|---|---|
| Sim | The simulator process (`sim/`). Plays the factory. Has no DB access. |
| Edge gateway | Role played by the sim for machine telemetry. Source id `gw-tarnby-edge-01`. Sends over WebSocket. |
| MES / ERP | Role played by the sim for business events (shifts, quality, inventory). Source id `mes-tarnby-01`. Sends signed webhooks. |
| Ingest | Server code that verifies, de-duplicates and stores events: `server/ingest.ts`. |
| Plant profile | Server mode enabled by `LINELEDGER_PLANT=1`. Adds lines L3 to L7, extra stock, ingest endpoints and extra tables. |
| Seed profile | Existing behaviour (`openDb()` seed). Used by the tests and old docs. |
| Sim clock | The plant's simulated UTC time. Runs faster than wall time. Shown in the UI. |
| Hold | A scripted pause of the sim clock (wall seconds) so the presenter can type or speak. |
| Snapshot | One JSON document of the whole live plant: `GET /api/plant/snapshot` in Tier 1, MCP resource `plant://snapshot` in Tier 2. |
| A / P / Q / OEE | Availability, Performance, Quality, and their product (section 6.3). |
| Pace | Produced units divided by target-to-date. Replaces "percent of full target" for in-progress shifts. |
| Outbox | The sim-side queue of unacknowledged events (store-and-forward). |

## 2. How a real startup plant integrates, and what the sim imitates

### 2.1 The layered picture

A small contract manufacturer with about 100 people and seven lines typically has this stack. The sim imitates the **output** of layers 1 and 2, and plays layers 3 and 4 as the senders. Nothing in layers 0 to 2 is a runtime dependency of this project.

| Layer | Real world | In our simulation |
|---|---|---|
| 0. Machines | PLCs with counters, run and stop bits, fault words, analog inputs (temperature) | Seven line state machines in `sim/line.ts`. Tier 2: a register map in `sim/plc.ts` |
| 1. Edge gateway | A small industrial PC. Polls the PLCs about once a second over OPC UA, Modbus TCP or EtherNet/IP. Converts counter changes to deltas. Buffers while offline (store-and-forward). Pushes **outward** to the cloud over a persistent connection (MQTT, WebSocket) so no inbound port is opened into the plant network | `sim/gateway.ts`: batches per sim-minute, keeps an outbox, reconnects with resume, **WebSocket** to the server |
| 2. MES / historian | Shift counts, downtime reasons, quality checks, OEE. Often a small MES or a spreadsheet-plus-forms tool in a startup | The sim's MES role: `shift_start`, `shift_end`, `quality_check`. Delivered as **signed webhooks** |
| 3. ERP / WMS | Stock, suppliers, purchase orders. Sends callbacks when inventory changes | The sim's ERP role: `material_level`. Delivered as **signed webhooks** |
| 4. Cloud / DMZ application | Receives from the plant, never reaches in | LineLedger server: ingest, storage, MCP tools, UI |

Human-entered data stays human-entered: handover notes and follow-ups go through the existing MCP tools, not through ingest.

### 2.2 Why two channels (this is the answer to "WebSocket or webhook?")

Both exist in real plants, for different jobs. The sim uses both on purpose.

| | WebSocket (telemetry) | Signed webhook (business events) |
|---|---|---|
| Represents | The edge gateway's live stream | An MES or ERP callback |
| Direction | Gateway opens the connection outward | MES/ERP posts to a URL |
| Data | High-rate, small, ephemeral: counters, state changes, alarms, sensor values | Low-rate, authoritative records: shift start and end, quality checks, inventory levels |
| Delivery | Ordered stream with acknowledgements and resume from the last acknowledged `seq` | At-least-once with retries; the receiver de-duplicates |
| Failure handling | Reconnect with backoff, replay the outbox from `last_seq + 1` | Retry with exponential backoff, then dead-letter log |
| Auth | HMAC-signed `hello` frame at connect, Origin check | HMAC over timestamp plus body on every request |
| Source id and sequence | `gw-tarnby-edge-01`, own `seq` | `mes-tarnby-01`, own `seq` |

Two sources with two sequences is also what makes the data look real: the edge gateway and the MES can disagree slightly (Tier 2 reconciliation, section 7.7).

### 2.3 Open-source stack mapping (for the story and the Q&A, not for runtime)

This is a map from our simulation to recognisable open-source parts a real startup might use. **We do not use these at runtime and we make no integration claim.** The only new runtime dependency is `ws` (WebSocket server library; check its licence in `package.json` before the submission text names it). Names are from general knowledge; verify before printing them.

| Real-world job | Examples of open-source parts a plant could use |
|---|---|
| Soft PLC / PLC test bench | OpenPLC Runtime |
| Industrial protocol drivers | libmodbus, node-opcua, open62541, Eclipse Milo, Apache PLC4X |
| Edge flows and gateways | Node-RED, Eclipse Kura, Telegraf |
| Message bus to the cloud | Eclipse Mosquitto or EMQX (MQTT), Sparkplug B (Eclipse Tahu) |
| Time series and dashboards | InfluxDB or TimescaleDB, Grafana |
| Small ERP / MES style webhooks | ERPNext, Odoo |
| IoT platform / web SCADA | ThingsBoard CE, FUXA |

In a real deployment an MQTT or Sparkplug B bus would typically sit between the gateway and the cloud. Our WebSocket hop stands in for that bridge. Say so if asked.

### 2.4 Optional: the simulator as its own open-source project

The Open Source mini challenge currently rests on `container-load-planner`. The simulator could also be published as a separate MIT repository (for example `tarnby-plant-sim`), but: the challenge rules were not verified (the rules page returned 403), the repo would have to be created inside the submission period, and extraction costs about 20 to 30 minutes. **Default: do not do this before the deadline.** Mention it as a next step only.

## 3. Decisions log

| Id | Decision | Why |
|---|---|---|
| D-LINES | 7 lines, 3 shifts, about 100 people | Author request. Looks like a real startup contract manufacturer. Lines are data in `plant/plant.json`, so extra lines cost little |
| D-TRANSPORT | Both channels: WebSocket telemetry from the edge gateway, signed webhooks from MES/ERP, one shared `applyEvents()` | Author request. Mirrors real plants. Separate sources and sequences |
| D-FALLBACK-WS | If the WebSocket channel is not working by minute 70 of Tier 1, run the sim with `--telemetry webhook` (all events over the webhook). The server keeps the WS code behind a flag | Protects the 2-hour target |
| D-PROFILE | Extra lines and stock only when `LINELEDGER_PLANT=1`. Extra tables are `CREATE TABLE IF NOT EXISTS` | Keeps tests, seed and old docs valid |
| D-CLOCK | Accelerated sim clock, default ×120, time-lapse ×300 in one scripted stretch, visible chip | A real 8 h shift cannot fit a 2:40 video. The chip keeps it honest |
| D-ROLLUP | Counter deltas (`count_report`), not per-unit events | How real gateways report. About 14 events per wall second at ×120 with 7 lines, easy for SQLite |
| D-LATE | Counters accept late events by event time. Live state and downtime intervals assume in-order delivery per source | Simple. Mark with a `ponytail:` comment naming the ceiling |
| D-NOLLM | Planner stays rule-based. New tools are SQL plus arithmetic | qwen3:4b scored 7/10 at about 13 s per turn. Not demo-safe |
| D-STATEFUL | Stateful MCP (sessions, GET SSE, subscription push) is the target design but **Tier 2** | Author decision, deferred by the 2-hour budget. Tier 1 polls `/api/plant/snapshot` so the trace panel stays clean |
| D-POLL | Tier 1 dashboard polls a plain HTTP endpoint, not an MCP tool | Polling an MCP tool every 2 s would flood the trace drawer (buffer cap 500) |

## 4. Repo changes: files, env, scripts

### 4.1 Proposed layout (new files marked +)

```
plant/plant.json            + single source of truth: 7 lines, stations, cycles, BOM, stock, crew, reason mixes
sim/main.ts                 + entry, CLI flags, control loop, stdin keys
sim/clock.ts                + sim clock, speed, holds, time-lapse segments
sim/rng.ts                  + mulberry32, per-line substreams
sim/line.ts                 + line state machine (RUN, STOP_FAULT, STOP_OTHER, PLANNED_STOP, IDLE_STARVED)
sim/events.ts               + event builders, per-source seq counters, deterministic event_id
sim/gateway.ts              + WebSocket client: hello, batch, ack, outbox, reconnect with resume
sim/mes.ts                  + webhook client: sign, POST, retry with backoff, dead-letter log
sim/story.json              + scripted beats (section 11)
sim/plc.ts                  + Tier 2: register map and gateway poller
scripts/seed-search.ts      + offline seed search (section 12.4)
server/ingest.ts            + applyEvents(), webhook route, HMAC verify, zod union
server/wsingest.ts          + WebSocket route (ws), hello auth, ack, heartbeat
server/plant.ts             + plant schema (DDL), plant.json loader, snapshot builder, plantBus
server/metrics.ts           + lineMetrics() shared helper (Tier 2 tools; pace in Tier 1)
server/sessions.ts          + Tier 2: MCP session map, subscriptions
server/tools.ts               edit: pace fields on get_shift_summary, days_cover on check_stock, get_live_line_status
server/app.ts                 edit: mount webhook route BEFORE express.json, /api/plant/snapshot
server/main.ts                edit: attach the WebSocket server to the HTTP server returned by listen()
web/src/planner.ts            edit: new rules before the generic shift rule
web/src/main.ts               edit: poll snapshot, 7 compact line cards, chips (file not yet read)
tests/ingest.test.ts        + webhook signature, duplicate, WebSocket hello and ack, rollup math
tests/server.test.ts          edit only if the harness needs the plant flag
docs/simulation_context.md  + this file
```

Keep it small. No framework, no ORM, no message broker, no extra npm packages except `ws`.

### 4.2 Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `LINELEDGER_PLANT` | server | `1` enables the plant profile, ingest endpoints and the extra lines. Unset means seed profile and unchanged tests |
| `LINELEDGER_DB` | server | Existing. Plant default `data/plant.sqlite` |
| `LL_INGEST_SECRET` | server, sim | HMAC key. If unset, read `data/.ingest-secret` |
| `LL_SIM_SEED` | sim | Integer seed. Default is the frozen story seed |
| `LL_SIM_SPEED` | sim | Default 120 |
| `LL_SERVER_URL` | sim | Default `http://127.0.0.1:8787` (the WebSocket URL derives from it: `ws://127.0.0.1:8787/ingest/ws`) |
| `PORT`, `WEB_PORT` | server, web | Existing. The Origin allowlist follows `WEB_PORT` |

### 4.3 npm scripts to add

- `plant:init` creates `data/.ingest-secret` (32 random bytes, hex, git-ignored). Never commit it. Confirm `data/` is in `.gitignore` first.
- `dev:plant` starts the server with `LINELEDGER_PLANT=1`.
- `sim` runs the simulator. Flags: `--seed`, `--speed`, `--story`, `--telemetry ws|webhook`, `--no-hold`.
- `plant:seed-search` runs the seed search (section 12.4).

## 5. The fictional plant: Tarnby Works

Invented contract manufacturer. Seven lines, three shifts, about 100 people. Everything here is synthetic.

### 5.1 Plant-level facts

- Shifts: A 06:00 to 14:00, B 14:00 to 22:00 (all seven lines). C 22:00 to 06:00 runs **L2 and L4 only** (the two molding lines, 2 crew each).
- Planned breaks per shift: tea 10 min at +2 h, meal 30 min at +4 h, tea 10 min at +6 h. Shift A breaks at 08:00, 10:00, 12:00. Shift B at 16:00, 18:00, 20:00.
- Planned production time per shift: 480 − 50 = **430 min**.
- Shift C belongs to the date of its 22:00 start. Times are UTC and serve as plant time.
- Headcount. Line crews per A or B shift: L1 5, L2 4, L3 4, L4 3, L5 5, L6 3, L7 4 = 28. Support per shift: 2 supervisors, 2 maintenance, 1 QA, 2 material handlers = 7. So **35 per A or B shift**. Shift C: 4 line crew plus 2 support = 6. Day staff (planner, quality engineer, purchasing, maintenance lead, admin, management): 12. Total 35 + 35 + 6 + 12 = 88 posts, about **100 people** with leave and rotation cover. Inside the brief's 40 to 120.
- Names (all invented): Asha (shift A lead), Joel (shift B lead), Ravi (maintenance), Meena (purchasing), Priya (QA), Kofi (L1), Dev (L5), Nina (L7), Sam (material handler). Asha, Ravi and Meena come from the existing seed.
- Buffer `B23` (Tier 2): capacity 40 crates, between L2 and L3, starts the story at 25. L3 uses about 0.93 crates per minute, so a stopped L2 starves L3 in about 25 minutes.

### 5.2 Lines

Targets follow one rule: `target = round(0.8 × 430 × 60 / ideal_cycle_s)`, rounded to the nearest 10. L1 and L2 keep the existing seed targets (1200 and 800), so the old trend chart stays continuous. Capacity per shift is `430 × 60 / ideal_cycle_s`.

| Line | Product | Stations | Ideal cycle | Capacity | Target | Crew |
|---|---|---|---|---|---|---|
| L1 | Steel bracket 40x60 (`BRK-4060`) | S1 bend 14 s; S2 spot weld 17 s (bottleneck); S3 deburr 12 s; S4 inspect and pack 15 s | 17 s | 1517 | 1200 | 5 |
| L2 | Poly crate 600x400x300 (`CRT-6430`) with liner bag. **Story line** | M1 molding press 26 s (bottleneck); M2 cooling conveyor; M3 liner insert and **heat sealer** 24 s; M4 palletise | 26 s | 992 | 800 (C: 500) | 4 |
| L3 | Retail kit: 1 crate + 2 brackets (`KIT-01`) | P1 kit pick; P2 label; P3 carton seal | 52 s | 496 | 400 | 4 |
| L4 | Poly crate lid 600x400 (`LID-6040`) | M1 molding press 22 s (bottleneck); M2 degate and cool; M3 stack | 22 s | 1173 | 940 (C: 600) | 3 |
| L5 | Steel shelf panel 600x300 (`PNL-6030`) | S1 laser blank 15 s; S2 press 21 s (bottleneck); S3 deburr 14 s; S4 stack and strap 12 s | 21 s | 1229 | 980 | 5 |
| L6 | Shrink-pack bundle of 8 crates (`BND-08`) | P1 crate stack 20 s; P2 film wrap and shrink tunnel 45 s (bottleneck); P3 strap and label 25 s | 45 s | 573 | 460 | 3 |
| L7 | Foam insert and carton pack-out (`PKG-FI`) | I1 foam insert 22 s; I2 carton erect and load 30 s (bottleneck); I3 label and seal 18 s | 30 s | 860 | 690 | 4 |

Statistical parameters per line. All are inputs to the sim, tunable in `plant/plant.json` only.

| | L1 | L2 | L3 | L4 | L5 | L6 | L7 |
|---|---|---|---|---|---|---|---|
| Baseline A / P / Q | .92 / .86 / .984 | .87 / .86 / .978 | .93 / .87 / .994 | .91 / .88 / .985 | .90 / .87 / .982 | .92 / .85 / .990 | .93 / .88 / .993 |
| Baseline OEE | 78% | 73% | 79% | 79% | 77% | 77% | 81% |
| MTBF (run min) | 125 | 80 | 110 | 85 | 110 | 100 | 120 |
| MTTR median (min, lognormal σ .6) | 8 | 9 | 5 | 9 | 7 | 6 | 5 |
| Micro-stops per run hour (median 20 to 25 s) | 5 | 3 | 4 | 3 | 5 | 4 | 4 |
| Cycle slowdown, median (lognormal σ .05) | ×1.10 | ×1.08 | ×1.10 | ×1.08 | ×1.10 | ×1.12 | ×1.07 |
| Warm-up after restart (multiplier, decay min) | ×1.25, 4 | ×1.5, 15 | ×1.1, 3 | ×1.5, 15 | ×1.2, 4 | ×1.3, 10 | ×1.1, 3 |
| Base reject rate | 1.6% | 2.4% | 0.7% | 2.0% | 1.4% | 0.9% | 0.6% |

Reject codes (percent) and downtime reason mix (percent):

| Line | Reject codes | Downtime reasons |
|---|---|---|
| L1 | `BURR` 45, `DIM_OOS` 35, `WELD_POROSITY` 20 | `WELD_TIP_CHANGE` 30, `COIL_JAM` 25, `UNCLASSIFIED` 30, `NO_OPERATOR` 15 |
| L2 | `SHORT_SHOT` 40, `FLASH` 35, `SEAL_WEAK` 25 | `MOLD_TEMP_TRIP` 35, `UNCLASSIFIED` 33, `QUALITY_HOLD` 19, `NO_OPERATOR` 13 |
| L3 | `LABEL_MISPRINT` 60, `MISSING_PART` 40 | `LABEL_JAM` 40, `CARTON_JAM` 30, `UNCLASSIFIED` 30 |
| L4 | `SHORT_SHOT` 45, `WARP` 30, `FLASH` 25 | `MOLD_TEMP_TRIP` 35, `UNCLASSIFIED` 30, `QUALITY_HOLD` 20, `NO_OPERATOR` 15 |
| L5 | `BURR` 40, `DIM_OOS` 40, `SCRATCH` 20 | `DIE_ADJUST` 35, `COIL_JAM` 25, `UNCLASSIFIED` 25, `NO_OPERATOR` 15 |
| L6 | `WEAK_SHRINK` 55, `TORN_FILM` 45 | `FILM_CHANGE` 40, `TUNNEL_TEMP` 25, `UNCLASSIFIED` 20, `NO_OPERATOR` 15 |
| L7 | `MISSING_INSERT` 50, `LABEL_MISPRINT` 50 | `CARTON_JAM` 40, `UNCLASSIFIED` 35, `NO_OPERATOR` 25 |

The story injects one extra reason `SEALER_FAULT` and one extra reject code `SEAL_BURN` on L2, and one scripted `COIL_JAM` on L5. `UNCLASSIFIED` is deliberate: real operators often choose no reason, and a Pareto with a fat "no reason entered" slice looks believable.

Realism check: with seven lines and the MTBF values above, roughly one or two lines will show a stop at any moment. That is wanted, because a dashboard where nothing ever stops looks fake. Do not suppress random stops outside the story.

### 5.3 Stock (plant profile values)

The seed's `PLY-HDPE 420 kg` would run out in 17 minutes at 1.7 kg per crate, so the plant profile uses new numbers. The old seed values stay in the seed profile.

| SKU | Name | Unit | On hand at 06:00 | Reorder point | Reorder qty | Lead (days) | Supplier | Used by |
|---|---|---|---|---|---|---|---|---|
| `PLY-HDPE` | HDPE granules | kg | about 20,700 (first guess, retune) | 18,000 | 20,000 | 3 | Demo Polymers Ltd | L2 1.7 kg per crate, L4 0.9 kg per lid |
| `STL-040` | Steel strip 40mm | kg | 12,000 | 9,500 | 10,000 | 6 | Demo Metals Ltd | L1 0.31 kg per bracket, L5 0.42 kg per panel |
| `HTR-BAND` | Heater band 230V | pcs | 3 | 2 | 6 | 14 | Demo Thermal Co | L2 sealer wear; the story swaps one |
| `LBL-ROLL` | Label roll 100x50 | rolls | 36 | 20 | 60 | 3 | Demo Print Works | L3 and L7, 1 roll per 500 labels |
| `FLM-SHR` | Shrink film roll | rolls | 42 | 24 | 60 | 5 | Demo Packaging Co | L6, 1 roll per 120 bundles |

Reorder points were set to cover about lead time times daily use. Daily HDPE use is about 5,400 kg (about 230 kg/h averaged over 24 h). `check_stock` status rule (existing): `out_of_stock` if on hand is 0, `reorder` if on hand is at or below the reorder point, else `ok`. After the scripted band swap `HTR-BAND` goes from 3 to 2, equal to its reorder point, so it reads `reorder`.

The HDPE start value is a first guess so that the stock crosses 18,000 kg between 16:10 and 16:30 on the story day. The seed search and calibration decide the final number.

### 5.4 Seed content kept in the plant profile

Keep the two existing handover notes (2026-10-21, Asha) and the two follow-ups (Ravi re-check sealer jaw, Meena order heater band). The 10-21 note ("Sealer jaw on Line 2 ran hot after 10:00. Maintenance swapped the heater band.") is what makes the recurring fault visible when the operator lists L2 notes.

History: the existing seed already provides 2026-10-15 to 2026-10-21 for L1 and L2 (the trend chart). L3 to L7 have no history in Tier 1, so the trend chart shows L1 and L2 only for those dates. Tier 2 backfills seven days for all lines through `applyEvents()` at full speed in-process.

## 6. Signal model

### 6.1 Principles

- Seeded and deterministic. Same seed, same events, same `event_id`s. RNG is `mulberry32`, with a substream per `(seed, line_id)`, so adding a line does not change the others.
- Event ids are `<source>-<seq>`, not random, so a replayed batch is byte-identical.
- The sim ticks in sim-minutes. Each tick, each line state machine advances and emits.
- Realism comes from parameters (section 5.2), not special cases.

### 6.2 Per-tick model (per line, per sim minute)

1. **State.**
   - `PLANNED_STOP` during the break windows. No production.
   - `RUN` otherwise, until a fault. Run time to the next fault is exponential with mean MTBF. Repair time is lognormal with the line's median and σ .6. The fault reason comes from the line's mix. Stops of 2 minutes or more are downtime. Shorter stops are micro-stops, a separate Poisson process (Tier 2 event, Tier 1 folds them into slower cycles).
   - `IDLE_STARVED` when a downstream line has no input (Tier 2, L3 only, from `B23` empty).
2. **Cycle time.** `actual = ideal × slowdown × warmup(t)`. `slowdown` is lognormal with the line's median. `warmup(t) = 1 + (m − 1) × exp(−t / τ)`, with `t` minutes since restart and `(m, τ)` the line's warm-up. Units this minute: `60 / actual`, with the fraction carried to the next tick.
3. **Rejects.** `reject ~ Binomial(units, p)`, approximated by a normal for large `n`. `p` is the base rate multiplied by scripted anomalies. Each reject picks a code from the line's mix.
4. **Material.** `kg_used = (good + reject) × bom` per SKU. `HTR-BAND` is not consumed by rate; the story swaps it.
5. **Emit.** `count_report` every tick (window 60 s). `sensor` every tick for L2 (`M3.sealer_jaw_temp_c`) in Tier 1. `state_change`, `fault`, `fault_clear` when they occur. `quality_check` hourly and `material_level` every 15 sim-minutes go out as webhooks.

### 6.3 Metric definitions (server computes, sim does not)

- `planned_production_s` = shift planned time (430 min) elapsed so far, breaks excluded.
- `downtime_min` = sum of unplanned stops of 2 min or longer (faults, `IDLE_STARVED`, no operator, quality hold). Micro-stops are excluded. This is what goes into the existing `shift_output.downtime_min`.
- `run_s` = `planned_production_s − downtime_s`.
- Availability = `(planned_production_s − downtime_s) / planned_production_s`.
- Performance = `(good + reject) × ideal_cycle_s / run_s`. Micro-stops and slow cycles reduce it.
- Quality = `good / (good + reject)`.
- OEE = A × P × Q. Cross-check: it equals `good × ideal_cycle_s / planned_production_s`. Use it as a test assertion.
- `target_to_date = target × planned_production_s_elapsed / (430 × 60)`. The elapsed planned time is a pure function of the sim time of day and the break schedule, so Tier 1 needs no extra table for it.
- Pace % = `produced / target_to_date × 100`.

### 6.4 Statistical sanity bands (calibration, section 12.3)

Over 30 simulated days, per line, average shift OEE must fall in: L1 74 to 80%, L2 68 to 76%, L3 74 to 82%, L4 75 to 82%, L5 73 to 80%, L6 73 to 80%, L7 77 to 84%. Individual shifts vary widely. A line at a "clean 85%" is a bug, not a goal.

### 6.5 Realism features: build now vs later

| Feature | Status |
|---|---|
| Breaks, MTBF/MTTR faults, slow cycles, warm-up, reject noise, unclassified downtime, seven lines running at once | **Tier 1** |
| Scripted sealer overheat on L2, scripted coil jam on L5 | **Tier 1** |
| Duplicate delivery (about 1 in 100 webhooks resent, WebSocket batch resent after a forced reconnect) to exercise idempotency | **Tier 1** (unit-test it) |
| Micro-stop events, buffer coupling B23, PLC register layer with counter rollover, MES `shift_end` reconciliation | Tier 2 |
| Gateway outage with store-and-forward replay on screen | Tier 2 (the outbox and resume exist in Tier 1 code; the staged demo is Tier 2) |
| Changeover with scrap burst, bad material batch, late or reordered events | Cut |

## 7. Ingest: channels, security, storage

### 7.1 Webhook channel (MES and ERP events)

`POST /ingest/webhook`, mounted only when `LINELEDGER_PLANT=1`. It must be mounted **before** `express.json({ limit: '64kb' })` (`server/app.ts:34`) because HMAC needs the raw bytes. Use `express.raw({ type: 'application/json', limit: '256kb' })` on that route only. The 64 KB global limit stays for `/mcp`.

Headers:

- `X-LL-Source`: `mes-tarnby-01`.
- `X-LL-Delivery`: unique id per delivery attempt group (UUID). Retries of the same body reuse it.
- `X-LL-Timestamp`: wall-clock unix seconds when the request was sent.
- `X-LL-Signature`: `v1=` plus hex of `HMAC-SHA256(secret, timestamp + "." + rawBody)`.

Checks: compare with `crypto.timingSafeEqual`. Reject missing headers or bad signature with 401. Reject a timestamp more than 300 s from server wall time with 401 (replay protection). Reject `synthetic !== true` with 400. Reject bodies over 256 KB with 413. At most 500 events per body.

The signature timestamp is **wall time**. Event `ts` is **sim time**. They are different on purpose.

Body:

```json
{
  "schema": "ll.batch/1",
  "source": "mes-tarnby-01",
  "synthetic": true,
  "sim": { "seed": 42, "speed": 120 },
  "events": [
    { "event_id": "mes-tarnby-01-0412", "seq": 412, "ts": "2026-10-22T14:00:00.000Z",
      "type": "shift_start", "data": { "shift": "B", "crew": [ { "name": "Joel", "role": "supervisor", "station": null } ] } }
  ]
}
```

Response (status 200 even when some events are duplicates or rejected; 401, 400, 413, 429 for batch-level problems):

```json
{ "accepted": 38, "duplicates": 2, "rejected": [ { "event_id": "...", "reason": "unknown_type" } ], "last_seq": 461 }
```

Sender behaviour (`sim/mes.ts`): on network error or 5xx, retry the same body with exponential backoff 0.5, 1, 2, 4, 8 s, at most 8 attempts, then print a dead-letter line (event ids, never the secret). On 429 honour `Retry-After`. About 1 in 100 deliveries is sent twice on purpose.

### 7.2 WebSocket channel (edge gateway telemetry)

Endpoint `GET /ingest/ws` upgrading to WebSocket, using the `ws` package (add explicitly to `package.json`; MIT licence, verify). Attach the `WebSocketServer` in `server/main.ts` to the HTTP server returned by `listen()`, with `noServer: true` and a manual `server.on('upgrade', ...)`, so only `/ingest/ws` is accepted and every other upgrade gets the socket destroyed.

Safeguards:

- Only when `LINELEDGER_PLANT=1`. Bound to 127.0.0.1 like the rest.
- **Origin check on upgrade** (cross-site WebSocket hijacking): allow no Origin (the sim, a non-browser client) or an Origin in the existing allowlist; refuse everything else with 403.
- `maxPayload` 256 KB. Close with code 1009 on larger frames.
- Authentication by a signed first frame (the Node global `WebSocket` client cannot reliably set custom headers, so do not depend on headers). The server closes the socket with code 4401 if no valid `hello` arrives within 5 s.
- Heartbeat: server sends a ping every 15 s; a connection with no pong for 45 s is terminated.
- One live connection per `gateway_id`. A new valid hello replaces the old connection.

Frames (JSON text, one object each):

| Direction | Frame | Fields |
|---|---|---|
| client to server | `hello` | `t:"hello"`, `gateway_id`, `ts` (wall unix seconds), `sig` = hex `HMAC-SHA256(secret, "hello." + gateway_id + "." + ts)`, `synthetic:true`, `resume_from:` the client's next unsent `seq` |
| server to client | `welcome` | `t:"welcome"`, `last_seq` (highest `seq` stored for this gateway), `server_time` |
| client to server | `batch` | `t:"batch"`, `batch_id`, `events:[...]` (the same event envelope as the webhook, at most 500) |
| server to client | `ack` | `t:"ack"`, `batch_id`, `accepted`, `duplicates`, `rejected:[...]`, `last_seq` |
| server to client | `error` | `t:"error"`, `code`, `message` (then close for fatal codes) |

Reject a stale hello (timestamp more than 300 s off) with close code 4401. No per-frame signature after a valid hello; in a real deployment the connection would also use TLS, which this loopback demo does not. State that limit in the docs.

Resume and backpressure (`sim/gateway.ts`): the client keeps an **outbox** of unacknowledged batches (cap 50,000 events) and at most 20 unacknowledged batches in flight. On disconnect it reconnects with exponential backoff 0.5 s doubling to 8 s, sends `hello` with `resume_from`, reads `welcome.last_seq`, and re-sends every outbox event with `seq > last_seq`. The server's idempotency makes any overlap harmless.

### 7.3 What rides on which channel

| Event | Channel | Real-world source |
|---|---|---|
| `count_report` | WebSocket | PLC counters via the gateway |
| `state_change` | WebSocket | PLC run and fault bits |
| `fault`, `fault_clear` | WebSocket | PLC alarm words |
| `sensor` | WebSocket | PLC analog inputs |
| `micro_stop` (Tier 2) | WebSocket | PLC |
| `shift_start`, `shift_end` | Webhook | MES |
| `quality_check` | Webhook | MES or QA tablet |
| `material_level` | Webhook | ERP/WMS or a silo load cell integration |

With `--telemetry webhook` (fallback D-FALLBACK-WS), the sim sends the WebSocket events through the webhook instead, with source `gw-tarnby-edge-01` and its own `seq`. The server code path after verification is identical.

### 7.4 Event envelope and types

Every event has: `event_id` (`<source>-<seq>`), `seq` (monotonic per source), `ts` (sim time, UTC ISO), `type`, `data`, and for line events `line_id` and optional `station`.

| `type` | `data` fields | Rate | Server effect |
|---|---|---|---|
| `count_report` | `window_s` (60), `good`, `reject`, `reject_codes` (map code to count), `avg_cycle_s` | per line per sim-min | Upsert `shift_output` produced; add to `shift_metrics`; update `line_state.last_cycle_s` and recent-rate window |
| `state_change` | `from`, `to`, `reason_code?`, `fault_ref?`. States: `RUN`, `IDLE_STARVED`, `IDLE_BLOCKED`, `STOP_FAULT`, `STOP_OTHER`, `PLANNED_STOP` | on change | Update `line_state`; close the open `downtime_record`; open a new one if the new state is a stop; add minutes to `shift_output.downtime_min` for stops of 2 min or longer |
| `fault` | `code`, `severity` (`warn` or `trip`), `text`, `value?`, `limit?` | rare | Insert an open `alarms` row |
| `fault_clear` | `code` | rare | Set `alarms.cleared_at` |
| `sensor` | `tag`, `value`, `unit`. Tier 1 tag: `M3.sealer_jaw_temp_c` (L2). Tier 2 adds `M1.mold_temp_c` | per sim-min | Insert `line_signal`; keep the latest value and 4 h of history |
| `quality_check` | `check` (`first_off` or `hourly_seal_peel`), `result` (`pass` or `fail`), `measure?`, `spec?` | hourly | Insert `quality_check` |
| `shift_start` | `shift`, `crew` array of `{name, role, station}` | 3 per day | Set current crew; create `shift_metrics` rows; roll the shift |
| `shift_end` | `shift`, Tier 2 field `reported_units` per line | 3 per day | Mark the shift rows `in_progress = 0` |
| `material_level` | `sku`, `on_hand`, `unit`, `source` (`silo_loadcell` or `erp_backflush`) | every 15 sim-min | Update `stock_items.on_hand`; append `material_log`; raise a `material_low` alarm when `on_hand <= reorder_point` and it was above |

Derived on the server, never sent by the sim: `material_low` alarm, `downtime_record` rows, link status, shift rollover bookkeeping.

### 7.5 Idempotency, ordering, backpressure

- `events.event_id` is the primary key. Insert with `INSERT OR IGNORE`. Apply the event's effect **only if the insert changed a row**, inside one transaction per batch. Retries, double sends and resume overlaps are therefore safe, on either channel.
- Sort the events in a batch by `(ts, seq)` before applying.
- `line_state` is last-writer-wins by event `ts`: ignore a `state_change` older than the current `since`.
- Downtime intervals assume in-order delivery per source. Where the interval is closed, put a comment of this form: `// ponytail: intervals assume in-order delivery per source; late state_change events are stored but do not rewrite downtime. Upgrade: rebuild intervals from the event log.`
- Seq gaps: store `last_seq` and a `gap_count` per source (diagnostic only for now).
- Backpressure: webhook route answers `429` with `Retry-After` when more than N batches are queued for processing. WebSocket relies on the in-flight window (20 unacknowledged batches) plus `ack`.
- An invalid or unknown event is reported in `rejected` and does **not** fail the batch, so a sender never retries forever because of one bad event.

### 7.6 Security summary (for the Q&A, and what is not claimed)

| Control | Where |
|---|---|
| HMAC-SHA256 over timestamp plus body | Webhook, every request |
| HMAC-signed `hello` with 300 s skew limit | WebSocket, at connect |
| `timingSafeEqual` comparison | Both |
| `synthetic: true` required | Both (enforces the hackathon rule in code) |
| Origin check on upgrade, no wildcard | WebSocket |
| Size limits (256 KB, 500 events), `maxPayload`, 5 s hello timeout, heartbeat | Both |
| Loopback binding, secret in git-ignored `data/.ingest-secret` | Both |
| Idempotent event ids | Both |

Not claimed: TLS, mutual TLS, key rotation, per-gateway keys, rate limiting beyond the 429 path, protection against a hostile local process (anything on the machine can read `data/.ingest-secret`). State these as demo-scale limits.

### 7.7 Tier 2: reconciliation between the two sources

The MES `shift_end` webhook carries `reported_units` per line, which is the MES's own count. The server compares it with the sum of gateway `count_report` good units for the shift and stores the difference in `shift_metrics.mes_variance`. The sim adds a small deterministic offset (0 to 0.8 percent) so the two sources disagree slightly, as real systems do. `get_shift_summary` keeps using the gateway total; the variance is shown only in a tool field and the docs. Do not build this in Tier 1.

### 7.8 Storage

Plant-profile tables (created only when `LINELEDGER_PLANT=1`; the seed-profile schema is untouched):

| Table | Columns (key in bold) |
|---|---|
| `events` | **`event_id`**, `source`, `seq`, `ts`, `line_id`, `station`, `type`, `data` (JSON text), `received_at`, `channel` (`ws` or `webhook`) |
| `ingest_source` | **`source`**, `last_seq`, `gap_count`, `last_event_wall`, `connected` |
| `line_config` | **`line_id`**, `ideal_cycle_s`, `target_per_shift`, `crew_size`, `stations` (JSON) |
| `line_state` | **`line_id`**, `state`, `since`, `reason_code`, `fault_ref`, `last_cycle_s`, `crew` (JSON), `recent_good` (JSON ring of the last 15 sim-minutes) |
| `shift_metrics` | **`line_id`, `shift_date`, `shift`**, `reject_units`, `planned_s`, `down_s`, `in_progress`, Tier 2: `mes_variance` |
| `downtime_record` | **`id`**, `line_id`, `shift_date`, `shift`, `start`, `end` (null while open), `reason_code`, `kind` |
| `alarms` | **`id`**, `line_id`, `code`, `severity`, `text`, `value`, `limit`, `raised_at`, `cleared_at` |
| `line_signal` | **`line_id`, `tag`, `ts`**, `value`, `unit` |
| `quality_check` | **`id`**, `line_id`, `check`, `result`, `measure`, `spec`, `ts` |
| `material_log` | **`sku`, `ts`**, `on_hand` |
| `plant_clock` | single row: `sim_now`, `speed`, `held`, `seed` |

Existing tables are reused, not replaced. `shift_output(line_id, shift_date, shift, target_units, produced_units, downtime_min)` is **upserted** by ingest, so `get_shift_summary`, `get_shift_history` and the dashboard keep working with live data. `stock_items.on_hand` is updated by `material_level`. `lines` gets L3 to L7 from `plant.json`. Handover notes and follow-ups stay human-entered through the existing tools.

`shift_output` has the primary key `(line_id, shift_date, shift)`. Shift C belongs to the date of its 22:00 start. `plant.json` loading uses `INSERT OR IGNORE` and happens only in the plant profile.

Link status for the UI: `connected` per source plus the age of `last_event_wall`. A source with no event for 10 seconds of wall time shows `LINK DOWN · stale since hh:mm`.

## 8. How the live data reaches the browser

### 8.1 Tier 1: polling a plain endpoint (stateless MCP)

- `GET /api/plant/snapshot` returns the snapshot JSON, built by `buildSnapshot(db)` in `server/plant.ts`. It is not an MCP call, so the trace drawer shows only the real chat calls.
- The browser polls it every 2 s while the tab is visible and renders from it.
- Snapshot content: `{ synthetic: true, sim_clock: {sim_now, speed, held, mode}, links: {edge: 'up'|'down', mes: 'up'|'down', last_event_age_s}, shift: {date, shift, crew}, lines: [ {line_id, name, product, state, since, reason_code, rate_per_h, pace_pct, status, produced, target_to_date, target, downtime_min, oee?, open_alarms: [...], signals: [...]} ], materials: [ {sku, on_hand, unit, reorder_point, status} ], alarms_open: [...], totals: {...} }`.
- Chat still goes through the planner and `tools/call`, exactly as today.

### 8.2 Tier 2: stateful MCP with resource subscription

This is the author's confirmed target design. It is the part most likely to go wrong, so give it a hard stop and fall back to 8.1.

What changes in `server/app.ts` (today: a fresh `McpServer` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST, closed when the response closes):

- `server/sessions.ts` holds a `Map<sessionId, { server, transport, subscribed: Set<string>, lastSeen }>`.
- `POST /mcp` without `mcp-session-id` and with an `initialize` body: create a transport with `sessionIdGenerator: () => randomUUID()` and `onsessioninitialized` to register the session; create a new `McpServer`, `registerTools(server, db)`, register the snapshot resource and subscription handlers, `server.connect(transport)`.
- `POST /mcp` with a known session id: route to that transport. With an unknown id: respond **404** with a JSON-RPC error (the SDK client treats it as "session gone").
- `GET /mcp` with a known session id opens the SSE stream for server-initiated messages. `DELETE /mcp` with a known id closes and removes the session. Unknown ids get 404, a missing id 400.
- **Remove** the per-request `res.on('close', ...)` teardown at `app.ts:50-53`.
- Caps: at most 16 concurrent sessions (503 on `initialize` beyond that); idle sweep every minute closes sessions idle more than 10 minutes.
- Keep `hostHeaderValidation`, the Origin allowlist, the 64 KB body limit on `/mcp` and loopback binding.
- Apply the trace tap wrapper (`transport.send` wrapped to record out messages) **per session transport**, so notifications on the GET stream are recorded. Raise the trace buffer from 500 to 2000 (check `server/trace.ts`).

Resource and subscription:

- Register `plant://snapshot` (`application/json`). `resources/read` returns the same document as 8.1. In the seed profile it returns a small valid snapshot built from the seed tables, so `tools/list` and `resources/list` behave the same everywhere. Test it.
- The SDK `McpServer` does not wire `resources/subscribe` by itself (confirm against 1.32.1). Declare `resources: { subscribe: true }` before `server.connect`, and handle `resources/subscribe` and `resources/unsubscribe` by adding or removing the URI from that session's `subscribed` set. Accept only `plant://snapshot`.
- `plantBus` (in-process `EventEmitter` in `server/plant.ts`): ingest emits `changed` after committing a batch. A throttle in `sessions.ts` pushes at most once per session every 2 s, except urgent changes (alarm raised or cleared, state change to or from a stop, `material_low`), which push after a 300 ms debounce. A push is `server.server.sendResourceUpdated({ uri: 'plant://snapshot' })` (confirm the name) per subscribed session. Catch and drop errors for closed sessions.

Browser (`web/src/mcp.ts`, SDK `Client` with `StreamableHTTPClientTransport`, which opens the GET stream by itself after `initialize`):

1. After connect, `client.subscribeResource({ uri: 'plant://snapshot' })`.
2. `client.setNotificationHandler(ResourceUpdatedNotificationSchema, ...)`: call `client.readResource({ uri })`, parse the JSON, render. One read in flight at a time.
3. If any request fails with a session-gone 404 (the server restarted), re-initialize, re-subscribe, re-read, and show "reconnecting" on the connection card.
4. Stop polling `/api/plant/snapshot` once subscribed.

The trace drawer then shows, for every push, `notifications/resources/updated` (no request id) followed by `resources/read`. That pair is the proof shot: no polling, the server pushed.

Tests for Tier 2: initialize returns a session header; bogus session id gets 404; `GET /mcp` without a session fails (replaces the 405 assertion at `tests/server.test.ts:76`); `DELETE` ends the session; subscribe then feed a signed batch and assert a notification arrives within 3 s; a second session that did not subscribe gets nothing; session cap and idle sweep.

If Tier 2 fails, nothing else changes. Keep the stateless handler and the polling endpoint, and drop the subscription claims from the docs.

## 9. Tools, resource, prompt

### 9.1 Tier 1: changes to existing tools and one new tool

| Tool | Change |
|---|---|
| `get_shift_summary` | Live row for the in-progress shift. Additive per-line output fields: `in_progress` (bool), `target_to_date`, `percent_of_pace`. `status` uses pace when `in_progress`, else the full-shift percent (existing thresholds). A line stopped more than 15 minutes is `behind`. Seed-profile output is unchanged (`in_progress` false), so the old tests pass |
| `get_shift_history` | Includes the in-progress shift as the last point. Additive `in_progress` per shift. The existing test at `tests/server.test.ts:104` (2 lines per shift) stays valid on the seed |
| `check_stock` | Live `on_hand`. Additive `days_cover` (on hand divided by trailing 24 h daily use; null if no `material_log`) |
| `create_handover_note`, `list_handover_notes`, `create_follow_up`, `list_follow_ups`, `close_follow_up` | Unchanged. Still human-entered |
| `plan_container_load` | Unchanged. Not part of the story. Leave it out of the video |

New in Tier 1: **`get_live_line_status`** (read-only).

- Input: `line_id?`.
- Output per line: `line_id, name, product, state, since, minutes_in_state, reason_code, rate_per_h` (last 15 sim-minutes, from `line_state.recent_good`), `ideal_rate_per_h`, `pace_percent`, `status`, `crew`, `open_alarms[]` (`code, severity, text, raised_at`), `signals[]` (`tag, value, unit, warn_limit, trip_limit`). Also a plant roll-up: counts of lines per state.
- Answers questions 1 to 5 of section 10.2.

Total in the plant profile after Tier 1: 9 + 1 = **10 tools**.

### 9.2 Tier 2 tools (each is thin once `lineMetrics()` exists)

Write `server/metrics.ts` first: `lineMetrics(db, { lineId?, date?, shift?, now })` returns planned seconds, downtime seconds, good, reject, A, P, Q, OEE, Pareto rows, pace, target-to-date. Test it against hand-computed fixtures.

- **`get_oee`**: input `line_id?`, `shift_date?`, `shift?` (default the current shift). Output per line: `availability, performance, quality, oee` (percent, 1 decimal), loss minutes by category, `good`, `reject`, `reject_rate`, `reject_rate_15m`, `top_reject_code`, `planned_min`.
- **`explain_downtime`**: input `line_id?`, `shift_date?`, `shift?`. Output: `total_downtime_min`, `reasons[]` sorted descending (`reason_code, minutes, count, percent`), `longest`, `micro_stops` (`count, minutes`, reported separately and **not** included in the total), and `by_line[]` when no `line_id` is given.
- **`get_material_forecast`**: input `query` (same matching as `check_stock`). Output per item: `sku, name, on_hand, unit, reorder_point, status, lead_days, rate_24h` (average over the trailing 24 sim-hours from `material_log`), `rate_flat_out` (consumption if all consuming lines run at full pace), `hours_to_stockout_avg`, `hours_to_stockout_flat_out`, `hours_lead_time`, `covers_lead_time_avg`, `covers_lead_time_flat_out`, `suggested_order_qty`, `supplier`.
- **`get_shift_brief`** (stretch): notes since the last shift, open follow-ups, open alarms, top loss, low materials, and a `recommended_actions` array from fixed rules, labelled rule-based.
- Prompt **`shift_handover`** (stretch): a template that names which tools to call. It only demonstrates anything with an LLM client.

Cut: `compare_shifts`, `suggest_next_action`, a standalone `get_open_alarms` (alarms are in status and the snapshot), and elicitation (needs a client UI handler, about 1.5 h).

### 9.3 Where an LLM adds value, honestly

All the new tools are SQL and arithmetic. An LLM would only route language to tools and phrase the answer. The local `qwen3:4b-instruct` spike scored 7 correct, 1 partly wrong, 2 failed out of 10, at about 12.9 s per turn on CPU. The rule-based planner is the demo path. Make no new claims about the agent.

## 10. Planner and the 15 operator questions

### 10.1 New planner rules

Add before the generic shift rule (`shift|output|target|production|summary|lines?`). Keep first-match-wins and add one test per rule in `tests/planner.test.ts`.

| Pattern (case-insensitive) | Tool | Tier |
|---|---|---|
| `why`, `down`, `stopped`, `running`, `right now`, `temperature`, `temp`, `alarm`, `status`, optionally with `line N` | `get_live_line_status` | 1 |
| `\boee\b` or `overall equipment` | `get_oee` | 2 |
| `downtime`, `pareto`, `lost (the )?most`, `top .* reasons`, `biggest stops` | `explain_downtime` | 2 |
| `run out`, `stock ?out`, `how long will .* last`, `forecast`, `days of`. **Place before the existing stock rule**, which would otherwise route "run out of hdpe" to `check_stock` | `get_material_forecast` with the longest non-stopword as `query` | 2 |

Pitfalls found in the current planner:

- The follow-up and handover rules run first and are keyed on "follow-up", "handover", "note". Keep them first.
- The shift-summary rule matches `lines?`, which catches "line 2". That is why the new rules go before it.
- The planner makes one tool call per request. The "what did shift A leave me" beat uses `list_handover_notes`.
- Do not put "line N" inside note or follow-up titles; the planner treats it as the line id.
- `lineOf` already accepts any number, so "line 7" works with no change.

### 10.2 The 15 questions (sim time given where the answer depends on it)

Numbers are model targets, frozen after calibration. Tier 2 questions are marked.

| # | Operator says | Tool call | Expected answer |
|---|---|---|---|
| 1 | how are the lines doing right now (12:58) | `get_live_line_status {}` | Usually 6 or 7 of 7 RUN; roll-up by state; any stopped line named with its reason |
| 2 | is line 2 running | `get_live_line_status {line_id:"L2"}` | state, minutes in state, rate/h |
| 3 | why is line 2 down (13:27) | `get_live_line_status L2` | `STOP_FAULT`, `M3-HEAT-OVR`, jaw 203 °C, 4 min |
| 4 | how long has line 2 been stopped | `get_live_line_status L2` | `minutes_in_state` |
| 5 | is the sealer temperature normal (13:15) | `get_live_line_status L2` | `M3.sealer_jaw_temp_c` 192 °C, warn above 190, trip at 200 |
| 6 | what's our OEE (13:00) (Tier 2) | `get_oee {}` | L1 78.2% (A 92.4, P 86.0, Q 98.4); L2 72.9% (A 87.0, P 85.7, Q 97.8); L3 78.9% (A 93.2, P 85.2, Q 99.4); L4 to L7 in their section 6.4 bands |
| 7 | what's the reject rate on line 2 (13:20) (Tier 2) | `get_oee L2` | `reject_rate_15m` about 8.9%, top code `SEAL_BURN` |
| 8 | top downtime reasons on line 2 this shift (14:05) (Tier 2) | `explain_downtime {line_id:"L2", shift:"A"}` | total 85 min: `SEALER_FAULT` 37 (44%), `MOLD_TEMP_TRIP` 17 (20%), `UNCLASSIFIED` 16 (19%), `QUALITY_HOLD` 9 (11%), `NO_OPERATOR` 6 (7%). Micro-stops: 18 events, 15 min (separate row) |
| 9 | which line lost the most time this shift (13:00) (Tier 2) | `explain_downtime {}` | by line; L2 is among the largest |
| 10 | stock of heater band | `check_stock {query:"heater band"}` | 2 pcs, `reorder`, suggest 6, lead 14 d |
| 11 | when will we run out of HDPE (16:30) (Tier 2) | `get_material_forecast {query:"hdpe"}` | about 78 h at the 24 h average (about 230 kg/h), about 58 h flat out (about 311 kg/h), lead time 72 h, so flat-out is about 14 h short |
| 12 | shift summary for shift A (14:00) | `get_shift_summary {shift:"A"}` | plant about 5,240 of 5,470 (about 95.8%); L1 1187 (98.9%); **L2 662 (82.8%, at risk)**; L3 382 (95.5%); L4 to L7 near 96 to 101% |
| 13 | show the trend for the last 10 shifts | `get_shift_history {limit:10}` | L1 and L2 trend as seeded; last point flagged in progress |
| 14 | add handover note for line 2: sealer jaw ran hot again, tripped 13:23 | `create_handover_note` | saved with id and timestamp |
| 15 | open follow-ups | `list_follow_ups {status:"open"}` | 2 seed items plus the story items |

Worked OEE cross-check for question 6, L2 at 13:00: planned elapsed 370 min, good 623, reject 14, ideal 26 s, downtime so far 48 min. `623 × 26 / 60 / 370 = 73.0%`, matching `0.870 × 0.857 × 0.978 = 72.9%` within rounding.

Plant total for question 12 is the sum of target-weighted lines: targets 1200 + 800 + 400 + 940 + 980 + 460 + 690 = 5,470. Expected good units (capacity times baseline OEE): L1 1187, L2 662 (after the story fault), L3 382 (Tier 2 starvation; about 395 in Tier 1), L4 925, L5 945, L6 443, L7 699, total about 5,243. The plant percent adds brackets, crates, lids, panels, bundles and packs, which are different products, and L3 and L6 consume L2 output. It is a target-weighted figure inherited from the seed; do not read it aloud as a physical quantity.

## 11. Scenario: the story day (2026-10-22)

### 11.1 Mechanics

- The sim starts at **12:55 sim time** on 2026-10-22 at ×120 (1 sim hour = 30 wall seconds).
- `sim/story.json` lists **beats** with fields: `at` (sim time), `action` (a scripted effect), `hold_s` (wall seconds to pause the sim clock, default 12), `speed` (optional new speed). Scripted effects override the random model for that line at that time.
- Time-lapse: ×300 from 14:10 to 16:15, then back to ×120, with a visible `×300 TIME-LAPSE` chip.
- While held, the clock chip shows `HOLD`. The gateway keeps its WebSocket alive (heartbeat) but sends nothing new. Stdin keys as a backup: `p` toggles pause, `+` and `-` change speed.
- Tier 2: a 7-day backfill runs first at maximum speed, in-process, through `applyEvents()` (not over the network).

### 11.2 Scripted effects

| Sim time | Effect |
|---|---|
| 13:05 | L2 `M3.sealer_jaw_temp_c` starts at 181 °C and rises 1.1 °C per minute (baseline otherwise 180 ±2). L2 reject probability ramps from 2.4% to 13% by 13:23 and its codes shift to `SEAL_BURN` |
| 13:14 | Temperature 190 °C: `fault` warn `M3-TEMP-HI` |
| 13:15 | `quality_check` (webhook) `hourly_seal_peel` result `fail` on L2 |
| 13:23 | Temperature 200 °C: `fault` trip `M3-HEAT-OVR`; L2 `state_change` `RUN` to `STOP_FAULT`, reason `SEALER_FAULT` |
| 13:28 | Maintenance (Ravi) starts repair (state stays `STOP_FAULT`) |
| 13:41 to 13:49 | Background texture: L5 `STOP_OTHER`, reason `COIL_JAM`, then back to `RUN` with warm-up. Shows that not every stop is the story |
| 13:50 | Tier 2: `B23` reaches 0, L3 `state_change` to `IDLE_STARVED` |
| 13:58 | Band swapped: `material_level` (webhook) `HTR-BAND` 3 to 2. Temperature returns to baseline. `fault_clear` for both codes |
| 14:00 | `shift_end` A and `shift_start` B (crew Joel and others), both webhooks |
| 14:02 to 14:03 | L2 `RUN` again with warm-up ×1.5 decaying over 15 min. Tier 2: L3 resumes about 14:04 |
| about 16:20 | `PLY-HDPE` crosses 18,000 kg (emergent from consumption, not scripted; the seed search checks the window 16:10 to 16:30) |

L2 shift A fault downtime is about 37 minutes (13:23 to 14:00). The remaining 2 minutes fall in shift B.

### 11.3 Beat sheet for the video (2:40 target, hard limit 3:00)

| Video t | Sim | On screen | Operator action, MCP call, expected answer |
|---|---|---|---|
| 0:00 | 12:55 | Seven line cards, most `▶ RUN`; SYNTHETIC badge, clock chip, edge and MES link chips | Voiceover: "Fictional factory, about 100 people, seven lines, simulated live. Something goes wrong on Line 2 in about a minute." |
| 0:12 | 12:58 hold | | "How are the lines doing right now?" |
| 0:25 | 13:05 to 13:14 | Amber temperature signal on L2, alarm ticker, L2 reject rate climbing | Hold at 13:15: "Is the sealer temperature normal?" |
| 0:55 | 13:23 | `■ STOPPED · SEALER FAULT` on L2 in red with text and icon; status `behind` | Hold: "Why is line 2 down?" |
| 1:10 | 13:30 | | Click Listen, dictate the handover note (question 14). Then "handover notes line 2": shows the 10-21 note, the same fault two days running |
| 1:25 | 13:35 | Open follow-ups gains an item | "add follow-up: inspect sealer thermocouple, owner Ravi, due 2026-10-24, line 2" |
| 1:35 | 13:41 to 13:49 | L5 shows `COIL_JAM` for a few seconds and recovers | Voiceover only: "Not every stop is the story." Tier 2 adds OEE here: "What's our OEE on line 2?" |
| 1:55 | 14:00 | Crew chip switches to shift B (arrives by webhook) | "Shift summary for shift A" → question 12 |
| 2:05 | 14:03 | L2 restarts, cycle recovering | Tier 2: "Top downtime reasons on line 2 this shift?" |
| 2:15 | 14:10 to 16:20 | Time-lapse chip; amber `LOW · PLY-HDPE` banner when stock crosses | Tier 2: "When will we run out of HDPE?" Tier 1 fallback: "stock of hdpe" |
| 2:30 | 16:25 | | "add follow-up: order 20000 kg HDPE, owner Meena, due 2026-10-23". Tier 2: open the trace drawer for the push-notification proof shot |
| 2:40 | | Title card: `LineLedger`, repo URL, `MIT license`, `Synthetic demo data` | |

Cut from the video: container planner, local model, restart-persistence beat. Voice is a "simulated voice experience, browser speech", with the existing disclosure that Chrome sends audio to the vendor. Do not claim it works in factory noise. Say "simulated" once, early. No music. No third-party logos.

Story numbers that must hold (checked by the seed search):

- L2 shift A final good in 655 to 670 (target 662, 82.8%).
- Plant shift A good units between 94% and 97% of 5,470.
- At 12:58 at least 6 of the 7 lines are `RUN`, and L2 is `RUN`.
- HDPE crosses the reorder point between 16:10 and 16:30.
- `HTR-BAND` ends at 2 and reads `reorder`.

## 12. Build, calibrate, verify

### 12.1 Simulator internals

- `clock.ts`: `simNow()`, `speed`, `held`, `advance(dtWall)`. Loop at 10 Hz wall; each loop advances sim time by `dt × speed` and ticks the model once per sim minute crossed.
- `line.ts`: `step(minute)` returns events and mutates state. Pure given the RNG and the parameters, so the live loop and the Tier 2 backfill share it.
- `gateway.ts`: opens `ws://127.0.0.1:8787/ingest/ws`, sends `hello`, waits for `welcome`, then streams `batch` frames (flush each 1 s wall or 400 events), tracks `ack`s, keeps the outbox, reconnects with backoff and resume. A forced reconnect about once per run exercises resume.
- `mes.ts`: signs and POSTs webhooks, retries with backoff, prints a dead-letter line on exhaustion, resends about 1 in 100 deliveries on purpose.
- No DB access from the sim. It talks only to the two ingest endpoints.
- The sim prints one line per sim hour (clock, states per line, link status) and never prints the secret.

### 12.2 Tests (vitest, real HTTP like the existing ones)

- Webhook: valid signature accepted; wrong signature, missing headers and timestamp skew over 300 s all give 401; `synthetic:false` gives 400; duplicate `event_id` returns `duplicates` and does not double-count; oversize gives 413; a bad event is reported in `rejected` while the others still apply.
- WebSocket: valid hello gets `welcome`; stale or wrongly signed hello is closed with 4401; no hello within 5 s closes the socket; a batch gets an `ack`; resending the same batch gets all `duplicates`; a refused Origin gets 403 on upgrade.
- Rollup math: feed fixed events, assert pace, target-to-date and (Tier 2) A/P/Q/OEE equal hand-computed values and satisfy OEE = good × ideal / planned.
- The new tool and the pace fields against a small fed fixture; status override for a long stop.
- Determinism: run the model for one sim-day with a fixed seed twice and assert an identical event hash.
- Existing suites stay green. Run `npm run typecheck`, `npm test`, `npm run check:contrast`, `npm run build`, `npm run preflight:mcp`. Update every count quoted in docs from the actual output.

### 12.3 Calibration

1. Run the model headless for 30 sim-days with seed 1.
2. Check the section 6.4 OEE bands per line. Tune MTBF, MTTR and slowdown in `plant/plant.json` only.
3. Check daily HDPE use (about 5,400 kg) and the L2 shift A baseline good (about 730 without the scripted fault).
4. Freeze `plant.json` parameters.

### 12.4 Seed search

`npm run plant:seed-search` runs the story day headless for seeds 1 to 200 and keeps the first seed where all the predicates in section 11.3 hold. Write it into `sim/story.json` as `"seed"`. This is also the "deterministic with a seed" claim: the same seed gives the same day every time.

### 12.5 UI

Existing design tokens only, so `npm run check:contrast` stays valid (no new colour pairs). State is always text plus icon, never colour alone (existing accessibility rule). `web/src/main.ts` has not been read; check how it renders the line cards first.

Tier 1:

- Seven compact line cards in a grid (two columns of cards plus the existing hero is not enough room for 7; use a compact row or grid of small cards: name, product, state text with icon, minutes in state, pace percent, produced against target-to-date).
- State icons and text: `▶ RUN`, `⏸ PLANNED STOP`, `■ STOPPED`, `◐ WAITING`. Andon colours map to the existing success, warning and danger tokens.
- Top-bar chips: `SIM CLOCK 13:15 ×120` (with `HOLD` or `TIME-LAPSE ×300` when applicable), `EDGE LINK UP/DOWN`, `MES LINK UP/DOWN · stale since hh:mm`.
- Alarm ticker: the last five alarms with sim time, severity text and code.
- The existing "SYNTHETIC DEMO DATA" badge stays visible.

Tier 2: a floor tile with station chips per line, an `!` on the faulted station with the code text, the `B23` bar with `25/40` text, shown next to the existing MCP trace tile so both are visible at once.

### 12.6 Definition of done per checkpoint (Tier 1)

| CP | Done when |
|---|---|
| 0 | `LINELEDGER_PLANT=1 npm run dev:plant` serves the nine tools and 7 lines; `npm test` green on the seed |
| 1 | A signed `curl` webhook batch changes `get_shift_summary`; webhook tests green |
| 2 | A scripted WebSocket client (or `websocat`-style test) gets `welcome` and `ack`; WS tests green |
| 3 | `npm run sim` makes all seven lines move with noisy numbers over both channels |
| 4 | `get_live_line_status` and the pace fields answer questions 1 to 5, 10, 12 and 14 to 15 through the chat |
| 5 | Seven cards, badges, chips visible; story runs end to end once |

## 13. Build order

### 13.1 Tier 1 in 120 minutes with two people

Shared work first, then split. Both people agree `plant/plant.json` and the event schema (section 7.4) in the first ten minutes. Changing either later costs both people time.

| Min | Person A (server) | Person B (sim and UI) |
|---|---|---|
| 0 to 10 | Together: branch `feat/sim-plant`, `plant/plant.json` with the 7 lines and 5 SKUs, plant profile flag and loader, `plant:init` | Together |
| 10 to 40 | `applyEvents()`, webhook route, HMAC, zod union, idempotency, `shift_output` and `line_state` effects, 3 tests (CP1) | Sim core: RNG, clock, 7 line state machines, event builders, per-source seq |
| 40 to 70 | WebSocket route with `ws`, hello auth, ack, heartbeat, Origin check, 3 tests (CP2). Fallback trigger at minute 70 | `sim/mes.ts` webhook client with retry; `sim/gateway.ts` WebSocket client with outbox and resume (CP3) |
| 70 to 95 | `get_live_line_status`, pace fields, `days_cover`, `/api/plant/snapshot`, planner rules and tests | `story.json`, scripted L2 and L5 effects, holds, time-lapse; seed search script |
| 95 to 120 | Integration, fix, rerun all checks | UI: seven cards, badges, chips, alarm ticker, 2 s polling (CP4, CP5); one rehearsal |

If the WebSocket channel is not working by minute 70, use `--telemetry webhook` and move on.

A single person needs about 3.5 hours for Tier 1: ingest 1.0 h, WebSocket 0.5 h, sim 1.0 h, tool and planner 0.5 h, UI 0.5 h.

### 13.2 Tier 2 (in this order, only if time remains)

1. Stateful MCP and subscription push (about 1.25 h), hard stop. Fall back to polling.
2. `lineMetrics()` plus `get_oee`, `explain_downtime`, `get_material_forecast` (about 1.5 h).
3. Floor tile and `B23` coupling (about 0.75 h).
4. 7-day backfill, PLC register layer, MES reconciliation, staged outage with replay.

### 13.3 After the build (not part of the 2 hours)

Video recording, README, Devpost text, video script, full check run, submission. See sections 15 and 16. Keep at least 3.5 hours for these.

## 14. Risks, and what could look fake on camera

| Risk | Mitigation |
|---|---|
| Two transports plus seven lines in 2 hours is tight | `--telemetry webhook` fallback; cut Tier 2; two people |
| Numbers look too clean or too perfect | Noise parameters, `UNCLASSIFIED` downtime, OEE in the 70s, never 85, and do not suppress random stops |
| Time-lapse looks like a cheat | `×300 TIME-LAPSE` chip on screen, said in the voiceover |
| Holds feel staged | Rehearse once; holds are 12 s and the chip says `HOLD` |
| Plant percent adds different products and double-counts crates | Do not read it aloud as a physical quantity; label it target-weighted |
| WebSocket library or upgrade handling problems | Webhook-only fallback; test the upgrade path with a plain Node client |
| `ws` is a new dependency | Add it explicitly, check its licence, run `npm audit`, update the Devpost "0 vulnerabilities" claim from the real result |
| Dashboard polling hides a stale sim | Link chips and the age of the last event are always visible |
| Tier 2 session loss on server restart | Re-init handler; do not restart on camera |
| Trace drawer floods with notifications (Tier 2) | 2 s throttle, buffer 2000 |
| Mid-shift status wrong | Additive pace fields (section 9.1) |
| Contrast regressions | Existing tokens only; rerun `npm run check:contrast` |
| Claims drift from the code | Section 16, update in the same change |
| People read "open source stack" as a claim we used it | Section 2.3 says plainly that it is a mapping only |

## 15. Verification before submitting

Run and record real output; never quote a number from this document as a result.

1. `npm run typecheck`, `npm test`, `npm run check:contrast`, `npm run build`, `npm run preflight:mcp`, `npm audit`.
2. Fresh clone: `npm install`, `npm run plant:init`, `npm run dev:plant`, `npm run dev:web`, `npm run sim`. Confirm seven lines move and the links show up.
3. Run the story once start to finish with `--no-hold` off and check the story numbers (section 11.3).
4. Confirm `data/.ingest-secret` is not tracked (`git status`) and no secret appears in logs or the repo.
5. Confirm `packages/` is not committed unless intended.

## 16. Claims that must change (README, Devpost text, video script)

### 16.1 `README.md`

- Replace "Nothing is connected to a real factory, real inventory or real customers. The project does not monitor live equipment." with: "All plant data comes from a seeded simulator that plays a fictional factory, Tarnby Works. It sends machine telemetry over a WebSocket and business events as signed webhooks, the way an edge gateway and an MES would. Nothing is connected to a real factory, PLC, inventory or customer. LineLedger reads and reports and never controls equipment."
- Add the new run instructions (`plant:init`, `dev:plant`, `sim`), the env vars, and the new dependency `ws`.
- "Nine tools" becomes ten after Tier 1, thirteen after Tier 2. Update the MCP evidence table row for `server/tools.ts`.
- Architecture diagram: add the simulator, the two ingest endpoints, the rollups and the snapshot endpoint.
- Keep "no paid service, no cloud account, no credentials in the repository" (still true: the ingest secret is generated locally and git-ignored).
- **Only if Tier 2 stateful ships:** replace the "Transport behaviour" paragraph ("stateless Streamable HTTP, `GET` and `DELETE` on `/mcp` return 405 with `Allow: POST`") with stateful sessions identified by `Mcp-Session-Id`, GET stream, DELETE, session cap and idle timeout, and update the `server/app.ts` row ("per POST") to per session. Otherwise leave the stateless wording alone.
- Update the verification counts from real output.

### 16.2 `docs/devpost-text.md`

- Replace the bullet "The project does not monitor live equipment" with: "The project monitors a simulated plant only. No real PLC, OPC UA, Modbus or MQTT integration was built or tested; the WebSocket and signed-webhook ingest contract is the integration boundary."
- Add to the data disclosure: data is generated by a seeded simulator for a fictional company with seven lines and a simulated clock (×120, with a ×300 time-lapse segment).
- Add one or two sentences on the two ingest channels, HMAC signing, idempotent event ids and resume, and their limits (loopback, shared secret, no TLS).
- Update "Nine tools" and "one of eight chat tools" to the real counts. Update "What was tested" (21 tests, 194 contrast pairs, agent tests) from real runs. Update the "0 vulnerabilities" claim after `npm audit` with `ws` added.
- Do not mention Node-RED, Mosquitto, OPC UA libraries or any other project as used. Section 2.3 is a mapping, not an integration claim.
- **Only if Tier 2 stateful ships:** rewrite the feature bullet "stateless Streamable HTTP" and "How it works" step 4 ("each POST creates a new server and transport, state lives in SQLite, not in MCP sessions") for stateful sessions with resource subscriptions, and mention the trace panel showing server-pushed notifications.
- Keep the Alexa+ wording: a simulated voice experience in a web app, not an Alexa+ skill.

### 16.3 `docs/video-script.md`

- Replace the shot list with section 11.3.
- "Always visible" adds the sim-clock chip and the two link chips.
- Remove the restart-persistence beat and the "Line 2 flagged behind" and "follow-up id 3" notes.
- "No live factory data" becomes "no real factory data; the data stream is simulated".
- Keep the rules: say "simulated" early, no music, no third-party logos, synthetic badge on screen all the time.

### 16.4 Other docs

- `docs/implementation-decisions.md`: add D-LINES, D-TRANSPORT, D-FALLBACK-WS, D-PROFILE, D-CLOCK, D-POLL from section 3. Reverse D2 (stateless) only if Tier 2 stateful ships.
- `docs/ui-spec.md`: add the seven-card layout, the clock and link chips, and the alarm ticker; add "Plant cards: loading, live, held, link down, error" to the component state table.

## 17. Likely judge questions, short best answers

- **Why both WebSocket and webhooks?** They are different jobs. The edge gateway streams high-rate machine telemetry outward over a persistent connection with acknowledgements and resume. The MES and ERP send authoritative business events as signed, retried webhooks. Each has its own source and sequence.
- **Are WebSocket and webhook what plants really use?** Plants typically speak OPC UA or Modbus to the machines, and often MQTT or Sparkplug B from the gateway to the cloud. Our WebSocket hop stands in for that bridge. No real PLC integration was built or tested.
- **Ingest security?** HMAC-SHA256 over timestamp plus body for webhooks, an HMAC-signed hello with a 300-second skew limit for the WebSocket, Origin check on upgrade, size limits, idempotent event ids, loopback binding, and a rule that rejects anything not marked synthetic. Limits: shared secret, no TLS, demo scale.
- **Why MCP and not just a dashboard?** The same tools serve a voice assistant, a chat client and an agent, and the trace shows the real protocol traffic. (If Tier 2 ships: the server pushes a notification with no request, and the client reads the resource in response.)
- **What happens with a real PLC?** An edge gateway would translate OPC UA or Modbus into this event format. The server never writes back, so it cannot control equipment.
- **Cost?** Zero. One laptop, no cloud account, no paid API.
- **Alexa+ relevance?** It is a simulated voice experience in a browser, not an Alexa+ skill. It prototypes the questions a plant manager would ask by voice and the answers an assistant could read back.
- **Is that real data?** No. It is a seeded simulation of a fictional company, labelled on screen, reproducible from the seed.

## 18. Files the teammate must read before coding

1. `server/app.ts` (guards, trace tap, route order: the webhook must mount before `express.json`) and `server/trace.ts`
2. `server/main.ts` (env handling, `listen`; the WebSocket server attaches here)
3. `server/tools.ts` (registration pattern, `ok` and `fail` helpers, `READ` and `WRITE` annotations)
4. `server/db.ts` (schema, seed, `openDb`, `seedHistory`)
5. `tests/server.test.ts` (harness `start(db)`, `connect`, `call`)
6. `web/src/planner.ts`, `web/src/mcp.ts`, `web/src/main.ts`
7. `docs/ui-spec.md` (tokens, accessibility rules, layout)
8. `docs/implementation-decisions.md` (not read during the brainstorm)
