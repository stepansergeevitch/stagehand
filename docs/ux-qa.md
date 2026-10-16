# Vortex UX QA

Run on branch `ux-redesign`, headless Chromium (Playwright) against `vite dev` proxied to the live API (GET only; every non-GET was answered by a route stub, none reached the server). Automated checks per screen: console and page errors, horizontal page overflow, elements wider than the viewport, emoji in text, inline `style` count, and (coarse pointer) controls shorter than 44px.

## Rendered and checked (page x viewport x theme)

Each row was rendered at 1440 and 390 px, light and dark (4 combinations), every reachable tab opened.

| Page | Tabs / states |
|------|---------------|
| Overview | table, readiness panel |
| Tasks, New task dialog | list, create dialog (`/tasks/new`) |
| Task workspace | Work, Code, Pull request, Conversation, Details; implementation, PR waiting, done tasks |
| Product, New owner dialog, Product owner | Design, Questions, Corrections, Context, Tickets, Events |
| Sessions, New session dialog, Session | Terminal, Changes |
| Usage, Timing | 24 h / 7 d / 30 d / all time |
| Resources | Running, Policies, Recent actions (needs the stub below) |
| Environments, New environment dialog (`/envs/new`), Environment | General, App, Lifecycle, Database, Agents, CLAUDE.md, QA, PR templates, CI autopilot, Code review |
| Config dirs, Config dir | General, Contents, CLAUDE.md, Rules |
| AI accounts, Account | General, Status, Models |
| Integrations, Integration, Prompter | default tab |

## Rendered with stubbed API responses (1440 and 390, light and dark)

Agent questions (answer panel), failed, blocked, rate limited, User Review panel (approve / request changes), PR waiting with failing CI (Fix CI, `⋯` menu open), empty Tasks / Sessions / Product / Overview lists, a dirty form with the sticky Save bar, Resources (the running server still answers with the pre-rename `stagehand` key; the stub aliases it to `vortex`).

## Interaction checks

- Tab order from load: skip link, home, every nav item, collapse, search, usage, page controls; a focus ring on every stop (desktop 1440).
- Cmd/Ctrl+K opens the palette, Esc closes it (4 combinations).
- Create dialogs (`/envs/new`): focus moves in, 25 Tabs stay inside, Esc returns to `#/envs` (4 combinations).
- Reduced motion: `--dur` and `--dur-overlay` compute to 0ms, no running CSS animation on the Overview; chip pulse and thread pulse rules are disabled under the media query.
- Coarse pointer (390 px with touch emulation): buttons, tabs, menu items, inputs, crumbs are 44px; what remains short is inline text links in running text and table cells (exempt) and two PR-comment icon links.

## Found and fixed in this pass

PR checks table overflowed at 390 (now scrolls in its own box); anchor chips in the chat overflowed; small buttons were 36px on touch; breadcrumb links were 19-25px; one-off `button-link` anchors replaced by `btn`; page title hint icon had no gap; explanatory paragraphs in Blocked / PR comments / QA became hovers; Resources crashed only against the stale live server.

## Not verified

- Real rate-limit, merge and PR draft review states beyond the stubs above; a PR draft editor with rendered preview was not rendered (no live data).
- Drag, paste and file-attach flows; xterm terminal rendering (headless, lazy chunk); the Prompter window open.
- Windows / Safari / Firefox; screen-reader output (landmarks and ARIA read from the DOM only).
- Contrast was judged from the tokens and screenshots, not measured per element; the 11px chip text on `-soft` fills remains the known AA gap.
- Emoji still appear in the Conversation tab: the server writes them into stored agent notes (`server/src/engine.ts`, `resources.ts`), the UI renders what it is given.
