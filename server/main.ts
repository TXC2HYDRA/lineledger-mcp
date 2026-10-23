import { createApp, type McpMode } from './app.js'
import { applyPlantSeed } from './plant.js'
import { FactorySim } from './sim.js'
import { openStore } from './store.js'
import { SqliteStore } from './store-sqlite.js'

const port = Number(process.env.PORT ?? 8787)
const webPort = Number(process.env.WEB_PORT ?? 5173)
const defaults = [port, webPort].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])
const allowedOrigins = process.env.LINELEDGER_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) ?? defaults

const mode = (process.env.LINELEDGER_MCP_MODE ?? 'stateful').trim().toLowerCase() as McpMode
if (mode !== 'stateful' && mode !== 'stateless') throw new Error(`LINELEDGER_MCP_MODE must be stateful or stateless, got "${mode}"`)

// Plant profile (LINELEDGER_PLANT=1): the Tarnby Works simulation with seven lines, in its own SQLite file by
// default. Without it the server keeps the small two-line seed and no simulation (the tests use that profile).
const plant = process.env.LINELEDGER_PLANT === '1'
if (plant && !process.env.LINELEDGER_DB) process.env.LINELEDGER_DB = 'data/plant.sqlite'

// LINELEDGER_STORE=sqlite (default, LINELEDGER_DB file) or dynamodb (see server/store-dynamodb.ts).
const store = await openStore(process.env)

let sim: FactorySim | undefined
if (plant) {
  // A fresh plant store gets a week of simulated shifts first. An older plant database loses the two-line demo rows
  // it was made with, and gets the same week.
  const fresh = await applyPlantSeed(store)
  const dropped = store instanceof SqliteStore && store.dropDemoSeed()
  if (fresh || dropped) await FactorySim.history(store)
  // LINELEDGER_SIM_SPEED: simulated seconds per real second (default 120: one simulated hour in 30 seconds).
  const speed = Number(process.env.LINELEDGER_SIM_SPEED ?? 120)
  if (!Number.isFinite(speed) || speed <= 0 || speed > 3600) throw new Error('LINELEDGER_SIM_SPEED must be a number from 0 to 3600')
  sim = await FactorySim.create(store, {
    faults: process.env.LINELEDGER_SIM_FAULTS === 'off' ? 'off' : 'random',
    story: process.env.LINELEDGER_SIM_STORY !== 'off',
    ...(process.env.LINELEDGER_SIM_SEED && { seed: Number(process.env.LINELEDGER_SIM_SEED) }),
  })
  sim.start({ speed, holds: process.env.LINELEDGER_SIM_HOLDS === 'on' })
}

const app = createApp({ store, sim, allowedOrigins, mode })
// Bind to loopback only.
const http = app.listen(port, '127.0.0.1', () => {
  const simText = sim ? `Tarnby Works plant simulation, sim clock ${sim.snapshot().sim_clock.sim_now}` : 'seed data, no simulation'
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
