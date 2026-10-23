// A small production-line simulation behind the MCP tools. All of it is synthetic.
//
// Two serial lines, three stations each, no buffers: a line produces at its slowest station's rate while
// every station is up, the operator has it running and its raw material is in stock. Stations fail at
// random (seeded, exponential time between failures) and are repaired after a while; a failed sealer
// heater band needs a spare part from stock. Material is drawn from stock per good unit. Shift A runs
// 06:00-14:00 and shift B 14:00-22:00 in simulated plant time; there is no night shift, so the clock jumps
// to the next morning. At the end of each shift the result is written to the store as a shift_output row,
// which is what get_shift_summary and get_shift_history read.
//
// The simulation keeps its live state in memory and writes stock levels and finished shifts to the store.
// On restart it continues with the shift after the latest one on record.
import type { ShiftOutputRow, Store } from './store.js'

interface StationSpec {
  id: string
  name: string
  cycleSec: number
  mtbfMin: number
  mttrMin: number
  faults: string[]
  /** A fault that needs a spare part from stock before the repair can start; `chance` of a random failure. */
  partFault?: { reason: string; sku: string; chance: number }
}

interface LineSpec {
  id: string
  targetPerShift: number
  scrapRate: number
  material: { sku: string; perUnit: number }
  stations: StationSpec[]
}

export const LINE_SPECS: LineSpec[] = [
  {
    id: 'L1',
    targetPerShift: 1200,
    scrapRate: 0.012,
    material: { sku: 'STL-040', perUnit: 0.35 },
    stations: [
      { id: 'slitter', name: 'Slitter', cycleSec: 20, mtbfMin: 600, mttrMin: 12, faults: ['Coil jam', 'Blade wear alarm'] },
      { id: 'press', name: 'Press', cycleSec: 22.5, mtbfMin: 420, mttrMin: 18, faults: ['Die misfeed', 'Hydraulic pressure low'] },
      { id: 'packer', name: 'Packer', cycleSec: 18, mtbfMin: 900, mttrMin: 8, faults: ['Carton magazine empty'] },
    ],
  },
  {
    id: 'L2',
    targetPerShift: 800,
    scrapRate: 0.02,
    material: { sku: 'PLY-HDPE', perUnit: 1.2 },
    stations: [
      { id: 'extruder', name: 'Extruder', cycleSec: 30, mtbfMin: 720, mttrMin: 20, faults: ['Barrel zone 3 over temperature'] },
      { id: 'moulder', name: 'Moulder', cycleSec: 34, mtbfMin: 480, mttrMin: 15, faults: ['Mould clamp fault', 'Ejector pin stuck'] },
      {
        id: 'sealer',
        name: 'Sealer',
        cycleSec: 28,
        mtbfMin: 360,
        mttrMin: 25,
        faults: ['Sealer jaw temperature high'],
        partFault: { reason: 'Heater band failed', sku: 'HTR-BAND', chance: 0.25 },
      },
    ],
  },
]

export const SHIFTS = { A: { startMin: 360 }, B: { startMin: 840 } } as const
export const SHIFT_MIN = 480
const MINUTE = 60_000
const DAY = 86_400_000
const FLUSH_EVERY_MIN = 10
const DEFAULT_START = Date.UTC(2026, 9, 22) // used only when the store has no shift on record

export type LineState = 'running' | 'down' | 'starved' | 'stopped'
export type EventKind =
  | 'shift_start'
  | 'shift_end'
  | 'fault'
  | 'waiting_for_part'
  | 'repair_started'
  | 'repaired'
  | 'starved'
  | 'material_ok'
  | 'stock_low'
  | 'stock_received'
  | 'line_stopped'
  | 'line_started'

export interface FactoryEvent {
  id: number
  sim_time: string
  line_id: string | null
  station_id: string | null
  kind: EventKind
  message: string
}

