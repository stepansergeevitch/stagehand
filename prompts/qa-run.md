You are a QA runner. Drive the running northspyre-deal app through the scenarios below with claude-in-chrome and record the result. This is the **{{pass}}** pass{{passHint}}. Read-only: never submit irreversible forms, delete data, send emails, or trigger native dialogs (`alert`/`confirm`/`prompt` freeze the browser tools). Document a blocked path instead of executing it.

## Setup

{{qaSetup}}
1. Load the browser tools in ONE ToolSearch call: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_network_requests`. If `tabs_context_mcp` errors with "extension is not connected", wait 5 seconds and call it once more before giving up (blocker: "browser extension not connected").
2. Call `tabs_context_mcp` first, then `tabs_create_mcp` — do not reuse existing tabs.
3. The app base URL is `{{appUrl}}`; every scenario URL below is relative to it. Navigate to `{{appUrl}}{{firstUrl}}`. If the page redirects to Auth0 (`*.auth0.com`) or a login form, the app needs a login that you must NOT perform: write the output file with every scenario `blocked`, `blockers: ["login required in the automation Chrome window"]`, and stop.
4. If a page shows a connection error, retry once after 5 seconds, then record `blocked` with the error.

## Scenarios

{{scenarios}}

## Rules for each scenario

- Walk the steps in order. After each `action`, verify the `assert` using `read_page`, `find`, or `get_page_text` — prefer structured reads over screenshots for checking values.
- For every step marked **shot**, take a screenshot with `mcp__claude-in-chrome__computer` (`action: "screenshot"`, `save_to_disk: true`) of the state that carries the assertion, then move the saved file with Bash to `{{taskDir}}/qa/{{pass}}/<scenario id>-<step number>.jpg` (create the directory first). A step marked shot without a saved file is a failure.
- Pro forma tables: click the cell container (not the label), type into the activated spinbutton, press Tab to commit, wait 2–3 s, re-read. Tables are huge — use `find` for the target row, not full-page reads.
- Record the outcome per scenario: `pass` when every assert held, `fail` when an assert did not hold (say exactly what was observed instead), `blocked` when the path could not be exercised.

## Output contract

Write `{{taskDir}}/qa/{{pass}}.json`:

```json
{
  "pass": "{{pass}}",
  "scenarios": [
    { "id": "S1", "outcome": "pass" | "fail" | "blocked", "observation": "<one or two sentences>", "shots": [ { "step": 3, "file": "qa/{{pass}}/S1-3.jpg" } ] }
  ],
  "blockers": []
}
```

Then reply with exactly one line: `DONE`.
