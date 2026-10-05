# Task databases (DB isolation) — design

Status: proposal, 2026-10-05. Replaces the "fix, when it is time" in `shared-databases.md`.

## Problem

Every task of an environment uses one database (DualEntry `localhost:5432/dualentry`, Core `dev`, Deal `ns_deal`).
One task's migrations land under every other task's code. Incidents:

- INV-149, 2026-10-01: `relation vendors.default_expense_account already exists`. A dev migration and the branch's
  copy of it met in the shared DB.
- INV-149, 2026-10-02: Manual QA saw `items.stock_unit` missing. INV-155's `core.0840_item_unit_settings`
  had dropped it. Rolling that back for INV-149 then broke INV-155's QA (`items.base_uom_id` missing).
- QA seeds and teardowns of one task write rows every other task sees.
- A baseline's migrate-down changes the schema under the other tasks' running servers.

## Decision

One database per task, created with `CREATE DATABASE <task db> TEMPLATE <env template>`. The **template is a
database named in the env's config**. At first it can be the environment's original database. Later it can be a
shrunk copy. Stagehand never copies or edits the template itself.

Stagehand stays environment-agnostic. It owns the lifecycle, the naming, the variables, the guard and the UI.
Every statement that touches a database is an **inline command in the env's config**.

## Env config

New column `envs.task_db` (JSON, null = off). Every command runs through the env's Prepare.

