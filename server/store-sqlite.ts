// Default store: one node:sqlite file. The SQL is the same the tools used before the store interface existed.
import { openDb, type Db } from './db.js'
import type { FollowUpRow, LineRow, NoteRow, ShiftLineRow, ShiftOutputRow, StockRow, Store } from './store.js'

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const

  constructor(readonly db: Db) {}

  static open(path = ':memory:', options: { seed?: boolean } = {}): SqliteStore {
    return new SqliteStore(openDb(path, options))
  }

  async lineExists(id: string): Promise<boolean> {
    return this.db.prepare('SELECT 1 FROM lines WHERE id = ?').get(id) !== undefined
  }

  async latestShift({ shift_date, shift }: { shift_date?: string; shift?: string }) {
    return this.db
      .prepare(
        `SELECT shift_date, shift FROM shift_output
         WHERE (?1 IS NULL OR shift_date = ?1) AND (?2 IS NULL OR shift = ?2)
         ORDER BY shift_date DESC, shift DESC LIMIT 1`,
      )
      .get(shift_date ?? null, shift ?? null) as { shift_date: string; shift: string } | undefined
  }

  async shiftLines(shift_date: string, shift: string): Promise<ShiftLineRow[]> {
    return this.db
      .prepare(
        `SELECT s.line_id, s.shift_date, s.shift, l.name, l.product, s.target_units, s.produced_units, s.downtime_min
         FROM shift_output s JOIN lines l ON l.id = s.line_id
         WHERE s.shift_date = ? AND s.shift = ? ORDER BY s.line_id`,
      )
      .all(shift_date, shift) as unknown as ShiftLineRow[]
  }

  async recentShifts(limit: number): Promise<(ShiftOutputRow & { name: string })[]> {
    return this.db
      .prepare(
        `SELECT s.shift_date, s.shift, s.line_id, l.name, s.target_units, s.produced_units, s.downtime_min
         FROM shift_output s JOIN lines l ON l.id = s.line_id
         WHERE (s.shift_date, s.shift) IN (
           SELECT shift_date, shift FROM shift_output GROUP BY shift_date, shift ORDER BY shift_date DESC, shift DESC LIMIT ?)
         ORDER BY s.shift_date, s.shift, s.line_id`,
      )
      .all(limit) as unknown as (ShiftOutputRow & { name: string })[]
  }

  async addNote({ line_id, author, text, created_at }: Omit<NoteRow, 'id'>): Promise<NoteRow> {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO handover_notes (line_id, author, text, created_at) VALUES (?, ?, ?, ?)')
      .run(line_id, author, text, created_at)
    return { id: Number(lastInsertRowid), line_id, author, text, created_at }
  }

  async listNotes({ line_id, limit }: { line_id?: string; limit: number }): Promise<NoteRow[]> {
    return this.db
      .prepare(
        `SELECT id, line_id, author, text, created_at FROM handover_notes
         WHERE (?1 IS NULL OR line_id = ?1) ORDER BY created_at DESC, id DESC LIMIT ?2`,
      )
      .all(line_id ?? null, limit) as unknown as NoteRow[]
  }

  async addFollowUp({ title, owner, line_id, due_date, created_at }: Pick<FollowUpRow, 'title' | 'owner' | 'line_id' | 'due_date' | 'created_at'>): Promise<FollowUpRow> {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO follow_ups (title, owner, line_id, due_date, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(title, owner, line_id, due_date, created_at)
    return { id: Number(lastInsertRowid), title, owner, line_id, due_date, status: 'open', created_at, closed_at: null }
  }

  async listFollowUps({ status, line_id }: { status: 'open' | 'closed' | 'all'; line_id?: string }): Promise<FollowUpRow[]> {
    return this.db
      .prepare(
        `SELECT * FROM follow_ups
         WHERE (?1 = 'all' OR status = ?1) AND (?2 IS NULL OR line_id = ?2)
         ORDER BY due_date IS NULL, due_date, id`,
      )
      .all(status, line_id ?? null) as unknown as FollowUpRow[]
  }

  async closeFollowUp(id: number, closed_at: string): Promise<FollowUpRow | 'not_found' | 'already_closed'> {
    const row = this.db.prepare('SELECT status FROM follow_ups WHERE id = ?').get(id) as { status: string } | undefined
    if (!row) return 'not_found'
    if (row.status === 'closed') return 'already_closed'
    this.db.prepare("UPDATE follow_ups SET status = 'closed', closed_at = ? WHERE id = ?").run(closed_at, id)
    return this.db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(id) as unknown as FollowUpRow
  }

  async findStock(query: string): Promise<StockRow[]> {
    return this.db
      .prepare(
        `SELECT * FROM stock_items
         WHERE instr(lower(sku), lower(?1)) > 0 OR instr(lower(name), lower(?1)) > 0 ORDER BY sku`,
      )
      .all(query) as unknown as StockRow[]
  }

  async putShiftOutput(r: ShiftOutputRow): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO shift_output (line_id, shift_date, shift, target_units, produced_units, downtime_min) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.line_id, r.shift_date, r.shift, r.target_units, r.produced_units, r.downtime_min)
  }

  async setStockOnHand(sku: string, onHand: number): Promise<void> {
    this.db.prepare('UPDATE stock_items SET on_hand = ? WHERE sku = ?').run(onHand, sku)
  }

  async addLine(l: LineRow): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO lines (id, name, product) VALUES (?, ?, ?)').run(l.id, l.name, l.product)
  }

  async putStockItem(s: StockRow): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO stock_items (sku, name, unit, on_hand, reorder_point, reorder_qty, lead_days, supplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.sku, s.name, s.unit, s.on_hand, s.reorder_point, s.reorder_qty, s.lead_days, s.supplier)
  }

  async close(): Promise<void> {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }
}
