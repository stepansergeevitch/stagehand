You are starting work on ticket {{ticketId}} in the repository at {{envPath}} (base branch: {{baseBranch}}). This is the RESEARCH stage. Do not write any application code, do not create branches, do not commit.

{{ticket}}

## Steps

1. Read the ticket above carefully. Do NOT re-fetch it unless the block above says Stagehand could not fetch it.
2. Classify the ticket as `bug` or `feature`. State the classification in one line.
3. Search institutional memory: call `mempalace_search` with the ticket's keywords, affected services/models and domain terms (skip only if the palace returns nothing relevant).
4. Read the code the ticket touches. Trace the real code paths. Use Explore subagents for broad searches, direct Read/Grep for targeted lookups. Do NOT propose a fix yet.
5. Write `{{taskDir}}/research.md` for an engineer who has never seen this area: ticket description and acceptance criteria verbatim, the purpose of the existing functionality, how it behaves today, the key classes/functions/files with paths, the data flow, relevant business rules and edge cases, and everything relevant the palace returned. Concrete and technical, not a summary.
6. Produce a branch name: lowercase ticket id, a hyphen, then a short kebab-case slug of the ticket title (e.g. `eng-21986-fix-recoverables-ws`). Lowercase letters, digits, dots, hyphens only.

## Output contract

Write `{{taskDir}}/research.json` with exactly this shape:

```json
{
  "classification": "bug" | "feature",
  "title": "<ticket title>",
  "branchName": "<branch name from step 6>",
  "summary": "<3-6 sentences: what the ticket asks, what exists today, where the change will land>",
  "affectedAreas": ["<file or module path>", "..."]
}
```

Then reply with exactly one line: `DONE`.
