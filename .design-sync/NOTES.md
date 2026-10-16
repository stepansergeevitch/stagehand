# design-sync notes (@vortex/ds, package shape)

- Build: `npm run build -w @vortex/ds` (vite + tsc) -> packages/vortex-ds/dist. Converter entry: `--entry ./packages/vortex-ds/dist/index.js --node-modules ./node_modules` (hoisted react at repo root).
- CSS: `cssEntry` = dist/index.css (tokens + components in one file).
- Render check: Stagehand's Chromium build (~/.stagehand/browsers, chromium_headless_shell-1234) does not match the staged playwright pin; run with `DS_CHROMIUM_PATH=~/.stagehand/browsers/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
- `.d.ts` extraction drops inherited HTML attributes (disabled, onClick ...); `dtsPropsFor` hand-writes Button, Input, Select, Textarea, Tab, Icon. Update when props change.

## Re-sync risks
- Previews and dtsPropsFor are hand-written against current props; new props/components need updates.
- Colour/dark mode only verified in light (default) rendering.
- Fonts: IBM Plex woff2 (latin) live in packages/vortex-ds/src/fonts/, @font-face in src/fonts.css. vite lib mode would base64-inline them, so `scripts/fonts.mjs` (last step of the DS build) appends fonts.css to dist/index.css and copies the files to dist/fonts. `extraFonts: ["src/fonts.css"]` (package-relative) lands them in ds-bundle/fonts/; the converter drops the dist copies of the faces as "dead" and imports fonts/fonts.css from styles.css. Do not "fix" that log line.
- Mark/Wordmark previews use var(--accent) etc. directly; Wordmark has no `Name` prop (the name is fixed).
