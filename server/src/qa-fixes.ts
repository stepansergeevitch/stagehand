import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// A QA runner that finds a scenario step or seed broken as written (wrong path, missing host, wrong field) proposes
// the corrected command through the questions mechanism. When the human approves it, Stagehand applies it to
// design.json itself — a fresh QA session then runs the corrected step instead of re-deriving the same defect and
// asking again (INV-134, 2026-09-21: six identical questions, twice).
//
// Recognised question text: "S<k> step <n> …" or "S<k> seed <n> …" (case-insensitive, anywhere in the text).
// Recognised answer: the corrected command, optionally prefixed "apply corrected command:" / "apply the corrected
// command below:"; an answer starting with "keep" (the "keep the step as written" option) or an empty answer is skipped.

export interface StepFixQuestion {
    id: string;
    text: string;
}

const REF = /\bS(\d+)\s+(step|seed|teardown)\s+(\d+)\b/i;
// The option label before the command: "apply corrected command:", "apply this teardown before seeding S1 (run once):",
// "use the corrected seed below:" … — everything up to the first colon when the answer starts with apply/use/run.
// A command itself never starts with those words; a "shell:"/"sql:" prefix after the label is kept (INV-136,
// 2026-09-21: "apply corrected teardown: cd backend …" was written into design.json label included → "command not found: corrected").
const PREFIX = /^\s*(apply|use|run)\b[^:\n]{0,200}:\s*/i;

export const parseStepFixAnswer = (text: string, answer: string | undefined): { scenario: string; kind: "step" | "seed" | "teardown"; index: number; command: string } | null => {
    const m = REF.exec(text);
    if (!m) return null;
    const raw = (answer ?? "").trim();
    if (!raw || /^keep\b/i.test(raw) || /^(no|skip)\b/i.test(raw)) return null;
    const command = raw.replace(PREFIX, "").trim();
    if (!command) return null;
    return { scenario: `S${m[1]}`, kind: m[2]!.toLowerCase() as "step" | "seed" | "teardown", index: Number(m[3]) - 1, command };
};

interface QaScenario {
    id: string;
    seed?: string[];
    teardown?: string[];
    steps?: Array<{ action?: string; [k: string]: unknown }>;
    [k: string]: unknown;
}

// Applies every approved fix to the design file; returns one line per applied change (empty when nothing matched).
// The original is kept beside it as design.json.bak-<timestamp> the first time a round changes anything.
export const applyApprovedStepFixes = (designPath: string, questions: StepFixQuestion[], answers: Record<string, string>): string[] => {
    if (!existsSync(designPath)) return [];
    const fixes = questions.map((q) => parseStepFixAnswer(q.text, answers[q.id])).filter((f): f is NonNullable<typeof f> => f !== null);
    if (fixes.length === 0) return [];
    const design = JSON.parse(readFileSync(designPath, "utf8")) as { qa?: QaScenario[] };
    const applied: string[] = [];
    for (const f of fixes) {
        const scenario = design.qa?.find((s) => s.id.toUpperCase() === f.scenario);
        if (!scenario) continue;
        if (f.kind === "step") {
            const step = scenario.steps?.[f.index];
            if (!step || typeof step.action !== "string") continue;
            if (step.action === f.command) continue;
            step.action = f.command;
            applied.push(`${f.scenario} step ${f.index + 1}: action replaced with the approved command`);
        } else {
            // Seeds and teardown steps carry a "shell:" / "sql:" / "ui:" prefix that says who runs them — keep it unless
            // the answer has one. A teardown index past the end appends (the runner may propose a teardown that did not exist).
            const list = f.kind === "seed" ? scenario.seed : (scenario.teardown ??= []);
            if (!list) continue;
            const current = typeof list[f.index] === "string" ? list[f.index]! : null;
            if (f.kind === "seed" && current === null) continue;
            const prefix = /^\s*(shell|sql|ui)\s*:/i.exec(f.command) ? "" : (current ? (/^\s*(shell|sql|ui)\s*:\s*/i.exec(current)?.[0] ?? "shell: ") : "shell: ");
            const next = `${prefix}${f.command}`;
            if (current === next) continue;
            if (current === null) list.push(next);
            else list[f.index] = next;
            applied.push(`${f.scenario} ${f.kind} ${f.index + 1}: ${current === null ? "added" : "replaced with"} the approved command`);
        }
    }
    if (applied.length) {
        copyFileSync(designPath, `${designPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        writeFileSync(designPath, JSON.stringify(design, null, 2));
    }
    return applied;
};
