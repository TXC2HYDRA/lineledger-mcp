// Production simulation of Tarnby Works (plant/plant.json), a fictional plant. Everything here is synthetic.
//
// Seven lines, stepped one simulated minute at a time. Per line and minute: planned breaks; random stops
// (run time to the next stop is exponential with the line's MTBF, repair time lognormal around its median,
// the reason drawn from the line's mix); cycle time = ideal x lognormal slowdown x warm-up after a restart;
// rejects per unit with reject codes; raw material drawn per unit (a line waits when it runs out). Line 2's
// heat sealer has a temperature sensor with warn and trip limits. Shift A 06:00-14:00 and B 14:00-22:00
// run all lines; C 22:00-06:00 runs Lines 2 and 4. The story day (plant.json "story") scripts a sealer
// overheat on Line 2 and a coil jam on Line 5 over the random model.
//
// LineLedger only reads this plant: no MCP tool starts, stops or repairs a line. The one write that touches
// the simulation is a goods receipt (receive_stock), which is a business record, not a machine command.
//
// Live state is in memory. In-progress and finished shifts go to the store as shift_output rows, and
// stock levels as stock_items.on_hand, so the existing tools read the simulation's output.
import { PLANNED_MIN, PLANT, type PlantLine, type PlantSignal, type StoryBeat } from './plant.js'
import type { Store } from './store.js'

export type ShiftId = 'A' | 'B' | 'C'
export type LineState = 'RUN' | 'STOP_FAULT' | 'STOP_OTHER' | 'PLANNED_STOP' | 'IDLE_STARVED' | 'OFF_SHIFT'
export type Pace = 'on_track' | 'at_risk' | 'behind'

const MINUTE = 60_000
const DAY = 86_400_000
const FLUSH_EVERY_MIN = 15
const ORDER: ShiftId[] = ['A', 'B', 'C']
const STOPPED: LineState[] = ['STOP_FAULT', 'STOP_OTHER', 'IDLE_STARVED']
// Reasons that are equipment trips; the rest (jams, changes, no operator, holds, unclassified) are other stops.
const isTrip = (reason: string) => /TRIP|FAULT|TEMP/.test(reason)

export interface FactoryEvent {
  id: number
  sim_time: string
  line_id: string | null
  kind: string
  message: string
}

export interface Alarm {
  line_id: string | null
  code: string
  severity: 'warn' | 'trip' | 'info'
  text: string
  raised_at: string
}

export interface LiveLine {
  line_id: string
  name: string
  product: string
  state: LineState
  since: string
  minutes_in_state: number
  reason_code: string | null
  rate_per_h: number
  ideal_rate_per_h: number
  produced_units: number
  reject_units: number
  target_units: number
  target_to_date: number
  pace_percent: number | null
  status: Pace | null
  downtime_min: number
  crew: number
  open_alarms: Omit<Alarm, 'line_id'>[]
  signals: { tag: string; value: number; unit: string; warn_limit: number; trip_limit: number }[]
}

export interface Snapshot {
  synthetic: true
  company: string
  sim_clock: { sim_now: string; speed: number; held: boolean; mode: 'live' | 'time-lapse' | 'hold' | 'manual' }
  shift: { date: string; shift: ShiftId; lead: string; headcount: number; planned_elapsed_min: number }
  roll_up: Record<string, number>
  lines: LiveLine[]
  materials: { sku: string; name: string; on_hand: number; unit: string; reorder_point: number; status: 'ok' | 'reorder' | 'out_of_stock'; days_cover: number | null }[]
  alarms_open: Alarm[]
  events: FactoryEvent[]
}

export interface SimOptions {
  /** Seed for the random model. Default: the story seed from plant.json. */
  seed?: number
  /** Run the scripted story day when the store holds no shift after it. Default true. */
  story?: boolean
  /** 'random' (default) or 'off' (no random stops; scripted ones still happen). */
  faults?: 'random' | 'off'
}

interface Stop {
  reason: string
  state: 'STOP_FAULT' | 'STOP_OTHER'
  since: number
  until: number | null
}