| Field | Meaning |
|---|---|
| `enabled` | New tasks get their own database |
| `template` | The template database's name |
| `namePattern` | Task database name; default `{{template}}_{{slug}}`. Stagehand lowercases it, keeps `[a-z0-9_]`, and cuts it to 63 chars with a 6-char hash when longer |
| `create` | Creates `$STAGEHAND_TASK_DB` from `$STAGEHAND_TASK_DB_TEMPLATE` |
| `drop` | Drops `$STAGEHAND_TASK_DB` |
| `connect` | Runs in the worktree: points the app's config at `$STAGEHAND_TASK_DB` |
| `list` | Prints the names of the task databases that exist, one per line (for orphans and existence checks) |
| `sharedNames` | Databases a worktree may still use besides its own (e.g. DualEntry's `migrations`) |

Every command and the env's other commands (setup, BE, FE, migrate, migrate down, cleanup, QA seeds, QA session)
get `$STAGEHAND_TASK_DB` and `$STAGEHAND_TASK_DB_TEMPLATE`, plus `{{taskDb}}` in templates.

DualEntry example (its config, not code):

```bash
# create
PGPASSWORD=password psql -h localhost -p 5432 -U dualentry -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$STAGEHAND_TASK_DB\" TEMPLATE \"$STAGEHAND_TASK_DB_TEMPLATE\" STRATEGY FILE_COPY"
# drop
PGPASSWORD=password psql -h localhost -p 5432 -U dualentry -d postgres -c "DROP DATABASE IF EXISTS \"$STAGEHAND_TASK_DB\" WITH (FORCE)"
# connect (backend/.env: DB_NAME only, the same way setup sets TEST_DB_NAME)
sed -i '' "s/^DB_NAME=.*/DB_NAME=$STAGEHAND_TASK_DB/" backend/.env
# list
PGPASSWORD=password psql -h localhost -p 5432 -U dualentry -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'dualentry\_%' AND datname NOT LIKE 'dualentry\_test%'"
```

## Lifecycle

1. **Task start: refresh the template to the env's base branch** (`envs.base_branch`: dev, main, master, …).
   - Stagehand keeps one **template worktree** per environment, next to the task worktrees. It is set up once with
     the env's setup command and never used for work.
   - At every task start: `git fetch` and a detached checkout of `origin/<env base branch>` in every repository,
     then `connect` (pointed at the template), then the env's Migrate. The template now has exactly the
     base branch's migrations. When nothing is new, Migrate is only its check.
   - The template worktree is the only place allowed to connect to the template (see Guard).
2. **Create the task DB** from the refreshed template: `create`.
3. **Bring it to the task's base** when the task's base differs from the env's (`tasks.base_branch`, e.g. another
   task's branch or a release branch). The task worktree starts at that base, so `connect` plus Migrate in the task
   worktree applies the base's migrations before any branch commit exists. For an adopted task that already has
   commits, the same step runs in the template worktree checked out at the task's base, pointed at the task DB.
4. **Branch migrations:** the env's setup, then the first BE start's Migrate apply the branch's own migrations, as
   today.
5. **Cleanup and delete:** stop the task's services, then `drop`.
6. **Recreate** (task page button and API): stop services, then steps 1–4 again (refresh, `drop`, `create`, base,
   migrate). This resets a DB that QA seeds polluted, or catches a task up after its base moved.
7. **Adopt** (existing tasks): the same as Recreate, for a task still on the shared DB. Before that, Stagehand
   lists every task still on the shared DB on the env page.
8. **Orphans:** `list`, minus the tasks' DBs, shows on the env page with Drop.

Steps 1–2 run under one lock per environment, so the template is migrated and copied by one task at a time, and
nothing is connected to it during `create`. A template that something else holds open (your own BE on the original DB) is retried 3 times over one minute,
then the task blocks and names the connections.

`task_dbs` table: task id, env id, name, template, created at, last migrate at, and the size at last look. The
task page gets a DB card: name, size, created from, age, Recreate.

## Guard

The DB host check (`db_hosts_command`) prints `host/name` pairs instead of hosts. When the env has task DBs on, a
worktree passes only when every pair has an allowed host **and** its name is the task's own DB or in
`sharedNames`. A task worktree pointing at the template or another task's DB blocks before migrate, BE start and
agent runs, exactly where the host check blocks today. Only the template worktree may point at the template, and
only with the env's base branch checked out, so the template only ever gets base-branch migrations.

## Template rules

- **Postgres refuses `TEMPLATE` while anything is connected to the source.** The template must be idle. With the
  original DB as template, nothing may hold a connection to it while a task DB is created: not your own BE, not
  a task still on the shared DB. Today `dualentry` has 6 connections (task Celery workers). Once every task is
  adopted, only your own work touches it. A dedicated template DB (`dualentry_template`) removes the
  problem entirely; that is the "shrunk copy" step.
- **The template should match the env's default branch.** A task DB inherits whatever the template has. The
  shared `dualentry` has INV-149's and INV-155's `0840`s applied today. Before the first adopt, roll those back
  on it (you run that), or the first task DBs start with foreign migrations.
- Step 1 keeps it current with the base branch at every task start, so a task DB starts at the base, not behind.
- Step 1 only migrates **forward**. Migrations the base branch doesn't have, already on the template, stay; the
  phase 3 check reports them.
- With the original DB as template, step 1 also migrates your own working DB to the base branch. A dedicated
  `dualentry_template` keeps your DB out of it.

## Sizes (decide before enabling DualEntry)

| Env | Template | Size | Server | Free |
|---|---|---|---|---|
| DualEntry | `dualentry` | 25 GB | Docker PG 18 (ext4 VM disk) | 26 GB |
| Core | `dev` | 19 GB | the same container | the same 26 GB |
| Deal | `ns_deal` | 26 MB | native PG 14 | APFS, 141 GiB |

Docker's ext4 can't share blocks, so each task DB is a **full copy** (`FILE_COPY` takes about 1–2 min for 25 GB;
the default `WAL_LOG` about 9 min). With 26 GB free, DualEntry fits one task DB, not two. Options:

1. Raise Docker Desktop's disk limit (Settings → Resources) to fit N tasks: 25 GB each for DualEntry, 19 GB for Core.
2. Shrink the template first: a `dualentry_template` without bulk tables nobody QAs against (request logs,
   checkpoints, import rows). That is the "shrunk version" step, done once the mechanism works.
3. Later, if full copies stay too heavy: native PG 18 on APFS with `file_copy_method = clone`. Measured
   on 2 GB: 1.35 s and copy-on-write. Only the env's commands and port change; nothing in Stagehand.

Deal works at once (26 MB).

## QA baseline (phase 2)

Today the baseline migrates the task's DB down to the base, runs, and migrates up again. That step blocked
INV-149 twice. With task DBs, the baseline gets its own throwaway DB instead:

1. refresh the template (lifecycle step 1), then `create` a `<task db>_base` from it (with `STAGEHAND_TASK_DB=<task db>_base`);
2. check out the base code, `connect` to it, and migrate: only the task base's migrations beyond the env's, always forward;
3. run the pass, check out the branch, `connect` back, `drop` the base DB.

No migrate-down, nothing to restore, and the task DB is never touched. Migrate down stays as the fallback for
envs without task DBs.

## Phases

1. **Mechanism:** `envs.task_db`, the variables, the template worktree and its refresh at task start, create, the
   step to the task's base, connect, drop at cleanup, Recreate, Adopt, orphans, the name guard, the env page section
   and task DB card, and tests. Enable Deal first, then DualEntry once the
   size decision is made.
2. **Baseline on a throwaway DB** instead of migrate-down.
3. **Template tools:** a check that the template has no migrations unknown to the default branch; template age;
   the shrunk-template recipe in DualEntry's config.

## Not in scope

Redis, S3/RustFS and queues stay shared (separate issue in `shared-databases.md`). DualEntry's per-task test
databases (`dualentry_test_<slug>`) are unchanged.
