import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { QaScenario } from "./stages/contracts.js";

// A QA runner that finds a scenario step, seed, teardown or assert broken as written proposes the correction through
// the questions mechanism. When it is approved — by the human, or by Jev for the mechanical kinds (qa-autofix.ts) —
// Stagehand applies it to design.json itself, so a fresh QA session runs the corrected scenario instead of
// re-deriving the same defect and asking again (INV-134, 2026-09-21: six identical questions, twice).
//
// Recognised question text: "S<k> step|seed|teardown|assert <n> …" or "S<k> scenario …" (case-insensitive, anywhere).
// Recognised answer: the corrected command / assert text / scenario JSON, optionally prefixed "apply corrected
// command:" and the like; an answer starting with "keep", "no" or "skip", or an empty one, is skipped.

export type FixKind = "step" | "seed" | "teardown" | "assert" | "scenario";

export interface ParsedFix {
    scenario: string;
    kind: FixKind;
    // 0-based step/seed/teardown index; -1 for a whole-scenario rewrite.
    index: number;
    // The corrected command, assert text, or scenario JSON.
    command: string;
}

export interface StepFixQuestion {
    id: string;
    text: string;
    context?: string;
    options?: string[];
}

// One applied correction, kept in qa/changes.json: the scenario before and after, who approved it and why.
export interface QaChange {
    id: string;
    at: string;
    scenario: string;
    kind: FixKind;
    index: number;
    before: unknown;
    after: unknown;
    by: "human" | "jev";
    question: string;
    reason?: string;
    jev?: { legit: number; weakens: number; kind: string };
    revertedAt?: string;
}

interface Scenario {
    id: string;
    kind?: string;
    seed?: string[];
    teardown?: string[];
    steps?: Array<{ action?: string; assert?: string; [k: string]: unknown }>;
    [k: string]: unknown;
}

const REF = /\bS(\d+)\s+(step|seed|teardown|assert)\s+(\d+)\b/i;
const SCENARIO_REF = /\bS(\d+)\s+scenario\b/i;
// The option label before the command: "apply corrected command:", "apply this teardown before seeding S1 (run once):",
// "use the corrected seed below:" … — everything up to the first colon when the answer starts with apply/use/run.
// A command itself never starts with those words; a "shell:"/"sql:" prefix after the label is kept (INV-136,
// 2026-09-21: "apply corrected teardown: cd backend …" was written into design.json label included → "command not found: corrected").
const PREFIX = /^\s*(apply|use|run|replace)\b[^:\n]{0,200}:\s*/i;

