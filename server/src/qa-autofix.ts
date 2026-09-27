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
    ticket: string;
    contract: string;
    pass: "before" | "after";
    fixKind: FixKind;
    question: string;
    reason: string;
    observation: string;
    before: unknown;
    after: unknown;
}

// One Jev call per proposed correction. Throws when Jev is off or fails; the caller then leaves the question to the human.
export const jevQaFixVerdict = async (cfg: Config, db: DB, ctx: Omit<UsageContext, "kind">, input: QaFixInput): Promise<QaFixVerdict> => {
    if (!jevEnabled(cfg)) throw new Error("Jev is not configured");
    const r = await jevAsk(
        cfg,
        {
            ticket: input.ticket.slice(0, 4000),
            acceptance: input.contract.slice(0, 4000),
            pass: input.pass === "before" ? "baseline, before the change is implemented" : "after the change is implemented",
            correction: { kind: input.fixKind, question: input.question, runnerReason: input.reason.slice(0, 1500), triggeringObservation: input.observation.slice(0, 1500) },
            scenarioBefore: input.before,
            scenarioAfter: input.after,
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
            weakens: {
                type: "noul",
                instructions: "The corrected scenario would pass in a state where the original would fail, or asserts less than the acceptance criterion requires",
                criteria: {
                    true: "An assert lost a value or condition, a step that verified something was dropped or neutralised, a seed now creates the state the assert expects instead of letting the app produce it, or the expected value moved to what the app currently shows",
                    false: "Every assert still requires what the acceptance criterion requires; the seed only sets up preconditions; nothing the original proved is lost",
                },
            },
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
