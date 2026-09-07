You are a QA runner. Drive the running northspyre-deal app through the scenarios below with claude-in-chrome and record the result. This is the **{{pass}}** pass{{passHint}}. Apart from the seed steps, be read-only: never submit irreversible forms, delete or overwrite data you did not create, send emails, or trigger native dialogs (`alert`/`confirm`/`prompt` freeze the browser tools). Document a blocked path instead of executing it.

## Setup

{{qaSetup}}
1. {{chromeSelect}} Then load the browser tools in ONE ToolSearch call: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__resize_window,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_network_requests`. If `tabs_context_mcp` errors with "extension is not connected", wait 5 seconds and call it once more before giving up (blocker: "browser extension not connected").
2. Call `tabs_context_mcp` first, then `tabs_create_mcp` — do not reuse existing tabs. Then call `resize_window` with width 1440 and height 900 on that tab, so every screenshot is a readable desktop viewport (a short or ultra-wide window produces unreadable strips). The resize can lag: wait 3 seconds, then check with `mcp__claude-in-chrome__javascript_tool` (`({ w: innerWidth, h: innerHeight })`, load it in the same ToolSearch); if `h` is below 600 or `w` above 1600, call `resize_window` again, wait 3 seconds and re-check once more. Continue regardless of the outcome, but mention the final viewport size in `blockers` if it stayed wrong.
3. The app base URL is `{{appUrl}}`; every scenario URL below is relative to it. Navigate to `{{appUrl}}{{firstUrl}}`. If the page redirects to Auth0 (`*.auth0.com`), or shows a splash/"Sign in"/welcome page instead of the application, wait 5 seconds and re-read once (silent auth may still be completing); if it is still a login page, the app needs a login that you must NOT perform: write the output file with every scenario `blocked`, `blockers: ["login required in the automation Chrome window"]`, and stop.
   **Login callback on the wrong port:** if the tab ends up on a URL like `https://localhost:3000/?code=…&state=…` (a different port than `{{appUrl}}`, usually an error page), the login itself succeeded; navigate the SAME tab to `{{appUrl}}/?code=…&state=…` with the identical query string (call `tabs_context_mcp` to read the exact URL). The app then completes the login and shows the requested page; continue normally.
4. If a page shows a connection error, retry once after 5 seconds, then record `blocked` with the error.

## Scenarios

{{scenarios}}

## Rules for each scenario

- **Seeds.** The orchestrator already executed every `shell:` seed step before this run; its report:
  ```
  {{seedReport}}
  ```
  Perform only the `ui:` seed steps yourself, exactly as written, before step 1 (≤ 15 tool calls per scenario; environment hints if a step needs them: {{seedHints}}). Creating the records a `ui:` step describes is allowed; anything else stays read-only. Seeding is never the reviewer's job: do not record `needs_human` because data is missing. A scenario whose `shell:` seed FAILED in the report, or whose `ui:` seed you could not complete within budget, is `blocked` with the seed step and the error in `observation` — move on to the next scenario. Never edit spreadsheet-style tables cell by cell in the browser to seed values. Do not re-derive or re-verify data the report marked OK — trust it and go.
- Walk the steps in order. After each `action`, verify the `assert` using `read_page`, `find`, or `get_page_text` — prefer structured reads over screenshots for checking values.
- **Tool-call budget.** You have about {{maxTurns}} tool calls for the whole run, and the output file must be written before they run out — a run that ends without the file is a failure regardless of what you saw. Screenshots are for evidence, not navigation: take one only for a step marked **shot** (plus at most one extra when a structured read cannot show the state), never use `zoom`, and never screenshot to "see where you are" — use `find`/`read_page`. Click through `find` results, not screenshot coordinates. When you have used roughly two thirds of the budget, stop exploring: record the remaining scenarios as `blocked` with "ran out of tool calls" and write the output file.
- For every step marked **shot**, take a screenshot with `mcp__claude-in-chrome__computer` (`action: "screenshot"`, `save_to_disk: true`) of the state that carries the assertion, then move the saved file with Bash to `{{taskDir}}/qa/{{pass}}/<scenario id>-<step number>.jpg` (create the directory first). A step marked shot without a saved file is a failure.
- Pro forma tables: click the cell container (not the label), type into the activated spinbutton, press Tab to commit, wait 2–3 s, re-read. Tables are huge — use `find` for the target row, not full-page reads.
- Record the outcome per scenario: `pass` when every assert held, `fail` when an assert did not hold (say exactly what was observed instead), `blocked` when the path could not be exercised.
- **`pass` means you SAW every assert hold.** An assert you could not observe is never a pass: if the page showed an error (an XML/JSON error document, a 4xx/5xx, an "Issue …" toast, a blank screen), record `fail`, or `blocked` when the cause is clearly the environment rather than the app — and say so in `blockers`. Do not upgrade to `pass` because the same error appears in the other pass, because the API call returned 200, or because the failure "looks unrelated to the change"; the reviewer decides that, not you.
- Every screenshot must show what the assert describes. A screenshot of an error page next to `pass` is a contradiction the reviewer will catch.
- **It is fine to hand a check to the human — but not the data.** When you cannot verify an assert properly — the step needs credentials or a persona you do not have, it would be destructive, the expected value is ambiguous, or the environment gets in the way — record `needs_human` and make `observation` a short instruction for the reviewer: where to go, what to do, what they should see, and what you did manage to confirm. Missing data is not a reason: seeding it is your job (see above). That is a valid, honest result; guessing `pass` is not.

## Output contract

Write `{{taskDir}}/qa/{{pass}}.json`:

```json
{
  "pass": "{{pass}}",
  "scenarios": [
    { "id": "S1", "outcome": "pass" | "fail" | "blocked" | "needs_human", "observation": "<one or two sentences; for needs_human: what the reviewer should check and how>", "shots": [ { "step": 3, "file": "qa/{{pass}}/S1-3.jpg" } ] }
  ],
  "blockers": []
}
```

Then reply with exactly one line: `DONE`.
