import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SEED_FOLLOW_UPS, SEED_LINES, SEED_NOTES, SEED_SHIFT_OUTPUT, SEED_STOCK, seedHistory } from './seed.js'

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shift_output (
  line_id TEXT NOT NULL REFERENCES lines(id),
  shift_date TEXT NOT NULL,
  shift TEXT NOT NULL CHECK (shift IN ('A','B','C')),
  target_units INTEGER NOT NULL,
  produced_units INTEGER NOT NULL,
  downtime_min INTEGER NOT NULL,
  PRIMARY KEY (line_id, shift_date, shift)
);
CREATE TABLE IF NOT EXISTS handover_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id TEXT REFERENCES lines(id),
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  line_id TEXT REFERENCES lines(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS sim_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_items (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  on_hand INTEGER NOT NULL,
  reorder_point INTEGER NOT NULL,
  reorder_qty INTEGER NOT NULL,
  lead_days INTEGER NOT NULL,
  supplier TEXT NOT NULL
);
`

// All values are synthetic demo data (server/seed.ts), shared with the DynamoDB store.
function seed(db: Db): void {
  const lines = db.prepare('INSERT INTO lines (id, name, product) VALUES (?, ?, ?)')
  for (const l of SEED_LINES) lines.run(l.id, l.name, l.product)

  const output = db.prepare(
    'INSERT INTO shift_output (line_id, shift_date, shift, target_units, produced_units, downtime_min) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const o of SEED_SHIFT_OUTPUT) output.run(o.line_id, o.shift_date, o.shift, o.target_units, o.produced_units, o.downtime_min)

  const note = db.prepare('INSERT INTO handover_notes (line_id, author, text, created_at) VALUES (?, ?, ?, ?)')
  for (const n of SEED_NOTES) note.run(n.line_id, n.author, n.text, n.created_at)

  const followUp = db.prepare(
    'INSERT INTO follow_ups (title, owner, line_id, due_date, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  for (const f of SEED_FOLLOW_UPS) followUp.run(f.title, f.owner, f.line_id, f.due_date, f.created_at)

  const stock = db.prepare(
    'INSERT INTO stock_items (sku, name, unit, on_hand, reorder_point, reorder_qty, lead_days, supplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const s of SEED_STOCK) stock.run(s.sku, s.name, s.unit, s.on_hand, s.reorder_point, s.reorder_qty, s.lead_days, s.supplier)
}

// Synthetic trend for the six days before the seeded shifts.
// INSERT OR IGNORE keeps this idempotent, so databases created before the trend card get it too.
function seedHistoryRows(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO shift_output (line_id, shift_date, shift, target_units, produced_units, downtime_min) VALUES (?, ?, ?, ?, ?, ?)')
  for (const r of seedHistory()) insert.run(r.line_id, r.shift_date, r.shift, r.target_units, r.produced_units, r.downtime_min)
}

/** `seed: false` leaves the database empty of demo rows (the plant profile fills it from the simulation). */
export function openDb(path = ':memory:', { seed: seedDemo = true }: { seed?: boolean } = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  // One transaction: a crash mid-seed leaves an empty database that seeds again, not a half-seeded one.
  db.exec('BEGIN IMMEDIATE')
  try {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM lines').get() as { n: number }
    if (seedDemo) {
      if (n === 0) seed(db)
      seedHistoryRows(db)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return db
}