interface SignalRt {
  spec: PlantSignal
  value: number
  ramp: { from: number; perMin: number; start: number } | null
  /** After a trip the heater is off: a short overshoot, then the jaw cools towards baseline. */
  trippedAt: { t: number; peak: number } | null
}

interface LineRt {
  spec: PlantLine
  rng: () => number
  state: LineState
  since: number
  stop: Stop | null
  runToStop: number
  restartAt: number
  good: number
  reject: number
  rejectCodes: Record<string, number>
  downtimeMin: number
  unitAcc: number
  recent: number[]
  signals: SignalRt[]
  rejectRamp: { to: number; start: number; until: number; code: string } | null
  starvedOn: string | null
}

// ---- small helpers ---------------------------------------------------------------------------------

/** mulberry32: the same seed gives the same stream. */
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
/** One substream per (seed, line), so adding a line does not change the others. */
const substream = (seed: number, key: string) => mulberry32([...key].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), (seed ^ 2166136261) >>> 0))
const normal = (rng: () => number) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())
const pick = (rng: () => number, mix: Record<string, number>) => {
  const total = Object.values(mix).reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (const [k, w] of Object.entries(mix)) if ((r -= w) < 0) return k
  return Object.keys(mix).at(-1)!
}
const fmt = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = (t: number) => new Date(t).toISOString().slice(0, 10)
const hhmm = (date: string, time: string) => Date.parse(`${date}T${time}:00.000Z`)
const round1 = (n: number) => Math.round(n * 10) / 10
const statusOf = (pace: number): Pace => (pace >= 95 ? 'on_track' : pace >= 80 ? 'at_risk' : 'behind')

/** Planned (break-free) minutes elapsed after `elapsed` minutes of a shift. */
export function plannedElapsed(elapsed: number): number {
  let planned = Math.min(Math.max(elapsed, 0), PLANT.shift_min)
  for (const b of PLANT.breaks) planned -= Math.max(0, Math.min(elapsed, b.after_min + b.min) - b.after_min)
  return Math.max(0, planned)
}
const inBreak = (elapsed: number) => PLANT.breaks.find((b) => elapsed >= b.after_min && elapsed < b.after_min + b.min)

export class FactorySim {
  private t = 0
  private shift: ShiftId = 'A'
  private shiftStart = 0
  private readonly lines: LineRt[]
  private readonly stock = new Map<string, { onHand: number; dirty: boolean; log: { t: number; used: number }[]; used: number }>()
  private readonly log: FactoryEvent[] = []
  private readonly alarms: Alarm[] = []
  private nextEventId = 1
  private lastFlush = 0
  private lastLog = 0
  private pending = 0
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private readonly randomFaults: boolean
  private story: Plant['story'] | null = null
  private readonly doneBeats = new Set<number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private holdUntil = 0
  private mode: Snapshot['sim_clock']['mode'] = 'manual'
  private speed = 0

  private constructor(
    private readonly store: Store,
    private readonly seed: number,
    options: SimOptions,
  ) {
    this.randomFaults = (options.faults ?? 'random') === 'random'
    this.lines = PLANT.lines.map((spec) => {
      const rng = substream(seed, spec.id)
      return {
        spec,
        rng,
        state: 'OFF_SHIFT' as LineState,
        since: 0,
        stop: null,
        runToStop: -Math.log(1 - rng()) * spec.mtbf_min,
        restartAt: 0,
        good: 0,
        reject: 0,
        rejectCodes: {},
        downtimeMin: 0,
        unitAcc: 0,
        recent: [],
        signals: (spec.signals ?? []).map((s) => ({ spec: s, value: s.baseline, ramp: null, trippedAt: null })),
        rejectRamp: null,
        starvedOn: null,
      }
    })
  }

