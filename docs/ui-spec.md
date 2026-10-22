# LineLedger UI specification

Voice-first factory-floor co-pilot. Synthetic demo data only.

## Style decision

- Primary style: **dark dashboard with a left sidebar** (Vaulto-style reference). Sidebar navigation, a top command bar, a hero metric, then independent cards.
- Secondary style: **Swiss Design**. One sans-serif family, strong alignment, clear hierarchy, consistent numerals.
- Palette: neutral near-black surfaces, one orange accent (`#FF5A1F`). Red (`--color-danger`) means "behind", never decoration.
- Cards are **solid surfaces**. No blur, no transparency on cards or text.
- One decorative exception to the old "no gradients" rule: a static radial glow on the page background, behind the cards. It carries no text and no state.
- Deliberate departures from the reference, kept for accessibility: text is 14 px or larger, every text pair passes WCAG AA, labels on orange use the dark `--color-bg` (white on orange fails 4.5:1).
- Rejected: Glassmorphism (blur makes contrast fragile), Neumorphism (low-contrast boundaries hide focus), Cyberpunk (neon undermines business credibility).

## Design tokens

Source of truth is the `:root` block in `web/src/style.css`. `npm run check:contrast` reads it. Token names are stable; change values, not names.

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#0A0A0B` | page background, label colour on accent fills |
| `--color-surface` | `#121214` | cards, sidebar |
| `--color-surface-raised` | `#1B1B1F` | rows, inputs, nested panels |
| `--color-border` | `#2A2A30` | decorative card edges only |
| `--color-border-strong` | `#6B6B76` | control boundaries (inputs, buttons) |
| `--color-text` / `--color-text-muted` | `#F5F5F6` / `#A8A8B3` | text |
| `--color-accent` / `--color-focus` | `#FF5A1F` | primary action, focus ring, selected state |
| `--color-success` / `--color-warning` / `--color-danger` | `#34D399` / `#FBBF24` / `#FF6B6B` | on track / at risk / behind |

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

| Foreground | on bg | on surface | on raised |
|---|---|---|---|
| text | 18.16 | 17.17 | 15.76 |
| text-muted | 8.40 | 7.94 | 7.29 |
| accent | 6.35 | 6.00 | 5.51 |
| success | 10.29 | 9.73 | 8.93 |
| warning | 11.85 | 11.21 | 10.28 |
| danger | 7.13 | 6.74 | 6.19 |

Dark label (`--color-bg`) on accent fill: 6.35. All text pairs pass the 4.5:1 AA minimum.

Non-text boundaries (WCAG 1.4.11 needs 3:1): `--color-border-strong` is 3.76 on bg, 3.55 on surface, 3.26 on raised. `--color-border` is decorative only. Focus ring `--color-focus` is 5.51 or better.

There is no light theme. Add one only after the dark theme is stable.

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
- No remote images, no blur, no heavy animation.

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
