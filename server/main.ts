import { createApp, type McpMode } from './app.js'
import { FactorySim } from './sim.js'
import { openStore } from './store.js'

const port = Number(process.env.PORT ?? 8787)
const webPort = Number(process.env.WEB_PORT ?? 5173)
const defaults = [port, webPort].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])
const allowedOrigins = process.env.LINELEDGER_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) ?? defaults

const mode = (process.env.LINELEDGER_MCP_MODE ?? 'stateful').trim().toLowerCase() as McpMode
if (mode !== 'stateful' && mode !== 'stateless') throw new Error(`LINELEDGER_MCP_MODE must be stateful or stateless, got "${mode}"`)

// LINELEDGER_STORE=sqlite (default, LINELEDGER_DB file) or dynamodb (see server/store-dynamodb.ts).
const store = await openStore(process.env)

// Production-line simulation: on by default. LINELEDGER_SIM=off disables it.
// LINELEDGER_SIM_SPEED: simulated seconds per real second (default 60, so one 8-hour shift takes 8 minutes).
let sim: FactorySim | undefined
if ((process.env.LINELEDGER_SIM ?? 'on').trim().toLowerCase() !== 'off') {
  const speed = Number(process.env.LINELEDGER_SIM_SPEED ?? 60)
  if (!Number.isFinite(speed) || speed <= 0 || speed > 3600) throw new Error('LINELEDGER_SIM_SPEED must be a number from 0 to 3600')
  const faults = process.env.LINELEDGER_SIM_FAULTS === 'off' ? 'off' : 'random'
  sim = await FactorySim.create(store, { faults, seed: Number(process.env.LINELEDGER_SIM_SEED ?? 20261022) })
  sim.start({ speed })
}

const app = createApp({ store, sim, allowedOrigins, mode })
// Bind to loopback only.
const http = app.listen(port, '127.0.0.1', () => {
  const simText = sim ? `simulation on (x${process.env.LINELEDGER_SIM_SPEED ?? 60})` : 'simulation off'
  console.log(`LineLedger MCP server (synthetic demo data, store: ${store.kind}, ${mode}, ${simText}) on http://127.0.0.1:${port}/mcp`)
})

// Save the simulation's stock levels and close MCP sessions before exit.
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1)
    stopping = true
    sim?.stop()
    void (async () => {
      await sim?.flushNow().catch(() => undefined)
      await app.sessions.closeAll()
      http.close()
      await store.close()
      process.exit(0)
    })()
  })
}
