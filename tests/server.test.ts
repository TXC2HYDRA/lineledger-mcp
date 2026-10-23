import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppOptions } from '../server/app.js'
import { applyPlantSeed } from '../server/plant.js'
import { FactorySim } from '../server/sim.js'
import type { Store } from '../server/store.js'
import { TraceTap } from '../server/trace.js'
import { HARNESSES } from './harness.js'

const ORIGIN = 'http://localhost:5173'
let http: Server
let app: ReturnType<typeof createApp>
let store: Store
let sim: FactorySim | undefined
let trace: TraceTap
let url: string
const clients: Client[] = []

// Seed profile by default (two lines, no simulation). { plant: true } adds the Tarnby Works plant and its
// simulation, without its timer: tests advance it explicitly.
async function start(database: Store, options: Partial<AppOptions> & { plant?: boolean } = {}) {
  trace = new TraceTap()
  sim = undefined
  if (options.plant) {
    await applyPlantSeed(database)
    sim = await FactorySim.create(database)
  }
  app = createApp({ store: database, sim, trace, allowedOrigins: [ORIGIN], notifyEveryMs: 50, ...options })
  http = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
}

async function stop() {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await app.sessions.closeAll()
  http.closeAllConnections()
  http.close()
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

describe.each(HARNESSES)('$name store', (h) => {
beforeEach(async () => {
  store = await h.open()
  await start(store)
})
afterEach(async () => {
  await stop()
  await h.dispose(store)
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
      'get_shift_history',
      'get_shift_summary',
      'list_follow_ups',
      'list_handover_notes',
      'plan_container_load',
    ])
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined()
  })

  it('reports which store is in use on /api/health', async () => {
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ ok: true, name: 'lineledger', synthetic: true, store: h.name, degraded: false, mcp: 'stateful', simulation: false, sessions: 0 })
    await connect()
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ sessions: 1 })
  })

  it('offers no resources in the seed profile', async () => {
    const { client } = await connect()
    expect(client.getServerCapabilities()?.resources).toBeUndefined()
    await expect(client.listResources()).rejects.toThrow(/Method not found/)
  })
})

