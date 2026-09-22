import { z } from "zod";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { recordExternalUsage, type UsageContext } from "./usage.js";

// Jev (TypeSafe AI's "System One" model): one state + typed questions in, calibrated probabilities out, no prose,
// ~100–500 ms. Used for the small judgments the engine otherwise makes with regexes or a whole Claude run.
// https://docs.typesafe.ai — POST /v1/systemone, $0.042 per 1M input tokens, output free.

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const USD_PER_M_INPUT = 0.042;
const TIMEOUT_MS = 15_000;

export type JevQuestion =
    | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
    | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
    | { type: "score"; instructions: string; criteria: string[] };

const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });
const ChoiceAnswer = z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number(), probabilities: z.record(z.string(), z.number()) });
const ScoreAnswer = z.object({ type: z.literal("score"), score: z.number(), confidence: z.number(), legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), z.number()) });
export const JevAnswer = z.discriminatedUnion("type", [NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type JevAnswer = z.infer<typeof JevAnswer>;

const JevResponse = z.object({
    model: z.string(),
    answers: z.record(z.string(), JevAnswer),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

type AnswerFor<Q extends JevQuestion> = Q["type"] extends "noul" ? z.infer<typeof NoulAnswer> : Q["type"] extends "choice" ? z.infer<typeof ChoiceAnswer> : z.infer<typeof ScoreAnswer>;

export interface JevResult<Q extends Record<string, JevQuestion>> {
    model: string;
    answers: { [K in keyof Q]: AnswerFor<Q[K]> };
    inputTokens: number;
    costUsd: number;
    ms: number;
}

export const jevEnabled = (cfg: Config): boolean => Boolean(cfg.typesafeApiKey);

// One request. Throws when Jev is not configured, on a non-2xx status, a timeout, or a response that does not match
// the contract — callers keep their heuristic fallback in the catch. `usage` (db + context) records the call like a run.
export const jevAsk = async <Q extends Record<string, JevQuestion>>(
    cfg: Config,
    state: string | Record<string, unknown> | unknown[],
    questions: Q,
    usage?: { db: DB; ctx: Omit<UsageContext, "kind"> & { kind?: string } },
): Promise<JevResult<Q>> => {
    if (!cfg.typesafeApiKey) throw new Error("Jev is not configured — add it on the Integrations page");
    const started = Date.now();
    const res = await fetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.typesafeApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    if (!res.ok) throw new Error(`Jev ${res.status}: ${text.slice(0, 200)}`);
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error(`Jev returned non-JSON: ${text.slice(0, 120)}`);
    }
    const parsed = JevResponse.safeParse(raw);
    if (!parsed.success) throw new Error(`Jev response does not match the contract: ${parsed.error.message.slice(0, 200)}`);
    for (const id of Object.keys(questions)) {
        const a = parsed.data.answers[id];
        if (!a) throw new Error(`Jev answered without question "${id}"`);
        if (a.type !== questions[id]!.type) throw new Error(`Jev answered "${id}" as ${a.type}, asked ${questions[id]!.type}`);
    }
    const inputTokens = parsed.data.usage?.input_tokens ?? 0;
    const costUsd = (inputTokens / 1_000_000) * USD_PER_M_INPUT;
    if (usage) {
        recordExternalUsage(usage.db, { kind: "jev", ...usage.ctx }, { model: parsed.data.model, inputTokens, outputTokens: parsed.data.usage?.output_tokens ?? 0, costUsd, durationMs: ms });
    }
    return { model: parsed.data.model, answers: parsed.data.answers as JevResult<Q>["answers"], inputTokens, costUsd, ms };
};

// Settings "Test": one request with all three question types over a CI-failure-shaped state, so the credentials,
// the endpoint and the response contract are all exercised.
export const jevProbe = async (cfg: Config): Promise<{ ok: true; model: string; ms: number; inputTokens: number; summary: string } | { ok: false; error: string }> => {
    try {
        const r = await jevAsk(
            cfg,
            { check: "Tests (public-api-2)", log_tail: "FAILED tests/api/public/test_receipts.py::test_receipts_create_serials_matching_quantity - assert [] == ['SN-P1', 'SN-P2']" },
            {
                kind: {
                    type: "choice",
                    instructions: "What kind of CI failure is this",
                    criteria: {
                        regression: "A test assertion about product behavior fails deterministically",
                        flake: "Infrastructure: timeout, OOM or exit 137, network, a runner that died",
                        environment: "A missing dependency, migration, config or credential",
                    },
                },
                needs_code_change: { type: "noul", instructions: "An agent must change application or test code to make this check pass" },
                severity: { type: "score", instructions: "How much this failure blocks the merge", criteria: ["Cosmetic", "Minor", "Blocks the merge until fixed"] },
            },
        );
        const k = r.answers.kind;
        return {
            ok: true,
            model: r.model,
            ms: r.ms,
            inputTokens: r.inputTokens,
            summary: `kind=${k.choice} (${Math.round((k.probabilities[k.choice] ?? 0) * 100)}%) · needs code change ${Math.round(r.answers.needs_code_change.noul * 100)}% · severity ${r.answers.severity.score.toFixed(1)}/2`,
        };
    } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e) };
    }
};
