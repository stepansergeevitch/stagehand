# Vortex UX redesign

> Status: phase 1 (foundation) is implemented on branch `ux-redesign`: shell, shared layout components, DataTable, EntityView, Modal, Tasks. Phase 2 pages are built on top of it (section 9). Rules in `CLAUDE.md` (DataTable lists, EntityView tabs, hints on hover, every view in the URL, no env-specific logic) and `docs/brand-guidelines.md` still apply; this file decides how they look and are assembled.

## 1. Audit

Jobs, in order of frequency:

1. **Triage**: what needs me now, across every environment and ticket.
2. **Drive a task** through its stages: read what the agent produced, answer, approve, send back.
3. **Review**: code, PR checks, comments, QA evidence.
4. **Configure**: environments, config dirs, AI accounts, integrations (rare, but long forms).

Problems found in the old app:

| Problem | Where | Fix |
|---------|-------|-----|
| "Environments" appears twice (a task list and a config list), the sidebar is a collapsible tree with ▾ glyphs | nav | One level, three named groups, one meaning per name (section 2) |
| No global "needs me" signal beyond one count | shell | Status tones on nav badges, a live-connection dot, usage as one control |
| Account gauges (two bars per account) fill the top bar and push the page on phones | top bar | One usage button with a popover (section 3) |
| Every page invents its header (h1, `.sub`, back link, card h2) | all pages | `PageHeader` with breadcrumbs, meta, actions; entity pages use `EntityView` |
| Dashboard is a wall of cards, one per environment, status only as a coloured word | Tasks (Active tab) | An environment tab strip, then one table sorted by urgency (section 6.1) |
| Status is conveyed differently on every list (glyphs, chips, text) | lists | One status language (section 5) |
| Task view: 9 tabs, widgets above them, chips for stages, actions as a row of 6 buttons | task | Task workspace template (section 4.3) |
| Forms are one narrow column with labels above, Save at the bottom of a long tab | entity | Label-left fields, sticky Save bar while dirty |
| Sidebar becomes a horizontal strip on phones (hides, truncates) | mobile | Off-canvas drawer, 44px targets, tables scroll inside their box |
| Focus, contrast and touch size are per-page accidents | a11y | Rules in section 8, scoped in `shell.css` |

## 2. Information architecture

```
Work        Tasks · Product · Sessions
Insights    Usage · Timing · Resources
Settings    Environments · Config dirs · AI accounts · Integrations · Prompter
```

- **Tasks**: a tab per environment (badge = tasks waiting on you), then that environment's tasks in two pill tabs, Active and Completed (the tab is the path, `#/tasks` / `#/tasks/completed`; the environment tab is the route's `?env=`). A row opens the task workspace. The old `#/dashboard[/<id>/…]` paths parse and are rewritten to `#/tasks`.
- Labels are nouns in sentence case, no hints in the label; the hint is the link's `title` (the rail's label when collapsed).
- Badge in the nav: Tasks = tasks that need you (warn), else agents running (info). No other badges.
- Route page ids and URLs are unchanged (`routes.ts` is the contract; only labels moved).
- **Search / command palette** (`Cmd/Ctrl+K`, `CommandPalette`): jump to a page, an environment's tasks, or a task by id or title. Navigation only; every result is a `navigate`.

## 3. App shell

```
┌ sidebar 232px ┬ topbar 52px: [search ⌘K]                    [● Live] [● 13% used ▾] ┐
│ Wordmark      ├────────────────────────────────────────────────────────────────────┤
│ WORK          │ <main id="main">  PageFrame(width) → PageHeader → page content      │
│  Tasks (2)    │                                                                    │
│ …             │                                                                    │
│ [‹ collapse]  │                                                                    │
└───────────────┴────────────────────────────────────────────────────────────────────┘
```

