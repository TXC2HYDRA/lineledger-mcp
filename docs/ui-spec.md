# LineLedger UI specification

Voice-first factory-floor co-pilot. Synthetic demo data only.

## Style decision

- Primary style: **dark dashboard with a left sidebar** (Vaulto-style reference). Sidebar navigation, a top command bar, a hero metric, then independent cards.
- Secondary style: **Swiss Design**. One sans-serif family, strong alignment, clear hierarchy, consistent numerals.
- Palette: neutral near-black surfaces, one orange accent (`#FF6A2B`). Red (`--color-danger`) means "behind", never decoration.
- Surfaces are **glass** (glassmorphism): translucent fills with `backdrop-filter: blur`, a light edge and a soft shadow, over a plain solid page background (no discs, glows or gradients; the blur is subtle by design). The background carries no text and no state.
- Glass is only allowed because contrast is checked against the worst case: `npm run check:contrast` composites every glass fill over the page before testing text and boundaries.
- Fallback: with no `backdrop-filter` support, or with `prefers-reduced-transparency: reduce`, the glass tokens switch to the solid surface tokens.
- Deliberate departures from the reference, kept for accessibility: text is 14 px or larger, every text pair passes WCAG AA, labels on orange use the dark `--color-bg` (white on orange fails 4.5:1).
- Rejected: Neumorphism (low-contrast boundaries hide focus), Cyberpunk (neon undermines business credibility). Glassmorphism was rejected first and adopted in phase 7 once the contrast check could cover translucent surfaces.

## Design tokens

Source of truth is the `:root` block in `web/src/style.css`. `npm run check:contrast` reads it. Token names are stable; change values, not names.

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#0A0A0B` | page background, label colour on accent fills |
| `--color-surface` | `#121214` | cards, sidebar |
| `--color-surface-raised` | `#1B1B1F` | rows, inputs, nested panels |
| `--color-border` | `#2A2A30` | decorative card edges only |
| `--color-border-strong` | `#85858F` | control boundaries (inputs, buttons) |
| `--color-text` / `--color-text-muted` | `#F5F5F6` / `#A8A8B3` | text |
| `--color-accent` / `--color-focus` | `#FF6A2B` | primary action, focus ring, selected state |
| `--color-success` / `--color-warning` / `--color-danger` | `#34D399` / `#FBBF24` / `#FF7A7A` | on track / at risk / behind |

Glass tokens (percentages are fill opacity, so the check script can read them): `--glass-pct` 55% (cards, sidebar), `--sheen-pct` 3% (diagonal highlight), `--lift-pct` 5% (controls and rows on glass), `--pill-pct` 85% (voice pill), `--drawer-pct` 90% (trace drawer), `--glass-blur` 18px.

Type scale: 14 (minimum) / 18 body / 24 section / 32 metric / 56 hero. Spacing 4-8-12-16-24-32-48. Radius 12 control, 16 card, 20 panel. Motion 120 to 180 ms.

