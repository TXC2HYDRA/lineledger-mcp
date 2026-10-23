/// <reference lib="dom" />
// Stateful mode (LINELEDGER_STATEFUL=1): sessions, change notices on the GET stream, and recovery after a restart.
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpConnection } from '../web/src/mcp.js'
import { createApp } from '../server/app.js'
import { SqliteStore } from '../server/store-sqlite.js'
import type { Store } from '../server/store.js'

const ORIGIN = 'http://localhost:5173'
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
}

let store: Store
let http: Server
let url: string
const clients: Client[] = []
const connections: McpConnection[] = []

const listen = (port = 0) =>
  new Promise<Server>((resolve) => {
    const s = createApp({ store, allowedOrigins: [ORIGIN], stateful: true }).listen(port, '127.0.0.1', () => resolve(s))
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  store = SqliteStore.open()
  http = await listen()
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})
afterEach(async () => {
  await Promise.all([...clients.splice(0).map((c) => c.close()), ...connections.splice(0).map((c) => c.close())])
  http.closeAllConnections()
  http.close()
  await store.close()
})

async function connect() {
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`))
  await client.connect(transport)
  clients.push(client)
  return { client, transport }
}

describe('stateful sessions', () => {
  it('issues a session id on initialize and serves tools within it', async () => {
    const { client, transport } = await connect()
    expect(transport.protocolVersion).toBe('2025-11-25')
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await client.listTools()).tools).toHaveLength(9)
    const health = await (await fetch(`${url}/api/health`)).json()
    expect(health).toMatchObject({ stateful: true, sessions: 1 })
  })

  it('rejects a missing or unknown session, and a request after DELETE', async () => {
    const noSession = await fetch(`${url}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
    expect(noSession.status).toBe(400)
    const unknown = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...HEADERS, 'mcp-session-id': 'nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
    expect(unknown.status).toBe(404)
    expect((await fetch(`${url}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } })).status).toBe(400)

    const init = await fetch(`${url}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify(INIT) })
    const id = init.headers.get('mcp-session-id')!
    await init.text()
    expect(id).toBeTruthy()
    const del = await fetch(`${url}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': id } })
    expect(del.status).toBe(200)
    const after = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...HEADERS, 'mcp-session-id': id }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) })
    expect(after.status).toBe(404)
    expect((await (await fetch(`${url}/api/health`)).json()).sessions).toBe(0)
  })

  it('keeps the Origin check and the body limit', async () => {
    const badOrigin = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...HEADERS, origin: 'http://evil.example' }, body: JSON.stringify(INIT) })
    expect(badOrigin.status).toBe(403)
    const big = await fetch(`${url}/mcp`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ pad: 'a'.repeat(70_000) }) })
    expect(big.status).toBe(413)
  })

  it('pushes a data_changed notice to another session when a note or follow-up is written', async () => {
    const watcher = await connect()
    const seen: { event: string; resource: string }[] = []
    watcher.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      seen.push(n.params.data as { event: string; resource: string })
    })
    const writer = await connect()
    await sleep(300) // let the watcher's GET stream open
    await writer.client.callTool({ name: 'create_follow_up', arguments: { title: 'Recheck guard', owner: 'Ravi' } })
    await writer.client.callTool({ name: 'create_handover_note', arguments: { author: 'Test', text: 'Belt tension low' } })
    await writer.client.callTool({ name: 'list_follow_ups', arguments: {} }) // a read pushes nothing
    for (let i = 0; i < 30 && seen.length < 2; i++) await sleep(100)
    expect(seen).toEqual([
      { event: 'data_changed', resource: 'follow_ups' },
      { event: 'data_changed', resource: 'handover_notes' },
    ])
  })

  it('the web client recovers from a 404 for a session the server dropped', async () => {
    const conn = new McpConnection()
    connections.push(conn)
    let reconnects = 0
    conn.onReconnect = () => reconnects++
    await conn.connect(url)
    const first = conn.sessionId!
    // Drop the session on the server only: the next call gets a plain 404 on a healthy socket.
    expect((await fetch(`${url}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': first } })).status).toBe(200)
    // Two calls at once must share one reconnect.
    const [a, b] = await Promise.all([conn.call('list_follow_ups', {}), conn.call('list_handover_notes', {})])
    expect(a.isError).toBeFalsy()
    expect(b.isError).toBeFalsy()
    expect(reconnects).toBe(1)
    expect(conn.sessionId).not.toBe(first)
  })

  it('the web client reconnects after a server restart and the data survives', async () => {
    const conn = new McpConnection()
    connections.push(conn)
    let reconnects = 0
    conn.onReconnect = () => reconnects++
    await conn.connect(url)
    const first = conn.sessionId
    expect(first).toBeTruthy()
    await conn.call('create_follow_up', { title: 'Survives restart', owner: 'Meena' })

    // Restart: same port, same database, all sessions gone.
    const port = (http.address() as AddressInfo).port
    http.closeAllConnections()
    await new Promise((r) => http.close(r))
    http = await listen(port)

    const after = await conn.call('list_follow_ups', {})
    expect(after.isError).toBeFalsy()
    expect(JSON.stringify(after.structuredContent)).toContain('Survives restart')
    expect(reconnects).toBe(1)
    expect(conn.sessionId).toBeTruthy()
    expect(conn.sessionId).not.toBe(first)
  })
})