- **Sidebar**: groups with an uppercase label, items = icon + label + optional badge, active item has an accent bar and tinted fill. Collapses to a 56px icon rail (`vortex.sidebar.collapsed`, a per-viewer convenience). Under 900px it is a drawer opened from the top bar; Esc, the scrim or following a link closes it.
- **Top bar**: no title (the page owns its h1). Left: search trigger. Right: live dot (green = socket open, amber pulse = reconnecting) and `UsageGauges`: one button showing the worst rate-limit window across subscription accounts (`13% used`, dot tone by 60/90% thresholds, "n no auth" if an account has no login), a popover with every account's 5-hour and 7-day meters and a refresh button.
- **Errors** from actions appear as a dismissible `Notice tone="bad"` above the page content, not inside it.
- **Prompter** (floating assistant) stays as is; it sits above the page, below modals.

## 4. Page templates

Every page is `PageFrame` (width) > `PageHeader` > content. Widths: `narrow` 800 (forms), `default` 1200, `wide` 1600 (tables, workspaces), `full` (own panes: terminal, diff). Vertical rhythm: `gap: 16px` between blocks (`--sp-4`), 12px on phones.

### 4.1 List page: `DataTable`
`PageHeader` (entity name left, list actions + **Create new <entity>** primary right) above one bordered table box: tools row (search with icon, Filter button with count badge, columns menu, bulk bar when rows are checked), optional facet row, table, footer count. One value per cell on one line; a checkbox column for bulk actions; rows 44px, header 36px uppercase; sorted header shows a chevron; a row is keyboard-focusable and opens on Enter. Empty list = `EmptyState` with the create button. `embedded` makes the header an h2 section heading for a list inside another page's tab.

### 4.2 Entity page: `EntityView`
Title `<Entity type> / <identifier>` (type is the link back to the list), state chips in `meta`, entity actions right, one tab per section (`Tabs`, route-driven), the open tab in one surface. Fields: `Field` / `CheckField` / `ReadField`, label left (220px) and input right at ≥900px, stacked below. `EntityForm` ends the tab with Save / Discard; while dirty the bar sticks to the bottom of the viewport with an "Unsaved changes" mark. Action outcomes: `notice` (a `Notice` ok/bad).

### 4.3 Task workspace (phase 2, area A)
```
PageHeader: Tasks › PROJ-123 title            chips: [Needs you] [PR Waiting]    [Primary action] [⋯ menu]
StageProgress strip (12 segments) + the one-line status
Tabs: Work · Code · PR · Conversation · Details          (was 9; Runs, Cost, Ticket move into Details; Comments and Chat into Conversation)
Work tab: the current stage's card first (what the agent produced, what is asked of you, the primary button), the stage history below, collapsed
```
Rules: one primary action per state, shown in the header (Approve, Answer, Run QA, Merge); destructive and rare actions (Clean up, Delete, Rebase, Return to stage, Open terminal) go to the `⋯` `Menu`. Stage chips become the `StageProgress` strip; a stage opens from it (`work/<stage>` in the URL). New route tab names must keep old ones parsing (`routes.ts` rewrites old links).

### 4.4 Settings / configuration
Lists are 4.1; an item is 4.2 (EnvPage, AccountPage, IntegrationPage, ConfigDirPage). One concept per tab. Dangerous actions (Delete) in the header actions with `variant="danger"` and a confirm.

### 4.5 Dialogs: `Modal`
Create dialogs are routes (`/new`). 520px (`wide` 960), header with title and Close, scrolling body, optional `footer` (buttons pinned). Focus moves in, Tab cycles inside, Esc/backdrop closes, focus returns to the opener. Under 760px it is a bottom sheet.

### 4.6 Analytics (Usage, Timing)
`PageHeader` with the range as `Tabs variant="pill"` (7 / 30 / 90 days; route `?days=`) in `actions`; a `StatRow` of 3-4 `StatTile`s; then `Panel`s (flush) holding `DataTable embedded` or a chart. Charts follow the dataviz rules: one hue per series from the intent/brand tokens, labels not colour alone. No explanatory paragraphs; hints on the tile or panel title.

## 5. Status and priority language

One mapping, `components/status.tsx` (`taskState`, `TaskStatusChip`, `StageProgress`). Tone says what the human should do:

