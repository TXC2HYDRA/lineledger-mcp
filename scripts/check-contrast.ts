// Recomputes WCAG 2.x contrast from the real CSS custom properties in web/src/style.css, for both themes.
// Fails on any normal-text pair below 4.5:1 or any control boundary below 3:1.
// Glass surfaces are translucent, so they are composited over the worst-case backdrop first.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8')
const block = (selector: RegExp) => selector.exec(css)?.[1] ?? ''
const hexVars = (b: string) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]))
const pctVars = (b: string) => Object.fromEntries([...b.matchAll(/--([\w-]+-pct):\s*(\d+(?:\.\d+)?)%\s*;/g)].map((m) => [m[1]!, Number(m[2]) / 100]))

const dark = block(/:root\s*{([^}]*)}/)
const light = block(/\[data-theme="light"\]\s*{([^}]*)}/)
const themes = {
  dark: { vars: hexVars(dark), pct: pctVars(dark) },
  // the light block only overrides; everything else is inherited from :root
  light: { vars: { ...hexVars(dark), ...hexVars(light) }, pct: { ...pctVars(dark), ...pctVars(light) } },
}

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

type Pair = [string, string, string, string, number]
let failed = 0
let total = 0

for (const [name, { vars, pct }] of Object.entries(themes)) {
  for (const k of ['glass-pct', 'sheen-pct', 'lift-pct', 'pill-pct', 'drawer-pct']) if (pct[k] === undefined) { console.error(`missing --${k}`); process.exit(1) }
  for (const k of ['lift-color', 'sheen-color']) if (!vars[k]) { console.error(`missing --${k}`); process.exit(1) }

  // Worst cases: cards sit over the plain page; the pill and drawer can float over the brightest or darkest content
  // (a full accent block or dense text).
  const glass = over(vars['color-surface']!, pct['glass-pct']!, vars['color-bg']!)
  const withSheen = over(vars['sheen-color']!, pct['sheen-pct']!, glass)
  const surfaces: Record<string, string> = {
    'color-bg': vars['color-bg']!,
    'color-surface': vars['color-surface']!,
    'color-surface-raised': vars['color-surface-raised']!,
    'glass (over bg)': glass,
    'glass + sheen + lift': over(vars['lift-color']!, pct['lift-pct']!, withSheen),
  }
  // dense blurred text is about 40% coverage, not a solid block of the text colour
  const denseText = over(vars['color-text']!, 0.4, vars['color-bg']!)
  for (const [label, under] of [['accent', vars['color-accent']!], ['dense text', denseText]] as const) {
    const pill = over(vars['color-surface']!, pct['pill-pct']!, under)
    const drawer = over(vars['color-surface']!, pct['drawer-pct']!, under)
    surfaces[`pill (over ${label})`] = pill
    surfaces[`drawer + lift (over ${label})`] = over(vars['lift-color']!, pct['lift-pct']!, drawer)
  }

  // smooth backdrop colours (when a theme defines them): text on the page itself and under glass over it
  for (const k of ['mesh-a', 'mesh-b', 'mesh-c']) {
    if (!vars[k]) continue
    surfaces[k] = vars[k]!
    surfaces[`glass + sheen + lift (over ${k})`] = over(vars['lift-color']!, pct['lift-pct']!, over(vars['sheen-color']!, pct['sheen-pct']!, over(vars['color-surface']!, pct['glass-pct']!, vars[k]!)))
  }

  const text = ['color-text', 'color-text-muted', 'color-accent', 'color-success', 'color-warning', 'color-danger']
  const entries = Object.entries(surfaces)
  const pairs: Pair[] = [
    ...text.flatMap((fg) => entries.map(([n, h]) => [fg, vars[fg]!, n, h, 4.5] as Pair)),
    ...['color-border-strong', 'color-focus'].flatMap((fg) => entries.map(([n, h]) => [fg, vars[fg]!, n, h, 3] as Pair)),
    ['color-bg (button label)', vars['color-bg']!, 'color-accent', vars['color-accent']!, 4.5],
  ]
  for (const [fg, f, bgName, b, min] of pairs) {
    const r = ratio(f, b)
    const pass = r >= min
    total++
    if (!pass) failed++
    console.log(`${pass ? 'PASS' : 'FAIL'} [${name}] ${r.toFixed(2).padStart(5)}:1 (min ${min}) ${fg} ${f} on ${bgName} ${b}`)
  }
}
console.log(failed ? `FAIL: ${failed} of ${total} pair(s) below minimum` : `PASS: ${total} pairs`)
process.exit(failed ? 1 : 0)
