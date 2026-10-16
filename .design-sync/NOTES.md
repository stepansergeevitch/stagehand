# design-sync notes (@vortex/ds, package shape)

- Build: `npm run build -w @vortex/ds` (vite + tsc) -> packages/vortex-ds/dist. Converter entry: `--entry ./packages/vortex-ds/dist/index.js --node-modules ./node_modules` (hoisted react at repo root).
- CSS: `cssEntry` = dist/index.css (tokens + components in one file).
- Render check: Stagehand's Chromium build (~/.stagehand/browsers, chromium_headless_shell-1234) does not match the staged playwright pin; run with `DS_CHROMIUM_PATH=~/.stagehand/browsers/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
- `.d.ts` extraction drops inherited HTML attributes (disabled, onClick ...); `dtsPropsFor` hand-writes Button, Input, Select, Textarea, Tab, Icon. Update when props change.
- Known render warns: `[FONT_MISSING] IBM Plex Mono/Sans` - no font files exist in the repo; DS falls back to system-ui / ui-monospace. Action required if brand fonts matter: supply woff2 + `extraFonts`.

## Re-sync risks
- Previews and dtsPropsFor are hand-written against current props; new props/components need updates.
- Colour/dark mode only verified in light (default) rendering.
- Fonts not shipped (see above).
