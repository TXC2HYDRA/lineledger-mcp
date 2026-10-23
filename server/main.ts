import { createApp } from './app.js'
import { openDb } from './db.js'

const port = Number(process.env.PORT ?? 8787)
const webPort = Number(process.env.WEB_PORT ?? 5173)
const defaults = [port, webPort].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])
const allowedOrigins = process.env.LINELEDGER_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) ?? defaults

const db = openDb(process.env.LINELEDGER_DB ?? 'data/lineledger.sqlite')
// Bind to loopback only.
const stateful = process.env.LINELEDGER_STATEFUL === '1'
createApp({ db, allowedOrigins, stateful }).listen(port, '127.0.0.1', () => {
  console.log(`LineLedger MCP server (synthetic demo data, ${stateful ? 'stateful sessions' : 'stateless'}) on http://127.0.0.1:${port}/mcp`)
})
