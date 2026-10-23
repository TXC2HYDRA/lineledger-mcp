// Storage interface used by the MCP tools. Two implementations:
//   store-sqlite.ts   node:sqlite file (default, LINELEDGER_STORE=sqlite)
//   store-dynamodb.ts one Amazon DynamoDB table (opt-in, LINELEDGER_STORE=dynamodb)
// Business rules (status thresholds, percentages, reorder advice) stay in tools.ts, so both stores
// return the same rows and the tools behave the same on either.

export interface LineRow {
  id: string
  name: string
  product: string
}

export interface ShiftOutputRow {
  line_id: string
  shift_date: string
  shift: string
  target_units: number
  produced_units: number
  downtime_min: number
}

export interface ShiftLineRow extends ShiftOutputRow {
  name: string
  product: string
}

export interface NoteRow {
  id: number
  line_id: string | null
  author: string
  text: string
  created_at: string
}

export interface FollowUpRow {
  id: number
  title: string
  owner: string
  line_id: string | null
  due_date: string | null
  status: 'open' | 'closed'
  created_at: string
  closed_at: string | null
}

export interface StockRow {
  sku: string
  name: string
  unit: string
  on_hand: number
  reorder_point: number
  reorder_qty: number
  lead_days: number
  supplier: string
}

export type StoreKind = 'sqlite' | 'dynamodb'

export interface Store {
  readonly kind: StoreKind
  lineExists(id: string): Promise<boolean>
  /** Latest (date, shift) on record, optionally restricted to one date and/or one shift letter. */
  latestShift(filter: { shift_date?: string; shift?: string }): Promise<{ shift_date: string; shift: string } | undefined>
  /** Rows of one shift joined with their line, ordered by line id. */
  shiftLines(shift_date: string, shift: string): Promise<ShiftLineRow[]>
  /** Rows of the `limit` most recent shifts joined with their line name, oldest shift first, then line id. */
  recentShifts(limit: number): Promise<(ShiftOutputRow & { name: string })[]>
  addNote(note: Omit<NoteRow, 'id'>): Promise<NoteRow>
  /** Newest first (created_at, then id), optionally for one line. */
  listNotes(filter: { line_id?: string; limit: number }): Promise<NoteRow[]>
  addFollowUp(followUp: Pick<FollowUpRow, 'title' | 'owner' | 'line_id' | 'due_date' | 'created_at'>): Promise<FollowUpRow>
  /** Sorted by due date (no due date last), then id. */
  listFollowUps(filter: { status: 'open' | 'closed' | 'all'; line_id?: string }): Promise<FollowUpRow[]>
  closeFollowUp(id: number, closed_at: string): Promise<FollowUpRow | 'not_found' | 'already_closed'>
  /** Case-insensitive substring match on SKU or name, ordered by SKU. */
  findStock(query: string): Promise<StockRow[]>
  /** Insert or replace one shift result (the simulation writes one per line at each shift end). */
  putShiftOutput(row: ShiftOutputRow): Promise<void>
  setStockOnHand(sku: string, onHand: number): Promise<void>
  /** The simulation's saved live state (plant profile), a JSON text written with every flush, so a restart resumes mid-shift. */
  getSimState(): Promise<string | undefined>
  putSimState(json: string): Promise<void>
  /** Insert a line if it does not exist yet (plant profile). */
  addLine(line: LineRow): Promise<void>
  /** Insert or replace a stock item (plant profile). */
  putStockItem(item: StockRow): Promise<void>
  close(): Promise<void>
}

export const STORE_KINDS: readonly StoreKind[] = ['sqlite', 'dynamodb']

export function storeKind(value: string | undefined): StoreKind {
  const kind = (value ?? 'sqlite').trim().toLowerCase() || 'sqlite'
  if (!(STORE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`LINELEDGER_STORE must be one of ${STORE_KINDS.join(', ')}, got "${value}"`)
  }
  return kind as StoreKind
}

/** Opens the store named by LINELEDGER_STORE (default sqlite). The DynamoDB module loads only when asked for. */
export async function openStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  if (storeKind(env.LINELEDGER_STORE) === 'dynamodb') {
    const { openDynamoDbStore } = await import('./store-dynamodb.js')
    return openDynamoDbStore(env)
  }
  const { SqliteStore } = await import('./store-sqlite.js')
  // The plant profile keeps no hand-written demo rows: its shifts, stock and trend come from the simulation.
  return SqliteStore.open(env.LINELEDGER_DB ?? 'data/lineledger.sqlite', { seed: env.LINELEDGER_PLANT !== '1' })
}
