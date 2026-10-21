import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { openDb, type Db } from '../server/db.js'
import { TraceTap } from '../server/trace.js'

const ORIGIN = 'http://localhost:5173'
let http: Server
let db: Db
let trace: TraceTap
let url: string
const clients: Client[] = []

async function start(database: Db) {
  trace = new TraceTap()
  const app = createApp({ db: database, trace, allowedOrigins: [ORIGIN] })
  http = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
}

async function connect() {
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`))
  await client.connect(transport)
  clients.push(client)
  return { client, transport }
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    structuredContent?: Record<string, any>
    content: { type: string; text: string }[]
  }

beforeEach(async () => {
  db = openDb()
  await start(db)
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  http.close()
  db.close()
})

describe('protocol', () => {
  it('negotiates 2025-11-25 and lists every tool with an output schema', async () => {
    const { client, transport } = await connect()
    expect(transport.protocolVersion).toBe('2025-11-25')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_stock',
      'close_follow_up',
      'create_follow_up',
      'create_handover_note',
      'get_shift_summary',
      'list_follow_ups',
      'list_handover_notes',
      'plan_container_load',
    ])
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined()
  })

  it('returns 405 on GET and DELETE /mcp', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${url}/mcp`, { method })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })
})

describe('tools', () => {
  it('summarises the latest shift per line', async () => {
    const { client } = await connect()
    const r = await call(client, 'get_shift_summary')
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ shift_date: '2026-10-21', shift: 'B' })
    const lines = r.structuredContent!.lines
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ line_id: 'L1', produced_units: 1002, percent_of_target: 83.5, status: 'at_risk' })
    expect(lines[1]).toMatchObject({ line_id: 'L2', status: 'behind' })
    const a = await call(client, 'get_shift_summary', { shift: 'A' })
    expect(a.structuredContent!.lines[0].status).toBe('on_track')
    const none = await call(client, 'get_shift_summary', { shift_date: '2020-01-01' })
    expect(none.isError).toBe(true)
  })

  it('creates and lists handover notes, newest first, filters by line, honours limit', async () => {
    const { client } = await connect()
    const first = await call(client, 'create_handover_note', { author: 'Test', text: 'Belt tension low', line_id: 'L1' })
    const second = await call(client, 'create_handover_note', { author: 'Test', text: 'Guard re-fitted', line_id: 'L1' })
    expect(first.structuredContent).toMatchObject({ author: 'Test', line_id: 'L1' })
    // created_at is the wall clock, so order is asserted between the two new notes only
    const l1 = (await call(client, 'list_handover_notes', { line_id: 'L1' })).structuredContent!.notes as { id: number; line_id: string }[]
    const ids = l1.map((n) => n.id)
    expect(ids.indexOf(second.structuredContent!.id)).toBeLessThan(ids.indexOf(first.structuredContent!.id))
    expect(l1.every((n) => n.line_id === 'L1')).toBe(true)
    expect(l1).toHaveLength(3) // 1 seeded + 2 new
    const l2 = (await call(client, 'list_handover_notes', { line_id: 'L2' })).structuredContent!.notes as { line_id: string }[]
    expect(l2).toHaveLength(1)
    expect(l2[0]!.line_id).toBe('L2')
    expect((await call(client, 'list_handover_notes', { limit: 1 })).structuredContent!.notes).toHaveLength(1)
    expect((await call(client, 'list_handover_notes', { limit: 0 })).isError).toBe(true)
    expect((await call(client, 'list_handover_notes', { limit: 51 })).isError).toBe(true)
  })

  it('persists handover notes in a SQLite file across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lineledger-'))
    try {
      const file = join(dir, 'test.sqlite')
      const first = openDb(file)
      http.close()
      await start(first)
      const { client } = await connect()
      await call(client, 'create_handover_note', { author: 'Test', text: 'Persist me' })
      await client.close()
      clients.length = 0
      http.close()
      first.close()

      const second = openDb(file)
      await start(second)
      const again = await connect()
      const notes = (await call(again.client, 'list_handover_notes', { limit: 50 })).structuredContent!.notes
      expect(notes.some((n: { text: string }) => n.text === 'Persist me')).toBe(true)
      expect(notes).toHaveLength(3) // 2 seeded once, not reseeded, plus the new one
      await again.client.close()
      clients.length = 0
      http.close()
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    db = openDb() // afterEach closes it
    await start(db)
  })

  it('creates, lists and closes follow-ups', async () => {
    const { client } = await connect()
    const open = await call(client, 'list_follow_ups')
    expect(open.structuredContent!.follow_ups).toHaveLength(2)
    const created = await call(client, 'create_follow_up', { title: 'Check guard', owner: 'Ravi', due_date: '2026-10-22', line_id: 'L1' })
    const id = created.structuredContent!.id as number
    expect(created.structuredContent!.status).toBe('open')
    const closed = await call(client, 'close_follow_up', { id })
    expect(closed.structuredContent).toMatchObject({ id, status: 'closed' })
    expect(closed.structuredContent!.closed_at).toBeTruthy()
    expect((await call(client, 'list_follow_ups')).structuredContent!.follow_ups).toHaveLength(2)
    expect((await call(client, 'list_follow_ups', { status: 'all' })).structuredContent!.follow_ups).toHaveLength(3)
    expect((await call(client, 'close_follow_up', { id })).isError).toBe(true)
    expect((await call(client, 'close_follow_up', { id: 9999 })).isError).toBe(true)
  })

  it('checks stock and suggests an order quantity', async () => {
    const { client } = await connect()
    const hdpe = (await call(client, 'check_stock', { query: 'hdpe' })).structuredContent!.items
    expect(hdpe[0]).toMatchObject({ sku: 'PLY-HDPE', status: 'reorder', suggested_order_qty: 2500 })
    const band = (await call(client, 'check_stock', { query: 'HEATER' })).structuredContent!.items
    expect(band[0]).toMatchObject({ status: 'out_of_stock' })
    const steel = (await call(client, 'check_stock', { query: 'steel' })).structuredContent!.items
    expect(steel[0]).toMatchObject({ status: 'ok', suggested_order_qty: 0 })
    db.prepare("UPDATE stock_items SET on_hand = reorder_point WHERE sku = 'LBL-ROLL'").run()
    const edge = (await call(client, 'check_stock', { query: 'label' })).structuredContent!.items
    expect(edge[0]).toMatchObject({ status: 'reorder', suggested_order_qty: 60 }) // on_hand == reorder_point reorders
    expect((await call(client, 'check_stock', { query: 'nothing-like-this' })).structuredContent!.items).toEqual([])
  })

  it('returns isError with a useful message for invalid input and unknown references', async () => {
    const { client } = await connect()
    const text = (r: Awaited<ReturnType<typeof call>>) => r.content[0]!.text
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['create_handover_note', { author: 'X', text: '' }, /text/i],
      ['create_handover_note', { author: 'X', text: '   ' }, /text/i],
      ['create_handover_note', { author: 'X', text: 'y'.repeat(501) }, /text/i],
      ['create_handover_note', { author: 'a'.repeat(61), text: 'ok' }, /author/i],
      ['create_handover_note', { author: 'X', text: 'ok', line_id: 'L99' }, /Unknown line "L99"/],
      ['create_follow_up', { title: 't', owner: 'o', line_id: 'L99' }, /Unknown line "L99"/],
      ['get_shift_summary', { shift: 'Z' }, /shift/i],
      ['create_follow_up', { title: 't', owner: 'o', due_date: 'tomorrow' }, /due_date/i],
    ]
    for (const [tool, args, pattern] of cases) {
      const r = await call(client, tool, args)
      expect(r.isError, tool).toBe(true)
      expect(text(r), tool).toMatch(pattern)
    }
    // nothing was written by the rejected calls
    expect((await call(client, 'list_handover_notes', { limit: 50 })).structuredContent!.notes).toHaveLength(2)
    expect((await call(client, 'list_follow_ups', { status: 'all' })).structuredContent!.follow_ups).toHaveLength(2)
  })

  it('applies the status thresholds and shift_date-only lookups', async () => {
    db.prepare("INSERT INTO shift_output VALUES ('L1', '2026-10-22', 'A', 1000, 950, 0)").run() // exactly 95.0
    db.prepare("INSERT INTO shift_output VALUES ('L2', '2026-10-22', 'A', 1000, 949, 0)").run() // 94.9
    db.prepare("INSERT INTO shift_output VALUES ('L1', '2026-10-23', 'A', 1000, 800, 0)").run() // exactly 80.0
    db.prepare("INSERT INTO shift_output VALUES ('L2', '2026-10-23', 'A', 1000, 799, 0)").run() // 79.9
    const { client } = await connect()
    const a = (await call(client, 'get_shift_summary', { shift_date: '2026-10-22' })).structuredContent!.lines
    expect([a[0].status, a[1].status]).toEqual(['on_track', 'at_risk'])
    const b = (await call(client, 'get_shift_summary', { shift_date: '2026-10-23' })).structuredContent!.lines
    expect([b[0].status, b[1].status]).toEqual(['at_risk', 'behind'])
    expect((await call(client, 'get_shift_summary')).structuredContent!.shift_date).toBe('2026-10-23') // default = latest
  })

  it('plans a container load with the standalone planner package', async () => {
    const { client } = await connect()
    const container = { length: 5898, width: 2352, height: 2393, maxPayloadKg: 26000 }
    const item = { length: 600, width: 400, height: 300, weightKg: 12 }
    const r = await call(client, 'plan_container_load', { container, item })
    expect(r.isError).toBeFalsy()
    // 600x400 footprint: 9 x 5 or 14 x 5 style grids; assert the invariants instead of a magic number
    const d = r.structuredContent!
    expect(d.count).toBe(Math.min(d.geometricCount, d.payloadCount))
    expect(d.grid.along * d.grid.across * d.grid.layers).toBe(d.geometricCount)
    expect(d.count).toBeGreaterThan(100)
    expect(d.totalWeightKg).toBe(d.count * 12)
    // payload-limited case
    const heavy = await call(client, 'plan_container_load', { container, item: { ...item, weightKg: 500 } })
    expect(heavy.structuredContent).toMatchObject({ limitedBy: 'payload', count: 52 })
    // invalid input is rejected by the zod schema and reported as isError
    for (const bad of [{ ...item, weightKg: -1 }, { ...item, length: 0 }]) {
      const r2 = await call(client, 'plan_container_load', { container, item: bad })
      expect(r2.isError).toBe(true)
    }
  })
})