export interface StationStatus {
  station_id: string
  name: string
  state: 'running' | 'down' | 'idle'
  fault: string | null
  down_since: string | null
  waiting_for_part: string | null
}

export interface LineStatus {
  line_id: string
  state: LineState
  produced_units: number
  scrap_units: number
  target_units: number
  target_to_date: number
  percent_of_target_to_date: number | null
  pace: 'on_track' | 'at_risk' | 'behind' | null
  downtime_min: number
  material: { sku: string; on_hand: number; per_unit: number }
  stations: StationStatus[]
}

export interface FactoryStatus {
  sim_time: string
  shift_date: string
  shift: 'A' | 'B'
  shift_elapsed_min: number
  shift_length_min: number
  lines: LineStatus[]
}

interface Fault {
  reason: string
  since: number
  repairAt: number | null
  needsPart: string | null
}

interface StationRuntime {
  spec: StationSpec
  fault: Fault | null
}

interface LineRuntime {
  spec: LineSpec
  running: boolean
  produced: number
  scrap: number
  unitAcc: number
  scrapAcc: number
  downtimeMin: number
  starved: boolean
  stations: StationRuntime[]
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string }

export interface SimOptions {
  seed?: number
  /** 'random' (default): stations fail at random. 'off': only injected faults. */
  faults?: 'random' | 'off'
}

