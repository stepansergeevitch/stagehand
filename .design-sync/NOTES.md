# design-sync notes (@vortex/ds, package shape)

- Build: `npm run build -w @vortex/ds` (vite + tsc) -> packages/vortex-ds/dist. Converter entry: `--entry ./packages/vortex-ds/dist/index.js --node-modules ./node_modules` (hoisted react at repo root).
- CSS: `cssEntry` = dist/index.css (tokens + components in one file).
- Render check: Vortex's Chromium build (~/.vortex/browsers, chromium_headless_shell-1234) does not match the staged playwright pin; run with `DS_CHROMIUM_PATH=~/.vortex/browsers/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
- `.d.ts` extraction drops inherited HTML attributes (disabled, onClick ...); `dtsPropsFor` hand-writes Button, Input, Select, Textarea, Tab, Icon. Update when props change.

## Re-sync risks
- Previews and dtsPropsFor are hand-written against current props; new props/components need updates.
- Colour/dark mode only verified in light (default) rendering.
- Fonts: IBM Plex woff2 (latin) live in packages/vortex-ds/src/fonts/, @font-face in src/fonts.css. vite lib mode would base64-inline them, so `scripts/fonts.mjs` (last step of the DS build) appends fonts.css to dist/index.css and copies the files to dist/fonts. `extraFonts: ["src/fonts.css"]` (package-relative) lands them in ds-bundle/fonts/; the converter drops the dist copies of the faces as "dead" and imports fonts/fonts.css from styles.css. Do not "fix" that log line.
- Mark/Wordmark previews use var(--accent) etc. directly; Wordmark has no `Name` prop (the name is fixed).
- Visual rework: tokens are generated once from a node script (light + dark blocks, `[data-theme]` pins) and committed in src/styles.css; edit the CSS directly. Dark follows prefers-color-scheme; previews pin both themes with `previews/_Both.tsx` (a relative helper, not a component - the converter ignores it).
- Intent contrast was computed for text on `-soft` tints (>=4.5:1 in both themes); form-control borders use `--control-border` (>=3:1). `--line*` are decorative hairlines.
- `Foundations` is a documentation component (token scales) exported only so it gets a preview card; `overrides.Foundations` uses a tall single card. Icon uses cardMode column (GRID_OVERFLOW).
- Tooltip preview forces the bubble open with an injected <style>; the real one is hover/focus only.
- Web mock screenshots: `.ds-sync/shots.mjs` (gitignored) serves web/dist and stubs /api; a thin mock crashes pages that need real data, so only list/config pages render.
- MoreMenu preview clicks its own button on mount (useEffect) so the card shows the open menu; the menu is absolutely positioned, so the wrapper reserves min-height. CodeArea sizes map to rows (CODE_ROWS in Input.tsx). `Button leadingIcon` and `Chip mono` are listed in dtsPropsFor by hand.
