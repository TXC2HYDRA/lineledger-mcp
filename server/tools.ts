import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod/v4'
import { loadPlanner } from './container.js'
import type { Db } from './db.js'

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

type Row = Record<string, string | number | null>
const lineExists = (db: Db, id: string): boolean => db.prepare('SELECT 1 FROM lines WHERE id = ?').get(id) !== undefined

export function registerTools(server: McpServer, db: Db): void {
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
    ({ shift_date, shift }) => {
      const latest = db
        .prepare(
          `SELECT shift_date, shift FROM shift_output
           WHERE (?1 IS NULL OR shift_date = ?1) AND (?2 IS NULL OR shift = ?2)
           ORDER BY shift_date DESC, shift DESC LIMIT 1`,
        )
        .get(shift_date ?? null, shift ?? null) as { shift_date: string; shift: string } | undefined
      if (!latest) return fail('No shift data for that date and shift.')
      const rows = db
        .prepare(
          `SELECT s.line_id, l.name, l.product, s.target_units, s.produced_units, s.downtime_min
           FROM shift_output s JOIN lines l ON l.id = s.line_id
           WHERE s.shift_date = ? AND s.shift = ? ORDER BY s.line_id`,
        )
        .all(latest.shift_date, latest.shift) as Row[]
      const pct = (produced: number, target: number) => Math.round((produced / target) * 1000) / 10
      const lines = rows.map((r) => {
        const percent = pct(r.produced_units as number, r.target_units as number)
        return {
          line_id: r.line_id as string,
          name: r.name as string,
          product: r.product as string,
          target_units: r.target_units as number,
          produced_units: r.produced_units as number,
          percent_of_target: percent,
          downtime_min: r.downtime_min as number,
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
    'create_handover_note',
    {
      title: 'Create handover note',
      description: 'Save a shift handover note, optionally tied to one line. Stored in SQLite and kept across restarts.',
      inputSchema: {
        author: z.string().trim().min(1).max(60).describe('Who is writing, for example "Asha (shift A)"'),
        text: z.string().trim().min(1).max(500),
        line_id: lineIdSchema.optional(),
      },
      outputSchema: noteShape,
      annotations: WRITE,
    },
    ({ author, text, line_id }) => {
      if (line_id && !lineExists(db, line_id)) return fail(`Unknown line "${line_id}".`)
      const created_at = new Date().toISOString()
      const { lastInsertRowid } = db
        .prepare('INSERT INTO handover_notes (line_id, author, text, created_at) VALUES (?, ?, ?, ?)')
        .run(line_id ?? null, author, text, created_at)
      return ok({ id: Number(lastInsertRowid), line_id: line_id ?? null, author, text, created_at })
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
    ({ line_id, limit }) => {
      const notes = db
        .prepare(
          `SELECT id, line_id, author, text, created_at FROM handover_notes
           WHERE (?1 IS NULL OR line_id = ?1) ORDER BY created_at DESC, id DESC LIMIT ?2`,
        )
        .all(line_id ?? null, limit) as Row[]
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
    ({ title, owner, line_id, due_date }) => {
      if (line_id && !lineExists(db, line_id)) return fail(`Unknown line "${line_id}".`)
      const created_at = new Date().toISOString()
      const { lastInsertRowid } = db
        .prepare('INSERT INTO follow_ups (title, owner, line_id, due_date, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(title, owner, line_id ?? null, due_date ?? null, created_at)
      return ok({
        id: Number(lastInsertRowid),
        title,
        owner,
        line_id: line_id ?? null,
        due_date: due_date ?? null,
        status: 'open',
        created_at,
        closed_at: null,
      })
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
    ({ status, line_id }) => {
      const follow_ups = db
        .prepare(
          `SELECT * FROM follow_ups
           WHERE (?1 = 'all' OR status = ?1) AND (?2 IS NULL OR line_id = ?2)
           ORDER BY due_date IS NULL, due_date, id`,
        )
        .all(status, line_id ?? null) as Row[]
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
    ({ id }) => {
      const row = db.prepare('SELECT status FROM follow_ups WHERE id = ?').get(id) as { status: string } | undefined
      if (!row) return fail(`Follow-up ${id} not found.`)
      if (row.status === 'closed') return fail(`Follow-up ${id} is already closed.`)
      db.prepare("UPDATE follow_ups SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), id)
      return ok(db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(id) as Row)
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
    ({ query }) => {
      const rows = db
        .prepare(
          `SELECT * FROM stock_items
           WHERE instr(lower(sku), lower(?1)) > 0 OR instr(lower(name), lower(?1)) > 0 ORDER BY sku`,
        )
        .all(query) as Row[]
      const items = rows.map((r) => {
        const onHand = r.on_hand as number
        const status = onHand === 0 ? ('out_of_stock' as const) : onHand <= (r.reorder_point as number) ? ('reorder' as const) : ('ok' as const)
        return {
          sku: r.sku as string,
          name: r.name as string,
          unit: r.unit as string,
          on_hand: onHand,
          reorder_point: r.reorder_point as number,
          status,
          suggested_order_qty: status === 'ok' ? 0 : (r.reorder_qty as number),
          lead_days: r.lead_days as number,
          supplier: r.supplier as string,
        }
      })
      return ok({ items })
    },
  )

  const positive = z.number().positive().finite()
  server.registerTool(
    'plan_container_load',
    {
      title: 'Container load plan',
      description:
        'How many identical boxes fit in a container, limited by geometry and payload. Uses the standalone container-load-planner package. Dimensions in mm, weights in kg.',
      inputSchema: {
        container: z.object({ length: positive, width: positive, height: positive, maxPayloadKg: positive }),
        item: z.object({ length: positive, width: positive, height: positive, weightKg: positive }),
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
    async (input) => {
      const plan = await loadPlanner()
      if (!plan) return fail('container-load-planner package is not installed on this server.')
      try {
        return ok(plan(input))
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Container load calculation failed.')
      }
    },
  )
}
