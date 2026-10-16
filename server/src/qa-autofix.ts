import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { jevAsk, jevEnabled } from "./jev.js";
import type { UsageContext } from "./usage.js";
import type { FixKind } from "./qa-fixes.js";

// Who may approve a QA runner's proposed correction without the human (per environment, envs.qa_auto_fix):
//   off              — every correction waits for the human (the behaviour before 2026-09-27)
//   seeds            — seed and teardown commands
//   seeds+steps      — plus a step's action (route, control, selector); the assert stays
//   seeds+steps+asserts — plus assert text and whole-scenario rewrites
// A removal of a step or a scenario never qualifies. Jev judges each correction against the ticket's acceptance
// criteria; the deterministic guard in qa-fixes.ts runs first and cannot be argued with.
export type QaAutoFixScope = "off" | "seeds" | "seeds+steps" | "seeds+steps+asserts";
export const QA_AUTO_FIX_SCOPES: readonly QaAutoFixScope[] = ["off", "seeds", "seeds+steps", "seeds+steps+asserts"];
export const DEFAULT_QA_AUTO_FIX: QaAutoFixScope = "seeds+steps";

export const autoFixKinds = (scope: QaAutoFixScope | string | null | undefined): Set<FixKind> => {
    switch (scope) {
        case "seeds":
            return new Set<FixKind>(["seed", "teardown"]);
        case "seeds+steps":
            return new Set<FixKind>(["seed", "teardown", "step"]);
        case "seeds+steps+asserts":
            return new Set<FixKind>(["seed", "teardown", "step", "assert", "scenario"]);
        default:
            return new Set<FixKind>();
    }
};

export const QA_FIX_POLICY = { legitMin: 0.85, weakensMax: 0.15 } as const;

export type JevFixKind = "seed_fix" | "step_mechanics" | "assert_semantics" | "scope_cut" | "other";

export interface QaFixVerdict {
    legit: number;
    weakens: number;
    kind: JevFixKind;
}

const expectedJevKind: Record<FixKind, JevFixKind> = { seed: "seed_fix", teardown: "seed_fix", step: "step_mechanics", assert: "assert_semantics", scenario: "assert_semantics" };

// The policy, pure: approve when the scope allows the kind, Jev's reading of the change agrees with what the runner
// called it, the change is legitimate enough and weakens the scenario little enough.
export const decideQaFix = (v: QaFixVerdict, fixKind: FixKind, scope: QaAutoFixScope | string | null | undefined): { approve: boolean; why: string } => {
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const stats = `legit ${pct(v.legit)}, weakens ${pct(v.weakens)}, read as ${v.kind}`;
    if (!autoFixKinds(scope).has(fixKind)) return { approve: false, why: `${fixKind} corrections are for the human in this environment (${stats})` };
    if (v.kind === "scope_cut") return { approve: false, why: `Jev reads it as a scope cut (${stats})` };
    if (v.kind !== expectedJevKind[fixKind] && !(fixKind === "scenario" && v.kind === "step_mechanics")) return { approve: false, why: `Jev reads the change as ${v.kind}, not a ${fixKind} correction (${stats})` };
    if (v.legit < QA_FIX_POLICY.legitMin) return { approve: false, why: `not clearly legitimate (${stats})` };
    if (v.weakens > QA_FIX_POLICY.weakensMax) return { approve: false, why: `it may weaken the scenario (${stats})` };
    return { approve: true, why: stats };
};

export interface QaFixInput {
    // The ticket's acceptance criteria (its description when none are listed) and the whole design.md: what the change must do and how.
    acceptanceCriteria: string;
    design: string;
    pass: "before" | "after";
    fixKind: FixKind;
    question: string;
    reason: string;
    observation: string;
    before: unknown;
    after: unknown;
}

