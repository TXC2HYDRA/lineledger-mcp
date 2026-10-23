import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FactorySim } from '../server/sim.js'
import type { Store } from '../server/store.js'
import { HARNESSES } from './harness.js'

const MIN = 60_000
const HOUR = 60 * MIN
const onHand = async (store: Store, sku: string) => (await store.findStock(sku)).find((r) => r.sku === sku)!.on_hand

describe.each(HARNESSES)('$name store: factory simulation', (h) => {
  let store: Store
  const extra: Store[] = []
  beforeEach(async () => {
    store = await h.open()
  })
  afterEach(async () => {
    await h.dispose(store)
    for (const s of extra.splice(0)) await h.dispose(s)
  })

  it('starts with the shift after the latest one on record, all lines running', async () => {
    const sim = await FactorySim.create(store, { faults: 'off' })
    expect(sim.status()).toMatchObject({ sim_time: '2026-10-22 06:00', shift_date: '2026-10-22', shift: 'A', shift_elapsed_min: 0, shift_length_min: 480 })
    expect(sim.status().lines.map((l) => [l.line_id, l.state, l.material.on_hand])).toEqual([
      ['L1', 'running', 1850],
      ['L2', 'running', 420],
    ])
  })

  it('produces at the bottleneck rate and draws material per unit', async () => {
    const sim = await FactorySim.create(store, { faults: 'off' })
    await sim.advance(2 * HOUR)
    const [l1, l2] = sim.status().lines
    // L1 bottleneck 22.5 s = 160 units/h, L2 34 s = about 106 units/h; up to 3 % slower, before scrap
    expect(l1!.produced_units + l1!.scrap_units).toBeGreaterThanOrEqual(310)
    expect(l1!.produced_units + l1!.scrap_units).toBeLessThanOrEqual(320)
    expect(l2!.produced_units + l2!.scrap_units).toBeGreaterThanOrEqual(205)
    expect(l2!.produced_units + l2!.scrap_units).toBeLessThanOrEqual(212)
    expect(l1!.material.on_hand).toBe(Math.floor(1850 - (l1!.produced_units + l1!.scrap_units) * 0.35 + 1e-9))
    expect(sim.status().shift_elapsed_min).toBe(120)
    await sim.flushNow()
    expect(await onHand(store, 'STL-040')).toBe(l1!.material.on_hand)
  })

  it('a material shortage starves the line until stock is received', async () => {
    const sim = await FactorySim.create(store, { faults: 'off' })
    await sim.advance(4 * HOUR) // 420 kg of HDPE at 1.2 kg per crate lasts about 3.3 h
    const l2 = sim.status().lines[1]!
    expect(l2.state).toBe('starved')
    expect(l2.produced_units + l2.scrap_units).toBe(350)
    expect(l2.downtime_min).toBeGreaterThan(30)
    expect(sim.events({ limit: 50, line_id: 'L2' }).map((e) => e.kind)).toEqual(expect.arrayContaining(['stock_low', 'starved']))
    expect(await onHand(store, 'PLY-HDPE')).toBe(0)
    const r = await sim.receiveStock('PLY-HDPE', 2500)
    expect(r).toMatchObject({ ok: true, on_hand: 2500 })
    expect(sim.status().lines[1]!.state).toBe('running')
    await sim.advance(30 * MIN)
    expect(sim.status().lines[1]!.produced_units).toBeGreaterThan(l2.produced_units + 40)
    expect(sim.events({ limit: 3, line_id: 'L2' }).map((e) => e.kind)).toContain('material_ok')
  })

  it('an injected fault stops the line, counts downtime and repairs itself after a while', async () => {
    const sim = await FactorySim.create(store, { faults: 'off' })
    expect(await sim.injectFault('L1', 'press')).toMatchObject({ ok: true })
    expect(await sim.injectFault('L1', 'press')).toMatchObject({ ok: false, message: expect.stringMatching(/already down/) })
    const l1 = sim.status().lines[0]!
    expect(l1.state).toBe('down')
    expect(l1.stations.map((s) => s.state)).toEqual(['idle', 'down', 'idle'])
    await sim.advance(10 * MIN) // repair takes 70 to 130 % of 18 min, so at least 12 min
    expect(sim.status().lines[0]).toMatchObject({ state: 'down', produced_units: 0, downtime_min: 10 })
    await sim.advance(20 * MIN)
    expect(sim.status().lines[0]!.state).toBe('running')
    expect(sim.events({ limit: 1, line_id: 'L1' })[0]).toMatchObject({ kind: 'repaired', station_id: 'press' })
  })

  it('a heater band failure waits for a spare part, then repairs once one is received', async () => {
    const sim = await FactorySim.create(store, { faults: 'off' })
    await sim.injectFault('L2', 'sealer', 'Heater band failed')
    expect(sim.status().lines[1]!.stations[2]).toMatchObject({ state: 'down', waiting_for_part: 'HTR-BAND' })
    expect(await sim.clearFault('L2', 'sealer')).toMatchObject({ ok: false, message: expect.stringMatching(/out of stock/) })
    await sim.advance(60 * MIN)
    expect(sim.status().lines[1]!.state).toBe('down') // no spare, no repair
    await sim.receiveStock('HTR-BAND', 3)
    expect(sim.status().lines[1]!.stations[2]!.waiting_for_part).toBeNull()
    expect(await onHand(store, 'HTR-BAND')).toBe(2)
    await sim.advance(35 * MIN) // 25 min x 1.3 at most
    expect(sim.status().lines[1]!.state).toBe('running')
  })

  it('an operator stop halts production without counting downtime', async () => {
    const sim = await FactorySim.create(store, { faults: 'off' })
    await sim.setRunning('L1', false)
    await sim.advance(30 * MIN)
    expect(sim.status().lines[0]).toMatchObject({ state: 'stopped', produced_units: 0, downtime_min: 0 })
    expect(sim.status().lines[0]!.stations.every((s) => s.state === 'idle')).toBe(true)
    expect(await sim.setRunning('L9', true)).toMatchObject({ ok: false, message: 'Unknown line "L9".' })
  })

  it('writes both lines at shift end, skips the night and continues after a restart', async () => {
    const sim = await FactorySim.create(store, { faults: 'off' })
    await sim.advance(8 * HOUR)
    const rows = await store.shiftLines('2026-10-22', 'A')
    expect(rows.map((r) => [r.line_id, r.target_units])).toEqual([
      ['L1', 1200],
      ['L2', 800],
    ])
    expect(rows[0]!.produced_units).toBeGreaterThan(1150)
    expect(rows[1]!.downtime_min).toBeGreaterThan(250)
    expect(sim.status()).toMatchObject({ shift_date: '2026-10-22', shift: 'B', sim_time: '2026-10-22 14:00' })

    const again = await FactorySim.create(store, { faults: 'off' }) // a restart picks up after shift A
    expect(again.status()).toMatchObject({ shift_date: '2026-10-22', shift: 'B' })
    await again.advance(8 * HOUR)
    expect(again.status()).toMatchObject({ shift_date: '2026-10-23', shift: 'A', sim_time: '2026-10-23 06:00' })
    expect(await store.latestShift({})).toEqual({ shift_date: '2026-10-22', shift: 'B' })
  })

  it('random faults are reproducible from the seed', async () => {
    const run = async (seed: number) => {
      const s = await h.open()
      extra.push(s)
      const sim = await FactorySim.create(s, { seed })
      for (let i = 0; i < 16; i++) await sim.advance(HOUR)
      return { status: sim.status(), events: sim.events({ limit: 200 }).map((e) => `${e.sim_time} ${e.message}`) }
    }
    const a = await run(7)
    const b = await run(7)
    const c = await run(8)
    expect(b).toEqual(a)
    expect(c.events).not.toEqual(a.events)
    expect(a.events.filter((e) => / down: /.test(e)).length).toBeGreaterThan(0)
  })
})
