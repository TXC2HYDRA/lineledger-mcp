import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPlantSeed, PLANNED_MIN, PLANT } from '../server/plant.js'
import { FactorySim, plannedElapsed } from '../server/sim.js'
import { SqliteStore } from '../server/store-sqlite.js'
import type { Store } from '../server/store.js'
import { HARNESSES } from './harness.js'

const MIN = 60_000
const HOUR = 60 * MIN
const onHand = async (store: Store, sku: string) => (await store.findStock(sku)).find((r) => r.sku === sku)!.on_hand
const line = (sim: FactorySim, id: string) => sim.snapshot().lines.find((l) => l.line_id === id)!

describe('plant definition', () => {
  it('has seven lines, the documented targets and 430 planned minutes per shift', () => {
    expect(PLANT.synthetic).toBe(true)
    expect(PLANT.lines.map((l) => [l.id, l.target.A])).toEqual([
      ['L1', 1200], ['L2', 800], ['L3', 400], ['L4', 940], ['L5', 980], ['L6', 460], ['L7', 690],
    ])
    expect(PLANNED_MIN).toBe(430)
    // target = 80 % of planned capacity, rounded to 10 (L1 and L2 keep the seed's 1200 and 800)
    for (const l of PLANT.lines.slice(2)) expect(l.target.A, l.id).toBe(Math.round((0.8 * PLANNED_MIN * 60) / l.ideal_cycle_s / 10) * 10)
    expect(Object.values(PLANT.shifts).map((s) => s.lines)).toEqual(['all', 'all', ['L2', 'L4']])
  })

  it('counts planned time without the breaks', () => {
    expect([0, 120, 125, 130, 240, 270, 360, 370, 480].map(plannedElapsed)).toEqual([0, 120, 120, 120, 230, 230, 320, 320, 430])
  })
})

