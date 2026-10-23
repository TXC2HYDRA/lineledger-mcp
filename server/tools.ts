import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { planContainerLoad } from 'container-load-planner'
import * as z from 'zod/v4'
import type { Store } from './store.js'

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
})
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

const lineIdSchema = z.string().min(1).max(20).describe('Line id, for example L1')
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const

const noteShape = {
  id: z.number().int(),
  line_id: z.string().nullable(),
  author: z.string(),
  text: z.string(),
  created_at: z.string(),
}
const followUpShape = {
  id: z.number().int(),
  title: z.string(),
  owner: z.string(),
  line_id: z.string().nullable(),
  due_date: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  created_at: z.string(),
  closed_at: z.string().nullable(),
}

export function registerTools(server: McpServer, store: Store): void {
  server.registerTool(
    'get_shift_summary',
    {
      title: 'Shift summary',
      description:
        'Output versus target for every production line in one shift. Defaults to the latest shift on record. All data is synthetic.',
      inputSchema: {
        shift_date: z.iso.date().optional().describe('YYYY-MM-DD. Default: latest date on record'),
        shift: z.enum(['A', 'B', 'C']).optional().describe('Shift letter. Default: latest shift of that date'),
      },
      outputSchema: {
        shift_date: z.string(),
        shift: z.string(),
        lines: z.array(
          z.object({
            line_id: z.string(),
            name: z.string(),
            product: z.string(),
            target_units: z.number(),
            produced_units: z.number(),
            percent_of_target: z.number(),
            downtime_min: z.number(),
            status: z.enum(['on_track', 'at_risk', 'behind']),
          }),
        ),
        totals: z.object({ target_units: z.number(), produced_units: z.number(), percent_of_target: z.number() }),
      },
      annotations: READ,
    },
    async ({ shift_date, shift }) => {
      const found = await store.latestShift({ shift_date, shift })
      if (!found) return fail('No shift data for that date and shift.')
      const latest = { shift_date: found.shift_date, shift: found.shift }
      const rows = await store.shiftLines(latest.shift_date, latest.shift)
      const pct = (produced: number, target: number) => Math.round((produced / target) * 1000) / 10
      const lines = rows.map((r) => {
        const percent = pct(r.produced_units, r.target_units)
        return {
          line_id: r.line_id,
          name: r.name,
          product: r.product,
          target_units: r.target_units,
          produced_units: r.produced_units,
          percent_of_target: percent,
          downtime_min: r.downtime_min,
          status: percent >= 95 ? ('on_track' as const) : percent >= 80 ? ('at_risk' as const) : ('behind' as const),
        }
      })
      const target = lines.reduce((sum, l) => sum + l.target_units, 0)
      const produced = lines.reduce((sum, l) => sum + l.produced_units, 0)
      return ok({
        ...latest,
        lines,
        totals: { target_units: target, produced_units: produced, percent_of_target: pct(produced, target) },
      })
    },
  )

  server.registerTool(
    'get_shift_history',
    {
      title: 'Shift history',
      description:
        'Percent of target per line for the most recent shifts, oldest first. Use it for trends. All data is synthetic.',
      inputSchema: { limit: z.number().int().min(2).max(60).default(14).describe('How many recent shifts to return') },
      outputSchema: {
        shifts: z.array(
          z.object({
            shift_date: z.string(),
            shift: z.string(),
            lines: z.array(z.object({ line_id: z.string(), name: z.string(), percent_of_target: z.number() })),
          }),
        ),
      },
      annotations: READ,
    },
    async ({ limit }) => {
      const rows = await store.recentShifts(limit)
      type Entry = { shift_date: string; shift: string; lines: { line_id: string; name: string; percent_of_target: number }[] }
      const byShift = new Map<string, Entry>() // Map keeps insertion order, and the query is already oldest first
      for (const r of rows) {
        const key = `${r.shift_date}|${r.shift}`
        const entry = byShift.get(key) ?? { shift_date: r.shift_date, shift: r.shift, lines: [] }
        byShift.set(key, entry)
        entry.lines.push({ line_id: r.line_id, name: r.name, percent_of_target: Math.round((r.produced_units / r.target_units) * 1000) / 10 })
      }
      const shifts = [...byShift.values()]
      return ok({ shifts })
    },
  )

  server.registerTool(
    'create_handover_note',
    {
      title: 'Create handover note',
      description: 'Save a shift handover note, optionally tied to one line. Stored in the configured store (SQLite by default, or Amazon DynamoDB) and kept across restarts.',
      inputSchema: {
        author: z.string().trim().min(1).max(60).describe('Who is writing, for example "Asha (shift A)"'),
        text: z.string().trim().min(1).max(500),
        line_id: lineIdSchema.optional(),
      },
      outputSchema: noteShape,
      annotations: WRITE,
    },
    async ({ author, text, line_id }) => {
      if (line_id && !(await store.lineExists(line_id))) return fail(`Unknown line "${line_id}".`)
      const note = await store.addNote({ line_id: line_id ?? null, author, text, created_at: new Date().toISOString() })
      return ok({ ...note })
    },
  )

  server.registerTool(
    'list_handover_notes',
    {
      title: 'List handover notes',
      description: 'Read handover notes, newest first. Optionally filter by line.',
      inputSchema: {
        line_id: lineIdSchema.optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      outputSchema: { notes: z.array(z.object(noteShape)) },
      annotations: READ,
    },
    async ({ line_id, limit }) => {
      const notes = await store.listNotes({ line_id, limit })
      return ok({ notes })
    },
  )

  server.registerTool(
    'create_follow_up',
    {
      title: 'Create follow-up',
      description: 'Add an open follow-up task with an owner and an optional due date.',
      inputSchema: {
        title: z.string().trim().min(1).max(120),
        owner: z.string().trim().min(1).max(60),
        line_id: lineIdSchema.optional(),
        due_date: z.iso.date().optional().describe('YYYY-MM-DD'),
      },
      outputSchema: followUpShape,
      annotations: WRITE,
    },
    async ({ title, owner, line_id, due_date }) => {
      if (line_id && !(await store.lineExists(line_id))) return fail(`Unknown line "${line_id}".`)
      const followUp = await store.addFollowUp({ title, owner, line_id: line_id ?? null, due_date: due_date ?? null, created_at: new Date().toISOString() })
      return ok({ ...followUp })
    },
  )

  server.registerTool(
    'list_follow_ups',
    {
      title: 'List follow-ups',
      description: 'List follow-up tasks. Default status is open. Sorted by due date, then id.',
      inputSchema: {
        status: z.enum(['open', 'closed', 'all']).default('open'),
        line_id: lineIdSchema.optional(),
      },
      outputSchema: { follow_ups: z.array(z.object(followUpShape)) },
      annotations: READ,
    },
    async ({ status, line_id }) => {
      const follow_ups = await store.listFollowUps({ status, line_id })
      return ok({ follow_ups })
    },
  )

  server.registerTool(
    'close_follow_up',
    {
      title: 'Close follow-up',
      description: 'Mark an open follow-up as closed.',
      inputSchema: { id: z.number().int().positive() },
      outputSchema: followUpShape,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id }) => {
      const result = await store.closeFollowUp(id, new Date().toISOString())
      if (result === 'not_found') return fail(`Follow-up ${id} not found.`)
      if (result === 'already_closed') return fail(`Follow-up ${id} is already closed.`)
      return ok({ ...result })
    },
  )

  server.registerTool(
    'check_stock',
    {
      title: 'Stock and purchase check',
      description:
        'Look up stock by SKU or part of the item name. Says whether to reorder and the suggested purchase quantity. Synthetic data.',
      inputSchema: { query: z.string().trim().min(1).max(60).describe('SKU or part of the item name') },
      outputSchema: {
        items: z.array(
          z.object({
            sku: z.string(),
            name: z.string(),
            unit: z.string(),
            on_hand: z.number(),
            reorder_point: z.number(),
            status: z.enum(['ok', 'reorder', 'out_of_stock']),
            suggested_order_qty: z.number(),
            lead_days: z.number(),
            supplier: z.string(),
          }),
        ),
      },
      annotations: READ,
    },
    async ({ query }) => {
      const rows = await store.findStock(query)
      const items = rows.map((r) => {
        const onHand = r.on_hand
        const status = onHand === 0 ? ('out_of_stock' as const) : onHand <= r.reorder_point ? ('reorder' as const) : ('ok' as const)
        return {
          sku: r.sku,
          name: r.name,
          unit: r.unit,
          on_hand: onHand,
          reorder_point: r.reorder_point,
          status,
          suggested_order_qty: status === 'ok' ? 0 : r.reorder_qty,
          lead_days: r.lead_days,
          supplier: r.supplier,
        }
      })
      return ok({ items })
    },
  )

  const positive = z.number().positive().finite()
  const CONTAINERS = {
    '20ft': { length: 5898, width: 2352, height: 2393, maxPayloadKg: 28200 },
    '40ft': { length: 12032, width: 2352, height: 2393, maxPayloadKg: 26700 },
  }
  server.registerTool(
    'plan_container_load',
    {
      title: 'Container load plan',
      description:
        'How many identical boxes fit in a container, limited by geometry and payload. Uses the standalone container-load-planner package. ' +
        'Simple form: container_type "20ft" or "40ft" plus box_length_mm, box_width_mm, box_height_mm and box_weight_kg. ' +
        'Advanced form: container {length, width, height, maxPayloadKg} and item {length, width, height, weightKg}, in mm and kg.',
      inputSchema: {
        container_type: z.enum(['20ft', '40ft']).optional().describe('Standard container, used when container is not given'),
        box_length_mm: positive.optional(),
        box_width_mm: positive.optional(),
        box_height_mm: positive.optional(),
        box_weight_kg: positive.optional(),
        container: z.object({ length: positive, width: positive, height: positive, maxPayloadKg: positive }).optional(),
        item: z.object({ length: positive, width: positive, height: positive, weightKg: positive }).optional(),
        rotation: z.enum(['upright', 'any']).default('upright'),
      },
      outputSchema: {
        count: z.number(),
        geometricCount: z.number(),
        payloadCount: z.number(),
        limitedBy: z.enum(['geometry', 'payload', 'both']),
        orientation: z.object({ length: z.number(), width: z.number(), height: z.number() }),
        grid: z.object({ along: z.number(), across: z.number(), layers: z.number() }),
        volumeUtilisation: z.number(),
        payloadUtilisation: z.number(),
        totalWeightKg: z.number(),
      },
      annotations: READ,
    },
    ({ container_type, box_length_mm, box_width_mm, box_height_mm, box_weight_kg, container, item, rotation }) => {
      const box =
        item ??
        (box_length_mm && box_width_mm && box_height_mm && box_weight_kg
          ? { length: box_length_mm, width: box_width_mm, height: box_height_mm, weightKg: box_weight_kg }
          : undefined)
      const where = container ?? (container_type ? CONTAINERS[container_type] : undefined)
      if (!box) return fail('Give the box size and weight: box_length_mm, box_width_mm, box_height_mm and box_weight_kg.')
      if (!where) return fail('Give the container: container_type "20ft" or "40ft".')
      try {
        return ok({ ...planContainerLoad({ container: where, item: box, rotation }) })
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Container load calculation failed.')
      }
    },
  )
}
