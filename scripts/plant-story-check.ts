// Runs the story day headless for one seed (or a range with --search) and prints or checks the story numbers.
//   npx tsx scripts/plant-story-check.ts [seed]        print the day for one seed
//   npx tsx scripts/plant-story-check.ts --search 200  first seed in 1..N where every story predicate holds
import { applyPlantSeed, PLANT } from '../server/plant.js'
import { FactorySim } from '../server/sim.js'
import { SqliteStore } from '../server/store-sqlite.js'

const MIN = 60_000

export async function storyDay(seed: number) {
  const store = SqliteStore.open()
  await applyPlantSeed(store)
  const sim = await FactorySim.create(store, { seed })
  const at1258 = await (async () => {
    await sim.advance(3 * MIN)
    return sim.snapshot()
  })()
  let trip: string | undefined
  let hdpeCross: string | undefined
  for (let i = 0; i < 9 * 60 + 30; i++) {
    await sim.advance(MIN)
    const s = sim.snapshot()
    const l2 = s.lines.find((l) => l.line_id === 'L2')!
    if (!trip && l2.state === 'STOP_FAULT') trip = l2.since
    const hdpe = s.materials.find((m) => m.sku === 'PLY-HDPE')!
    if (!hdpeCross && hdpe.on_hand <= 18000) hdpeCross = s.sim_clock.sim_now
  }
  const shiftA = await store.shiftLines(PLANT.story.date, 'A')
  const final = sim.snapshot()
  await store.close()
  const l2A = shiftA.find((r) => r.line_id === 'L2')!
  const plantA = shiftA.reduce((n, r) => n + r.produced_units, 0)
  const targetA = shiftA.reduce((n, r) => n + r.target_units, 0)
  const running1258 = at1258.lines.filter((l) => l.state === 'RUN').length
  const l2Run1258 = at1258.lines.find((l) => l.line_id === 'L2')!.state === 'RUN'
  const htr = final.materials.find((m) => m.sku === 'HTR-BAND')!
  const checks = {
    'at 12:58 at least 6 of 7 lines RUN, L2 RUN': running1258 >= 6 && l2Run1258,
    'L2 trips at 13:23': trip?.endsWith('13:23') ?? false,
    'L2 shift A good 640 to 690': l2A.produced_units >= 640 && l2A.produced_units <= 690,
    'plant shift A 90 to 99 % of target': plantA / targetA >= 0.9 && plantA / targetA <= 0.99,
    'HDPE crosses 18,000 kg between 16:00 and 16:40': !!hdpeCross && hdpeCross.slice(11) >= '16:00' && hdpeCross.slice(11) <= '16:40',
    'HTR-BAND ends at 2 (reorder)': htr.on_hand === 2 && htr.status === 'reorder',
  }
  return {
    seed, checks, ok: Object.values(checks).every(Boolean),
    numbers: { running1258, l2Run1258, trip, l2A: l2A.produced_units, l2Down: l2A.downtime_min, plantA, targetA, pct: Math.round((plantA / targetA) * 1000) / 10, hdpeCross, shiftA: shiftA.map((r) => `${r.line_id} ${r.produced_units}/${r.target_units} down ${r.downtime_min}`) },
  }
}

const args = process.argv.slice(2)
if (args[0] === '--search') {
  const n = Number(args[1] ?? 200)
  for (let seed = 1; seed <= n; seed++) {
    const r = await storyDay(seed)
    if (r.ok) {
      console.log(JSON.stringify(r, null, 2))
      process.exit(0)
    }
  }
  console.log(`no seed in 1..${n} meets every story check`)
  process.exitCode = 1
} else {
  console.log(JSON.stringify(await storyDay(Number(args[0] ?? PLANT.story.seed)), null, 2))
}
