---
name: stagehand-dev
description: How to change Stagehand itself (the app you live in) safely — branch in a worktree, test from the branch on preview ports, land with one command that merges, builds and restarts at a boundary. Use whenever the human asks you to fix, change or extend Stagehand.
---

# Changing Stagehand

The repository is `~/code/my/stagehand` (npm workspaces: `server/` Hono + SQLite + node-pty, `web/` Vite + React,
`prompts/` stage prompts, `prompter/` your own identity and skills, `scripts/`). The live app runs main's working tree
from tmux `stagehand-server` (server, port 4747) and `stagehand-web` (Vite dev UI, 5173; the public UI on 4748 serves
`web/dist`). Editing main while it runs makes the app flaky — so never edit main.

## 1. Branch in a worktree

```bash
cd ~/code/my/stagehand
git worktree add .claude/worktrees/<name> -b <name>
for d in node_modules server/node_modules web/node_modules; do ln -s ~/code/my/stagehand/$d .claude/worktrees/<name>/$d; done
```

Edit only inside the worktree. Conventions: STE comments, 4-space indent, no `any`, prompts under `prompts/` are read
at dispatch (live without a restart), engine code is not. Commit messages: one plain line, no prefixes, no trailers.

## 2. Check

```bash
cd .claude/worktrees/<name>/server && npx tsc --noEmit && npx vitest run
cd ../web && npx tsc --noEmit && npx vite build
```

Two known foreign errors in `server` (`PR_STAGE_SET`, `index.ts …LineComment[]`) come from an old uncommitted WIP on
main; ignore them.

## 3. Test from the branch

```bash
scripts/preview.sh .claude/worktrees/<name>
```

starts the branch's server on 4757 (preview mode: shares the live data, starts no runs, no pollers) and its UI on
`http://localhost:5174`. Open it, click through, hit `http://127.0.0.1:4757/api/...`. `scripts/preview.sh stop` ends it.

## 4. Land and restart, in one go

```bash
git -C .claude/worktrees/<name> add -A && git -C .claude/worktrees/<name> commit -m "…"
scripts/release.sh <name>          # or: scripts/release.sh <name> --force   (only when the human accepted that runs are killed)
```

`release.sh` refuses unless no run is running and no task is running/queued (a boundary). It rebases the branch onto
main, fast-forwards main, runs `npm install` when the lockfile changed, builds the web bundle, restarts the live server
in its tmux pane, waits for `/api/health`, stops the preview and removes the worktree and branch. Your own chat
survives the restart: say "landing and restarting now; we continue when it is back", run it, then report the result
(the script prints `release: main <old> → <new>` and `server up`).

Never `git push`, never commit on main directly, never force-push, never rewrite main's history.
