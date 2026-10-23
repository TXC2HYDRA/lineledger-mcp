// Synthetic demo data shared by both stores. Names, SKUs and suppliers are invented.
import type { FollowUpRow, LineRow, NoteRow, ShiftOutputRow, StockRow } from './store.js'

export const SEED_LINES: LineRow[] = [
  { id: 'L1', name: 'Line 1', product: 'Steel bracket 40x60' },
  { id: 'L2', name: 'Line 2', product: 'Poly crate 600x400' },
]

export const SEED_SHIFT_OUTPUT: ShiftOutputRow[] = [
  { line_id: 'L1', shift_date: '2026-10-21', shift: 'A', target_units: 1200, produced_units: 1236, downtime_min: 12 },
  { line_id: 'L2', shift_date: '2026-10-21', shift: 'A', target_units: 800, produced_units: 704, downtime_min: 41 },
  { line_id: 'L1', shift_date: '2026-10-21', shift: 'B', target_units: 1200, produced_units: 1002, downtime_min: 35 },
  { line_id: 'L2', shift_date: '2026-10-21', shift: 'B', target_units: 800, produced_units: 612, downtime_min: 58 },
]

/** Seeded in this order, so the first gets id 1. */
export const SEED_NOTES: Omit<NoteRow, 'id'>[] = [
  { line_id: 'L2', author: 'Asha (shift A)', text: 'Sealer jaw on Line 2 ran hot after 10:00. Maintenance swapped the heater band.', created_at: '2026-10-21T08:40:00.000Z' },
  { line_id: 'L1', author: 'Asha (shift A)', text: 'Line 1 changeover to bracket 40x60 done at 06:15. First-off check passed.', created_at: '2026-10-21T06:30:00.000Z' },
]

/** Seeded in this order, so the first gets id 1. */
export const SEED_FOLLOW_UPS: Pick<FollowUpRow, 'title' | 'owner' | 'line_id' | 'due_date' | 'created_at'>[] = [
  { title: 'Re-check Line 2 sealer jaw temperature', owner: 'Ravi', line_id: 'L2', due_date: '2026-10-22', created_at: '2026-10-21T08:45:00.000Z' },
  { title: 'Order spare heater band', owner: 'Meena', line_id: 'L2', due_date: '2026-10-23', created_at: '2026-10-21T08:50:00.000Z' },
]

export const SEED_STOCK: StockRow[] = [
  { sku: 'STL-040', name: 'Steel strip 40mm', unit: 'kg', on_hand: 1850, reorder_point: 800, reorder_qty: 3000, lead_days: 6, supplier: 'Demo Metals Ltd' },
  { sku: 'PLY-HDPE', name: 'HDPE granules', unit: 'kg', on_hand: 420, reorder_point: 600, reorder_qty: 2500, lead_days: 9, supplier: 'Demo Polymers Ltd' },
  { sku: 'HTR-BAND', name: 'Heater band 230V', unit: 'pcs', on_hand: 0, reorder_point: 2, reorder_qty: 6, lead_days: 14, supplier: 'Demo Thermal Co' },
  { sku: 'LBL-ROLL', name: 'Label roll 100x50', unit: 'rolls', on_hand: 36, reorder_point: 20, reorder_qty: 60, lead_days: 3, supplier: 'Demo Print Works' },
]

// Synthetic trend for the six days before the seeded shifts: percent of target per shift (A then B, oldest first).
const HISTORY_START = Date.UTC(2026, 9, 15)
const HISTORY_PCT = {
  L1: { target: 1200, pct: [97, 94, 101, 96, 92, 98, 103, 99, 95, 90, 104, 96] },
  L2: { target: 800, pct: [88, 84, 91, 86, 79, 83, 90, 85, 82, 77, 87, 80] },
} as const

export function seedHistory(): ShiftOutputRow[] {
  const rows: ShiftOutputRow[] = []
  for (const [lineId, { target, pct }] of Object.entries(HISTORY_PCT)) {
    pct.forEach((p, i) => {
      rows.push({
        line_id: lineId,
        shift_date: new Date(HISTORY_START + Math.floor(i / 2) * 86_400_000).toISOString().slice(0, 10),
        shift: i % 2 === 0 ? 'A' : 'B',
        target_units: target,
        produced_units: Math.round((target * p) / 100),
        downtime_min: Math.max(5, Math.round((105 - p) * 2)),
      })
    })
  }
  return rows
}