| Tone | Meaning | Task states |
|------|---------|-------------|
| `warn` | You must act | Needs you (waiting_user), Blocked |
| `bad` | Broken | Failed |
| `info` | An agent is working (dot pulses) | Running |
| `wait` | Waiting on someone or something else | Waiting on GitHub (idle in a PR stage), Rate limited |
| `ok` | Finished | Done |
| neutral | Parked | Idle, Queued, Stopped |

- A toned `Chip` leads with its dot; words always carry the meaning. `StatusDot` alone only with a `title`. `Badge` is for counts only (solid tone = needs action).
- Rank for sorting "what needs me now": Needs you, Blocked, Failed, Rate limited, Running, Queued, Waiting on GitHub, Idle, Stopped, Done.
- Stage is a place, not a state: plain text or `StageProgress`, never a tone chip. Accent (brand) is never status.
- Labels (user-coloured chips) are data and keep their own colours.
- Priority (ticket 1-4): text `Urgent / High / Medium / Low` in a neutral chip, with the tone dot `bad / warn / info / neutral`; no emoji.

## 6. Pages

### 6.1 Tasks (done)
`Tabs` of environments (a warn `Badge` with the Needs-you count when above zero), `Tabs variant="pill"` Active / Completed, then the `DataTable`. Active: every non-finished task of the environment, pinned first, then rank, then recency. Completed: finished and stopped tasks. Columns Status, Task, Title, Stage (+ progress), Updated; Latest, Base and Labels hidden by default. A row opens the task in place (`#/tasks/<id>`).

### 6.2 Others
Product (list + PO entity), Sessions (list + terminal/changes workspace, `full` width), Resources (tabs, tables), Prompter (singleton entity) and Settings (4.4) follow their templates.

## 7. Density, spacing, motion

- 4px grid (`--sp-1..6`); page padding 24px (16px on phones); panel padding 16px, entity body 24px; control height 32px, 44px on phones and coarse pointers; table rows 44px.
- Type: page title `--fs-xl` 600; section/panel title `--fs-md` 600; body `--fs-md`; dense/secondary `--fs-sm`; machine text mono. Numbers use tabular figures in tiles.
- Surfaces: page `--bg`, panels `--panel` with `--shadow-sm`, menus and popovers `--surface-3`, dialogs `--surface-2` with `--shadow-lg`. Layout tokens (`--sidebar-w`, `--topbar-h`, `--z-*`, `--touch`) are in `shell.css`.
- Motion: `--dur` 150ms for hover/colour, `--dur-overlay` 220ms for drawer, dialog and popover; opacity/transform only; both are 0 under `prefers-reduced-motion` (tokens) and the pulse animations stop.

## 8. Responsive and accessibility

- Breakpoints: 900px (drawer, topbar shows menu button and the mark), 760px (phone: 16px gutters, 44px targets, sheets, stacked key-value, filters wrap, field labels above).
- Tables never reflow into cards: the box scrolls horizontally, columns keep one line; hide columns by default instead of cramming (`defaultHidden`).
- Touch: 44px minimum for buttons, tabs, menu items, nav items, inputs; 16px input text (no iOS zoom); safe-area insets honoured.
- Keyboard: skip link to `#main`; nav items are links; `Cmd/Ctrl+K`; Esc closes drawer, palette, dialog, menus; table rows focusable, Enter opens; focus ring is the DS ring everywhere (never removed); dialogs trap focus.
- Contrast: tokens are AA for text; chips on tints depend on the DS fix noted in `brand-guidelines.md`; meaning never rests on colour alone (chips say it in words, `StageProgress` has an aria-label, tiles carry words).
- Landmarks: `aside[aria-label=Primary]`, `nav`, `header`, `main#main`, `role=dialog aria-modal`, `role=tab/tabpanel`, `aria-sort` on headers, `aria-current="page"` on the active nav item.

## 9. Components and who uses them

