# Stagehand

A local orchestrator that takes a ticket from your task manager and walks it through a fixed pipeline with headless
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) — research, design proposal, QA baseline, implementation,
manual QA, review, pull request — pausing wherever a human should look, and showing the evidence at each pause.

It runs on your own machine, against your own checkouts, with your own Claude subscription. Nothing is hosted.

> Status: personal tooling, extracted from daily use. It works for its author's projects; expect rough edges elsewhere.

## What it does

For every task Stagehand:

1. **Fetches the ticket** (ClickUp or Linear, REST) with comments and attachments.
2. **Research** — a headless Claude run reads the repo and the ticket and writes `research.json` (classification, branch name, affected areas).
3. **Design proposal** — a fixed-structure `design.md` a human reviews (approve / request changes), plus `design.json` with the test plan and browser QA scenarios, including literal seed steps. psql seeds are dry-run against the real database before the design is accepted.
4. **QA baseline** — the app is started from the task's own git worktree (backend + frontend on free ports), and a browser-driving Claude run records the *before* state with screenshots.
5. **Implementation** — code, tests, type-checks, commits; guarded by a hook that enforces the environment's commit/branch/push rules.
6. **Manual QA** — the same scenarios again, now the *after* state; failures go back to implementation automatically, blocked scenarios get one budgeted unblock-and-retry, and a wrong seed command is corrected only after you confirm it.
7. **User review** — a diff with line comments (sent back as review rounds), or questions to the agent about any line.
8. **Pull request** — drafted per repository, reviewed by you, pushed and opened with `gh`; CI is polled, failing checks and PR comments can be handed back to the agent.

Around that: per-task backend/frontend services in tmux (with start timeouts, failure reasons and "fix with agent"), a per-task chat with the agent, free-form interactive Claude sessions with their own worktrees, usage and cost analytics per account/environment/task, rate-limit aware scheduling with account failover, desktop and phone notifications, and a phone-friendly UI reachable over an authenticated HTTPS listener.

## How it is built

```
server/   Hono + WebSocket API, SQLite (better-sqlite3), tmux + node-pty for terminals, `claude -p --output-format stream-json` runs
web/      Vite + React UI (xterm.js terminals, markdown rendering, diff viewer)
prompts/  one prompt per stage, `{{variables}}`, strict JSON output contracts (retried on violation)
hooks/    guard.py — a Claude Code PreToolUse hook enforcing each environment's git rules
scripts/  environment-specific helpers (example: running a frontend on an alternate port behind a fixed OAuth callback)
```

Key concepts:

- **Environment** — a repository (or a workspace of several) with a base branch, how to start its backend/frontend, a setup command for fresh worktrees, seeding hints for QA, and an optional dependency on another environment's backend.
- **Claude config dir** — the `CLAUDE_CONFIG_DIR` (skills, hooks, MCP servers, rules) every run in an environment uses.
- **AI account** — a Claude login (long-lived OAuth token from `claude setup-token`). Environments list accounts in priority order; runs fail over on rate limits and resume when the window resets.
- **Task** — one ticket (or a batch), one branch, one worktree, one Claude session id threaded through the stages, artifacts under `~/.stagehand/tasks/<id>/`.

## Requirements

- macOS (tmux, AppleScript and Chrome profile handling are macOS-specific)
- Node.js ≥ 22, `tmux`, `git`, `gh` (GitHub CLI, logged in)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI with a subscription; browser stages need Google Chrome with the Claude in Chrome extension signed in
- optional: `terminal-notifier` (desktop notifications), an [ntfy](https://ntfy.sh) topic (phone notifications)

## Run it

```bash
npm install
npm run dev          # API on http://127.0.0.1:4747, UI on http://localhost:5173
```

Or, as in daily use, keep both in tmux so they survive terminal closes — after a reboot nothing starts by itself:

```bash
scripts/up.sh            # tmux stagehand-server (scripts/serve.sh, API 4747, public 4748) + stagehand-web (Vite 5173, TLS from ~/.stagehand/tls); waits for /api/health
scripts/up.sh status     # what runs where (also says whether Docker Desktop is up — the task envs need it, Stagehand does not)
scripts/up.sh down       # stop both (the server gets its stop file, so serve.sh does not start it again)
```

By hand, the same thing is:

```bash
tmux new-session -d -s stagehand-server -c "$PWD" 'scripts/serve.sh'
tmux new-session -d -s stagehand-web -c "$PWD/web" 'npx vite --port 5173'
```

The dev UI is plain HTTP on 127.0.0.1:5173. If your browser insists on HTTPS for `localhost` (Safari does once any
local HTTPS app has sent an HSTS header), serve it over TLS with a locally trusted pair, e.g. from
[mkcert](https://github.com/FiloSottile/mkcert):

```bash
STAGEHAND_DEV_TLS_CERT=/path/cert.pem STAGEHAND_DEV_TLS_KEY=/path/key.pem npx vite --port 5173   # https://localhost:5173
```

Then in the UI: add a Claude config dir, add an AI account (it opens a terminal running `claude setup-token`), add an
environment (path, base branch, backend/frontend commands with `{{port}}`, setup command), set the ClickUp or Linear
token under Integrations, and create a task from a ticket id.

State lives in `~/.stagehand/` (`config.json`, `stagehand.sqlite`, `tasks/`, `runs/`, `accounts/`). Set
`STAGEHAND_HOME` to use another directory — handy for a scratch instance while the real one keeps working.

### Public listener (optional)

`config.json → publicAccess` enables a second HTTPS listener (self-signed cert, Basic auth then a signed cookie) that
also serves the built UI (`cd web && npx vite build`) — for checking on tasks from a phone. Set `notifications.baseUrl`
so pushed notifications link there.

## Prompter — the assistant in the app

The button in the bottom-right corner opens Prompter: a headless Claude session per chat window, on a token account,
with its own config dir and its own MemPalace under `~/.stagehand/prompter/` (identity, skills and MCP setup come from
this repository's `prompter/` folder and are re-synced at every start). Every message carries a description of the
page you are on (the URL hash is the single source of truth for that — see `web/src/routes.ts`), it searches and files
its palace, and it acts through the local API. Configure it on the AI accounts page (account, model, idle timeout) and
seed its palace there once (`scripts/seed-prompter-palace.py`). A server restart does not end a chat.

## Development

```bash
npm run typecheck    # both workspaces
npm test             # vitest (server)
```

Work on a branch in a worktree, never in the live checkout (the dev UI hot-reloads it and the server runs it):

```bash
git worktree add .claude/worktrees/my-change -b my-change
scripts/preview.sh .claude/worktrees/my-change   # the branch's server on :4757 (no scheduler, no runs) + UI on :5174
scripts/release.sh my-change                     # at a boundary: rebase, fast-forward main, build, restart, clean up
```

`release.sh` refuses while a run is in flight (`--force` kills them; Retry resumes them), because a restart kills
in-flight Claude runs. `POST /api/server/restart` does the restart part from inside the app.

## License

MIT — see [LICENSE](LICENSE).