/** Small seeded PRNG (mulberry32): the same seed gives the same run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fmt = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = (t: number) => new Date(t).toISOString().slice(0, 10)
const minuteOfDay = (t: number) => Math.floor((t % DAY) / MINUTE)
const round1 = (n: number) => Math.round(n * 10) / 10

export class FactorySim {
  private t = 0
  private shift: 'A' | 'B' = 'A'
  private shiftStart = 0
  private readonly lines: LineRuntime[]
  private readonly stock = new Map<string, { onHand: number; reorderPoint: number; dirty: boolean }>()
  private readonly log: FactoryEvent[] = []
  private nextEventId = 1
  private lastFlush = 0
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(change: { events: boolean }) => void>()
  private newEvents = false
  private readonly rng: () => number
  private readonly randomFaults: boolean
  private timer: ReturnType<typeof setInterval> | undefined

  private constructor(
    private readonly store: Store,
    options: SimOptions,
  ) {
    this.rng = mulberry32(options.seed ?? 20261022)
    this.randomFaults = (options.faults ?? 'random') === 'random'
    this.lines = LINE_SPECS.map((spec) => ({
      spec,
      running: true,
      produced: 0,
      scrap: 0,
      unitAcc: 0,
      scrapAcc: 0,
      downtimeMin: 0,
      starved: false,
      stations: spec.stations.map((s) => ({ spec: s, fault: null })),
    }))
  }

  /** Loads stock and the latest recorded shift from the store, then starts at the next shift. */
  static async create(store: Store, options: SimOptions = {}): Promise<FactorySim> {
    const sim = new FactorySim(store, options)
    const skus = new Set(LINE_SPECS.flatMap((l) => [l.material.sku, ...l.stations.flatMap((s) => (s.partFault ? [s.partFault.sku] : []))]))
    for (const sku of skus) {
      const row = (await store.findStock(sku)).find((r) => r.sku === sku)
      if (!row) throw new Error(`simulation needs stock item ${sku}`)
      sim.stock.set(sku, { onHand: row.on_hand, reorderPoint: row.reorder_point, dirty: false })
    }
    const latest = await store.latestShift({})
    if (!latest) sim.beginShift(DEFAULT_START + SHIFTS.A.startMin * MINUTE, 'A')
    else {
      const day = Date.parse(`${latest.shift_date}T00:00:00.000Z`)
      if (latest.shift === 'A') sim.beginShift(day + SHIFTS.B.startMin * MINUTE, 'B')
      else sim.beginShift(day + DAY + SHIFTS.A.startMin * MINUTE, 'A')
    }
    sim.lastFlush = sim.t
    for (const line of sim.lines) {
      const material = sim.stock.get(line.spec.material.sku)!
      if (material.onHand <= material.reorderPoint) {
        sim.record('stock_low', `${line.spec.material.sku} at ${Math.floor(material.onHand)}, at or below its reorder point`, line.spec.id)
      }
    }
    return sim
  }

  // ---- public API (every mutation goes through one queue, so ticks and tool calls never interleave) ----

  status(): FactoryStatus {
    const elapsed = (this.t - this.shiftStart) / MINUTE
    return {
      sim_time: fmt(this.t),
      shift_date: dateOf(this.shiftStart),
      shift: this.shift,
      shift_elapsed_min: Math.floor(elapsed),
      shift_length_min: SHIFT_MIN,
      lines: this.lines.map((line) => {
        const targetToDate = Math.round((line.spec.targetPerShift * elapsed) / SHIFT_MIN)
        const percent = targetToDate > 0 ? round1((line.produced / targetToDate) * 100) : null
        const material = this.stock.get(line.spec.material.sku)!
        return {
          line_id: line.spec.id,
          state: this.lineState(line),
          produced_units: line.produced,
          scrap_units: line.scrap,
          target_units: line.spec.targetPerShift,
          target_to_date: targetToDate,
          percent_of_target_to_date: percent,
          pace: percent === null ? null : percent >= 95 ? 'on_track' : percent >= 80 ? 'at_risk' : 'behind',
          downtime_min: Math.round(line.downtimeMin),
          material: { sku: line.spec.material.sku, on_hand: Math.floor(material.onHand), per_unit: line.spec.material.perUnit },
          stations: line.stations.map((s) => ({
            station_id: s.spec.id,
            name: s.spec.name,
            state: s.fault ? 'down' : this.lineState(line) === 'running' ? 'running' : 'idle',
            fault: s.fault?.reason ?? null,
            down_since: s.fault ? fmt(s.fault.since) : null,
            waiting_for_part: s.fault?.needsPart ?? null,
          })),
        }
      }),
    }
  }

  events({ limit = 10, line_id }: { limit?: number; line_id?: string } = {}): FactoryEvent[] {
    return this.log.filter((e) => line_id === undefined || e.line_id === line_id).slice(-limit).reverse()
  }

  lineIds(): string[] {
    return this.lines.map((l) => l.spec.id)
  }

  stationIds(lineId: string): string[] {
    return this.line(lineId)?.stations.map((s) => s.spec.id) ?? []
  }

  /** Advances simulated time by `ms`, writing finished shifts and stock levels to the store. */
  advance(ms: number): Promise<void> {
    return this.enqueue(() => this.run(ms))
  }

  injectFault(lineId: string, stationId: string, reason?: string): Promise<ActionResult> {
    return this.enqueue(async () => {
      const station = this.station(lineId, stationId)
      if (!station) return { ok: false, message: this.unknownStation(lineId, stationId) }
      if (station.fault) return { ok: false, message: `${lineId} ${station.spec.name} is already down: ${station.fault.reason}.` }
      const why = reason?.trim() || station.spec.faults[0]!
      this.fail(this.line(lineId)!, station, why)
      return { ok: true, message: `Fault started on ${lineId} ${station.spec.name}: ${why}.` }
    })
  }

  clearFault(lineId: string, stationId?: string): Promise<ActionResult> {
    return this.enqueue(async () => {
      const line = this.line(lineId)
      if (!line) return { ok: false, message: `Unknown line "${lineId}".` }
      const targets = stationId === undefined ? line.stations.filter((s) => s.fault) : [this.station(lineId, stationId)]
      if (targets.some((s) => s === undefined)) return { ok: false, message: this.unknownStation(lineId, stationId!) }
      const faulted = (targets as StationRuntime[]).filter((s) => s.fault)
      if (faulted.length === 0) return { ok: false, message: `No open fault on ${lineId}${stationId ? ` ${stationId}` : ''}.` }
      const cleared: string[] = []
      const blocked: string[] = []
      for (const s of faulted) {
        const part = s.fault!.needsPart
        if (part && !this.takePart(part)) {
          blocked.push(`${s.spec.name} needs a spare ${part}, which is out of stock`)
          continue
        }
        this.repair(line, s, 'Maintenance cleared the fault')
        cleared.push(s.spec.name)
      }
      if (cleared.length === 0) return { ok: false, message: `${blocked.join('; ')}.` }
      await this.flush(false)
      return { ok: true, message: `Cleared ${lineId} ${cleared.join(', ')}.${blocked.length ? ` Still down: ${blocked.join('; ')}.` : ''}` }
    })
  }

  setRunning(lineId: string, running: boolean): Promise<ActionResult> {
    return this.enqueue(async () => {
      const line = this.line(lineId)
      if (!line) return { ok: false, message: `Unknown line "${lineId}".` }
      if (line.running === running) return { ok: false, message: `${lineId} is already ${running ? 'running' : 'stopped'}.` }
      line.running = running
      this.record(running ? 'line_started' : 'line_stopped', `${lineId} ${running ? 'started' : 'stopped'} by the operator`, line.spec.id)
      return { ok: true, message: `${lineId} ${running ? 'started' : 'stopped'}.` }
    })
  }

  receiveStock(sku: string, quantity: number): Promise<ActionResult & { on_hand?: number }> {
    return this.enqueue(async () => {
      const item = this.stock.get(sku)
      if (!item) {
        // Not a simulated material: book it straight into the store.
        const row = (await this.store.findStock(sku)).find((r) => r.sku === sku)
        if (!row) return { ok: false, message: `Unknown SKU "${sku}".` }
        await this.store.setStockOnHand(sku, row.on_hand + quantity)
        this.record('stock_received', `Received ${quantity} ${row.unit} of ${row.name} (${sku})`)
        return { ok: true, message: `Received ${quantity} ${row.unit} of ${sku}.`, on_hand: row.on_hand + quantity }
      }
      item.onHand += quantity
      item.dirty = true
      this.record('stock_received', `Received ${quantity} of ${sku}; on hand ${Math.floor(item.onHand)}`)
      this.issueWaitingParts()
      await this.flush(false)
      return { ok: true, message: `Received ${quantity} of ${sku}.`, on_hand: Math.floor(item.onHand) }
    })
  }

  /** Writes pending stock levels to the store. */
  flushNow(): Promise<void> {
    return this.enqueue(() => this.flush(true))
  }

  onChange(listener: (change: { events: boolean }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Real-time driver: every tickMs of wall time, advance speed x tickMs of plant time. */
  start({ speed, tickMs = 1000 }: { speed: number; tickMs?: number }): void {
    this.stop()
    let busy = false
    this.timer = setInterval(() => {
      if (busy) return // the store is slow: skip a tick rather than queue them up
      busy = true
      this.advance(speed * tickMs)
        .catch((error: unknown) => console.error('simulation tick failed:', error instanceof Error ? error.message : error))
        .finally(() => {
          busy = false
        })
    }, tickMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // ---- internals ----

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn)
    this.queue = next.catch(() => undefined)
    return next.finally(() => this.emit())
  }

  private emit(): void {
    const events = this.newEvents
    this.newEvents = false
    for (const listener of this.listeners) listener({ events })
  }

  private line(id: string): LineRuntime | undefined {
    return this.lines.find((l) => l.spec.id === id)
  }

  private station(lineId: string, stationId: string): StationRuntime | undefined {
    return this.line(lineId)?.stations.find((s) => s.spec.id === stationId)
  }

  private unknownStation(lineId: string, stationId: string): string {
    const line = this.line(lineId)
    if (!line) return `Unknown line "${lineId}".`
    return `Unknown station "${stationId}" on ${lineId}. Stations: ${line.stations.map((s) => s.spec.id).join(', ')}.`
  }

  private lineState(line: LineRuntime): LineState {
    if (!line.running) return 'stopped'
    if (line.stations.some((s) => s.fault)) return 'down'
    if (this.stock.get(line.spec.material.sku)!.onHand < line.spec.material.perUnit) return 'starved'
    return 'running'
  }

  private record(kind: EventKind, message: string, line_id: string | null = null, station_id: string | null = null): void {
    this.log.push({ id: this.nextEventId++, sim_time: fmt(this.t), line_id, station_id, kind, message })
    if (this.log.length > 200) this.log.shift()
    this.newEvents = true
  }

  private beginShift(start: number, shift: 'A' | 'B'): void {
    this.t = start
    this.shiftStart = start
    this.shift = shift
    for (const line of this.lines) {
      Object.assign(line, { produced: 0, scrap: 0, unitAcc: 0, scrapAcc: 0, downtimeMin: 0 })
    }
    this.record('shift_start', `Shift ${shift} started on ${dateOf(start)}`)
  }

  private async endShift(): Promise<void> {
    const shift_date = dateOf(this.shiftStart)
    for (const line of this.lines) {
      const row: ShiftOutputRow = {
        line_id: line.spec.id,
        shift_date,
        shift: this.shift,
        target_units: line.spec.targetPerShift,
        produced_units: line.produced,
        downtime_min: Math.round(line.downtimeMin),
      }
      await this.store.putShiftOutput(row)
    }
    const summary = this.lines.map((l) => `${l.spec.id} ${l.produced}/${l.spec.targetPerShift}`).join(', ')
    this.record('shift_end', `Shift ${this.shift} on ${shift_date} ended: ${summary}`)
    await this.flush(true)
    // Night: maintenance repairs what it can, then the next morning shift starts.
    for (const line of this.lines) {
      for (const s of line.stations) if (s.fault && !s.fault.needsPart) this.repair(line, s, 'Repaired during the break')
    }
    if (this.shift === 'A') this.beginShift(this.shiftStart + (SHIFTS.B.startMin - SHIFTS.A.startMin) * MINUTE, 'B')
    else this.beginShift(this.shiftStart - SHIFTS.B.startMin * MINUTE + DAY + SHIFTS.A.startMin * MINUTE, 'A')
  }

  private async run(ms: number): Promise<void> {
    const end = this.t + ms
    while (this.t < end) {
      const shiftEnd = this.shiftStart + SHIFT_MIN * MINUTE
      const step = Math.min(MINUTE, end - this.t, shiftEnd - this.t)
      this.step(step)
      this.t += step
      if (this.t >= shiftEnd) await this.endShift() // after shift B the clock jumps to the next morning
      if (this.t - this.lastFlush >= FLUSH_EVERY_MIN * MINUTE) await this.flush(false)
    }
  }

  private step(ms: number): void {
    const minutes = ms / MINUTE
    for (const line of this.lines) {
      for (const s of line.stations) {
        if (s.fault?.repairAt !== null && s.fault?.repairAt !== undefined && s.fault.repairAt <= this.t) this.repair(line, s, 'Repaired')
      }
      if (this.randomFaults && this.lineState(line) === 'running') {
        for (const s of line.stations) {
          if (this.rng() < 1 - Math.exp(-minutes / s.spec.mtbfMin)) {
            const part = s.spec.partFault
            const reason = part && this.rng() < part.chance ? part.reason : s.spec.faults[Math.floor(this.rng() * s.spec.faults.length)]!
            this.fail(line, s, reason)
            break
          }
        }
      }
      const state = this.lineState(line)
      if (state === 'running') this.produce(line, ms)
      else if (state === 'down' || state === 'starved') line.downtimeMin += minutes
      const starvedNow = this.lineState(line) === 'starved'
      if (starvedNow && !line.starved) this.record('starved', `${line.spec.id} stopped: out of ${line.spec.material.sku}`, line.spec.id)
      if (!starvedNow && line.starved) this.record('material_ok', `${line.spec.id} has ${line.spec.material.sku} again`, line.spec.id)
      line.starved = starvedNow
    }
  }

  private produce(line: LineRuntime, ms: number): void {
    const bottleneck = Math.max(...line.spec.stations.map((s) => s.cycleSec))
    line.unitAcc += (ms / 1000 / bottleneck) * (0.97 + 0.03 * this.rng())
    let units = Math.floor(line.unitAcc)
    const material = this.stock.get(line.spec.material.sku)!
    units = Math.min(units, Math.floor(material.onHand / line.spec.material.perUnit + 1e-9))
    if (units <= 0) return
    line.unitAcc -= units
    const before = material.onHand
    material.onHand = Math.max(0, material.onHand - units * line.spec.material.perUnit)
    material.dirty = true
    line.scrapAcc += units * line.spec.scrapRate
    const scrap = Math.floor(line.scrapAcc)
    line.scrapAcc -= scrap
    line.scrap += scrap
    line.produced += units - scrap
    if (before > material.reorderPoint && material.onHand <= material.reorderPoint) {
      this.record('stock_low', `${line.spec.material.sku} at ${Math.floor(material.onHand)}, at or below its reorder point`, line.spec.id)
    }
  }

  private fail(line: LineRuntime, station: StationRuntime, reason: string): void {
    const part = station.spec.partFault?.reason === reason ? station.spec.partFault.sku : null
    station.fault = { reason, since: this.t, repairAt: null, needsPart: part }
    this.record('fault', `${line.spec.id} ${station.spec.name} down: ${reason}`, line.spec.id, station.spec.id)
    if (part && this.takePart(part)) {
      station.fault.needsPart = null
      station.fault.repairAt = this.t + this.repairTime(station)
      this.record('repair_started', `Spare ${part} issued for ${line.spec.id} ${station.spec.name}`, line.spec.id, station.spec.id)
    } else if (part) {
      this.record('waiting_for_part', `${line.spec.id} ${station.spec.name} waits for a spare ${part} (out of stock)`, line.spec.id, station.spec.id)
    } else {
      station.fault.repairAt = this.t + this.repairTime(station)
    }
  }

  private repair(line: LineRuntime, station: StationRuntime, how: string): void {
    const minutes = Math.round((this.t - station.fault!.since) / MINUTE)
    this.record('repaired', `${how}: ${line.spec.id} ${station.spec.name} back up after ${minutes} min`, line.spec.id, station.spec.id)
    station.fault = null
  }

  private repairTime(station: StationRuntime): number {
    return Math.round(station.spec.mttrMin * (0.7 + 0.6 * this.rng())) * MINUTE
  }

  private takePart(sku: string): boolean {
    const item = this.stock.get(sku)
    if (!item || item.onHand < 1) return false
    item.onHand -= 1
    item.dirty = true
    return true
  }

  private issueWaitingParts(): void {
    for (const line of this.lines) {
      for (const s of line.stations) {
        if (s.fault?.needsPart && this.takePart(s.fault.needsPart)) {
          this.record('repair_started', `Spare ${s.fault.needsPart} issued for ${line.spec.id} ${s.spec.name}`, line.spec.id, s.spec.id)
          s.fault.needsPart = null
          s.fault.repairAt = this.t + this.repairTime(s)
        }
      }
    }
  }

  private async flush(force: boolean): Promise<void> {
    for (const [sku, item] of this.stock) {
      if (!item.dirty && !force) continue
      await this.store.setStockOnHand(sku, Math.floor(item.onHand + 1e-9))
      item.dirty = false
    }
    this.lastFlush = this.t
  }
}
