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

const REF = /\bS(\d+)\s+(step|seed)\s+(\d+)\b/i;
const PREFIX = /^\s*(apply|use)\s+(the\s+)?corrected\s+(command|step|seed)(\s+below)?\s*:\s*/i;

export const parseStepFixAnswer = (text: string, answer: string | undefined): { scenario: string; kind: "step" | "seed"; index: number; command: string } | null => {
    const m = REF.exec(text);
    if (!m) return null;
    const raw = (answer ?? "").trim();
    if (!raw || /^keep\b/i.test(raw) || /^(no|skip)\b/i.test(raw)) return null;
    const command = raw.replace(PREFIX, "").trim();
    if (!command) return null;
    return { scenario: `S${m[1]}`, kind: m[2]!.toLowerCase() as "step" | "seed", index: Number(m[3]) - 1, command };
};

interface QaScenario {
    id: string;
    seed?: string[];
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
            const seeds = scenario.seed;
            if (!seeds || typeof seeds[f.index] !== "string") continue;
            // Seeds carry a "shell:" / "sql:" / "ui:" prefix that says who runs them — keep it unless the answer has one.
            const prefix = /^\s*(shell|sql|ui)\s*:/i.exec(f.command) ? "" : (/^\s*(shell|sql|ui)\s*:\s*/i.exec(seeds[f.index]!)?.[0] ?? "shell: ");
            const next = `${prefix}${f.command}`;
            if (seeds[f.index] === next) continue;
            seeds[f.index] = next;
            applied.push(`${f.scenario} seed ${f.index + 1}: replaced with the approved command`);
        }
    }
    if (applied.length) {
        copyFileSync(designPath, `${designPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        writeFileSync(designPath, JSON.stringify(design, null, 2));
    }
    return applied;
};