  /**
   * Loads stock from the store and picks the start. On a fresh plant store (latest shift on record before
   * the story day) the story day runs: shift A from 06:00 is simulated at once up to the story start (12:55),
   * then the clock goes live. Otherwise the simulation continues with the shift after the latest on record.
   */
  static async create(store: Store, options: SimOptions = {}): Promise<FactorySim> {
    const sim = await FactorySim.load(store, options.seed ?? PLANT.story.seed, options)
    const latest = await store.latestShift({})
    const storyDay = Date.parse(`${PLANT.story.date}T00:00:00.000Z`)
    const latestDay = latest ? Date.parse(`${latest.shift_date}T00:00:00.000Z`) : storyDay - DAY
    if ((options.story ?? true) && latestDay < storyDay) {
      sim.story = PLANT.story
      sim.beginShift(storyDay + PLANT.shifts.A.start_min * MINUTE, 'A')
      sim.lastLog = sim.t
      sim.logUse()
      await sim.run(hhmm(PLANT.story.date, PLANT.story.start) - sim.t, false) // shift A up to the story start
      await sim.flush(true)
    } else if (!latest) {
      sim.beginShift(storyDay + PLANT.shifts.A.start_min * MINUTE, 'A')
    } else {
      const shift = latest.shift as ShiftId
      const next = ORDER[(ORDER.indexOf(shift) + 1) % 3]!
      const nextDay = shift === 'C' ? latestDay + DAY : latestDay
      sim.beginShift(nextDay + PLANT.shifts[next].start_min * MINUTE, next)
      await sim.flush(true)
    }
    return sim
  }

  private static async load(store: Store, seed: number, options: SimOptions): Promise<FactorySim> {
    const sim = new FactorySim(store, seed, options)
    for (const item of PLANT.stock) {
      const row = (await store.findStock(item.sku)).find((r) => r.sku === item.sku)
      if (!row) throw new Error(`the plant simulation needs stock item ${item.sku}; run with LINELEDGER_PLANT=1`)
      sim.stock.set(item.sku, { onHand: row.on_hand, dirty: false, log: [], used: 0 })
    }
    for (const line of PLANT.lines) {
      if (!(await store.lineExists(line.id))) throw new Error(`the plant simulation needs line ${line.id}; run with LINELEDGER_PLANT=1`)
    }
    return sim
  }

  /**
   * For a fresh plant store: simulates the `days` whole days before the story day, headless and with its own
   * random streams, and writes only their shift results, so the shift history and the trend hold simulated
   * shifts instead of hand-written ones. Stock goes back to the plant's starting levels afterwards, and the
   * last shift stays one minute short of its end, so the story day still runs on this store.
   */
  static async history(store: Store, days = 7): Promise<void> {
    const sim = await FactorySim.load(store, PLANT.story.seed + 1, { story: false })
    for (const item of sim.stock.values()) item.onHand = 1e12 // a week of goods receipts is not modelled: no line starves
    const storyDay = Date.parse(`${PLANT.story.date}T00:00:00.000Z`)
    const end = storyDay + PLANT.shifts.A.start_min * MINUTE
    sim.beginShift(end - days * DAY, 'A')
    sim.lastLog = sim.t
    await sim.run(days * DAY - MINUTE, false)
    await sim.flush(true)
    for (const item of PLANT.stock) await store.putStockItem(item)
  }

  // ---- reading ----------------------------------------------------------------------------------

  /** The current shift and the live per-line counts, for overlaying the in-progress shift summary. */
  liveShift() {
    return {
      shift_date: dateOf(this.shiftStart),
      shift: this.shift,
      planned_elapsed_min: plannedElapsed((this.t - this.shiftStart) / MINUTE),
      lines: new Map(this.lines.filter((l) => this.onShift(l)).map((l) => [l.spec.id, this.liveLine(l)])),
    }
  }

