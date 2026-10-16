# Vortex brand guidelines

> Status: v1. The source of truth for every value below is `packages/vortex-ds/src/styles.css` (tokens) and the components in `packages/vortex-ds/src`. This document describes them; when they disagree, the code wins and this file is fixed.

## Quick reference

| Element | Value |
|---------|-------|
| Name | Vortex (formerly Vortex) |
| Positioning | A local orchestrator that walks tickets through stages with headless Claude Code, pausing where a human must look. |
| Primary colour | `--accent` #2b59d6 (dark mode #7c9bff) |
| UI font | IBM Plex Sans, mono IBM Plex Mono |
| Voice | Plain, direct, sentence case |

## 1. Name and positioning

- Written "Vortex": capital V, one word, never "VORTEX", "vortex" in running text or "Vortex.app".
- One line: *a local orchestrator that walks tickets through stages with headless Claude Code, pausing where a human must look.*
- What it is not: a hosted service, a chat client, a CI system. It runs on the user's machine, on their repositories.
- The old name Vortex survives only in code, paths (`~/.vortex`), environment variables and storage keys. It does not appear in anything a person reads in the UI.

## 2. Colour

All colour is a CSS custom property on `:root`; nothing writes a raw colour. Light is the default, dark follows `prefers-color-scheme` with the same names.

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--accent` | #2b59d6 | #7c9bff | Brand colour: primary actions, links, the active tab, the mark |
| `--accent-ink` | #ffffff | #0c1118 | Text and icons on `--accent` |
| `--accent-soft` | #e6ecfb | #1c2845 | Hover and selected backgrounds |
| `--bg` | #f5f6f8 | #0c1118 | Page |
| `--panel` / `--panel-2` | #ffffff / #fafbfc | #141b24 / #10161e | Cards, inputs / quiet panels |
| `--code` | #eceff3 | #1c2530 | Chips, code and hover fills |
| `--ink` / `--ink-2` / `--ink-3` | #0f1722 / #3f4b5b / #5d6a7b | #e8edf3 / #b6c1cd / #8795a5 | Text: primary, secondary, muted |
| `--line` / `--line-strong` | #e1e5ea / #c9d0d9 | #263140 / #364457 | Dividers / control borders |

Intent colours, each with a `-soft` background: `--ok` #17803d, `--warn` #a9640a, `--bad` #c03030, `--wait` #6a4fc2 (dark: #4cc47e, #e3ac55, #f07b74, #b3a2f2). Meaning is never carried by colour alone: a chip or notice always says it in words too.

Surfaces that stay dark in both themes: `--terminal-bg` (the terminal), `--scrim` with `--scrim-ink`, `--scrim-link`, `--scrim-line` (the lightbox bar over media), `--media-bg`. `--bad-ink` is the text on a solid `--bad` fill.

Rules: one accent only; never use `--accent` for status; add a token (with its dark value) before adding a colour; a label's colour is user data (the swatches in `web/src/Labels.tsx`), not brand colour.

Measured contrast (WCAG): `--ink` on `--panel` 18.0:1, `--ink-3` on `--panel` 5.5:1, `--accent` on `--panel` 6.0:1, `--accent-ink` on `--accent` 6.0:1 (dark 7.2:1). Known gap: the 11px chip text on `-soft` backgrounds is 4.3:1 for ok and 4.0:1 for warn, under AA; the chip's words carry the meaning, and a darker `--ok` / `--warn` is the fix.

## 3. Typography

```css
--sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
--mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
```

Plex Sans 400 / 500 / 600 and Plex Mono 400 / 500 ship with the design system (latin subset, `src/fonts/`, SIL OFL). Body is `--fs-md` (14px) at line-height 1.5.

| Token | Size | Use |
|-------|------|-----|
| `--fs-xs` | 11px | Chips, badges |
| `--fs-sm` | 12.5px | Dense text, small buttons |
| `--fs-md` | 14px | Body, controls |
| `--fs-lg` | 16px | Wordmark in the top bar |
| `--fs-xl` | 19px | Large wordmark, page-level titles |

Weights: 400 body, 500 controls and tabs, 600 card and section titles, 700 the wordmark only. Machine text (branches, commands, ids, chips, logs) is always mono.

## 4. Logo

The mark is a spiral of growing half-circles: a vortex seen from above. It is a stroke icon on a 24px grid, drawn in `currentColor` so it follows its context.

| Variant | Where | Component |
|---------|-------|-----------|
| Wordmark (mark + "Vortex") | Top bar, documents | `<Wordmark size="sm\|md\|lg" />` |
| Mark only | Collapsed or tight places | `<Wordmark markOnly />`, `<Mark size={n} />` |
| App icon | Favicon, home-screen icon | `web/public/favicon.svg`, `web/public/apple-touch-icon.png`: white mark on an `--accent` square |

- Mark colour: `--accent` beside the wordmark; `--accent-ink` on an accent fill; `--ink` in one-colour contexts.
- Clear space: at least the height of the mark on every side.
- Minimum size: the mark is legible from 16px; the full wordmark from 14px type.
- Do not: rotate, outline, add shadows or gradients, recolour outside the tokens above, stretch, set the name in another font, or put the mark on a busy background.

## 5. Voice and tone

Plain, direct, sentence case. Say what happens and what the person can do about it.

| We are | We are not |
|--------|-----------|
| Direct: "Rebase onto main" | Clever: "Let's sync things up!" |
| Specific: "Setup failed: port 5432 is already in use." | Vague: "Something went wrong." |
| Calm when it fails: state, cause, next step | Alarmed: capitals, exclamation marks |
| Brief | Wordy or apologetic |

Rules:
- Sentence case everywhere (buttons, tabs, titles, columns): "Create task", not "Create Task". Proper nouns keep their capitals.
- Buttons are verbs naming the result ("Run QA", "Delete branch"); "Create new <entity>" opens a create dialog.
- Labels use the person's words, not internal ones. No stage codes, run ids, or implementation names in a label; put detail in the field's hover hint.
- Explanations live in hints on hover, never as free-floating paragraphs.
- Errors: what failed, why if known, what to do. Success is quiet.
- No emoji in the product. Status uses a chip tone, not a symbol.

## 6. Components and spacing

- Space is a 4px grid: `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32.
- Radii: `--r-sm` 4, `--r-md` 6 (controls), `--r-lg` 10 (cards), `--r-pill` (chips, pill tabs).
- Depth: `--shadow-sm` on cards, `--shadow-md` on menus and dialogs. Controls are 30px tall (`--ctl-h`), 24px small.
- Icons: the `Icon` set only, 16px stroke icons in `currentColor`.
- Pages are built from `@vortex/ds` (Button, IconButton, Chip, Badge, Card, Input, Select, Textarea, CodeArea, Tabs, Menu, MoreMenu, Notice, Icon, Wordmark) and the shared components in `web/src/components/`; a page never restyles them.

- DS conventions: a generic primitive goes into `packages/vortex-ds/src`, is exported from `index.ts`, styled with tokens in `styles.css`, and appears on the DS preview (Claude Design) with its variants. `Button` takes `leadingIcon` for a glyph before the label (`icon` / `IconButton` is the icon-only square). `Chip` renders sans for plain labels; `mono` marks ids, branches and other machine text. `Tab` labels may hold a `Badge` (spaced by the DS). `MoreMenu` is the one `⋯` menu (rare and destructive actions; items close it). `CodeArea` is the one text area for commands and machine text. `money` and counts group thousands ($68,779).

## Changelog

- v1: first guidelines, written with the rename from Vortex.
