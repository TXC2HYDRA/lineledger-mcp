// Recomputes WCAG 2.x contrast from the real CSS custom properties in web/src/style.css.
// Fails on any normal-text pair below 4.5:1 or any control boundary below 3:1.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8')
const root = /:root\s*{([^}]*)}/.exec(css)?.[1] ?? ''
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]))

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const surfaces = ['color-bg', 'color-surface', 'color-surface-raised']
const text = ['color-text', 'color-text-muted', 'color-accent', 'color-success', 'color-warning', 'color-danger']
const pairs: [string, string, number][] = [
  ...text.flatMap((fg) => surfaces.map((bg) => [fg, bg, 4.5] as [string, string, number])),
  ...['color-border-strong', 'color-focus'].flatMap((fg) => surfaces.map((bg) => [fg, bg, 3] as [string, string, number])),
  ['color-bg', 'color-accent', 4.5], // primary button label on accent fill
]

let failed = 0
for (const [fg, bg, min] of pairs) {
  const f = vars[fg], b = vars[bg]
  if (!f || !b) { console.error(`missing variable for ${fg} / ${bg}`); failed++; continue }
  const r = ratio(f, b)
  const pass = r >= min
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${r.toFixed(2).padStart(5)}:1 (min ${min}) ${fg} ${f} on ${bg} ${b}`)
}
console.log(failed ? `FAIL: ${failed} pair(s) below minimum` : `PASS: ${pairs.length} pairs`)
process.exit(failed ? 1 : 0)