// One Jev call per proposed correction. Throws when Jev is off or fails; the caller then leaves the question to the human.
// A seed or teardown correction, as Jev reads it: the setup lines that changed and the asserts they must not satisfy.
// The deterministic guard already proves the steps and asserts are untouched, so the one way such a fix weakens the
// scenario is a seed that writes the result an assert checks.
const setupDiff = (before: unknown, after: unknown, kind: "seed" | "teardown"): { changed: Array<{ line: number; before: string | null; after: string | null }>; asserts: string[] } => {
    const list = (x: unknown): string[] => ((x as Record<string, unknown> | null)?.[kind] as string[] | undefined) ?? [];
    const b = list(before);
    const a = list(after);
    const changed: Array<{ line: number; before: string | null; after: string | null }> = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push({ line: i + 1, before: b[i] ?? null, after: a[i] ?? null });
    const steps = ((after as Record<string, unknown> | null)?.["steps"] as Array<{ action?: string; assert?: string }> | undefined) ?? [];
    return { changed, asserts: steps.map((st, i) => `step ${i + 1}: ${st.action ?? ""} → assert: ${st.assert ?? ""}`) };
};

export const jevQaFixVerdict = async (cfg: Config, db: DB, ctx: Omit<UsageContext, "kind">, input: QaFixInput): Promise<QaFixVerdict> => {
    if (!jevEnabled(cfg)) throw new Error("Jev is not configured");
    const setup = input.fixKind === "seed" || input.fixKind === "teardown";
    // The generic weakens criteria counted any seed that creates data as "creates the state the assert expects": every
    // seed fix scored 50–65 % and none passed the 15 % gate (PRODUCT-10587, INV-151, INV-149, 2026-09-29/30). For setup
    // fixes Jev gets the changed lines and the asserts, and a question about exactly that one risk.
    const weakens = setup
        ? {
              type: "noul" as const,
              instructions: "The corrected setup writes the result that an assert checks, so the scenario no longer tests that the app produces it",
              criteria: {
                  true: "A changed seed line inserts or updates the very record, value or state an assert's expected result names as the outcome of the journey's steps (e.g. the assert expects a status the seed now sets directly, or a total the seed writes)",
                  false: "The changed lines only create or reset preconditions the steps start from — records, relations, settings, ids, files, credentials — and every asserted result still has to come from the app during the steps",
              },
          }
        : {
              type: "noul" as const,
              instructions: "The corrected scenario would pass in a state where the original would fail, or asserts less than the acceptance criterion requires",
              criteria: {
                  true: "An assert lost a value or condition, a step that verified something was dropped or neutralised, a seed now creates the state the assert expects instead of letting the app produce it, or the expected value moved to what the app currently shows",
                  false: "Every assert still requires what the acceptance criterion requires; the seed only sets up preconditions; nothing the original proved is lost",
              },
          };
    const r = await jevAsk(
        cfg,
        {
            ticketAcceptanceCriteria: input.acceptanceCriteria.slice(0, 4000),
            design: input.design.slice(0, 16000),
            pass: input.pass === "before" ? "baseline, before the change is implemented" : "after the change is implemented",
            correction: { kind: input.fixKind, question: input.question, runnerReason: input.reason.slice(0, 1500), triggeringObservation: input.observation.slice(0, 1500) },
            ...(setup ? { setupChange: setupDiff(input.before, input.after, input.fixKind as "seed" | "teardown") } : { scenarioBefore: input.before, scenarioAfter: input.after }),
        },
        {
            legit: {
                type: "noul",
                instructions: "The correction fixes how the scenario is exercised without changing what it proves",
                criteria: {
                    true: "The corrected seed, teardown, step or assert exercises the same journey and checks the same acceptance criterion; the change is a path, field, id, selector, wording or data-setup fix a careful engineer would make",
                    false: "The correction changes which behaviour is checked, expects a different result than the acceptance criterion states, or is unrelated to what made the original fail",
                },
            },
            weakens,
            kind: {
                type: "choice",
                instructions: "What the correction really is",
                criteria: {
                    seed_fix: "A seed or teardown command fix: path, host, field, id, import, deletion order, collision with leftover data",
                    step_mechanics: "A step action fix: route, control name, selector, input sequence; the assert is unchanged",
                    assert_semantics: "An assert or expected value changes, or the scenario is rewritten",
                    scope_cut: "A step, an assert or a scenario is removed or neutralised",
                    other: "None of the above",
                },
            },
        },
        { db, ctx: { ...ctx, kind: "jev" } },
    );
    return { legit: r.answers.legit.noul, weakens: r.answers.weakens.noul, kind: r.answers.kind.choice as JevFixKind };
};
