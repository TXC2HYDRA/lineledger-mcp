// Tarnby Works, the fictional plant behind the simulation (plant/plant.json is the single source of truth).
// The plant profile (LINELEDGER_PLANT=1) adds Lines 3 to 7 and the plant's stock levels to the store once.
// Without it the store keeps the small seed (2 lines) that the tests and older docs use.
import { readFileSync } from 'node:fs'
import type { StockRow, Store } from './store.js'

export interface PlantStation {
  id: string
  name: string
  cycle_s: number
}

export interface PlantSignal {
  tag: string
  station: string
  unit: string
  baseline: number
  noise: number
  warn: number
  trip: number
  warn_code: string
  trip_code: string
  trip_reason: string
}

export interface PlantLine {
  id: string
  name: string
  product: string
  sku: string
  crew: number
  crew_c?: number
  stations: PlantStation[]
  ideal_cycle_s: number
  target: Partial<Record<'A' | 'B' | 'C', number>>
  mtbf_min: number
  mttr_median_min: number
  slowdown: number
  warmup: [number, number]
  /** Micro-stops per run hour (about 22 s each), folded into a slower cycle. */
  micro_stops_per_h: number
  reject_rate: number
  reject_codes: Record<string, number>
  downtime_reasons: Record<string, number>
  bom: Record<string, number>
  signals?: PlantSignal[]
}

export interface StoryBeat {
  at: string
  line?: string
  action: 'sensor_ramp' | 'reject_ramp' | 'quality_check' | 'note' | 'stop' | 'swap_part' | 'sensor_reset' | 'restart'
  [key: string]: unknown
}

export interface Plant {
  company: string
  synthetic: true
  shifts: Record<'A' | 'B' | 'C', { start_min: number; lines: 'all' | string[]; lead: string }>
  shift_min: number
  breaks: { name: string; after_min: number; min: number }[]
  support_per_shift: Record<'A' | 'B' | 'C', number>
  day_staff: number
  lines: PlantLine[]
  stock: StockRow[]
  story: {
    date: string
    start: string
    seed: number
    quiet: Record<string, [string, string]>
    speed: { from: string; to: string; speed: number }[]
    holds: { at: string; s: number }[]
    beats: StoryBeat[]
  }
}

export const PLANT: Plant = JSON.parse(readFileSync(new URL('../plant/plant.json', import.meta.url), 'utf8'))
if (PLANT.synthetic !== true) throw new Error('plant/plant.json must declare synthetic: true')

export const PLANNED_MIN = PLANT.shift_min - PLANT.breaks.reduce((sum, b) => sum + b.min, 0)

/** Adds Lines 3 to 7 and the plant's stock to a store once. Returns true when it changed the store. */
export async function applyPlantSeed(store: Store): Promise<boolean> {
  if (await store.lineExists('L3')) return false
  for (const line of PLANT.lines) await store.addLine({ id: line.id, name: line.name, product: line.product })
  for (const item of PLANT.stock) await store.putStockItem(item)
  return true
}
