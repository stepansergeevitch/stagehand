---
name: vortex-runbook
description: Operating rules of this Vortex installation — stage boundaries, what a restart does, QA and Chrome rules, environment specifics (DualEntry, Northspyre Deal, Core). Use before advising on or performing an operational action.
---

# Vortex runbook (this installation)

Search the palace (wing `vortex`, rooms `operations` and `conventions`) for the full drawers; this is the short form.

## Server

- The server runs in tmux session `vortex-server` (`cd ~/code/my/stagehand/server && npx tsx src/index.ts`), port
  4747 (loopback) and 4748 (public, Basic auth). It is not in watch mode: code changes need a restart.
- A restart kills every in-flight run. Restart only at a boundary: no task `running`/`queued` and no run `running`
  (`sqlite3 ~/.vortex/vortex.sqlite`), and never during a QA pass. The human decides when; you do not restart
  on your own.
- Data: `~/.vortex/` — `vortex.sqlite`, `runs/*.ndjson` (event logs), `tasks/<id>/` (artifacts: research.json,
  design.json, design.md, impl.json, qa/*.json, pr.json, questions.json, attachments), `config.json`.

## Tasks and stages

- Stages: research → design_proposal → qa_baseline → implementation → manual_qa → user_review → pr_creation_review →
  pr_waiting/pr_green/pr_fix/pr_approved → done. Statuses: running, queued, idle, waiting_user, blocked, failed,
  rate_limited, stopped, done.
- `waiting_user` with open questions: the agent asked; answers go through the questions endpoint (answer with the
  option text verbatim when options are given). `waiting_user` at a review: approve or request changes.
- `blocked`: read the status line; it names the cause and often the button (Log in for QA, Relaunch Chrome, Retry).
- Retry resumes the task's session where it stopped; Rerun restarts a stage from scratch; Return moves the task back
  to an earlier stage.
- Prompts (`prompts/*.md`) are read at dispatch, so a prompt edit is live at the next run; engine code is not.

## Browser QA

- Browser stages need a Chrome profile whose Claude extension is signed into the account (no token sessions). With
  "Chrome per QA run" on, each run copies that profile into a private Chrome window and deletes it afterwards
  (`~/.vortex/chrome-clones/`); several runs go in parallel. The human logs in to the apps in the master profile;
  copies inherit it. A cloned window must not be closed by hand while its run goes.
- The Deal frontend runs on a 13xxx port through an origin-override hack; Auth0 sends logins back to
  `localhost:3000/?code=…` and Vortex moves that tab to the right port.

## Environments

- Northspyre Deal (`~/code/northspyre/northspyre-deal`, base `main`, ClickUp) depends on Northspyre Core
  (`~/code/northspyre/northspyre`, `master`, shared dependency service on 7777).
- DualEntry (`~/code/dualentry`, sub-repos `backend` + `frontend`, base `dev`, Linear, branch prefix `stepanb/`):
  shared venv via symlink, per-task test databases cloned from `dualentry_test_template` (never migrate a test DB
  from scratch), Django repos must pass `manage.py check --database default`, never terminate DB sessions named
  `celery` (that is every Django connection), the `bank-connections-2` CI shard dying with exit 137 is a flake
  (rerun failed jobs), `gh`/`git` for DualEntry need `GH_CONFIG_DIR=/Users/stepanburlakov/code/dualentry/.gh`.

## Writing

The human writes and reads ASD-STE100 Simplified Technical English. Do the same.
