# LineLedger UI specification

Voice-first factory-floor co-pilot. Synthetic demo data only.

## Style decision

- Primary style: **Bento Grid**. Independent cards separate three tasks: chat, live MCP trace, shift dashboard.
- Secondary style: **Swiss Design**. One sans-serif family, strong alignment, clear hierarchy, consistent numerals.
- Default palette: **high-contrast, solid-surface dark UI**. No blur, no transparency, no gradients.
- Rejected: Glassmorphism (blur makes contrast fragile), Neumorphism (low-contrast boundaries hide focus), Cyberpunk (neon undermines business credibility).

## Design tokens

```css
:root {
  color-scheme: dark;

  /* Surfaces */
  --color-bg: #0B1220;
  --color-surface: #111C2E;
  --color-surface-raised: #19273B;
  --color-border: #334155;          /* decorative card edges only */
  --color-border-strong: #64748B;   /* control boundaries (inputs, buttons): >= 3:1 on all dark surfaces */

  /* Text */
  --color-text: #F1F5F9;
  --color-text-muted: #B7C4D8;

  /* Accent and status */
  --color-accent: #2DD4BF;
  --color-success: #22C55E;
  --color-warning: #F59E0B;
  --color-danger: #F87171;
  --color-focus: #2DD4BF;

  /* Typography */
  --font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --text-xs: 14px;      /* minimum size for any text */
  --text-body: 18px;
  --text-section: 24px;
  --text-metric: 32px;
  --text-hero: 40px;

  /* Spacing */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-6: 24px; --space-8: 32px; --space-12: 48px;

  /* Shape */
  --radius-control: 8px;
  --radius-card: 12px;
  --radius-panel: 16px;

  /* Motion (state must never depend on animation) */
  --motion-fast: 120ms;
  --motion-normal: 180ms;
}

[data-theme="light"] {            /* lower priority: only after the dark theme is stable */
  color-scheme: light;
  --color-bg: #F8FAFC;
  --color-surface: #FFFFFF;
  --color-surface-raised: #E2E8F0;
  --color-border: #64748B;
  --color-text: #0F172A;
  --color-text-muted: #334155;
  --color-accent: #0F766E;
  --color-focus: #0F766E;
}

:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### Contrast (WCAG 2.x, computed locally in Phase 0, not copied)

| Foreground | on `--color-bg` #0B1220 | on `--color-surface` #111C2E | on `--color-surface-raised` #19273B |
|---|---|---|---|
| text #F1F5F9 | 17.09 | 15.59 | 13.74 |
| text-muted #B7C4D8 | 10.61 | 9.68 | 8.53 |
| accent #2DD4BF | 10.06 | 9.18 | 8.09 |
| success #22C55E | 8.22 | 7.50 | 6.61 |
| warning #F59E0B | 8.72 | 7.95 | 7.01 |
| danger #F87171 | 6.77 | 6.18 | 5.44 |

All text pairs pass the 4.5:1 AA minimum.

Non-text boundaries (WCAG 1.4.11 needs 3:1):

- `--color-border` #334155 is only 1.81:1 on bg and 1.65:1 on surface. Use it for decorative card edges only.
- `--color-border-strong` #64748B is 3.93 on bg, 3.59 on surface, 3.16 on raised. Use it for every input, button and control boundary.
- Light theme (`#0F172A` on `#F8FAFC`) 17.06; muted `#334155` on `#FFFFFF` 10.35; accent `#0F766E` on `#F8FAFC` 5.23; border `#64748B` on `#F8FAFC` 4.55.

`npm run check:contrast` (Phase 2) must recompute these from the actual CSS values and fail on any normal-text pair below 4.5:1.

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