  snapshot(): Snapshot {
    const lines = this.lines.map((l) => this.liveLine(l))
    const roll_up: Record<string, number> = {}
    for (const l of lines) roll_up[l.state] = (roll_up[l.state] ?? 0) + 1
    const onShift = this.lines.filter((l) => this.onShift(l))
    return {
      synthetic: true,
      company: PLANT.company,
      sim_clock: { sim_now: fmt(this.t), speed: this.speed, held: this.mode === 'hold', mode: this.mode },
      shift: {
        date: dateOf(this.shiftStart),
        shift: this.shift,
        lead: PLANT.shifts[this.shift].lead,
        headcount: onShift.reduce((n, l) => n + (this.shift === 'C' ? (l.spec.crew_c ?? l.spec.crew) : l.spec.crew), 0) + PLANT.support_per_shift[this.shift],
        planned_elapsed_min: Math.floor(plannedElapsed((this.t - this.shiftStart) / MINUTE)),
      },
      roll_up,
      lines,
      materials: PLANT.stock.map((s) => {
        const onHand = Math.floor(this.stock.get(s.sku)!.onHand + 1e-9)
        return {
          sku: s.sku,
          name: s.name,
          on_hand: onHand,
          unit: s.unit,
          reorder_point: s.reorder_point,
          status: onHand === 0 ? 'out_of_stock' : onHand <= s.reorder_point ? 'reorder' : 'ok',
          days_cover: this.daysCover(s.sku),
        }
      }),
      alarms_open: [...this.alarms],
      events: this.events({ limit: 8 }),
    }
  }

  events({ limit = 10, line_id }: { limit?: number; line_id?: string } = {}): FactoryEvent[] {
    return this.log.filter((e) => line_id === undefined || e.line_id === line_id).slice(-limit).reverse()
  }

  /** On hand divided by the use over the trailing 24 simulated hours (or what there is, from one hour). */
  daysCover(sku: string): number | null {
    const item = this.stock.get(sku)
    if (!item) return null
    const from = item.log.find((p) => p.t >= this.t - DAY)
    if (!from || this.t - from.t < 60 * MINUTE) return null
    const perDay = ((item.used - from.used) / (this.t - from.t)) * DAY
    return perDay > 0 ? round1(item.onHand / perDay) : null
  }

  /** Live stock on hand for a simulated material, or undefined for other SKUs. */
  onHand(sku: string): number | undefined {
    const item = this.stock.get(sku)
    return item ? Math.floor(item.onHand + 1e-9) : undefined
  }

  lineIds(): string[] {
    return this.lines.map((l) => l.spec.id)
  }

  // ---- changing ---------------------------------------------------------------------------------

  /** Advances simulated time by `ms`, writing shift rows and stock levels to the store. */
  advance(ms: number): Promise<void> {
    return this.enqueue(() => this.run(ms, true))
  }

  /** Goods receipt (ERP): adds stock. A line waiting for that material starts again. */
  receiveStock(sku: string, quantity: number): Promise<{ ok: true; on_hand: number; message: string } | { ok: false; message: string }> {
    return this.enqueue(async () => {
      const item = this.stock.get(sku)
      if (!item) {
        const row = (await this.store.findStock(sku)).find((r) => r.sku === sku)
        if (!row) return { ok: false as const, message: `Unknown SKU "${sku}".` }
        await this.store.setStockOnHand(sku, row.on_hand + quantity)
        this.record('stock_received', `Goods receipt: ${quantity} ${row.unit} of ${sku}`)
        return { ok: true as const, on_hand: row.on_hand + quantity, message: `Received ${quantity} ${row.unit} of ${sku}.` }
      }
      item.onHand += quantity
      item.dirty = true
      const unit = PLANT.stock.find((s) => s.sku === sku)!.unit
      this.record('stock_received', `Goods receipt: ${quantity} ${unit} of ${sku}, on hand ${Math.floor(item.onHand)}`)
      await this.flush(false)
      return { ok: true as const, on_hand: Math.floor(item.onHand + 1e-9), message: `Received ${quantity} ${unit} of ${sku}.` }
    })
  }

