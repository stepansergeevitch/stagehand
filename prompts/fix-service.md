This is a SERVICE START FIX the human asked for directly through the UI (App widget → "Fix with agent" on the {{kind}}) — not a normal stage of this task's pipeline. The task's {{kind}} dev server failed to start from its worktree; find out why and repair the cause. Stagehand restarts the {{kind}} itself as soon as you finish, so you do not need to leave it running — you need to leave it *able* to run.

Worktree: `{{cwd}}` (every command below runs there).

## What failed

Stagehand ran the {{kind}} command in a tmux pane inside the worktree, with these variables exported:

```
{{serviceEnv}}
```

Command (as rendered):

```
{{command}}
```

Expected: something listening on port {{port}} ({{url}}). What happened: {{error}}.

Full log: `{{logPath}}`. Its tail (the current start only):

```
{{logTail}}
```
{{taskNotes}}

## Steps

1. Read the log above and, if needed, the whole file. Identify the actual cause: a missing dependency or virtualenv (`uv sync` / `npm install` not run in this worktree), a gitignored file the worktree lacks (`.env`, a config, certs — the env's setup command normally creates them; compare with the main checkout), a database/migration/service it needs that isn't there, a port collision, a code error on the branch, a stale `node_modules`, and so on.
2. Fix the cause *in a way that survives a restart of the same command* — install what is missing, create or fix the config file, correct the code. If the fix is a code change on the branch, keep it minimal and in the spirit of the branch's own work; do not refactor around it.
3. Verify by running the command yourself for a short while in the foreground with the same variables exported (`export PORT={{port}}` etc.), until you see it listening on port {{port}} (e.g. `curl -sS {{url}}` in another step, or the server's own "listening" line) — then STOP it (Ctrl-C / kill the process). Never leave a server of your own running on port {{port}}: Stagehand starts it again right after you finish and would collide with yours.
4. If the cause is outside the worktree (the env's BE/FE command itself is wrong, a machine-wide service is down, credentials are missing), do not guess — say precisely what is wrong and what the human should change, and where (env configuration page, a service to start, a file to create).
5. Do not push, do not touch GitHub, do not commit unless the repository's rules for this environment allow it and the fix is a code change that belongs on the branch.

## Reply

Plain text, not a file, not JSON — this has no output contract. Say plainly: the cause (one sentence), what you changed (files/commands), whether you saw the {{kind}} listening on port {{port}} yourself, and anything the human still needs to do.
