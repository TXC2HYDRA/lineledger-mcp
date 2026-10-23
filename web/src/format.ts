// Turns structured tool results into short sentences for the transcript and for speech.
type Data = Record<string, any>

export type Status = 'on_track' | 'at_risk' | 'behind'

// Same thresholds as get_shift_summary on the server (>= 95 on track, >= 80 at risk).
export const statusOf = (percent: number): Status => (percent >= 95 ? 'on_track' : percent >= 80 ? 'at_risk' : 'behind')
export const STATUS_LABEL: Record<Status, string> = { on_track: '▲ ON TRACK', at_risk: '◆ AT RISK', behind: '▼ BEHIND' }

export function summarize(tool: string, d: Data): string {
  switch (tool) {
    case 'get_shift_summary': {
      const lines = (d.lines as Data[]).map(
        (l) => `${l.name} is at ${l.percent_of_target} percent of target, ${l.produced_units} of ${l.target_units}, ${l.status.replace('_', ' ')}`,
      )
      return `Shift ${d.shift} on ${d.shift_date}. ${lines.join('. ')}. Plant total ${d.totals.percent_of_target} percent.`
    }
    case 'create_handover_note':
      return `Saved handover note ${d.id}${d.line_id ? ` for ${d.line_id}` : ''}.`
    case 'list_handover_notes': {
      const notes = d.notes as Data[]
      return notes.length ? `${notes.length} handover notes. Latest: ${notes[0]!.text}` : 'No handover notes.'
    }
    case 'create_follow_up':
      return `Created follow-up ${d.id}: ${d.title}, owner ${d.owner}${d.due_date ? `, due ${d.due_date}` : ''}.`
    case 'list_follow_ups': {
      const items = d.follow_ups as Data[]
      return items.length ? `${items.length} follow-ups. ${items.map((f) => `${f.id}: ${f.title}, ${f.owner}`).join('. ')}.` : 'No follow-ups in that list.'
    }
    case 'close_follow_up':
      return `Closed follow-up ${d.id}: ${d.title}.`
    case 'check_stock': {
      const items = d.items as Data[]
      if (!items.length) return 'No stock item matches that.'
      return items
        .map((i) =>
          i.status === 'ok'
            ? `${i.name}: ${i.on_hand} ${i.unit} on hand, fine.`
            : `${i.name}: ${i.on_hand} ${i.unit} on hand, ${i.status === 'out_of_stock' ? 'out of stock' : 'below reorder point'}. Order ${i.suggested_order_qty} ${i.unit} from ${i.supplier}, lead time ${i.lead_days} days.`,
        )
        .join(' ')
    }
    case 'get_line_status': {
      const lines = (d.lines as Data[]).map((l) => {
        const down = (l.stations as Data[]).filter((s) => s.fault).map((s) => `${s.name}, ${s.fault}${s.waiting_for_part ? `, waiting for a spare ${s.waiting_for_part}` : ''}`)
        const state = l.state === 'down' ? `down: ${down.join('; ')}` : l.state === 'starved' ? `starved, out of ${l.material.sku}` : l.state
        const pace = l.percent_of_target_to_date === null ? '' : `, ${l.percent_of_target_to_date} percent of target to date`
        return `Line ${String(l.line_id).slice(1)} ${state}. ${l.produced_units} good units${pace}`
      })
      return `Plant time ${String(d.sim_time).slice(11)}, shift ${d.shift}. ${lines.join('. ')}.`
    }
    case 'get_factory_events': {
      const events = d.events as Data[]
      return events.length ? `Latest events: ${events.slice(0, 3).map((e) => `${String(e.sim_time).slice(11)} ${e.message}`).join('. ')}.` : 'No events yet.'
    }
    case 'inject_fault':
    case 'clear_fault':
    case 'set_line_running':
      return `${d.message} Line ${String(d.line.line_id).slice(1)} is now ${d.line.state}.`
    case 'receive_stock':
      return `${d.message} ${d.on_hand} on hand.`
    case 'plan_container_load':
      return `${d.count} boxes fit, limited by ${d.limitedBy}. Volume ${Math.round(d.volumeUtilisation * 100)} percent, payload ${Math.round(d.payloadUtilisation * 100)} percent, ${d.totalWeightKg} kilograms.`
    default:
      return 'Done.'
  }
}
