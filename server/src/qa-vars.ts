// QA scenario text (seeds, teardown, step actions/asserts) carries placeholders the orchestrator resolves at run time:
//   {{beUrl}} / {{feUrl}} / {{appUrl}} — this task's own servers (ports are allocated per task, so a design can never
//                                        hard-code a host);
//   {{qaPass}}                          — a short id unique to this QA pass (e.g. "b7k2x"), for records the app never
//                                        lets a teardown remove (posted documents, serial numbers, memos): a value
//                                        like `QA-X001-{{qaPass}}` cannot collide with an earlier pass.

export interface QaVars {
    beUrl: string;
    feUrl: string;
    appUrl: string;
    qaPass: string;
}

export const fillQaVars = (text: string, v: QaVars): string =>
    text.replace(/\{\{beUrl\}\}/g, v.beUrl).replace(/\{\{feUrl\}\}/g, v.feUrl).replace(/\{\{appUrl\}\}/g, v.appUrl).replace(/\{\{qaPass\}\}/g, v.qaPass);

// A pass id: the pass letter (b = baseline, a = after) plus a time-based base36 suffix.
export const newQaPassId = (stage: "qa_baseline" | "manual_qa", at = Date.now()): string => `${stage === "qa_baseline" ? "b" : "a"}${at.toString(36).slice(-5)}`;

interface ScenarioLike {
    id: string;
    kind?: string | undefined;
    teardown?: string[] | undefined;
    seed?: string[] | undefined;
    steps: Array<{ action: string; assert: string }>;
}

const CREATES = /\b(insert\s+into|create\(|get_or_create|update_or_create|bulk_create|\.save\(|curl\b[^|]*-X\s*POST|-X\s*PUT|\bPOST\b)/i;
const HAS_HOST = /https?:\/\/[^\s'"]+/i;
const PLACEHOLDER_HOST = /\{\{(beUrl|appUrl|feUrl)\}\}/;

// Static checks on design.json's QA block, run when the design lands (same contract-retry path as the seed dry-run):
//  - an API step's curl must address the task's own server through {{beUrl}}/{{appUrl}} (never a hard-coded host, never
//    a bare path — the port differs per task and a bare path is not a URL);
//  - a scenario whose seed creates records must declare a teardown that removes its fixture set first, so reruns and
//    the second pass start clean instead of colliding with leftovers (INV-134 / INV-132, 2026-09-21);
//  - teardown steps are shell:/sql: only (the orchestrator runs them, no agent).
export const qaContractProblems = (scenarios: ScenarioLike[]): string | null => {
    const problems: string[] = [];
    for (const s of scenarios) {
        const kind = s.kind ?? "browser";
        if (kind === "api") {
            s.steps.forEach((st, i) => {
                if (!/\bcurl\b/.test(st.action)) return;
                if (PLACEHOLDER_HOST.test(st.action)) return;
                if (HAS_HOST.test(st.action)) problems.push(`${s.id} step ${i + 1} hard-codes a host — the task's servers get their own ports; write the URL as {{beUrl}}/<path> (or {{appUrl}} for the frontend)`);
                else problems.push(`${s.id} step ${i + 1} calls curl with a bare path — prefix it with {{beUrl}} (the task's backend) so it is a full URL`);
            });
        }
        const seeds = s.seed ?? [];
        const creates = seeds.some((x) => /^\s*(shell|sql)\s*:/i.test(x) && CREATES.test(x));
        if (creates && (s.teardown ?? []).length === 0) problems.push(`${s.id} seeds create records but has no teardown — add \`teardown\` steps that delete this scenario's fixture set by natural key (documents first, then master data) so a rerun starts clean`);
        (s.teardown ?? []).forEach((t, i) => {
            if (!/^\s*(shell|sql)\s*:/i.test(t)) problems.push(`${s.id} teardown ${i + 1} must be a \`shell:\` or \`sql:\` command (the orchestrator runs teardown without an agent)`);
        });
    }
    return problems.length ? `QA scenarios must be self-resetting and addressable: ${problems.join("; ")}` : null;
};
