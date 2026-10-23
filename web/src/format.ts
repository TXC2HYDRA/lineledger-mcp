// Turns structured tool results into short sentences for the transcript and for speech.
type Data = Record<string, any>

export type Status = 'on_track' | 'at_risk' | 'behind'

// Same thresholds as get_shift_summary on the server (>= 95 on track, >= 80 at risk).
export const statusOf = (percent: number): Status => (percent >= 95 ? 'on_track' : percent >= 80 ? 'at_risk' : 'behind')
export const STATUS_LABEL: Record<Status, string> = { on_track: '▲ ON TRACK', at_risk: '◆ AT RISK', behind: '▼ BEHIND' }

const STATE_SPOKEN: Record<string, string> = {
  RUN: 'running',
  STOP_FAULT: 'stopped on a fault',
  STOP_OTHER: 'stopped',
  PLANNED_STOP: 'on a planned break',
  IDLE_STARVED: 'waiting for material',
  OFF_SHIFT: 'off shift',
}

export function summarize(tool: string, d: Data): string {
  switch (tool) {
    case 'get_shift_summary': {
      if (d.in_progress) {
        const lines = (d.lines as Data[]).map((l) => `${l.name} ${l.percent_of_pace} percent of target to date, ${l.status.replace('_', ' ')}`)
        return `Shift ${d.shift} on ${d.shift_date}, in progress. ${lines.join('. ')}. Plant ${d.totals.percent_of_pace} percent of target to date, target-weighted.`
      }
      const lines = (d.lines as Data[]).map(
        (l) => `${l.name} is at ${l.percent_of_target} percent of target, ${l.produced_units} of ${l.target_units}, ${l.status.replace('_', ' ')}`,
      )
      return `Shift ${d.shift} on ${d.shift_date}. ${lines.join('. ')}. Plant total ${d.totals.percent_of_target} percent${(d.lines as Data[]).length > 2 ? ', target-weighted' : ''}.`
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
            : `${i.name}: ${i.on_hand} ${i.unit} on hand, ${i.status === 'out_of_stock' ? 'out of stock' : 'at or below reorder point'}. Order ${i.suggested_order_qty} ${i.unit} from ${i.supplier}, lead time ${i.lead_days} days.${i.days_cover ? ` About ${i.days_cover} days of cover at the current use.` : ''}`,
        )
        .join(' ')
    }
    case 'get_live_line_status': {
      const lines = d.lines as Data[]
      const said = (l: Data) => {
        const temp = (l.signals as Data[]).map((g) => `${String(g.tag).split('.').pop()!.replace(/_c$/, '').replace(/_/g, ' ')} ${g.value} ${g.unit === '°C' ? 'degrees' : g.unit}, warn at ${g.warn_limit}, trip at ${g.trip_limit}`)
        const alarms = (l.open_alarms as Data[]).map((a) => a.code)
        const state = STATE_SPOKEN[l.state] ?? l.state
        const why = l.reason_code && l.state !== 'RUN' ? `, ${String(l.reason_code).replace(/_/g, ' ').toLowerCase()}` : ''
        const pace = l.pace_percent === null ? '' : `, ${l.pace_percent} percent of target to date`
        const rate = l.state === 'RUN' ? `, ${l.rate_per_h} an hour` : ''
        return `${l.name} ${state}${why} for ${l.minutes_in_state} minutes${rate}${pace}${temp.length ? `. ${temp.join('. ')}` : ''}${alarms.length ? `. Alarms: ${alarms.join(', ')}` : ''}`
      }
      if (lines.length === 1) return `Plant time ${String(d.sim_now).slice(11)}. ${said(lines[0]!)}.`
      const roll = Object.entries(d.roll_up as Record<string, number>).map(([k, n]) => `${n} ${STATE_SPOKEN[k] ?? k}`).join(', ')
      const stopped = lines.filter((l) => !['RUN', 'PLANNED_STOP', 'OFF_SHIFT'].includes(l.state)).map((l) => `${l.name} ${STATE_SPOKEN[l.state]}, ${String(l.reason_code).replace(/_/g, ' ').toLowerCase()}`)
      return `Plant time ${String(d.sim_now).slice(11)}, shift ${d.shift.shift}. ${roll}.${stopped.length ? ` ${stopped.join('. ')}.` : ' No line is stopped.'}`
    }
    case 'get_factory_events': {
      const events = d.events as Data[]
      return events.length ? `Latest events: ${events.slice(0, 3).map((e) => `${String(e.sim_time).slice(11)} ${e.message}`).join('. ')}.` : 'No events yet.'
    }
    case 'get_shift_history': {
      const shifts = (d.shifts as Data[]).filter((s) => !s.in_progress)
      if (!shifts.length) return 'No finished shifts yet.'
      const last = shifts.at(-1)!
      return `${shifts.length} finished shifts, from ${shifts[0]!.shift_date} ${shifts[0]!.shift} to ${last.shift_date} ${last.shift}. Last one: ${(last.lines as Data[]).map((l) => `${l.name} ${l.percent_of_target} percent`).join(', ')}.`
    }
    case 'receive_stock':
      return `${d.message} ${d.on_hand} on hand.`
    case 'plan_container_load':
      return `${d.count} boxes fit, limited by ${d.limitedBy}. Volume ${Math.round(d.volumeUtilisation * 100)} percent, payload ${Math.round(d.payloadUtilisation * 100)} percent, ${d.totalWeightKg} kilograms.`
    default:
      return 'Done.'
  }
}
