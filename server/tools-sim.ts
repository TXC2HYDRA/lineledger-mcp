// MCP tools and resources for the production-line simulation (server/sim.ts). All data is synthetic.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod/v4'
import { LINE_SPECS, type FactorySim } from './sim.js'

export const STATUS_URI = 'factory://status'
export const EVENTS_URI = 'factory://events'
export const FACTORY_RESOURCES = [STATUS_URI, EVENTS_URI] as const

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
})
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

const READ = { readOnlyHint: true, idempotentHint: false, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const

const STATIONS = LINE_SPECS.map((l) => `${l.id}: ${l.stations.map((s) => s.id).join(', ')}`).join('; ')
const lineId = z.enum(LINE_SPECS.map((l) => l.id) as [string, ...string[]]).describe('Line id: L1 or L2')
const stationId = z.string().trim().min(1).max(20).describe(`Station id. ${STATIONS}`)

const stationShape = z.object({
  station_id: z.string(),
  name: z.string(),
  state: z.enum(['running', 'down', 'idle']),
  fault: z.string().nullable(),
  down_since: z.string().nullable(),
  waiting_for_part: z.string().nullable(),
})
const lineShape = z.object({
  line_id: z.string(),
  state: z.enum(['running', 'down', 'starved', 'stopped']),
  produced_units: z.number(),
  scrap_units: z.number(),
  target_units: z.number(),
  target_to_date: z.number(),
  percent_of_target_to_date: z.number().nullable(),
  pace: z.enum(['on_track', 'at_risk', 'behind']).nullable(),
  downtime_min: z.number(),
  material: z.object({ sku: z.string(), on_hand: z.number(), per_unit: z.number() }),
  stations: z.array(stationShape),
})
const statusShape = {
  sim_time: z.string(),
  shift_date: z.string(),
  shift: z.enum(['A', 'B']),
  shift_elapsed_min: z.number(),
  shift_length_min: z.number(),
  lines: z.array(lineShape),
}
const eventShape = z.object({
  id: z.number(),
  sim_time: z.string(),
  line_id: z.string().nullable(),
  station_id: z.string().nullable(),
  kind: z.string(),
  message: z.string(),
})
const actionShape = { message: z.string(), line: lineShape }

export function registerSimTools(server: McpServer, sim: FactorySim): void {
  const lineStatus = (id: string) => sim.status().lines.find((l) => l.line_id === id)!

  server.registerTool(
    'get_line_status',
    {
      title: 'Live line status',
      description:
        'Live state of the simulated production lines in the current shift: running, down, starved (no material) or stopped; ' +
        'units produced and scrapped so far, pace against the pro-rated target, downtime, raw material on hand, and each station with its fault. ' +
        'Use get_shift_summary for finished shifts. Simulated plant time, synthetic data.',
      inputSchema: { line_id: lineId.optional() },
      outputSchema: statusShape,
      annotations: READ,
    },
    async ({ line_id }) => {
      const status = sim.status()
      return ok({ ...status, lines: status.lines.filter((l) => line_id === undefined || l.line_id === line_id) })
    },
  )

  server.registerTool(
    'get_factory_events',
    {
      title: 'Factory events',
      description: 'Recent simulation events, newest first: faults, repairs, material shortages, stock receipts, line starts and stops, shift ends.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(10), line_id: lineId.optional() },
      outputSchema: { events: z.array(eventShape) },
      annotations: READ,
    },
    async ({ limit, line_id }) => ok({ events: sim.events({ limit, line_id }) }),
  )

  server.registerTool(
    'inject_fault',
    {
      title: 'Simulate a station fault',
      description:
        `Simulation control for demos: puts one station into a fault, which stops its line until it is repaired. ${STATIONS}. ` +
        'The reason "Heater band failed" on the L2 sealer needs a spare heater band (HTR-BAND) before it can be repaired.',
      inputSchema: { line_id: lineId, station_id: stationId, reason: z.string().trim().min(1).max(80).optional() },
      outputSchema: actionShape,
      annotations: WRITE,
    },
    async ({ line_id, station_id, reason }) => {
      const r = await sim.injectFault(line_id, station_id, reason)
      return r.ok ? ok({ message: r.message, line: lineStatus(line_id) }) : fail(r.message)
    },
  )

  server.registerTool(
    'clear_fault',
    {
      title: 'Clear a fault',
      description: `Maintenance has fixed a station: clears its fault so the line can run again. Without station_id, clears every faulted station of the line. ${STATIONS}.`,
      inputSchema: { line_id: lineId, station_id: stationId.optional() },
      outputSchema: actionShape,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ line_id, station_id }) => {
      const r = await sim.clearFault(line_id, station_id)
      return r.ok ? ok({ message: r.message, line: lineStatus(line_id) }) : fail(r.message)
    },
  )

  server.registerTool(
    'set_line_running',
    {
      title: 'Start or stop a line',
      description: 'Operator start (running: true) or stop (running: false) of a production line.',
      inputSchema: { line_id: lineId, running: z.boolean() },
      outputSchema: actionShape,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ line_id, running }) => {
      const r = await sim.setRunning(line_id, running)
      return r.ok ? ok({ message: r.message, line: lineStatus(line_id) }) : fail(r.message)
    },
  )

  server.registerTool(
    'receive_stock',
    {
      title: 'Receive stock',
      description: 'Book a goods receipt: adds the quantity to the stock on hand. A starved line or a station waiting for a spare part restarts once the material arrives.',
      inputSchema: {
        sku: z.string().trim().min(1).max(20).describe('SKU, for example PLY-HDPE, STL-040, HTR-BAND'),
        quantity: z.number().int().positive().max(100_000),
      },
      outputSchema: { message: z.string(), sku: z.string(), on_hand: z.number() },
      annotations: WRITE,
    },
    async ({ sku, quantity }) => {
      const r = await sim.receiveStock(sku.toUpperCase(), quantity)
      return r.ok ? ok({ message: r.message, sku: sku.toUpperCase(), on_hand: r.on_hand ?? 0 }) : fail(r.message)
    },
  )
}

export function registerFactoryResources(server: McpServer, sim: FactorySim): void {
  server.registerResource(
    'factory-status',
    STATUS_URI,
    { title: 'Live factory status', description: 'The same data as get_line_status, as a resource clients can subscribe to.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(sim.status()) }] }),
  )
  server.registerResource(
    'factory-events',
    EVENTS_URI,
    { title: 'Factory events', description: 'The 20 most recent simulation events, newest first.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ events: sim.events({ limit: 20 }) }) }] }),
  )
}
