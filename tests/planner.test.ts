import { describe, expect, it } from 'vitest'
import { statusOf, summarize } from '../web/src/format.js'
import { plan } from '../web/src/planner.js'

const call = (text: string) => {
  const p = plan(text)
  if (p.kind !== 'call') throw new Error(`expected a call for "${text}", got help: ${p.message}`)
  return p
}

describe('rule-based planner', () => {
  it('maps requests to tools', () => {
    expect(call('shift summary')).toMatchObject({ tool: 'get_shift_summary', args: {} })
    expect(call('how are the lines doing in shift A')).toMatchObject({ tool: 'get_shift_summary', args: { shift: 'A' } })
    expect(call('show handover notes for line 2')).toMatchObject({ tool: 'list_handover_notes', args: { line_id: 'L2' } })
    expect(call('add handover note for line 2: sealer jaw ran hot')).toMatchObject({
      tool: 'create_handover_note',
      args: { text: 'sealer jaw ran hot', line_id: 'L2' },
    })
    expect(call('open follow-ups')).toMatchObject({ tool: 'list_follow_ups', args: { status: 'open' } })
    expect(call('show all follow ups')).toMatchObject({ args: { status: 'all' } })
    expect(call('close follow-up 3')).toMatchObject({ tool: 'close_follow_up', args: { id: 3 } })
    expect(call('close follow up #12')).toMatchObject({ args: { id: 12 } })
    expect(call('add follow-up: re-check guard, owner Ravi, due 2026-10-22, line 1')).toMatchObject({
      tool: 'create_follow_up',
      args: { title: 're-check guard', owner: 'Ravi', due_date: '2026-10-22', line_id: 'L1' },
    })
    expect(call('stock of hdpe')).toMatchObject({ tool: 'check_stock', args: { query: 'hdpe' } })
    expect(call('do we need to order heater bands')).toMatchObject({ tool: 'check_stock', args: { query: 'heater' } })
  })

  it('maps simulation requests to the simulation tools', () => {
    expect(call('line status')).toMatchObject({ tool: 'get_line_status', args: {} })
    expect(call('is line 2 down?')).toMatchObject({ tool: 'get_line_status', args: { line_id: 'L2' } })
    expect(call('what is running right now')).toMatchObject({ tool: 'get_line_status' })
    expect(call('simulate a fault on line 2 sealer')).toMatchObject({ tool: 'inject_fault', args: { line_id: 'L2', station_id: 'sealer' } })
    expect(call('simulate a heater band failure on the sealer')).toMatchObject({ tool: 'inject_fault', args: { line_id: 'L2', station_id: 'sealer', reason: 'Heater band failed' } })
    expect(call('trigger a jam at the slitter')).toMatchObject({ tool: 'inject_fault', args: { line_id: 'L1', station_id: 'slitter' } })
    expect(call('clear fault on line 2')).toMatchObject({ tool: 'clear_fault', args: { line_id: 'L2' } })
    expect(call('press on line 1 is fixed')).toMatchObject({ tool: 'clear_fault', args: { line_id: 'L1', station_id: 'press' } })
    expect(call('stop line 1')).toMatchObject({ tool: 'set_line_running', args: { line_id: 'L1', running: false } })
    expect(call('restart line 1')).toMatchObject({ tool: 'set_line_running', args: { line_id: 'L1', running: true } })
    expect(call('receive 2,500 kg hdpe')).toMatchObject({ tool: 'receive_stock', args: { sku: 'PLY-HDPE', quantity: 2500 } })
    expect(call('goods in: 6 heater bands')).toMatchObject({ tool: 'receive_stock', args: { sku: 'HTR-BAND', quantity: 6 } })
    expect(call('received 40 of LBL-ROLL')).toMatchObject({ tool: 'receive_stock', args: { sku: 'LBL-ROLL', quantity: 40 } })
    expect(call('factory events for line 2')).toMatchObject({ tool: 'get_factory_events', args: { line_id: 'L2' } })
    expect(call('what happened')).toMatchObject({ tool: 'get_factory_events' })
    // the earlier rules still win where they should
    expect(call('stock status of hdpe')).toMatchObject({ tool: 'check_stock' })
    expect(call('how are the lines doing in shift A')).toMatchObject({ tool: 'get_shift_summary' })
    expect(call('close follow-up 2')).toMatchObject({ tool: 'close_follow_up' })
    for (const text of ['simulate a fault', 'clear fault', 'receive hdpe', 'receive 40 things']) expect(plan(text).kind, text).toBe('help')
  })

  it('builds a container-load call with 20ft and 40ft presets', () => {
    const p20 = call('how many 600x400x300 12kg boxes fit in a 20ft container')
    expect(p20).toMatchObject({
      tool: 'plan_container_load',
      args: { item: { length: 600, width: 400, height: 300, weightKg: 12 }, rotation: 'upright' },
    })
    expect((p20.args.container as { length: number }).length).toBe(5898)
    const p40 = call('fit 60x40x30 cm 8 kg cartons in a 40 ft container, any rotation')
    expect((p40.args.container as { length: number }).length).toBe(12032)
    expect(p40.args).toMatchObject({ rotation: 'any', item: { length: 600, weightKg: 8 } })
  })

  it('asks for what is missing instead of guessing', () => {
    for (const text of ['', 'hello there', 'add follow-up: fix guard', 'add follow-up', 'add handover note', 'how many 600x400x300 boxes fit in a container', 'close follow-up']) {
      expect(plan(text).kind, text).toBe('help')
    }
  })
})

describe('summaries', () => {
  it('speaks stock reorders with quantity and lead time', () => {
    const text = summarize('check_stock', {
      items: [{ name: 'HDPE granules', unit: 'kg', on_hand: 420, status: 'reorder', suggested_order_qty: 2500, supplier: 'Demo Polymers Ltd', lead_days: 9 }],
    })
    expect(text).toContain('Order 2500 kg')
    expect(text).toContain('9 days')
  })
})

describe('statusOf', () => {
  it('matches the server thresholds at the boundaries', () => {
    expect([100, 95, 94.9, 80, 79.9, 0].map(statusOf)).toEqual(['on_track', 'on_track', 'at_risk', 'at_risk', 'behind', 'behind'])
  })
})
