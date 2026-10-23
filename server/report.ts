// End-of-shift digest: built from the store, sent by lambda/shift-report.ts on an EventBridge schedule.
import type { AlertEvent } from './notify.js'
import { lineStatus, percentOf, stockStatus } from './rules.js'
import type { Store } from './store.js'

export async function buildShiftReport(store: Store, today = new Date().toISOString().slice(0, 10)): Promise<AlertEvent> {
  const latest = await store.latestShift({})
  if (!latest) return { subject: 'LineLedger shift report: no shift data', message: 'No shift data on record.' }
  const [rows, stock, followUps] = await Promise.all([
    store.shiftLines(latest.shift_date, latest.shift),
    store.findStock(''),
    store.listFollowUps({ status: 'open' }),
  ])
  const lines = rows.map((r) => ({ ...r, percent: percentOf(r.produced_units, r.target_units) }))
  const flagged = lines.filter((l) => lineStatus(l.percent) !== 'on_track')
  const reorder = stock.filter((s) => stockStatus(s.on_hand, s.reorder_point) !== 'ok')
  const overdue = followUps.filter((f) => f.due_date !== null && f.due_date < today)
  const out = [`Shift ${latest.shift_date} ${latest.shift} (synthetic demo data)`, '']
  out.push(...lines.map((l) => `${l.line_id} ${l.name}: ${l.percent}% of target, ${l.downtime_min} min down, ${lineStatus(l.percent)}`))
  out.push('', `Stock to reorder: ${reorder.length ? reorder.map((s) => `${s.sku} (${s.on_hand} ${s.unit})`).join(', ') : 'none'}`)
  out.push(`Open follow-ups: ${followUps.length}, overdue: ${overdue.length}`)
  return {
    subject: `LineLedger shift ${latest.shift_date} ${latest.shift}: ${flagged.length} line(s) need attention, ${reorder.length} to reorder`,
    message: out.join('\n'),
  }
}