describe.each(HARNESSES)('$name store: Tarnby Works simulation', (h) => {
  let store: Store
  const extra: Store[] = []
  beforeEach(async () => {
    store = await h.open()
    expect(await applyPlantSeed(store)).toBe(true)
    expect(await applyPlantSeed(store)).toBe(false) // once only
  })
  afterEach(async () => {
    await h.dispose(store)
    for (const s of extra.splice(0)) await h.dispose(s)
  })

  it('the plant seed adds Lines 3 to 7 and the plant stock levels', async () => {
    expect(await store.lineExists('L7')).toBe(true)
    expect(await onHand(store, 'PLY-HDPE')).toBe(20400)
    expect(await onHand(store, 'FLM-SHR')).toBe(42)
  })

  it('starts the story at 12:55 with shift A already run from 06:00 and stored', async () => {
    const sim = await FactorySim.create(store)
    const s = sim.snapshot()
    expect(s).toMatchObject({ synthetic: true, company: 'Tarnby Works', sim_clock: { sim_now: '2026-10-22 12:55' }, shift: { date: '2026-10-22', shift: 'A', lead: 'Asha', planned_elapsed_min: 365 } })
    expect(s.shift.headcount).toBe(28 + 7)
    expect(s.lines.filter((l) => l.state === 'RUN').length).toBeGreaterThanOrEqual(6)
    const rows = await store.shiftLines('2026-10-22', 'A')
    expect(rows).toHaveLength(7)
    expect(rows.find((r) => r.line_id === 'L1')!.produced_units).toBe(line(sim, 'L1').produced_units)
    expect(await store.latestShift({})).toEqual({ shift_date: '2026-10-22', shift: 'A' })
  })

  it('runs the scripted sealer overheat on Line 2 and the coil jam on Line 5', async () => {
    const sim = await FactorySim.create(store)
    await sim.advance(19 * MIN) // the minute 12:55 to 13:13 run: 189.8 °C, no alarm yet
    expect(line(sim, 'L2').open_alarms).toEqual([])
    await sim.advance(MIN) // minute 13:14: 190.9 °C, warn
    expect(line(sim, 'L2').open_alarms.map((a) => a.code)).toEqual(['M3-TEMP-HI'])
    expect(line(sim, 'L2').state).toBe('RUN')
    await sim.advance(9 * MIN) // minute 13:23: 200.8 °C, trip
    expect(line(sim, 'L2')).toMatchObject({ state: 'STOP_FAULT', reason_code: 'SEALER_FAULT', since: '2026-10-22 13:23' })
    expect(line(sim, 'L2').signals[0]!.value).toBeGreaterThanOrEqual(200)
    await sim.advance(19 * MIN) // 13:43
    expect(line(sim, 'L5')).toMatchObject({ state: 'STOP_OTHER', reason_code: 'COIL_JAM' })
    await sim.advance(7 * MIN) // 13:50
    expect(line(sim, 'L5').state).not.toBe('STOP_OTHER')
    await sim.advance(9 * MIN) // 13:59: band swapped, alarms cleared, still stopped
    expect(line(sim, 'L2')).toMatchObject({ state: 'STOP_FAULT', open_alarms: [] })
    expect(Math.abs(line(sim, 'L2').signals[0]!.value - 180)).toBeLessThan(3) // back to baseline noise
    await sim.advance(4 * MIN) // 14:03, shift B
    expect(sim.snapshot().shift).toMatchObject({ shift: 'B', lead: 'Joel' })
    expect(line(sim, 'L2').state).toBe('RUN')
    const kinds = sim.events({ limit: 200, line_id: 'L2' }).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['alarm', 'quality_check', 'stop', 'note', 'part_swap', 'alarm_clear', 'restart']))
    const a = (await store.shiftLines('2026-10-22', 'A')).find((r) => r.line_id === 'L2')!
    expect(a.produced_units).toBe(678) // seed 1: the story's frozen number
    expect(a.downtime_min).toBeGreaterThanOrEqual(37) // 13:23 to 14:00 at least
    await sim.flushNow()
    expect(await onHand(store, 'HTR-BAND')).toBe(2)
  })

  it('pace counts against the target to date, and a long stop is behind', async () => {
    const sim = await FactorySim.create(store)
    const l1 = line(sim, 'L1')
    expect(l1.target_to_date).toBe(Math.round((1200 * 365) / 430))
    expect(l1.pace_percent).toBe(Math.round((l1.produced_units / l1.target_to_date) * 1000) / 10)
    await sim.advance(45 * MIN) // 13:40, L2 stopped for 17 minutes
    expect(line(sim, 'L2')).toMatchObject({ state: 'STOP_FAULT', status: 'behind' })
  })

  it('a material shortage idles a line until a goods receipt', async () => {
    await store.setStockOnHand('LBL-ROLL', 0) // Lines 3 and 7 use 1 roll per 500 labels
    const sim = await FactorySim.create(store, { story: false, faults: 'off' }) // starts with shift C of 10-21
    await sim.advance(8 * HOUR + 30 * MIN) // 06:30 on 10-22, shift A
    expect(line(sim, 'L3')).toMatchObject({ state: 'IDLE_STARVED', reason_code: 'NO_LBL-ROLL' })
    expect(line(sim, 'L7').state).toBe('IDLE_STARVED')
    expect(sim.events({ limit: 300 }).some((e) => e.kind === 'starved')).toBe(true)
    expect(await sim.receiveStock('LBL-ROLL', 60)).toMatchObject({ ok: true, on_hand: 60 })
    await sim.advance(5 * MIN)
    expect(line(sim, 'L3').state).toBe('RUN')
    expect(line(sim, 'L3').downtime_min).toBeGreaterThanOrEqual(30)
  })

  it('shift C runs Lines 2 and 4 only, then the next morning starts with every line', async () => {
    const sim = await FactorySim.create(store, { story: false, faults: 'off' }) // continues after the stored 10-21 B
    expect(sim.snapshot().shift).toMatchObject({ date: '2026-10-21', shift: 'C', lead: 'Kofi', headcount: 2 + 2 + 2 })
    expect(sim.snapshot().lines.filter((l) => l.state !== 'OFF_SHIFT').map((l) => l.line_id)).toEqual(['L2', 'L4'])
    await sim.advance(8 * HOUR)
    expect(sim.snapshot().shift).toMatchObject({ date: '2026-10-22', shift: 'A' })
    const c = await store.shiftLines('2026-10-21', 'C')
    expect(c.map((r) => [r.line_id, r.target_units])).toEqual([['L2', 800], ['L4', 940]])
    expect(c[0]!.produced_units).toBeGreaterThan(400)
    expect(sim.snapshot().lines.every((l) => l.state !== 'OFF_SHIFT')).toBe(true)
  })

  it('the same seed gives the same day; another seed does not', async () => {
    const run = async (seed: number) => {
      const s = await h.open()
      extra.push(s)
      await applyPlantSeed(s)
      const sim = await FactorySim.create(s, { seed })
      for (let i = 0; i < 12; i++) await sim.advance(HOUR)
      const snap = sim.snapshot()
      return { lines: snap.lines.map((l) => [l.line_id, l.state, l.produced_units, l.reject_units, l.downtime_min]), events: sim.events({ limit: 300 }).map((e) => `${e.sim_time} ${e.message}`) }
    }
    const a = await run(7)
    expect(await run(7)).toEqual(a)
    expect((await run(8)).events).not.toEqual(a.events)
  })
})

describe('plant profile on an empty store (no hand-written demo rows)', () => {
  it('holds a week of simulated shifts, no seed notes or follow-ups, the starting stock, and still runs the story day', async () => {
    const store = SqliteStore.open(':memory:', { seed: false })
    expect(await store.listNotes({ limit: 10 })).toEqual([])
    expect(await store.listFollowUps({ status: 'all' })).toEqual([])
    expect(await applyPlantSeed(store)).toBe(true)
    await FactorySim.history(store)

    const shifts = await store.recentShifts(500)
    const dates = [...new Set(shifts.map((r) => r.shift_date))]
    expect(dates).toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'])
    expect(new Set(shifts.map((r) => r.line_id)).size).toBe(7) // every line has history, not just L1 and L2
    for (const r of shifts) {
      expect(r.produced_units).toBeGreaterThan(0.5 * r.target_units) // nothing starves: a week of receipts is not modelled
      expect(r.produced_units).toBeLessThan(1.25 * r.target_units)
    }
    expect(await store.latestShift({})).toEqual({ shift_date: '2026-10-21', shift: 'C' })
    expect(await onHand(store, 'PLY-HDPE')).toBe(20400) // history does not eat the story's stock

    const sim = await FactorySim.create(store)
    expect(sim.snapshot().sim_clock.sim_now).toBe('2026-10-22 12:55')
    expect(await store.latestShift({})).toEqual({ shift_date: '2026-10-22', shift: 'A' })
  })
})
