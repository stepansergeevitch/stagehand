import { z } from "zod";

// The wrong-repo short form (research.md step 1) only carries repositoryPath, branchName and summary; the rest defaults
// so that file passes the contract and afterStage can block the task with the right message instead of "contract failed".
export const ResearchResult = z.object({
    classification: z.enum(["bug", "feature"]).default("feature"),
    title: z.string().default(""),
    branchName: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    summary: z.string(),
    affectedAreas: z.array(z.string()).default([]),
    repositoryPath: z.string().nullable().default(null),
});
export type ResearchResult = z.infer<typeof ResearchResult>;

export const QaScenario = z.object({
    id: z.string().regex(/^S\d+$/),
    title: z.string(),
    url: z.string(),
    persona: z.string().default("default user"),
    // Data the journey needs, as concrete steps the runner performs itself before the first step (UI actions, API calls
    // with payloads, SQL, or a repo script) — never a request for a human to prepare something. Empty = nothing to seed.
    seed: z.array(z.string()).default([]),
    steps: z
        .array(
            z.object({
                action: z.string(),
                assert: z.string(),
                shot: z.boolean().default(false),
            }),
        )
        .min(1),
});
export type QaScenario = z.infer<typeof QaScenario>;

export const DesignResult = z.object({
    classification: z.enum(["bug", "feature"]),
    // Multi-repo workspaces: the sub-repository directories the change touches ([] for a single repo).
    affectedRepos: z.array(z.string()).default([]),
    scope: z.object({ inScope: z.array(z.string()), outOfScope: z.array(z.string()) }),
    plan: z.array(z.object({ layer: z.string(), changes: z.array(z.string()) })),
    testPlan: z.array(z.object({ file: z.string(), cases: z.array(z.string()) })),
    qa: z.array(QaScenario).max(10),
    qaSkippedReason: z.string().nullable().default(null),
});
export type DesignResult = z.infer<typeof DesignResult>;

export const QaPassResult = z.object({
    pass: z.enum(["before", "after"]),
    scenarios: z.array(
        z.object({
            id: z.string(),
            // needs_human: the runner could not verify this properly and asks the reviewer to check it (observation = instructions).
            outcome: z.enum(["pass", "fail", "blocked", "needs_human"]),
            observation: z.string(),
            // A blocked or needs_human scenario legitimately has no screenshots.
            shots: z.array(z.object({ step: z.number().int(), file: z.string() })).default([]),
        }),
    ),
    blockers: z.array(z.string()).default([]),
});
export type QaPassResult = z.infer<typeof QaPassResult>;

export const ImplResult = z.object({
    files: z.array(z.string()),
    commits: z.array(z.string()),
    tests: z.object({ backend: z.string().nullable(), frontend: z.string().nullable() }),
    coverageNewLines: z.number().nullable(),
    gates: z.object({ tests: z.boolean(), typecheck: z.boolean() }),
    notes: z.string().default(""),
});
export type ImplResult = z.infer<typeof ImplResult>;

// One PR per repository that has commits: `repo` is the sub-repo directory in a multi-repo workspace, "" for a single repo.
export const PrDraftEntry = z.object({
    repo: z.string().default(""),
    title: z.string().min(1),
    body: z.string(),
});
export type PrDraftEntry = z.infer<typeof PrDraftEntry>;
export const PrDraft = z.object({
    base: z.string(),
    drafts: z.array(PrDraftEntry).min(1),
});
export type PrDraft = z.infer<typeof PrDraft>;

export const PrFixResult = z.object({
    summary: z.string(),
});
export type PrFixResult = z.infer<typeof PrFixResult>;

// <taskDir>/questions.json — what an agent writes (any stage) when only the human can decide something; the run then
// ends with NEED_INPUT and the task waits for answers, which come back as notes in the resumed session.
export const QuestionsFile = z.object({
    questions: z
        .array(
            z.object({
                id: z.string().min(1),
                text: z.string().min(1),
                context: z.string().default(""),
                options: z.array(z.string()).default([]),
            }),
        )
        .min(1)
        .max(10),
});
export type QuestionsFile = z.infer<typeof QuestionsFile>;
export type AgentQuestion = QuestionsFile["questions"][number];
