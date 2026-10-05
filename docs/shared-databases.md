# Shared task databases (known issue, postponed)

The tasks of an environment share one database: every DualEntry worktree points at `localhost:5432/dualentry`, the
Northspyre Core tasks at Core's dev database, the Deal tasks at `ns_deal` on 5433. Only DualEntry's *test* databases are
per task (`dualentry_test_<slug>`, made by the setup command).

## What it breaks

- **Migrations leak between tasks.** A task's migrations are applied for every task. A task whose branch lacks them
  runs against a schema it does not know (extra columns usually pass; renamed or dropped ones do not).
- **The QA baseline on base code is partial.** Before a baseline, Stagehand rolls back only the migrations the task's
  branch added (`migrate_down_command`, `server/src/migrations.ts`). Migrations of other branches stay applied, so the
  "base" schema the baseline sees is the base plus whatever other tasks applied.
- **Data leaks between tasks.** QA seeds and teardowns of one task write rows every other task sees; scenarios rely on
  their own record ids to stay apart.
- **Concurrent rollbacks.** A rollback for one task's baseline changes the schema under the other tasks' running
  servers for the length of the pass, when the two branches touch the same tables.

## The fix, when it is time (designed in `db-isolation.md`)

One database per task, created from a template at worktree setup (as DualEntry already does for its test databases):
`CREATE DATABASE <env>_<task-slug> TEMPLATE <env>_template`, the worktree's config pointed at it, dropped by the
cleanup command. Then a baseline can roll back freely, and nothing leaks.
