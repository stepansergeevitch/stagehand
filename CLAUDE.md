# Stagehand — rules for working in this repository

**Golden rule: generics are implemented in code; specifics go to env config.** Every fix asks two questions — what is
the mechanism any environment could use (that is code), and what does this one environment need (that is its config).

## No environment-specific logic

Stagehand is environment-agnostic. Nothing in `server/`, `web/`, `prompts/`, `product-owner/` or `scripts/` may know a particular environment, project, product or host setup: no project names (DualEntry, Northspyre, …), no project paths, ports, database names, model or table names, identity-provider quirks, ticket ids used as logic.

What one environment needs is **that environment's config** (the `envs` row, edited on its page):

- commands — Prepare (runs before every command), setup, BE / FE, migrate / migrate down, cleanup, rebase, verification, test, components;
- QA seeding hints, the CI autopilot's rules, the code review checklist, login callback ports, environment variables, memory wings.

**Everything inline, no helper files.** A command, a hint or a QA step carries its whole text — a SQL statement, a heredoc'd script — so a person on the environment's page sees exactly what runs. Never a script file a config field points at (in this repo or anywhere else): that is hidden behaviour.

When a fix seems to need an environment's specifics, add a **generic mechanism** with a config field, and put the specifics in that environment's config — never a special case, a hard-coded default, or a file. Incidents may be named in comments as history; never as behaviour.

## Web UI standards

Pages are built from the shared components in `web/src/components/`; extend them, never write a one-off variant.

- **A list is a `DataTable`** that fills the page and nothing else: header row (entity name, "Create new <entity>"),
  tools row (filters, search, column picker), real columns with one value per cell on one line, a checkbox column for
  bulk actions. No description under the title, no detail line under a value — information gets its own column.
- **A row opens an `EntityView`**: title `<Entity type> / <identifier>`, entity actions on the right, one tab per
  section (never one long page), each tab a set of `Field`s followed by Save / Discard (`EntityForm`).
- **No free-floating explanatory text.** A field's explanation is its hint, shown on hover of the hint icon.
- **A setting lives on the entity it describes** (models on the AI account, pipeline behaviour on the environment);
  one concept per Configuration subtab.
