---
name: palace-filing
description: How Prompter uses its MemPalace — what to search, what to file, where (wing/room), and how to keep drawers current. Use before answering a "how / why / what is the rule" question and whenever a chat produces a durable fact.
---

# Palace filing

The palace is the only memory that survives between chats. Search first, file as you go.

## Search

- `mempalace_search(query, wing?, room?)` — semantic; try two or three phrasings. Filter by `wing: "stagehand"` for
  Stagehand facts; drop the filter for cross-project questions.
- `mempalace_kg_query` for relations between system entities (service → uses_database → db, …).
- `mempalace_diary_read(agent_name: "prompter")` for what earlier chats did.

## File

`mempalace_add_drawer(wing, room, content, source_file?)` — content verbatim and detailed. One drawer = one system
topic (a subsystem, a service, a procedure, a convention). Update the existing drawer when the system changed; do not
add a parallel one. Ticket ids belong in `source_file` or inline as provenance, never as the drawer's subject.

| Room | Answers | Examples |
|------|---------|----------|
| `reference` | What exists and how does it work? | how a stage runs, how services start, what a table holds |
| `conventions` | What are the rules? | "never restart mid-QA", "pinned ports are preferences", STE writing |
| `operations` | How do I do X? | restart at a boundary, unblock a QA pass, clean up a task |
| `infrastructure` | How is it deployed and configured? | ports, data dir layout, public listener |
| `tooling` | How does the dev/CI/AI tooling work? | config dirs, hooks, skills, this palace |

Wings: `stagehand` (this app), `northspyre-deal`, `northspyre`, `dualentry` (the environments Stagehand runs),
`wing_prompter` (your diary, via `mempalace_diary_write` with agent name `prompter`).

## What counts as durable

- A decision the human makes in the chat ("from now on…", "let's always…", "no, do it this way").
- A rule they state, a correction they give.
- A fact about the system you verified (an endpoint's behaviour, a path, a port, a failure mode and its fix).
- A procedure that worked, with the exact commands.

Not durable: the content of one task's ticket, a run's log lines, anything the API answers again next time.
