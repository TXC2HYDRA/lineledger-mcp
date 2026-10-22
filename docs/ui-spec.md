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

Three-column CSS Grid at desktop; stacks below the narrow breakpoint without hiding the composer or the voice-state strip.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ LINELEDGER · SYNTHETIC DEMO DATA                         ● MCP connected  │
├───────────────────────┬─────────────────────────┬─────────────────────────┤
│ CHAT                  │ LIVE MCP TRACE          │ SHIFT DASHBOARD         │
│ Assistant transcript  │ initialize              │ Output / target         │
│ Operator request      │  request + response     │ Line 1   Line 2         │
│ Assistant result      │ tools/list              │ progress progress       │
│                       │  tool schemas           │                         │
│                       │ tools/call              │ Handover notes          │
│                       │  args + result          │ Open follow-ups         │
│ [ Type a request... ] │                         │ Container-load result   │
│ [🎙 Listen] [ Send ]  │                         │ MCP App card (optional) │
├───────────────────────┴─────────────────────────┴─────────────────────────┤
│ ● IDLE · LISTENING · THINKING · SPEAKING · ERROR     (text + icon)        │
└───────────────────────────────────────────────────────────────────────────┘
```

At 1920x1080 all three panels are visible. No remote images, no blur, no heavy animation.

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
| Header / connection status | idle, connecting, connected, error |
| Chat transcript | empty, idle, thinking, error |
| Text composer | empty, idle, thinking, error |
| Microphone control | idle, listening, error |
| Voice output indicator | idle, speaking, error |
| Global voice-state strip | idle, listening, thinking, speaking, error |
| MCP trace panel | empty, initializing, listing tools, calling tool, success, error |
| Shift dashboard | empty, loading, populated, error |
| Handover panel | empty, loading, populated, error |
| Follow-up panel | empty, loading, populated, error |
| Container-load card | empty, calculating, result, invalid input, error |
| MCP App card | empty, loading, rendered, unsupported, error (label "MCP App" only if compliant) |
| Theme control (optional) | idle, focused, active |

Every state is driven by real application events. An error never silently turns into success. The trace panel reads from the server-side trace tap, so it cannot show traffic that did not happen.

## Acceptance

- Screenshot at exactly 1920x1080 stored at `artifacts/lineledger-1920x1080.png` and visually inspected.
- `npm run check:contrast` passes for every foreground/background pair in use.
- Keyboard-only pass through composer, voice, send and any dashboard control.
- "SYNTHETIC DEMO DATA" visible on screen at all times. No claim of live factory monitoring.
