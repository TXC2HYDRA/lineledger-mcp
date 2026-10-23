import { createApp } from './app.js'
import { openNotifier } from './notify.js'
import { openStore } from './store.js'

const port = Number(process.env.PORT ?? 8787)
const webPort = Number(process.env.WEB_PORT ?? 5173)
const defaults = [port, webPort].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])
const allowedOrigins = process.env.LINELEDGER_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) ?? defaults

// LINELEDGER_STORE=sqlite (default, LINELEDGER_DB file) or dynamodb (see server/store-dynamodb.ts).
const store = await openStore(process.env)
// LINELEDGER_NOTIFY=none (default) or sns (see server/notify.ts).
const notifier = openNotifier(process.env)
// Bind to loopback only.
createApp({ store, notifier, allowedOrigins }).listen(port, '127.0.0.1', () => {
  console.log(`LineLedger MCP server (synthetic demo data, store: ${store.kind}, alerts: ${notifier.kind}) on http://127.0.0.1:${port}/mcp`)
})
