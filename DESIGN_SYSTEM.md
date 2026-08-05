# AIRS Agent — Design System

The interface serves people making airspace decisions under time pressure. It
favours legibility, unambiguous status and honest absence over decoration.

## 1. Token layer

All colour lives in `src/styles.css` as OKLCH custom properties exposed to
Tailwind through `@theme`. Components use semantic utilities
(`bg-background`, `text-foreground`, `border-border`, `text-muted-foreground`).
Hard-coded colour utilities (`text-white`, `bg-black`, `bg-[#...]`) are not used
in any application screen or component written for AIRS Agent, because they
bypass the light/dark themes. The only remaining occurrences are the stock
shadcn overlay scrims (`bg-black/80` in `dialog`, `sheet`, `drawer`,
`alert-dialog`), which are intentional modal dimming rather than surface colour.

| Token | Light | Role |
| --- | --- | --- |
| `--background` | `oklch(0.985 0.004 258)` | Page surface |
| `--foreground` | `oklch(0.183 0.069 258.6)` | Primary text |
| `--primary` | `oklch(0.482 0.138 250.3)` | Actions, active state |
| `--accent` | `oklch(0.801 0.159 88.5)` | Operational highlight (shared across themes) |
| `--destructive` | `oklch(0.556 0.216 27.3)` | Denials, destructive actions |

Dark theme redefines the same names under `.dark`; no component needs to know
which theme is active.

## 2. Typography

| Token | Family | Use |
| --- | --- | --- |
| `--font-display` | Barlow Condensed | Headings, wayfinding, dense labels |
| `--font-sans` | Barlow | Body and controls |
| `--font-mono` | IBM Plex Mono | Identifiers, coordinates, timestamps |

Condensed display type is a deliberate operations-console choice, not a
stylistic one: it keeps long agency and incident names on one line.

## 3. Status expression

Status is never carried by colour alone — every pill states its condition in
words. `StatusPill` (`src/components/brand`) takes a tone
(`neutral | info | active | caution | critical`), and the awareness screens map
domain values to tones in `src/components/awareness-ui.tsx`:

- **Freshness** — current → `active`, recent → `info`, aging → `caution`,
  stale/expired → `critical`, unknown → `neutral`.
- **Urgency** — routine → `neutral`, elevated → `info`, priority → `caution`,
  immediate → `critical`.
- **Verification** — confirmed → `active`, corroborated/under review → `info`,
  disputed/unable to verify → `caution`, rejected → `critical`,
  unreviewed → `neutral`.

## 4. Disclosure-absence convention

A field the reader is not entitled to see is **stated as absent**, never faked,
blanked or zero-filled. `Detail` renders
"Not released at your access level" for an absent value. This keeps the
interface honest about the difference between *nothing was reported* and
*something was reported and withheld from you*.

Denials follow the same rule: `Denied` maps a server deny code to one sentence
of plain language (`src/components/incident-ui.tsx`,
`src/components/awareness-ui.tsx`). The UI never invents a reason and never
decides access — it mirrors the server's decision.

## 5. Layout and accessibility

- Section layout routes (`/awareness`, `/incidents`, `/map`) provide the shell;
  children render through `<Outlet />`.
- Panels are `Panel` sections with a bordered heading; forms use `Field` with a
  real `<label>` wrapping its control.
- Grouped toggles (map layers) use `fieldset`/`legend` with checkboxes so the
  group is reachable and announced by keyboard and screen reader.
- Denials render with `role="alert"`.
- Brand assets live in `public/brand/airs-agent/` and are checked by
  `scripts/verify-brand-assets.mjs`.
