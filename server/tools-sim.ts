// MCP tools and the resource for the Tarnby Works simulation (server/sim.ts). All data is synthetic.
// Read-only toward machines: nothing here starts, stops or repairs a line. receive_stock books a goods receipt.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod/v4'
import { PLANT } from './plant.js'
import type { FactorySim } from './sim.js'

export const SNAPSHOT_URI = 'plant://snapshot'
export const PLANT_RESOURCES = [SNAPSHOT_URI] as const

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
})
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

const READ = { readOnlyHint: true, idempotentHint: false, openWorldHint: false } as const

const lineId = z.enum(PLANT.lines.map((l) => l.id) as [string, ...string[]]).describe(`Line id: ${PLANT.lines.map((l) => l.id).join(', ')}`)
const STATES = ['RUN', 'STOP_FAULT', 'STOP_OTHER', 'PLANNED_STOP', 'IDLE_STARVED', 'OFF_SHIFT'] as const

const liveLineShape = z.object({
  line_id: z.string(),
  name: z.string(),
  product: z.string(),
  state: z.enum(STATES),
  since: z.string(),
  minutes_in_state: z.number(),
  reason_code: z.string().nullable(),
  rate_per_h: z.number(),
  ideal_rate_per_h: z.number(),
  produced_units: z.number(),
  reject_units: z.number(),
  target_units: z.number(),
  target_to_date: z.number(),
  pace_percent: z.number().nullable(),
  status: z.enum(['on_track', 'at_risk', 'behind']).nullable(),
  downtime_min: z.number(),
  crew: z.number(),
  open_alarms: z.array(z.object({ code: z.string(), severity: z.string(), text: z.string(), raised_at: z.string() })),
  signals: z.array(z.object({ tag: z.string(), value: z.number(), unit: z.string(), warn_limit: z.number(), trip_limit: z.number(), level: z.enum(['ok', 'warn', 'trip']).describe('ok below the warn limit, warn at or above it, trip at or above the trip limit') })),
})

export function registerSimTools(server: McpServer, sim: FactorySim): void {
  server.registerTool(
    'get_live_line_status',
    {
      title: 'Live line status',
      description:
        `Live state of the ${PLANT.company} production lines (a simulated, fictional plant) right now: RUN, STOP_FAULT, STOP_OTHER, ` +
        'PLANNED_STOP (break), IDLE_STARVED (no material) or OFF_SHIFT; minutes in that state and the reason code; rate per hour over the last ' +
        '15 minutes; good units, pace against the target to date; open alarms; sensor signals with their warn and trip limits. ' +
        'Answers "is line 2 running", "why is line 2 down", "how long has it been stopped", "is the sealer temperature normal".',
      inputSchema: { line_id: lineId.optional() },
      outputSchema: {
        sim_now: z.string(),
        shift: z.object({ date: z.string(), shift: z.string(), lead: z.string(), headcount: z.number(), planned_elapsed_min: z.number() }),
        roll_up: z.record(z.string(), z.number()),
        lines: z.array(liveLineShape),
      },
      annotations: READ,
    },
    async ({ line_id }) => {
      const s = sim.snapshot()
      return ok({ sim_now: s.sim_clock.sim_now, shift: s.shift, roll_up: s.roll_up, lines: s.lines.filter((l) => line_id === undefined || l.line_id === line_id) })
    },
  )

  server.registerTool(
    'get_factory_events',
    {
      title: 'Plant events',
      description: 'Recent plant events, newest first: stops and restarts, alarms raised and cleared, material shortages, quality checks, part swaps, goods receipts, shift starts and ends.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(10), line_id: lineId.optional() },
      outputSchema: {
        events: z.array(z.object({ id: z.number(), sim_time: z.string(), line_id: z.string().nullable(), kind: z.string(), message: z.string() })),
      },
      annotations: READ,
    },
    async ({ limit, line_id }) => ok({ events: sim.events({ limit, line_id }) }),
  )

  server.registerTool(
    'receive_stock',
    {
      title: 'Receive stock',
      description: 'Book a goods receipt (an ERP record, not a machine command): adds the quantity to the stock on hand. A line waiting for that material runs again.',
      inputSchema: {
        sku: z.string().trim().min(1).max(20).describe(`SKU: ${PLANT.stock.map((s) => s.sku).join(', ')}`),
        quantity: z.number().int().positive().max(100_000),
      },
      outputSchema: { message: z.string(), sku: z.string(), on_hand: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ sku, quantity }) => {
      const r = await sim.receiveStock(sku.toUpperCase(), quantity)
      return r.ok ? ok({ message: r.message, sku: sku.toUpperCase(), on_hand: r.on_hand }) : fail(r.message)
    },
  )
}

export function registerPlantResources(server: McpServer, sim: FactorySim): void {
  server.registerResource(
    'plant-snapshot',
    SNAPSHOT_URI,
    {
      title: 'Live plant snapshot',
      description: 'The whole simulated plant in one JSON document: clock, shift and crew, every line, materials, open alarms, recent events. Subscribe for updates.',
      mimeType: 'application/json',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(sim.snapshot()) }] }),
  )
}