  flushNow(): Promise<void> {
    return this.enqueue(() => this.flush(true))
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Real-time driver. `speed` simulated seconds per real second (the story's time-lapse segment overrides it).
   * With holds on, the clock pauses for the story's hold beats so a presenter can speak.
   */
  start({ speed, tickMs = 500, holds = false }: { speed: number; tickMs?: number; holds?: boolean }): void {
    this.stop()
    let busy = false
    this.timer = setInterval(() => {
      if (busy) return
      if (Date.now() < this.holdUntil) {
        if (this.mode !== 'hold') {
          this.mode = 'hold'
          this.emit()
        }
        return
      }
      busy = true
      const segment = this.story?.speed.find((s) => this.t >= hhmm(this.story!.date, s.from) && this.t < hhmm(this.story!.date, s.to))
      this.speed = segment?.speed ?? speed
      this.mode = segment ? 'time-lapse' : 'live'
      let ms = this.speed * tickMs
      const hold = holds ? this.story?.holds.map((h) => ({ ...h, t: hhmm(this.story!.date, h.at) })).find((h) => h.t > this.t && h.t <= this.t + ms) : undefined
      if (hold) ms = hold.t - this.t
      this.advance(ms)
        .then(() => {
          if (hold) {
            this.holdUntil = Date.now() + hold.s * 1000
            this.mode = 'hold'
          }
        })
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

  // ---- internals --------------------------------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn)
    this.queue = next.catch(() => undefined)
    return next.finally(() => this.emit())
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private onShift(line: LineRt): boolean {
    const lines = PLANT.shifts[this.shift].lines
    return lines === 'all' || lines.includes(line.spec.id)
  }

  private target(line: LineRt): number {
    return this.onShift(line) ? (line.spec.target[this.shift] ?? 0) : 0
  }

  private liveLine(l: LineRt): LiveLine {
    const planned = plannedElapsed((this.t - this.shiftStart) / MINUTE)
    const target = this.target(l)
    const targetToDate = Math.round((target * planned) / PLANNED_MIN)
    const pace = this.onShift(l) && planned >= 10 && targetToDate > 0 ? round1((l.good / targetToDate) * 100) : null
    const minutes = Math.round((this.t - l.since) / MINUTE)
    const status = pace === null ? null : STOPPED.includes(l.state) && minutes > 15 ? 'behind' : statusOf(pace)
    return {
      line_id: l.spec.id,
      name: l.spec.name,
      product: l.spec.product,
      state: l.state,
      since: fmt(l.since),
      minutes_in_state: minutes,
      reason_code: l.stop?.reason ?? (l.state === 'IDLE_STARVED' ? `NO_${l.starvedOn}` : l.state === 'PLANNED_STOP' ? 'BREAK' : null),
      rate_per_h: l.recent.reduce((a, b) => a + b, 0) * (60 / Math.max(1, l.recent.length)),
      ideal_rate_per_h: Math.round(3600 / l.spec.ideal_cycle_s),
      produced_units: l.good,
      reject_units: l.reject,
      target_units: target,
      target_to_date: targetToDate,
      pace_percent: pace,
      status,
      downtime_min: Math.round(l.downtimeMin),
      crew: this.onShift(l) ? (this.shift === 'C' ? (l.spec.crew_c ?? l.spec.crew) : l.spec.crew) : 0,
      open_alarms: this.alarms.filter((a) => a.line_id === l.spec.id).map(({ line_id: _, ...a }) => a),
      signals: l.signals.map((s) => ({ tag: s.spec.tag, value: round1(s.value), unit: s.spec.unit, warn_limit: s.spec.warn, trip_limit: s.spec.trip })),
    }
  }

  private record(kind: string, message: string, line_id: string | null = null): void {
    this.log.push({ id: this.nextEventId++, sim_time: fmt(this.t), line_id, kind, message })
    if (this.log.length > 300) this.log.shift()
  }

  private raise(line_id: string | null, code: string, severity: Alarm['severity'], text: string): void {
    if (this.alarms.some((a) => a.code === code && a.line_id === line_id)) return
    this.alarms.push({ line_id, code, severity, text, raised_at: fmt(this.t) })
    this.record('alarm', `${line_id ? `${line_id} ` : ''}${severity.toUpperCase()} ${code}: ${text}`, line_id)
  }

  private clear(line_id: string | null, code: string): void {
    const i = this.alarms.findIndex((a) => a.code === code && a.line_id === line_id)
    if (i === -1) return
    this.alarms.splice(i, 1)
    this.record('alarm_clear', `${line_id ? `${line_id} ` : ''}${code} cleared`, line_id)
  }

  private beginShift(start: number, shift: ShiftId): void {
    this.t = start
    this.shiftStart = start
    this.shift = shift
    for (const l of this.lines) {
      Object.assign(l, { good: 0, reject: 0, rejectCodes: {}, downtimeMin: 0, unitAcc: 0, recent: [] })
      if (this.onShift(l)) l.restartAt = start
      const state: LineState = l.stop ? l.stop.state : this.onShift(l) ? 'RUN' : 'OFF_SHIFT'
      if (state !== l.state) {
        l.state = state
        l.since = start
      }
    }
    const crew = this.snapshotHeadcount()
    this.record('shift_start', `Shift ${shift} started on ${dateOf(start)}: lead ${PLANT.shifts[shift].lead}, ${crew} people on shift`)
  }

  private snapshotHeadcount(): number {
    return this.lines.filter((l) => this.onShift(l)).reduce((n, l) => n + (this.shift === 'C' ? (l.spec.crew_c ?? l.spec.crew) : l.spec.crew), 0) + PLANT.support_per_shift[this.shift]
  }

  private async endShift(): Promise<void> {
    await this.flush(true)
    const date = dateOf(this.shiftStart)
    const summary = this.lines.filter((l) => this.onShift(l)).map((l) => `${l.spec.id} ${l.good}/${this.target(l)}`).join(', ')
    this.record('shift_end', `Shift ${this.shift} on ${date} ended: ${summary}`)
    const next = ORDER[(ORDER.indexOf(this.shift) + 1) % 3]!
    const day = Date.parse(`${date}T00:00:00.000Z`) + (this.shift === 'C' ? DAY : 0)
    this.beginShift(day + PLANT.shifts[next].start_min * MINUTE, next)
    await this.flush(true) // the new shift's rows exist from its first minute
  }

  /** Whole simulated minutes only, so a run is the same whatever the tick size; the remainder carries over. */
  private async run(ms: number, flush: boolean): Promise<void> {
    this.pending += ms
    while (this.pending >= MINUTE) {
      this.pending -= MINUTE
      this.applyBeats()
      this.step()
      this.t += MINUTE
      if (this.t - this.lastLog >= FLUSH_EVERY_MIN * MINUTE) this.logUse()
      if (this.t >= this.shiftStart + PLANT.shift_min * MINUTE) await this.endShift()
      else if (flush && this.t - this.lastFlush >= FLUSH_EVERY_MIN * MINUTE) await this.flush(false)
    }
  }

  private logUse(): void {
    for (const item of this.stock.values()) {
      item.log.push({ t: this.t, used: item.used })
      if (item.log.length > 200) item.log.shift()
    }
    this.lastLog = this.t
  }

  private applyBeats(): void {
    if (!this.story) return
    const story = this.story
    story.beats.forEach((beat, i) => {
      if (this.doneBeats.has(i) || hhmm(story.date, beat.at) > this.t) return
      this.doneBeats.add(i)
      this.applyBeat(beat)
    })
  }

  private applyBeat(beat: StoryBeat): void {
    const line = this.lines.find((l) => l.spec.id === beat.line)
    const signal = line?.signals.find((s) => s.spec.tag === beat.tag)
    switch (beat.action) {
      case 'sensor_ramp':
        if (signal) signal.ramp = { from: Number(beat.from), perMin: Number(beat.per_min), start: this.t }
        break
      case 'reject_ramp':
        if (line) line.rejectRamp = { to: Number(beat.to), start: this.t, until: hhmm(this.story!.date, String(beat.until)), code: String(beat.code) }
        break
      case 'quality_check':
        this.record('quality_check', `${beat.message} (${beat.check}: ${beat.result})`, line?.spec.id ?? null)
        break
      case 'note':
        this.record('note', String(beat.message), line?.spec.id ?? null)
        break
      case 'stop':
        if (line && !line.stop) this.startStop(line, String(beat.reason), hhmm(this.story!.date, String(beat.until)))
        break
      case 'swap_part': {
        const item = this.stock.get(String(beat.sku))
        if (item) {
          item.onHand = Math.max(0, item.onHand - Number(beat.qty))
          item.dirty = true
        }
        this.record('part_swap', `${beat.message}: ${beat.qty} ${beat.sku} used, ${Math.floor(item?.onHand ?? 0)} left`, line?.spec.id ?? null)
        break
      }
      case 'sensor_reset':
        if (signal && line) {
          signal.ramp = null
          signal.trippedAt = null
          signal.value = signal.spec.baseline
          this.clear(line.spec.id, signal.spec.warn_code)
          this.clear(line.spec.id, signal.spec.trip_code)
        }
        break
      case 'restart':
        if (line?.stop) this.endStop(line)
        break
    }
  }

  private quiet(line: LineRt): boolean {
    const window = this.story?.quiet[line.spec.id]
    return window !== undefined && this.t >= hhmm(this.story!.date, window[0]) && this.t < hhmm(this.story!.date, window[1])
  }

  private startStop(line: LineRt, reason: string, until: number | null): void {
    line.stop = { reason, state: isTrip(reason) ? 'STOP_FAULT' : 'STOP_OTHER', since: this.t, until }
    this.record('stop', `${line.spec.id} stopped: ${reason}`, line.spec.id)
  }

  private endStop(line: LineRt): void {
    const minutes = Math.round((this.t - line.stop!.since) / MINUTE)
    this.record('restart', `${line.spec.id} running again after ${minutes} min (${line.stop!.reason})`, line.spec.id)
    line.stop = null
    line.restartAt = this.t
    line.runToStop = -Math.log(1 - line.rng()) * line.spec.mtbf_min
  }

  private step(): void {
    const minutes = 1
    const elapsed = (this.t - this.shiftStart) / MINUTE
    const brk = inBreak(elapsed)
    for (const l of this.lines) {
      const onShift = this.onShift(l)
      if (l.stop?.until !== null && l.stop?.until !== undefined && this.t >= l.stop.until) this.endStop(l)

      // sensors: baseline with noise, or a scripted ramp; warn and trip limits raise alarms
      for (const s of l.signals) {
        if (s.trippedAt) {
          const m = (this.t - s.trippedAt.t) / MINUTE
          s.value = m <= 4 ? s.trippedAt.peak + 0.5 * m : Math.max(s.spec.baseline, s.trippedAt.peak + 2 - 1.2 * (m - 4))
          continue
        }
        s.value = s.ramp ? s.ramp.from + (s.ramp.perMin * (this.t - s.ramp.start)) / MINUTE : s.spec.baseline + s.spec.noise * normal(l.rng)
        if (s.value >= s.spec.warn) this.raise(l.spec.id, s.spec.warn_code, 'warn', `${s.spec.tag} ${round1(s.value)} ${s.spec.unit}, warn limit ${s.spec.warn}`)
        if (s.value >= s.spec.trip) {
          this.raise(l.spec.id, s.spec.trip_code, 'trip', `${s.spec.tag} ${round1(s.value)} ${s.spec.unit}, trip limit ${s.spec.trip}`)
          if (!l.stop) this.startStop(l, s.spec.trip_reason, s.ramp ? null : this.t + this.repairMinutes(l) * MINUTE)
          s.trippedAt = { t: this.t, peak: s.value }
          s.ramp = null
          l.rejectRamp = null
        }
      }

      // random stops count down run time only
      const runnable = onShift && !brk && !l.stop
      if (runnable && this.randomFaults && !this.quiet(l)) {
        l.runToStop -= minutes
        if (l.runToStop <= 0) this.startStop(l, pick(l.rng, l.spec.downtime_reasons), this.t + this.repairMinutes(l) * MINUTE)
      }

      const short = Object.entries(l.spec.bom).find(([sku, qty]) => this.stock.get(sku)!.onHand < qty)
      const state: LineState = !onShift ? (l.stop ? l.stop.state : 'OFF_SHIFT') : l.stop ? l.stop.state : brk ? 'PLANNED_STOP' : short ? 'IDLE_STARVED' : 'RUN'
      if (state !== l.state) {
        if (state === 'IDLE_STARVED') this.record('starved', `${l.spec.id} waiting for material: ${short![0]} is out`, l.spec.id)
        if (l.state === 'IDLE_STARVED' && state !== 'IDLE_STARVED') this.record('material_ok', `${l.spec.id} has ${l.starvedOn} again`, l.spec.id)
        if (l.state === 'PLANNED_STOP' && state === 'RUN') l.restartAt = this.t
        l.state = state
        l.since = this.t
      }
      l.starvedOn = short?.[0] ?? null

      let goodNow = 0
      if (state === 'RUN') goodNow = this.produce(l, minutes)
      else if (onShift && STOPPED.includes(state)) l.downtimeMin += minutes
      if (onShift) {
        l.recent.push(goodNow)
        if (l.recent.length > 15) l.recent.shift()
      }
    }
  }

  private repairMinutes(l: LineRt): number {
    return Math.max(2, Math.round(l.spec.mttr_median_min * Math.exp(0.6 * normal(l.rng))))
  }

  private produce(l: LineRt, minutes: number): number {
    const sinceRestart = (this.t - l.restartAt) / MINUTE
    const [m, tau] = l.spec.warmup
    const warm = 1 + (m - 1) * Math.exp(-sinceRestart / tau)
    const micro = 1 + (l.spec.micro_stops_per_h * 22) / 3600 // short stops under 2 min are not downtime; they slow the cycle
    const cycle = l.spec.ideal_cycle_s * l.spec.slowdown * Math.exp(0.05 * normal(l.rng)) * warm * micro
    l.unitAcc += (minutes * 60) / cycle
    let units = Math.floor(l.unitAcc)
    for (const [sku, qty] of Object.entries(l.spec.bom)) units = Math.min(units, Math.floor(this.stock.get(sku)!.onHand / qty + 1e-9))
    if (units <= 0) return 0
    l.unitAcc -= units
    const ramp = l.rejectRamp
    const base = l.spec.reject_rate
    const p = ramp ? base + (ramp.to - base) * Math.min(1, (this.t - ramp.start) / Math.max(MINUTE, ramp.until - ramp.start)) : base
    let rejects = 0
    for (let i = 0; i < units; i++) {
      if (l.rng() >= p) continue
      rejects++
      const code = ramp && l.rng() < (p - base) / p ? ramp.code : pick(l.rng, l.spec.reject_codes)
      l.rejectCodes[code] = (l.rejectCodes[code] ?? 0) + 1
    }
    l.good += units - rejects
    l.reject += rejects
    for (const [sku, qty] of Object.entries(l.spec.bom)) {
      const item = this.stock.get(sku)!
      const before = item.onHand
      item.onHand = Math.max(0, item.onHand - units * qty)
      item.used += units * qty
      item.dirty = true
      const point = PLANT.stock.find((s) => s.sku === sku)!.reorder_point
      if (before > point && item.onHand <= point) this.raise(null, `LOW-${sku}`, 'info', `${sku} at ${Math.floor(item.onHand)}, at or below its reorder point ${point}`)
    }
    return units - rejects
  }

  private async flush(force: boolean): Promise<void> {
    const date = dateOf(this.shiftStart)
    for (const l of this.lines) {
      if (!this.onShift(l)) continue
      await this.store.putShiftOutput({ line_id: l.spec.id, shift_date: date, shift: this.shift, target_units: this.target(l), produced_units: l.good, downtime_min: Math.round(l.downtimeMin) })
    }
    for (const [sku, item] of this.stock) {
      if (!item.dirty && !force) continue
      await this.store.setStockOnHand(sku, Math.floor(item.onHand + 1e-9))
      item.dirty = false
    }
    this.lastFlush = this.t
  }
}

type Plant = typeof PLANT
