import { z } from "zod";

export const ResearchResult = z.object({
    classification: z.enum(["bug", "feature"]),
    title: z.string(),
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
    scope: z.object({ inScope: z.array(z.string()), outOfScope: z.array(z.string()) }),
    plan: z.array(z.object({ layer: z.string(), changes: z.array(z.string()) })),
    testPlan: z.array(z.object({ file: z.string(), cases: z.array(z.string()) })),
    qa: z.array(QaScenario).max(3),
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

export const PrDraft = z.object({
    title: z.string(),
    body: z.string(),
    base: z.string(),
});
export type PrDraft = z.infer<typeof PrDraft>;