// Commentary after the command is not part of it: an option like `… item={item.id}')" (and add the same line to S1
// teardown 1)` written whole into design.json gave bash "syntax error near unexpected token '('" (INV-133,
// 2026-09-25). Everything after the closing quote of a `-c "…"` / `-c '…'` argument goes, unless it continues the
// shell command (&&, ||, |, ;, >, 2>).
export const cutTrailingCommentary = (command: string): string => {
    const m = /\s-c\s+(["'])/.exec(command);
    if (!m) return command;
    const q = m[1]!;
    let i = m.index + m[0].length;
    for (; i < command.length; i++) {
        if (command[i] === "\\" && q === '"') i += 1;
        else if (command[i] === q) break;
    }
    if (i >= command.length) return command;
    const rest = command.slice(i + 1);
    if (!rest.trim() || /^\s*(&&|\|\||\||;|>|2>|<)/.test(rest)) return command;
    return command.slice(0, i + 1);
};

const stripFences = (s: string): string => s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

export const parseStepFixAnswer = (text: string, answer: string | undefined): ParsedFix | null => {
    const raw = (answer ?? "").trim();
    if (!raw || /^keep\b/i.test(raw) || /^(no|skip)\b/i.test(raw)) return null;
    const whole = SCENARIO_REF.exec(text);
    const m = REF.exec(text);
    if (!m && !whole) return null;
    let command = raw.replace(PREFIX, "").trim();
    if (whole && (!m || whole.index < m.index)) {
        command = stripFences(command);
        try {
            const parsed: unknown = JSON.parse(command);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        } catch {
            return null;
        }
        return { scenario: `S${whole[1]}`, kind: "scenario", index: -1, command };
    }
    const kind = m![2]!.toLowerCase() as Exclude<FixKind, "scenario">;
    if (kind !== "assert") command = cutTrailingCommentary(command);
    if (!command) return null;
    // An option that only points at a command ("apply the corrected N command above") carries no command to apply:
    // writing that text into design.json turned INV-133's S4 steps into placeholders (2026-09-22). Nothing to apply.
    if (kind !== "assert" && /^(apply|use|run)\b/i.test(command) && !/[|/$"'`=]/.test(command)) return null;
    return { scenario: `S${m![1]}`, kind, index: Number(m![3]) - 1, command };
};

// The option of a question that carries the proposed correction (the runner lists it first; "keep …" is the other).
export const proposedOption = (q: { options?: string[] | undefined }): string | undefined =>
    (q.options ?? []).find((o) => !/^\s*(keep|no|skip)\b/i.test(o) && o.trim().length > 0);

// Applies one fix to a copy of the scenario; null when it changes nothing or cannot apply.
export const applyFixToScenario = (scenario: Scenario, fix: ParsedFix): { after: Scenario; line: string } | null => {
    const after: Scenario = JSON.parse(JSON.stringify(scenario)) as Scenario;
    if (fix.kind === "scenario") {
        const parsed = QaScenario.safeParse(JSON.parse(fix.command));
        if (!parsed.success) return null;
        const next = { ...parsed.data, id: scenario.id } as Scenario;
        if (JSON.stringify(next) === JSON.stringify(scenario)) return null;
        return { after: next, line: `${scenario.id}: scenario replaced with the approved rewrite` };
    }
    if (fix.kind === "step" || fix.kind === "assert") {
        const step = after.steps?.[fix.index];
        if (!step) return null;
        const field = fix.kind === "step" ? "action" : "assert";
        if (step[field] === fix.command) return null;
        step[field] = fix.command;
        return { after, line: `${scenario.id} step ${fix.index + 1}: ${field} replaced with the approved ${fix.kind === "step" ? "command" : "text"}` };
    }
    // Seeds and teardown steps carry a "shell:" / "sql:" / "ui:" prefix that says who runs them — keep it unless the
    // answer has one. A teardown index past the end appends (the runner may propose a teardown that did not exist).
    const list = fix.kind === "seed" ? (after.seed ??= []) : (after.teardown ??= []);
    const current = typeof list[fix.index] === "string" ? list[fix.index]! : null;
    if (fix.kind === "seed" && current === null) return null;
    const prefix = /^\s*(shell|sql|ui)\s*:/i.exec(fix.command) ? "" : (current ? (/^\s*(shell|sql|ui)\s*:\s*/i.exec(current)?.[0] ?? "shell: ") : "shell: ");
    const next = `${prefix}${fix.command}`;
    if (current === next) return null;
    if (current === null) list.push(next);
    else list[fix.index] = next;
    return { after, line: `${scenario.id} ${fix.kind} ${fix.index + 1}: ${current === null ? "added" : "replaced with"} the approved command` };
};

const valueTokens = (s: string): string[] => [...s.matchAll(/\$?\d[\d,.]*%?|"[^"]+"|'[^']+'|`[^`]+`/g)].map((m) => m[0]);

// What no approval — human or Jev — may pass: the deterministic floor. A correction fixes how a scenario is
// exercised; it never makes the scenario prove less.
export const guardQaFix = (before: Scenario, after: Scenario, kind: FixKind): { ok: true } | { ok: false; reason: string } => {
    const bs = before.steps ?? [];
    const as = after.steps ?? [];
    if (as.length < bs.length) return { ok: false, reason: `removes ${bs.length - as.length} step(s)` };
    if (kind === "seed" || kind === "teardown") {
        if (JSON.stringify(bs) !== JSON.stringify(as)) return { ok: false, reason: "a seed or teardown correction must not touch the steps" };
        return { ok: true };
    }
    if (kind === "step") {
        for (let i = 0; i < bs.length; i++) if ((bs[i]?.assert ?? "") !== (as[i]?.assert ?? "")) return { ok: false, reason: `step ${i + 1}: a step correction must not change its assert` };
        return { ok: true };
    }
    if (kind === "scenario" && before.kind && after.kind && before.kind !== after.kind) return { ok: false, reason: "changes the scenario kind" };
    for (let i = 0; i < bs.length; i++) {
        const b = bs[i]?.assert ?? "";
        const a = as[i]?.assert ?? "";
        if (b === a) continue;
        if (a.trim().length < 8) return { ok: false, reason: `step ${i + 1}: the new assert is empty or trivial` };
        if (valueTokens(b).length > 0 && valueTokens(a).length === 0) return { ok: false, reason: `step ${i + 1}: the new assert drops the values the old one checked (${valueTokens(b).slice(0, 3).join(", ")})` };
    }
    return { ok: true };
};

export interface FixRequest {
    fix: ParsedFix;
    by: QaChange["by"];
    question: string;
    reason?: string | undefined;
    jev?: QaChange["jev"] | undefined;
}

// Applies every fix to the design file; returns one line per applied change and the change records. The original is
// kept beside it as design.json.bak-<timestamp> the first time a round changes anything.
export const applyQaFixes = (designPath: string, requests: FixRequest[]): { lines: string[]; changes: QaChange[] } => {
    if (!existsSync(designPath) || requests.length === 0) return { lines: [], changes: [] };
    const design = JSON.parse(readFileSync(designPath, "utf8")) as { qa?: Scenario[] };
    const lines: string[] = [];
    const changes: QaChange[] = [];
    for (const r of requests) {
        const i = design.qa?.findIndex((s) => s.id.toUpperCase() === r.fix.scenario) ?? -1;
        const scenario = i >= 0 ? design.qa![i] : undefined;
        if (!scenario) continue;
        const applied = applyFixToScenario(scenario, r.fix);
        if (!applied) continue;
        design.qa![i] = applied.after;
        lines.push(applied.line);
        changes.push({
            id: randomUUID().slice(0, 8),
            at: new Date().toISOString(),
            scenario: scenario.id,
            kind: r.fix.kind,
            index: r.fix.index,
            before: scenario,
            after: applied.after,
            by: r.by,
            question: r.question,
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.jev ? { jev: r.jev } : {}),
        });
    }
    if (changes.length) {
        copyFileSync(designPath, `${designPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        writeFileSync(designPath, JSON.stringify(design, null, 2));
    }
    return { lines, changes };
};

// The human-answer path: every question the answers match, applied as human-approved.
export const applyApprovedStepFixes = (designPath: string, questions: StepFixQuestion[], answers: Record<string, string>): string[] =>
    applyQaFixes(
        designPath,
        questions
            .map((q) => ({ fix: parseStepFixAnswer(q.text, answers[q.id]), question: q.text }))
            .filter((x): x is { fix: ParsedFix; question: string } => x.fix !== null)
            .map((x) => ({ ...x, by: "human" as const })),
    ).lines;

// Puts the scenario back as it was before the change (by id); false when the scenario is gone.
export const revertQaChange = (designPath: string, change: QaChange): boolean => {
    if (!existsSync(designPath)) return false;
    const design = JSON.parse(readFileSync(designPath, "utf8")) as { qa?: Scenario[] };
    const i = design.qa?.findIndex((s) => s.id === change.scenario) ?? -1;
    if (i < 0) return false;
    design.qa![i] = change.before as Scenario;
    copyFileSync(designPath, `${designPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    writeFileSync(designPath, JSON.stringify(design, null, 2));
    return true;
};