```css
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### Contrast (WCAG 2.x, computed by `npm run check:contrast`)

Solid surfaces (kept for the fallback):

| Foreground | on bg | on surface | on raised |
|---|---|---|---|
| text | 18.16 | 17.17 | 15.76 |
| text-muted | 8.40 | 7.94 | 7.29 |
| accent | 6.92 | 6.55 | 6.01 |
| success | 10.29 | 9.73 | 8.93 |
| warning | 11.85 | 11.21 | 10.28 |
| danger | 7.84 | 7.41 | 6.80 |

Translucent surfaces, worst case. "Page glow" is text placed directly on the page at its strongest glow (hero text, labels). "Glass" is the card fill over that glow. "Glass + sheen + lift" is a control or row sitting on a card. "Pill" and "drawer" are composited over a full-strength accent, because they can float over bright content:

| Foreground | page glow | glass | glass + sheen + lift | pill | drawer + lift |
|---|---|---|---|---|---|
| text | 11.99 | 15.08 | 12.03 | 14.12 | 13.28 |
| text-muted | 5.55 | 6.97 | 5.57 | 6.53 | 6.14 |
| accent | 4.57 | 5.75 | 4.59 | 5.38 | 5.06 |
| success | 6.80 | 8.54 | 6.82 | 8.00 | 7.52 |
| warning | 7.83 | 9.84 | 7.85 | 9.21 | 8.67 |
| danger | 5.17 | 6.51 | 5.19 | 6.09 | 5.73 |

Dark label (`--color-bg`) on accent fill: 6.9 or better. All 194 pairs pass (both themes): text 4.5:1, boundaries and focus ring 3:1. `--color-border-strong` is at least 3.5 on every surface above.

### Light theme

Same token names, overridden under `[data-theme="light"]`: bg `#F3F3F6`, surface `#FFFFFF`, raised `#ECECF1`, border `#D5D5DD`, border-strong `#6E6E7A`, text `#131316`, muted `#484853`, accent and focus `#B03A06`, success `#046045`, warning `#8A5100`, danger `#B42318`. Glass on light is frosted, after a warm blurred-glass reference: glass fill 42%, blur 28 px with 160% saturation, a bright 65% white rim, a warm soft shadow with a faint 1 px outline, whiter controls and rows (lift 45% white), sheen 22% white, pill 90%, drawer 94%, and larger radii (card 18 px, panel 26 px). The light page is a smooth blend of three warm colours with no shapes (`--mesh-a` `#FFD9BA`, `--mesh-b` `#FFE6C7`, `--mesh-c` `#FBD8C6`); dark keeps its plain background. The contrast check tests text on each mesh colour and on glass over each. 

The theme is set before first paint from the saved choice (`localStorage`, wrapped in try/catch), else the system preference. The toggle sits at the right of the top bar (`aria-pressed`, `aria-label`). `npm run check:contrast` checks both themes against their own worst-case surfaces; on light it assumes dense text covers 40% of the area behind the pill and drawer.

## Sidebar open and closed

The sidebar toggle (top bar, left) switches between two layouts built from the same DOM. The choice is saved in `localStorage` (try/catch) and applied before first paint.

| Sidebar | Layout | What it is |
|---|---|---|
| Open (default) | `data-layout="scroll"` | One long page: hero and line cards, output and trend charts, then a full-size Assistant, Follow-ups, Handover and Container load section, then the trace tile. The forms, the Open/Closed/All filter and the chat example chips are shown, and lists are not truncated. |
| Closed | `data-layout="compact"` | The one-screen dashboard. A small "SYNTHETIC DEMO DATA" chip with a connection dot appears in the top bar so the notice is never hidden. |

Sidebar links (open layout): Home, Assistant, Follow-ups, Handover and Container load scroll their section to the top with an eased scroll of 0.8 to 1.8 s (instant under `prefers-reduced-motion`). The active link and the breadcrumb follow the scroll position (scroll-spy) and the last link stays current at the end of the page. Each tool section is about one screen tall, so every link can bring its section to the top. MCP trace still opens the drawer. Sending a request from the top bar scrolls to Assistant, where the answer appears.

Transitions are deliberately slow. The sidebar slides and fades over 900 ms while the grid column closes. The content fades out (500 ms), switches layout while hidden, then fades in (500 ms). A second toggle press during the switch is ignored. A closed sidebar is `visibility: hidden` after the slide, so it leaves the tab order. Below 1100 px the sidebar is a top block that collapses by height instead of sliding sideways.
## Layout

Left sidebar plus a scrolling content column. Desktop (1500 px and wider) puts the hero and the line cards in one row; below that they stack.

