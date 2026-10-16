---
name: stagehand-api
description: The local Stagehand HTTP API (http://127.0.0.1:4747) — how to read tasks, runs, diffs, PRs, services, environments and accounts, and how to act (retry, stop, answer questions, instruct the agent, review, services, rerun/return, PR actions). Use whenever the context block is not enough or the human asks Prompter to do something.
---

# Stagehand local API

Base URL `http://127.0.0.1:4747`, JSON in and out, no auth on loopback. Use `curl -s` and `jq`. Ids are UUIDs; the
`<stagehand-context>` block gives the task id of the open task. Every list below is `METHOD path — what it does`.

## Read

- `GET /api/tasks` — every task (id, ticket_id, title, env_id, stage, status, status_line, branch, updated_at, labels).
- `GET /api/tasks/:id` — the task in full: task, runs, design, impl, qaBefore/qaAfter, pr, prFix, research, reviews,
  questions, messages, prStates, artifacts, tickets, qaHistory.
- `GET /api/tasks/:id/artifacts/<path>` — an artifact file (design.md, research.md, qa/after.json, …).
- `GET /api/tasks/:id/runs/:runId/events` — a run's stream-json event log (long).
- `GET /api/tasks/:id/diff[?commits=a,b|uncommitted=1][&file=path]` — the branch diff vs base (files, hunks, baseDrift).
- `GET /api/tasks/:id/commits` — the branch's own commits.
- `GET /api/tasks/:id/messages` — Chat (questions, answers, agent notes, instruction reports).
- `GET /api/tasks/:id/pr-comments?repo=<dir>` — GitHub PR comments (human, automation).
- `GET /api/tasks/:id/services` / `GET /api/tasks/:id/services/:kind/log` — BE/FE/component state and logs.
- `GET /api/tasks/:id/usage`, `GET /api/usage?days=7` — cost and tokens.
- `GET /api/envs`, `GET /api/envs/:id/rules`, `GET /api/envs/:id/branches?repo=`, `GET /api/envs/:id/dependency`,
  `GET /api/envs/:id/my-tickets` — environments, their rules, branches, dependency service, the human's tickets.
- `GET /api/accounts`, `GET /api/config-dirs`, `GET /api/sessions`, `GET /api/settings`, `GET /api/readiness`,
  `GET /api/labels`, `GET /api/task-managers`, `GET /api/health`.

## Act on a task

Say what you do in one line first. Re-read `GET /api/tasks/:id` afterwards and report the real outcome.

- `POST /api/tasks/:id/retry` — resume the failed/blocked/stopped stage where it stopped.
- `POST /api/tasks/:id/stop` — kill the current run (status stopped).
- `POST /api/tasks/:id/rerun {"stage": "<stage>"}` — run a stage again from scratch (research, design_proposal,
  qa_baseline, implementation, manual_qa, pr_creation_review, …).
- `POST /api/tasks/:id/return {"stage": "<stage>"}` — move the task back to an earlier stage.
- `POST /api/tasks/:id/questions/:qid/answer {"answers": {"<questionId>": "<text>"}, "files": [...]}` — answer the
  agent's open round (`qid` = the round id from `questions` in GET /api/tasks/:id; when a question lists options, answer
  with the option text verbatim; `files` as returned by `/files`).
- `POST /api/tasks/:id/messages {"text": "…", "files": [...]}` — ask the task's agent a question (answer lands in Chat).
- `POST /api/tasks/:id/instructions {"text": "…", "files": [...]}` — an instruction the agent carries out in the worktree now (Do).
- `POST /api/tasks/:id/files` — multipart, field `file`: hands a file to the agent. It lands in `<taskDir>/shared/` and the
  reply `{name, file, mime, size}` goes verbatim into `files` of a message, an instruction or an answer; the agent gets
  the absolute path in its prompt (`curl -F "file=@/path/shot.png" …/files`). Never copy files into the worktree for it.
- `POST /api/tasks/:id/review {"verdict": "approve"}` or `{"verdict": "changes", "notes": "…", "routeTo":
  "implementation"|"design_proposal", "comments": [...], "skipQa": bool, "repo": "<dir>"}` — the human's review at
  Design review, User Review, PR Creation Review (per repo), PR fix.
- `PATCH /api/tasks/:id {"notes": "…", "labels": [...], "baseBranch": "...", "skipQa": bool}` — notes for the
  agents, labels, base branch.
- `POST /api/tasks/:id/services/:kind/start|stop|fix` — BE, FE or a component (`kind` = be, fe, or a component key).
- `POST /api/tasks/:id/open-app` — open the app in the QA Chrome profile; `POST /api/tasks/:id/qa-login` — login helper.
- `POST /api/tasks/:id/relaunch-chrome` — asks first: closes the human's whole Chrome.
- `POST /api/tasks/:id/rebase {"repos": [...]}` — rebase onto the latest base (agent on conflicts).
- `POST /api/tasks/:id/pr/create`, `POST /api/tasks/:id/pr/refresh`, `POST /api/tasks/:id/fix-ci`,
  `POST /api/tasks/:id/fix-comments {"repo": "...", "commentIds": [...]}`, `POST /api/tasks/:id/pr-jobs {…}`,
  `POST /api/tasks/:id/ask-comments {"repo": "...", "commentIds": [...], "question": "optional"}` — the agent's take on picked comments in Chat, no code change,
  `POST /api/tasks/:id/pr-comments/:commentId/resolve {"resolved": true}`, `PATCH /api/tasks/:id/pr-draft {…}`.
- `POST /api/tasks/:id/pr/merge {"method": "squash", "deleteBranch": true}` — ask first (irreversible).
- `POST /api/tasks/:id/commits/:sha/reword {"repo": "", "message": "…"}`, `POST /api/tasks/:id/commits/:sha/remove`,
  `POST /api/tasks/:id/commits/force-push` — history edits; ask first for remove and force-push.
- `POST /api/tasks/:id/cleanup {"force": false}`, `DELETE /api/tasks/:id` — ask first (removes worktree/branch/task).
- `POST /api/tasks/:id/fetch-ticket`, `POST /api/tasks/:id/pin`, `POST /api/tasks/:id/account {"accountId": "…"}`.
- `POST /api/tasks {"envId": "…", "tickets": ["ABC-123"], "mode": "each", "notes": "…", "model": "…"}` — new task(s).

## Environments, accounts, sessions

- `PATCH /api/envs/:id {…}` — environment settings (commands, ports, components, keep_services, check_command, rules).
- `PATCH /api/accounts/:id {…}`, `POST /api/accounts/:id/probe-chrome`, `POST /api/accounts/:id/clone-test`,
  `POST /api/accounts/:id/refresh-limits`.
- `POST /api/sessions {…}`, `POST /api/sessions/:id/open|close`, `DELETE /api/sessions/:id` — ask before delete.
- `PATCH /api/settings {…}` — integrations and defaults; keys are stored, never echo them back.

## The server itself

- `POST /api/server/restart {"force": false}` — restarts Stagehand in its tmux pane (needed after a code change).
  Refused with 409 while a run goes; `force: true` kills the runs (Retry resumes them). Only when the human asks in
  the chat. Your own session survives the restart.
- `GET /api/health` — is it back.

## Rules of thumb

- Task ids, not ticket ids, in paths. Find a task by ticket with `GET /api/tasks | jq '.[] | select(.ticket_id=="…")'`.
- A `status_line` explains a `blocked`/`failed` state; quote it when you report.
- Do not poll in a loop; one read after an action is enough, the human sees live updates in the app.
