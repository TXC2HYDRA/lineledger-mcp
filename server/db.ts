import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

// All values below are synthetic demo data. Names, SKUs and suppliers are invented.
function seed(db: Db): void {
  const lines = db.prepare('INSERT INTO lines (id, name, product) VALUES (?, ?, ?)')
  lines.run('L1', 'Line 1', 'Steel bracket 40x60')
  lines.run('L2', 'Line 2', 'Poly crate 600x400')

  const output = db.prepare(
    'INSERT INTO shift_output (line_id, shift_date, shift, target_units, produced_units, downtime_min) VALUES (?, ?, ?, ?, ?, ?)',
  )
  output.run('L1', '2026-10-21', 'A', 1200, 1236, 12)
  output.run('L2', '2026-10-21', 'A', 800, 704, 41)
  output.run('L1', '2026-10-21', 'B', 1200, 1002, 35)
  output.run('L2', '2026-10-21', 'B', 800, 612, 58)

  const note = db.prepare('INSERT INTO handover_notes (line_id, author, text, created_at) VALUES (?, ?, ?, ?)')
  note.run('L2', 'Asha (shift A)', 'Sealer jaw on Line 2 ran hot after 10:00. Maintenance swapped the heater band.', '2026-10-21T08:40:00.000Z')
  note.run('L1', 'Asha (shift A)', 'Line 1 changeover to bracket 40x60 done at 06:15. First-off check passed.', '2026-10-21T06:30:00.000Z')

  const followUp = db.prepare(
    'INSERT INTO follow_ups (title, owner, line_id, due_date, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  followUp.run('Re-check Line 2 sealer jaw temperature', 'Ravi', 'L2', '2026-10-22', '2026-10-21T08:45:00.000Z')
  followUp.run('Order spare heater band', 'Meena', 'L2', '2026-10-23', '2026-10-21T08:50:00.000Z')

  const stock = db.prepare(
    'INSERT INTO stock_items (sku, name, unit, on_hand, reorder_point, reorder_qty, lead_days, supplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  stock.run('STL-040', 'Steel strip 40mm', 'kg', 1850, 800, 3000, 6, 'Demo Metals Ltd')
  stock.run('PLY-HDPE', 'HDPE granules', 'kg', 420, 600, 2500, 9, 'Demo Polymers Ltd')
  stock.run('HTR-BAND', 'Heater band 230V', 'pcs', 0, 2, 6, 14, 'Demo Thermal Co')
  stock.run('LBL-ROLL', 'Label roll 100x50', 'rolls', 36, 20, 60, 3, 'Demo Print Works')
}

// Synthetic trend for the six days before the seeded shifts: percent of target per shift (A then B, oldest first).
// INSERT OR IGNORE keeps this idempotent, so databases created before the trend card get it too.
const HISTORY_START = Date.UTC(2026, 9, 15)
const HISTORY_PCT = {
  L1: { target: 1200, pct: [97, 94, 101, 96, 92, 98, 103, 99, 95, 90, 104, 96] },
  L2: { target: 800, pct: [88, 84, 91, 86, 79, 83, 90, 85, 82, 77, 87, 80] },
} as const
function seedHistory(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO shift_output (line_id, shift_date, shift, target_units, produced_units, downtime_min) VALUES (?, ?, ?, ?, ?, ?)')
  for (const [lineId, { target, pct }] of Object.entries(HISTORY_PCT)) {
    pct.forEach((p, i) => {
      const date = new Date(HISTORY_START + Math.floor(i / 2) * 86_400_000).toISOString().slice(0, 10)
      insert.run(lineId, date, i % 2 === 0 ? 'A' : 'B', target, Math.round((target * p) / 100), Math.max(5, Math.round((105 - p) * 2)))
    })
  }
}

export function openDb(path = ':memory:'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  // One transaction: a crash mid-seed leaves an empty database that seeds again, not a half-seeded one.
  db.exec('BEGIN IMMEDIATE')
  try {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM lines').get() as { n: number }
    if (n === 0) seed(db)
    seedHistory(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return db
}