| Component | Props (short) | Used by |
|-----------|---------------|---------|
| `AppShell` / `PageFrame` | sidebar, topbar, collapsed, drawerOpen, onCloseDrawer, overlays / width | App only |
| `Sidebar`, `Topbar`, `UsageGauges`, `CommandPalette` | see files | App only |
| `PageHeader` | title, crumbs, meta, actions, children (tabs), sticky | every page (DataTable and EntityView render it) |
| `Toolbar` | children, end | lists, panels, analytics ranges |
| `Panel` / `Section` | title, hint, badge, actions, footer, flush, tone / title, hint, actions | any grouped content (replaces ad-hoc `.card` and `h2`) |
| `KeyValue` | items [{label, value, hint, mono}], columns | read-only facts (replaces `.kv`) |
| `StatTile` / `StatRow` | label, value, sub, tone, icon, onClick | Usage, Timing, Resources |
| `DataTable` | unchanged props + `embedded` | every list |
| `EntityView` | unchanged props + `meta` | every entity page |
| `Field`, `CheckField`, `ReadField`, `EntityForm`, `useDraft`, `useSaver` | unchanged | entity tabs |
| `Modal` | title, onClose, wide, footer | create dialogs (also re-exported from `web/src/Modal.tsx`) |
| `status.tsx`: `taskState`, `TaskStatusChip`, `StageName`, `StageProgress`, `age` | | every place a task state appears |

Primitives always come from `@vortex/ds` (Button, IconButton, Chip, Badge, StatusDot, Notice, Tabs, Menu, Popover, Hint, Kbd, EmptyState, Checkbox, Switch, Input/Select/Textarea, Icon). DS additions in phase 1: icons `menu chevronLeft chevronUp home tasks layers terminal chart cpu server folder user plug spark command pin gauge`.

## 10. Work breakdown (phase 2; disjoint file sets)

Each area moves its own rules out of `web/src/styles.css` into a co-located `.css` (delete only; do not add to styles.css), uses only tokens, checks light/dark at 1440 and 390 px, and keeps `routes.ts` behaviour (tests green). Shared components in `web/src/components/` (layout, DataTable, EntityView, Modal, status) are owned by the foundation; request changes rather than forking.

| Area | Files |
|------|-------|
| A. Tasks list and task workspace | `TasksPage.tsx`, `tasks.css`, `TaskDetail.tsx`, `TaskCost.tsx`, `Services.tsx`, `Chat.tsx`, `DiffView.tsx`, `NewTaskForm.tsx`, `BranchPicker.tsx`, `Labels.tsx`, `Terminal.tsx`, `LazyTerminal.tsx`, `Markdown.tsx`, `components/{AnnotatedMarkdown,BaseCheckChip,CommentEditor,LineThread,Collapsible}.tsx`; `routes.ts` only to add tab names (keep old parsing) |
| B. Settings and entities | `ManagePage.tsx`, `EnvPage.tsx`, `ConfigDirPage.tsx`, `ConfigEntities.tsx`, `AddForms.tsx`, `components/CheckboxSelect.tsx` |
| C. Product | `ProductPage.tsx`, `PoJournal.tsx`, `poBus.ts` |
| D. Sessions and Resources | `SessionsPage.tsx`, `ResourcesPage.tsx`, `FilePicker.tsx`, `AgentInput.tsx` |
| E. Insights | `Analytics.tsx`, `Timing.tsx` |
| F. Prompter | `Prompter.tsx`, `prompterBus.ts` |
| Foundation (done; change on request) | `App.tsx`, `main.tsx`, `styles.css`, `components/{AppShell,Sidebar,Topbar,PageHeader,Toolbar,Panel,KeyValue,StatTile,UsageGauges,CommandPalette,DataTable,EntityView,Modal,status}.tsx` + their `.css` |

Per-area first moves: **A** make Tasks a `DataTable` (default sort by rank, filters Environment/Status/Stage) and build the workspace of 4.3; **B** drop `.card`/`.env-page` wrappers for `Panel`/`Section`, use `meta` chips for state, move Delete/Verify into header actions; **C** `embedded` on the PO tabs' tables, PO workspace as 4.2; **D** terminal workspace `full` width with the session list as `DataTable`; **E** 4.6; **F** the Prompter's floating button must sit below the drawer scrim and avoid covering table footers on phones.

## 11. Unverified / open

Task workspace, Product, Sessions, Resources, Analytics pages still carry legacy markup inside the new frame. Contrast of 11px chip text on tinted fills is the known DS gap. The command palette has no recent-items memory yet.
