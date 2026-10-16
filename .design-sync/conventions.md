# Vortex DS conventions

Vortex is a small React design system (`@vortex/ds`): tokens plus 11 React exports (Button, Chip, Card, Input, Select, Textarea, Tabs, TabList, Tab, Notice, Icon). Compose them; never restyle them.

## Setup
- Import the one global stylesheet: `@vortex/ds/styles.css` (it defines tokens and every component class). No provider or wrapper exists; components work anywhere.
- The stylesheet sets NO base typography. On `body` set `font-family: var(--sans); font-size: var(--fs-md); color: var(--ink); background: var(--bg)`.
- Light is the default; dark follows `prefers-color-scheme` through the same token names. Never hard-code a colour.

## Styling idiom: tokens, then component classes
All look is CSS custom properties on `:root`:
- Surfaces/text: `--bg --panel --panel-2 --code --ink --ink-2 --ink-3 --line --line-strong`
- Intent: `--accent --accent-ink --accent-soft`, and `--ok --warn --bad --wait` each with a `-soft` background
- Type: `--sans --mono --fs-xs --fs-sm --fs-md --fs-lg --fs-xl`
- Space (4px grid): `--sp-1` (4px) to `--sp-6` (32px). Radii: `--r-sm --r-md --r-lg --r-pill`. Depth: `--shadow-sm --shadow-md`. Control heights: `--ctl-h` (30px), `--ctl-h-sm` (24px)
Layout around components uses these tokens (`gap: var(--sp-2)`, `padding: var(--sp-4)`).

Components render fixed class names: `btn btn-primary|btn-danger|btn-ghost btn-sm btn-icon on`, `chip` + `ok|warn|bad|wait|accent`, `card`, `notice` + tone, `tabs` / `subtabs` + `tab active`, `icon`. Inputs are plain `input/select/textarea` elements styled by element selector.

## Components and gotchas
- `Button` variant default|primary|danger|ghost; `size="sm"` for inline actions; `icon` = square icon-only button (give `aria-label`); `on` marks a switched-on toggle.
- `Chip` tone neutral|ok|warn|bad|wait|accent: a status pill, monospace. `Notice` tone accent|ok|warn|bad|wait: an inline message with a left rule.
- `Card` takes `title` (renders an h2) and optional `badge`.
- `Icon name=` one of close, plus, search, columns, filter, chevronDown, chevronRight, check, info, refresh, arrowLeft, external; 16px, inherits `currentColor`. Put it inside a Button with text, or alone in an `icon` Button.
- `Input`/`Select`/`Textarea`: `invalid` sets aria-invalid; the red border needs `className="field-ctl"` alongside it.
- `Tabs` holds no state: pass `items`, `active`, `onChange`; `variant="pill"` is the compact second level. `TabList` + `Tab active` is the manual form.

## Where the truth lives
Tokens and every class: `styles.css` (imports `_ds_bundle.css`). Props: `components/general/<Name>/<Name>.d.ts`.

## Idiomatic snippet
```jsx
<Card title="CI status" badge={<Chip tone="warn">1 running</Chip>}>
  <p style={{ margin: '0 0 var(--sp-3)' }}>Lint and unit tests passed. End-to-end is still running.</p>
  <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
    <Button variant="primary" size="sm">Open checks</Button>
    <Button size="sm">Re-run</Button>
  </div>
</Card>
```
