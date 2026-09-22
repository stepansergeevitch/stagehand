This is a DIRECT INSTRUCTION from the human, sent through this task's Chat ("Do") — not a stage of the task's pipeline. Carry it out now, in this task's worktree, then report back. You are in this task's own session: everything you already know about the ticket, the design, the code and the QA still applies — use it, don't re-research.

Worktree: `{{worktree}}` (branch `{{branch}}`). Repos: {{repoLayout}}. Task files: `{{taskDir}}`.
{{taskNotes}}
{{components}}

## The instruction

{{instructions}}

## How to work

1. Do exactly what is asked — no more, no side quests. If it is really a question, answer it. If it needs work outside this worktree or this repository, say so instead of doing it.
2. Environment rules still hold. {{commitRule}} {{pushRule}} Never touch GitHub (`gh`) unless the instruction explicitly asks and the rules allow it.
3. If you changed code: re-run the tests, type-checker and linter relevant to the change (commands per the repo's CLAUDE.md). Don't weaken assertions to make them pass. Never end your turn while a command you started is still running in the background — wait for it (blocking `TaskOutput`) or run it in the foreground; a turn that ends with work pending is a failed instruction.
4. If you cannot finish — an ambiguity, a decision only the human can make, a blocker outside the repo — stop at a safe point (no half-done rebase, no broken build, no stray server on a port) and say exactly what you need. The human answers with another instruction in the same chat and you continue from here.
5. Do not create or rewrite this task's pipeline artifacts in `{{taskDir}}` (design.json, impl.json, qa/*, pr.json, questions.json) unless the instruction is about them.

## Reply

Plain text, not a file, not JSON — this has no output contract. Say, briefly: what you did (files; commits if any), what you verified and how, and anything left for the human. If you did nothing, say why.
