/// <reference lib="dom" />
// The browser client must keep working against the default (stateless) server: no session, no reconnect.
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { McpConnection } from '../web/src/mcp.js'
import { createApp } from '../server/app.js'
import { SqliteStore } from '../server/store-sqlite.js'
import type { Store } from '../server/store.js'

let store: Store
let http: Server
beforeEach(async () => {
  store = SqliteStore.open()
  http = await new Promise<Server>((resolve) => {
    const s = createApp({ store, allowedOrigins: [] }).listen(0, '127.0.0.1', () => resolve(s))
  })
})
afterEach(async () => {
  http.close()
  await store.close()
})

it('connects and calls tools with no session id against the stateless server', async () => {
  const conn = new McpConnection()
  let reconnects = 0
  conn.onReconnect = () => reconnects++
  await conn.connect(`http://127.0.0.1:${(http.address() as AddressInfo).port}`)
  expect(conn.protocolVersion).toBe('2025-11-25')
  expect(conn.sessionId).toBeUndefined()
  expect((await conn.listTools()).length).toBe(9)
  const r = await conn.call('get_shift_summary', {})
  expect(r.isError).toBeFalsy()
  expect(reconnects).toBe(0)
  await conn.close()
})
