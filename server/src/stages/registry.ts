import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import type { Stage } from "../db.js";
import { DesignResult, ImplResult, PrDraft, QaPassResult, ResearchResult } from "./contracts.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "prompts");

export type StageKind = "auto" | "wait" | "poll" | "terminal";

export interface StageDef {
    stage: Stage;
    kind: StageKind;
    label: string;
    prompt?: string;
    contract?: ZodTypeAny;
    outputFile?: string;
    chrome?: boolean;
    freshSession?: boolean;
    maxTurns?: number;
    next: Stage | null;
}

export const STAGE_DEFS: Record<Stage, StageDef> = {
    research: {
        stage: "research",
        kind: "auto",
        label: "Research",
        prompt: "research.md",
        contract: ResearchResult,
        outputFile: "research.json",
        maxTurns: 60,
        next: "design_proposal",
    },
    design_proposal: {
        stage: "design_proposal",
        kind: "wait",
        label: "Design Proposal",
        prompt: "design.md",
        contract: DesignResult,
        outputFile: "design.json",
        maxTurns: 60,
        next: "qa_baseline",
    },
    qa_baseline: {
        stage: "qa_baseline",
        kind: "auto",
        label: "QA baseline",
        prompt: "qa-run.md",
        contract: QaPassResult,
        outputFile: "qa/before.json",
        chrome: true,
        freshSession: true,
        maxTurns: 80,
        next: "implementation",
    },
    implementation: {
        stage: "implementation",
        kind: "auto",
        label: "Implementation",
        prompt: "implementation.md",
        contract: ImplResult,
        outputFile: "impl.json",
        maxTurns: 200,
        next: "manual_qa",
    },
    manual_qa: {
        stage: "manual_qa",
        kind: "auto",
        label: "Manual QA",
        prompt: "qa-run.md",
        contract: QaPassResult,
        outputFile: "qa/after.json",
        chrome: true,
        freshSession: true,
        maxTurns: 80,
        next: "user_review",
    },
    user_review: { stage: "user_review", kind: "wait", label: "User Review", next: "pr_creation_review" },
    pr_creation_review: {
        stage: "pr_creation_review",
        kind: "wait",
        label: "PR Creation Review",
        prompt: "pr.md",
        contract: PrDraft,
        outputFile: "pr.json",
        maxTurns: 30,
        next: "pr_waiting",
    },
    pr_waiting: { stage: "pr_waiting", kind: "poll", label: "PR Waiting", next: "pr_green" },
    pr_red: { stage: "pr_red", kind: "auto", label: "PR Red", prompt: "pr-fix.md", maxTurns: 120, next: "pr_waiting" },
    pr_green: { stage: "pr_green", kind: "poll", label: "PR Green", next: "pr_approved" },
    pr_approved: { stage: "pr_approved", kind: "poll", label: "PR Approved", next: "done" },
    done: { stage: "done", kind: "terminal", label: "Done", next: null },
};

export type PromptVars = Record<string, string>;

export const renderPrompt = (file: string, vars: PromptVars): string => {
    const raw = readFileSync(join(PROMPTS_DIR, file), "utf8");
    return raw.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
};
