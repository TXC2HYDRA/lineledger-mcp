// Recomputes WCAG 2.x contrast from the real CSS custom properties in web/src/style.css.
// Fails on any normal-text pair below 4.5:1 or any control boundary below 3:1.
// Glass surfaces are translucent, so they are composited over the worst-case backdrop first.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8')
const root = /:root\s*{([^}]*)}/.exec(css)?.[1] ?? ''
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]))
const pct = Object.fromEntries([...root.matchAll(/--([\w-]+-pct):\s*(\d+(?:\.\d+)?)%\s*;/g)].map((m) => [m[1]!, Number(m[2]) / 100]))

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const hex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
// `top` drawn at `alpha` over `under`
const over = (top: string, alpha: number, under: string) => {
  const [t, u] = [rgb(top), rgb(under)]
  return hex(t.map((v, i) => v * alpha + u[i]! * (1 - alpha)))
}

const lum = (h: string) => {
  const [r, g, b] = rgb(h).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const need = ['glow-pct', 'glass-pct', 'sheen-pct', 'lift-pct', 'pill-pct', 'drawer-pct']
for (const k of need) if (pct[k] === undefined) { console.error(`missing --${k}`); process.exit(1) }

// Worst cases: cards sit over the strongest page glow; the pill and drawer can sit over a bright accent bar.
const peak = over(vars['color-accent']!, pct['glow-pct']!, vars['color-bg']!)
const glass = over(vars['color-surface']!, pct['glass-pct']!, peak)
const solids: Record<string, string> = {
  'color-bg': vars['color-bg']!,
  'color-surface': vars['color-surface']!,
  'color-surface-raised': vars['color-surface-raised']!,
  'page (glow peak)': peak,
  'glass (over glow peak)': glass,
  'glass + sheen': over('#FFFFFF', pct['sheen-pct']!, glass),
  'glass + sheen + lift': over('#FFFFFF', pct['lift-pct']!, over('#FFFFFF', pct['sheen-pct']!, glass)),
  'pill (over accent)': over(vars['color-surface']!, pct['pill-pct']!, vars['color-accent']!),
  'drawer (over accent)': over(vars['color-surface']!, pct['drawer-pct']!, vars['color-accent']!),
}
solids['drawer + lift'] = over('#FFFFFF', pct['lift-pct']!, solids['drawer (over accent)']!)

const text = ['color-text', 'color-text-muted', 'color-accent', 'color-success', 'color-warning', 'color-danger']
const entries = Object.entries(solids)
const pairs: [string, string, string, string, number][] = [
  ...text.flatMap((fg) => entries.map(([n, h]) => [fg, vars[fg]!, n, h, 4.5] as [string, string, string, string, number])),
  ...['color-border-strong', 'color-focus'].flatMap((fg) => entries.map(([n, h]) => [fg, vars[fg]!, n, h, 3] as [string, string, string, string, number])),
  ['color-bg (button label)', vars['color-bg']!, 'color-accent', vars['color-accent']!, 4.5],
]

let failed = 0
for (const [fg, f, bgName, b, min] of pairs) {
  const r = ratio(f, b)
  const pass = r >= min
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${r.toFixed(2).padStart(5)}:1 (min ${min}) ${fg} ${f} on ${bgName} ${b}`)
}
console.log(failed ? `FAIL: ${failed} pair(s) below minimum` : `PASS: ${pairs.length} pairs`)
process.exit(failed ? 1 : 0)
