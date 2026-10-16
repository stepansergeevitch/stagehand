# Vortex DS conventions

Vortex is a dark-first developer-tool design system (`@vortex/ds`): layered slate-navy surfaces, 1px borders, one indigo-violet brand. Compose the components; never restyle them.

## Setup
- Import the one global stylesheet: `@vortex/ds/styles.css` (tokens, base typography on `body`, every component class, IBM Plex fonts). No provider or wrapper exists.
- Theme follows `prefers-color-scheme`. Pin one on any subtree with `data-theme="light"` or `data-theme="dark"`.

## Styling idiom: tokens, then component classes
Everything is a CSS custom property; never write a raw colour.
- Surfaces (low to high): `--surface-0` (=`--bg`), `--surface-1` (=`--panel`), `--surface-2` (=`--raised`), `--surface-3` (menus, tooltips); `--panel-2` quiet/inset, `--code` hover and chip fill, `--field-bg` inputs.
- Text: `--ink` `--ink-2` `--ink-3`. Lines: `--line` (hairline), `--line-strong`, `--control-border` (3:1 form controls).
- Brand: `--accent` (text, links, focus, with `--accent-ink`), `--accent-soft`; fills `--brand`/`--brand-2` and `--brand-grad` (gradient for primary buttons, the active-tab bar only).
- Intent, each with `-soft` tint and `-ink`: `--ok --warn --bad --info`, and `--wait` (teal, not brand violet).
- Type: `--sans --mono`, scale `--fs-xs 11 / sm 12.5 / md 14 / lg 16 / xl 20 / 2xl 28`. Space `--sp-1..6` (4px grid). Radius `--r-sm/md/lg/xl/pill`. Elevation `--shadow-sm/md/lg` + inner highlight `--hi`. Controls `--ctl-h` 32px, `--ctl-h-sm` 26px. Motion `--dur` 150ms, `--dur-overlay` 220ms (both 0 under reduced motion).

## Components and gotchas
- `Button` variant default|primary|danger|ghost, `size="sm"`, `leadingIcon="name"` (glyph before the label), `icon` (square, one icon), `on`; `IconButton icon label` is the icon-only form (label required).
- `Chip` is sans by default; add `mono` for ids, branches and other machine text. `Chip` / `Badge` / `StatusDot` tone neutral|ok|warn|bad|wait|accent|info: a toned chip leads with a dot, so state is never colour alone. `StatusDot pulse` = in progress.
- `Notice` tone accent|info|ok|warn|bad|wait shows a tone icon. `Card` takes `title`, `badge`, `actions` (header right) and `footer`.
- `Input/Select/Textarea invalid` gives the red state. `CodeArea` (size sm|md|lg, `prose`) is the textarea for commands and machine text; `prose` wraps lines. `MoreMenu` is the header or row `⋯` button; put `MenuItem`s (and `<hr />`) inside, choosing one closes it. `Checkbox`, `Radio`, `Switch` take `label`.
- `Tabs items active onChange` (state is the caller's); `variant="pill"` for the second level; `TabList` + `Tab active` manually.
- `Tooltip text`, `Hint text` (info icon), `Kbd`, `Divider [vertical]`, `Skeleton`, `Spinner`, `EmptyState icon title action`, `Menu` + `MenuItem` (+ `<hr />`), `Popover` (surfaces; the host positions them), `Avatar name`.
- `Wordmark` (size sm|md|lg, `markOnly`) is the logo, `Mark` the bare mark; copy is sentence case, product name "Vortex".

## Where the truth lives
`styles.css` for tokens and classes; `components/general/<Name>/<Name>.d.ts` for props; `docs/brand-guidelines.md` in the repo for voice and logo rules.

## Idiomatic snippet
```jsx
<Card title="CI status" badge={<Chip tone="warn">1 running</Chip>}
      footer={<Button variant="primary" size="sm">Open checks</Button>}>
  <Notice tone="warn">End-to-end is still running.</Notice>
</Card>
```
