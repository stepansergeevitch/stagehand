# Stagehand — rules for working in this repository

## No environment-specific logic

Stagehand is environment-agnostic. Nothing in `server/`, `web/`, `prompts/`, `product-owner/` or `scripts/` may know a particular environment, project, product or host setup: no project names (DualEntry, Northspyre, …), no project paths, ports, database names, model or table names, identity-provider quirks, ticket ids used as logic.

What one environment needs is **that environment's config** (the `envs` row, edited on its page):

- commands — setup, BE / FE, migrate / migrate down, cleanup, rebase, verification, test, components;
- **scripts** — `envs.scripts`, written to `$STAGEHAND_SCRIPTS` (env-scripts.ts): a QA teardown, a session helper, the datastores it needs up;
- QA seeding hints, the CI autopilot's rules, the code review checklist, login callback ports, environment variables, memory wings.

When a fix seems to need an environment's specifics, add a **generic mechanism** with a config field, and put the specifics in that environment's config — never a special case, a hard-coded default, or a file in this repo. Incidents may be named in comments as history; never as behaviour.