```
┌────────────┬──────────────────────────────────────────────────────────────┐
│ LineLedger │ Dashboard / Home  [ Type a request (press /) ] Send Listen … │
│ GENERAL    ├───────────────────────┬──────────────┬──────────────┬────────┤
│  Home      │ Plant output          │ Line 1 card  │ Line 2 card  │ + stock│
│  Assistant │ 80.7%  ◆ AT RISK      │ % · bar      │ % · bar      │ dashed │
│ TOOLS      │ [Shift summary] [..]  │              │              │        │
│  Follow-ups├───────────────────────┴──────────────┴──────────────┴────────┤
│  Handover  │ Chat transcript (wide)               │ Output vs target bars  │
│  Container ├──────────────┬──────────────┬────────┴──────┬─────────────────┤
│ INSIGHTS   │ Open         │ Handover     │ Container     │ MCP trace tile  │
│  MCP trace │ follow-ups   │ notes        │ load          │ (opens drawer)  │
│ [SYNTHETIC │              │              │               │                 │
│  DEMO DATA]│              │      ( ● IDLE · voice state pill )              │
└────────────┴──────────────┴──────────────┴───────────────┴─────────────────┘
```

- The command bar is the composer. `/` or Ctrl/Cmd+K focuses it.
- The MCP trace is a right-edge drawer (native `<dialog>`). Escape or a backdrop click closes it.
- Below 1100 px the sidebar becomes a top block (brand, nav row, synthetic-data card) and every row stacks to one column. The composer and the voice pill stay on screen.
- At 1920x1080 the hero, line cards, chat, chart and data cards are visible without scrolling in the empty states. A populated container-load result makes the bottom row taller, so the column scrolls a little. The bottom 96 px of the column is reserved for the voice pill.
- No remote images, no heavy animation. Blur is limited to `backdrop-filter` on the glass surfaces (and a 4px blur on the drawer backdrop).

## Voice states

`idle`, `listening`, `thinking`, `speaking`, `error`.

- Each state is shown by text and an icon, never by color alone, and announced through an `aria-live` region.
- The microphone starts only after an explicit user action. Text entry is always available.
- Spoken output can be stopped. Unsupported browsers and denied permission degrade to text.
- No claim that speech recognition is reliable in heavy factory noise.

## Accessibility

- Minimum 48x48 px touch targets.
- Visible focus ring on every control (3 px, offset 3 px). Full keyboard navigation: Tab, Shift+Tab, Enter, Space, Escape.
- Respect `prefers-reduced-motion`. Transitions 120 to 180 ms at most.
- Body text 18 px, nothing below 14 px.
- Semantic labels on every control.

## Components and states

| Component | States |
|---|---|
| Sidebar connection card | connecting, connected, error (always shows SYNTHETIC DEMO DATA) |
| Chat transcript | empty, idle, thinking, error |
| Text composer | empty, idle, thinking, error |
| Microphone control | idle, listening, error |
| Voice output indicator | idle, speaking, error |
| Global voice-state pill | idle, listening, thinking, speaking, error |
| MCP trace tile + drawer | empty, initializing, listing tools, calling tool, success, error |
| Hero + line cards + output chart | empty, loading, populated, error |
| Shift trend card | loading, populated (needs 2+ shifts), empty, error |
| Handover panel | empty, loading, populated, error |
| Follow-up panel | empty, loading, populated, error |
| Container-load card | empty, calculating, result, invalid input, error |
| MCP App card | empty, loading, rendered, unsupported, error (label "MCP App" only if compliant) |

Every state is driven by real application events. An error never silently turns into success. The trace tile and drawer read from the server-side trace tap, so it cannot show traffic that did not happen.

## Acceptance

- Screenshot at exactly 1920x1080 stored at `artifacts/lineledger-1920x1080.png` and visually inspected (taken after Shift summary and Stock of HDPE, so the bottom row is not stretched by a container result).
- `npm run check:contrast` passes for every foreground/background pair in use.
- Keyboard-only pass through composer, voice, send and any dashboard control.
- "SYNTHETIC DEMO DATA" visible on screen at all times (sidebar card; top block on narrow screens). No claim of live factory monitoring.