describe('http hardening', () => {
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  })
  const post = (headers: Record<string, string>, body: string) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body,
    })

  it('rejects a foreign Origin, accepts the allowed Origin and no Origin', async () => {
    expect((await post({ origin: 'http://evil.example' }, initBody)).status).toBe(403)
    expect((await post({ origin: ORIGIN }, initBody)).status).toBe(200)
    expect((await post({}, initBody)).status).toBe(200)
  })

  it('rejects a foreign Host header', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const port = (http.address() as AddressInfo).port
      const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(initBody)
    })
    expect(status).toBe(403)
  })

  it('rejects oversize bodies, bad JSON and non-JSON content types', async () => {
    expect((await post({}, JSON.stringify({ pad: 'x'.repeat(70_000) }))).status).toBe(413)
    expect((await post({}, '{not json')).status).toBe(400)
    const text = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' }, body: 'x'.repeat(70_000) })
    expect(text.status).toBeGreaterThanOrEqual(400)
    expect(text.status).toBeLessThan(500)
  })
})

describe('trace tap', () => {
  it('records JSON-RPC in and out for a real tool call', async () => {
    const { client } = await connect()
    await call(client, 'check_stock', { query: 'steel' })
    const { entries } = (await (await fetch(`${url}/api/trace`)).json()) as { entries: { id: number; dir: string; message: any }[] }
    const methods = entries.filter((e) => e.dir === 'in').map((e) => e.message.method)
    expect(methods).toContain('initialize')
    expect(methods).toContain('tools/call')
    const out = entries.find((e) => e.dir === 'out' && e.message.result?.structuredContent?.items)
    expect(out).toBeDefined()
    const later = (await (await fetch(`${url}/api/trace?since=${entries.at(-1)!.id}`)).json()) as { entries: unknown[] }
    expect(later.entries).toEqual([])
  })
})