describe('stateful sessions', () => {
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  })
  const headers = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra })

  it('gives each client its own session id and keeps it across calls', async () => {
    const a = await connect()
    const b = await connect()
    expect(a.transport.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(b.transport.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId)
    expect(app.sessions.size).toBe(2)
    expect((await call(a.client, 'check_stock', { query: 'steel' })).isError).toBeFalsy()
    expect((await call(b.client, 'check_stock', { query: 'steel' })).isError).toBeFalsy()
    expect(app.sessions.size).toBe(2) // later calls reuse the sessions
  })

  it('rejects requests without a session (400) and with an unknown session (404)', async () => {
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: headers(), body: list })).status).toBe(400)
    const unknown = { 'mcp-session-id': '00000000-0000-4000-8000-000000000000' }
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: headers(unknown), body: list })).status).toBe(404)
    for (const method of ['GET', 'DELETE']) {
      expect((await fetch(`${url}/mcp`, { method })).status, method).toBe(400)
      expect((await fetch(`${url}/mcp`, { method, headers: unknown })).status, method).toBe(404)
    }
  })

  it('initialize over raw HTTP returns the session id header', async () => {
    const res = await fetch(`${url}/mcp`, { method: 'POST', headers: headers(), body: initBody })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/)
    await res.text()
  })

  it('DELETE ends the session; the old id is then unknown', async () => {
    const { client, transport } = await connect()
    const id = transport.sessionId!
    await transport.terminateSession()
    expect(app.sessions.size).toBe(0)
    const list = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect((await fetch(`${url}/mcp`, { method: 'POST', headers: headers({ 'mcp-session-id': id }), body: list })).status).toBe(404)
    await expect(client.listTools()).rejects.toThrow()
  })

  it('closes idle sessions and the least recently used one past the cap', async () => {
    await stop()
    await start(store, { sessionIdleMs: 300, maxSessions: 2 })
    const first = await connect()
    await connect()
    await connect() // over the cap: the first session is closed
    await new Promise((r) => setTimeout(r, 20))
    expect(app.sessions.size).toBe(2)
    await expect(first.client.listTools()).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 700))
    expect(app.sessions.size).toBe(0) // idle for longer than 300 ms
  })

  it('pushes plant snapshot updates to subscribed sessions only', async () => {
    await stop()
    await start(store, { plant: true })
    const watcher = await connect()
    const other = await connect()
    const seen: string[] = []
    const otherSeen: string[] = []
    watcher.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void seen.push(n.params.uri))
    other.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void otherSeen.push(n.params.uri))
    await watcher.client.subscribeResource({ uri: 'plant://snapshot' })
    await expect(watcher.client.subscribeResource({ uri: 'plant://nothing' })).rejects.toThrow(/Unknown resource/)
    await new Promise((r) => setTimeout(r, 200)) // the GET event stream opens after initialize
    await sim!.advance(60_000)
    await expect.poll(() => seen, { timeout: 3000 }).toEqual(['plant://snapshot'])
    expect(otherSeen).toEqual([])
    const snapshot = JSON.parse(((await watcher.client.readResource({ uri: 'plant://snapshot' })).contents[0] as { text: string }).text)
    expect(snapshot).toMatchObject({ synthetic: true, company: 'Tarnby Works', sim_clock: { sim_now: '2026-10-22 12:56' } })
    // the push went out on the session's GET stream and shows in the trace
    const { entries } = (await (await fetch(`${url}/api/trace`)).json()) as { entries: { dir: string; message: any }[] }
    expect(entries.some((e) => e.dir === 'out' && e.message.method === 'notifications/resources/updated')).toBe(true)
    await watcher.client.unsubscribeResource({ uri: 'plant://snapshot' })
    seen.length = 0
    await sim!.advance(60_000)
    await new Promise((r) => setTimeout(r, 300))
    expect(seen).toEqual([])
  })

  it('tells the other sessions when a note or follow-up is written', async () => {
    const watcher = await connect()
    const seen: { event: string; resource: string }[] = []
    watcher.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void seen.push(n.params.data as { event: string; resource: string }))
    const writer = await connect()
    await new Promise((r) => setTimeout(r, 200)) // the GET event stream opens after initialize
    await call(writer.client, 'create_follow_up', { title: 'Recheck guard', owner: 'Ravi' })
    await call(writer.client, 'create_handover_note', { author: 'Test', text: 'Belt tension low' })
    await call(writer.client, 'list_follow_ups', {}) // a read announces nothing
    await expect.poll(() => seen, { timeout: 3000 }).toEqual([
      { event: 'data_changed', resource: 'follow_ups' },
      { event: 'data_changed', resource: 'handover_notes' },
    ])
  })

  it('still serves every tool in the optional stateless mode', async () => {
    await stop()
    await start(store, { mode: 'stateless', plant: true })
    const { client, transport } = await connect()
    expect(transport.sessionId).toBeUndefined()
    expect((await client.listTools()).tools).toHaveLength(12)
    expect((await call(client, 'get_live_line_status', { line_id: 'L2' })).structuredContent!.lines).toHaveLength(1)
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${url}/mcp`, { method })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })
})

describe('plant profile (Tarnby Works simulation)', () => {
  beforeEach(async () => {
    await stop()
    await start(store, { plant: true })
  })

  it('adds the live tools and the snapshot resource, and no tool that controls a line', async () => {
    const { client } = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toHaveLength(12)
    expect(names).toEqual(expect.arrayContaining(['get_live_line_status', 'get_factory_events', 'receive_stock']))
    for (const control of ['inject_fault', 'clear_fault', 'set_line_running']) expect(names).not.toContain(control)
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(['plant://snapshot'])
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ simulation: true })
  })

  it('answers the live questions through the story: running, why down, how long, sealer temperature', async () => {
    const { client } = await connect()
    const live = async (args: Record<string, unknown> = {}) => (await call(client, 'get_live_line_status', args)).structuredContent!
    const now = await live()
    expect(now).toMatchObject({ sim_now: '2026-10-22 12:55', shift: { date: '2026-10-22', shift: 'A', lead: 'Asha' } })
    expect(now.lines).toHaveLength(7)
    expect(now.roll_up.RUN).toBeGreaterThanOrEqual(6)
    let l2 = (await live({ line_id: 'L2' })).lines[0]
    expect(l2).toMatchObject({ line_id: 'L2', state: 'RUN', crew: 4 })
    expect(l2.signals[0]).toMatchObject({ tag: 'M3.sealer_jaw_temp_c', unit: '°C', warn_limit: 190, trip_limit: 200 })

    await sim!.advance(20 * 60_000) // 13:15: the jaw is over its warn limit, the line still runs
    l2 = (await live({ line_id: 'L2' })).lines[0]
    expect(l2.state).toBe('RUN')
    expect(l2.signals[0].value).toBeGreaterThanOrEqual(190)
    expect(l2.open_alarms.map((a: { code: string }) => a.code)).toEqual(['M3-TEMP-HI'])

    await sim!.advance(12 * 60_000) // 13:27: tripped at 13:23
    l2 = (await live({ line_id: 'L2' })).lines[0]
    expect(l2).toMatchObject({ state: 'STOP_FAULT', reason_code: 'SEALER_FAULT', since: '2026-10-22 13:23', minutes_in_state: 4 })
    expect(l2.open_alarms.map((a: { code: string }) => a.code)).toEqual(['M3-TEMP-HI', 'M3-HEAT-OVR'])
    expect(l2.signals[0].value).toBeGreaterThan(200)
    const events = (await call(client, 'get_factory_events', { line_id: 'L2', limit: 50 })).structuredContent!.events as { kind: string; message: string }[]
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['stop', 'alarm', 'quality_check']))
    expect(events.find((e) => e.kind === 'quality_check')!.message).toMatch(/seal peel/)
  })

  it('shift summary of the shift in progress carries pace, and the finished shift is stored', async () => {
    const { client } = await connect()
    const summary = (await call(client, 'get_shift_summary')).structuredContent!
    expect(summary).toMatchObject({ shift_date: '2026-10-22', shift: 'A', in_progress: true })
    expect(summary.lines).toHaveLength(7)
    const l1 = summary.lines[0]
    expect(l1.in_progress).toBe(true)
    expect(l1.target_to_date).toBeLessThan(l1.target_units)
    expect(l1.percent_of_pace).toBeGreaterThan(l1.percent_of_target)
    await sim!.advance(66 * 60_000) // to 14:01: shift A has ended, B is in progress
    const a = (await call(client, 'get_shift_summary', { shift_date: '2026-10-22', shift: 'A' })).structuredContent!
    expect(a.in_progress).toBe(false)
    expect(a.lines.find((l: { line_id: string }) => l.line_id === 'L2')).toMatchObject({ produced_units: 678, status: 'at_risk' })
    expect((await call(client, 'get_shift_summary')).structuredContent).toMatchObject({ shift: 'B', in_progress: true })
    const history = (await call(client, 'get_shift_history', { limit: 3 })).structuredContent!.shifts
    expect(history.map((s: { shift: string; in_progress: boolean }) => `${s.shift} ${s.in_progress}`)).toEqual(['B false', 'A false', 'B true'])
  })

  it('stock shows live levels and days of cover; a goods receipt adds to it', async () => {
    const { client } = await connect()
    const band = (await call(client, 'check_stock', { query: 'heater band' })).structuredContent!.items[0]
    expect(band).toMatchObject({ sku: 'HTR-BAND', on_hand: 3, status: 'ok' })
    await sim!.advance(64 * 60_000) // 13:59: the band was swapped at 13:58
    expect((await call(client, 'check_stock', { query: 'heater band' })).structuredContent!.items[0]).toMatchObject({ on_hand: 2, status: 'reorder', suggested_order_qty: 6 })
    const hdpe = (await call(client, 'check_stock', { query: 'hdpe' })).structuredContent!.items[0]
    expect(hdpe.days_cover).toBeGreaterThan(1)
    expect(hdpe.on_hand).toBeLessThan(20400)
    const r = await call(client, 'receive_stock', { sku: 'htr-band', quantity: 6 })
    expect(r.structuredContent).toMatchObject({ sku: 'HTR-BAND', on_hand: 8 })
    expect((await call(client, 'check_stock', { query: 'HTR' })).structuredContent!.items[0]).toMatchObject({ on_hand: 8, status: 'ok' })
    expect((await call(client, 'receive_stock', { sku: 'NOPE', quantity: 1 })).content[0]!.text).toMatch(/Unknown SKU/)
    expect((await call(client, 'receive_stock', { sku: 'LBL-ROLL', quantity: 0 })).isError).toBe(true)
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

  it('returns shift history oldest first, honours limit and matches the summary', async () => {
    const { client } = await connect()
    const all = (await call(client, 'get_shift_history')).structuredContent!.shifts
    expect(all).toHaveLength(14)
    expect(all[0]).toMatchObject({ shift_date: '2026-10-15', shift: 'A' })
    expect(all.at(-1)).toMatchObject({ shift_date: '2026-10-21', shift: 'B' })
    expect(all.every((s: { lines: unknown[] }) => s.lines.length === 2)).toBe(true)
    const last3 = (await call(client, 'get_shift_history', { limit: 3 })).structuredContent!.shifts
    expect(last3.map((s: { shift: string }) => s.shift)).toEqual(['B', 'A', 'B'])
    const summary = (await call(client, 'get_shift_summary')).structuredContent!.lines
    expect(all.at(-1).lines.map((l: { percent_of_target: number }) => l.percent_of_target)).toEqual(summary.map((l: { percent_of_target: number }) => l.percent_of_target))
    expect((await call(client, 'get_shift_history', { limit: 1 })).isError).toBe(true)
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

  it('persists handover notes across a restart', async () => {
    const storage = await h.reopenable()
    try {
      const first = await storage.open()
      await stop()
      await start(first)
      const { client } = await connect()
      await call(client, 'create_handover_note', { author: 'Test', text: 'Persist me' })
      await stop()
      await first.close()

      const second = await storage.open()
      await start(second)
      const again = await connect()
      const notes = (await call(again.client, 'list_handover_notes', { limit: 50 })).structuredContent!.notes
      expect(notes.some((n: { text: string }) => n.text === 'Persist me')).toBe(true)
      expect(notes).toHaveLength(3) // 2 seeded once, not reseeded, plus the new one
      await stop()
      await second.close()
    } finally {
      await storage.cleanup()
    }
    await start(store) // afterEach closes it
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
    await h.setOnHand(store, 'LBL-ROLL', 20) // its reorder_point
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
    const row = (line_id: string, shift_date: string, produced_units: number) =>
      h.putShift(store, { line_id, shift_date, shift: 'A', target_units: 1000, produced_units, downtime_min: 0 })
    await row('L1', '2026-10-22', 950) // exactly 95.0
    await row('L2', '2026-10-22', 949) // 94.9
    await row('L1', '2026-10-23', 800) // exactly 80.0
    await row('L2', '2026-10-23', 799) // 79.9
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

  it('plans a container load from the flat form with a container preset', async () => {
    const { client } = await connect()
    const flat = { container_type: '20ft', box_length_mm: 600, box_width_mm: 400, box_height_mm: 300, box_weight_kg: 12 }
    const r = await call(client, 'plan_container_load', flat)
    expect(r.isError).toBeFalsy()
    const nested = await call(client, 'plan_container_load', {
      container: { length: 5898, width: 2352, height: 2393, maxPayloadKg: 28200 },
      item: { length: 600, width: 400, height: 300, weightKg: 12 },
    })
    expect(r.structuredContent).toEqual(nested.structuredContent)
    // missing pieces get a message that names what to supply
    const noBox = await call(client, 'plan_container_load', { container_type: '20ft' })
    expect(noBox.isError).toBe(true)
    expect(JSON.stringify(noBox.content)).toContain('box_length_mm')
    const noContainer = await call(client, 'plan_container_load', { ...flat, container_type: undefined })
    expect(noContainer.isError).toBe(true)
    expect(JSON.stringify(noContainer.content)).toContain('container_type')
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
})
