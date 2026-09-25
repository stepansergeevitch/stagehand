import type { QaPassResult } from "./stages/contracts.js";

// A runner that swaps a seeded record for another to get past a picker did not run the scenario as designed, so its
// "pass" is not one (INV-135 S1, 2026-09-25: the seeded customer was not selectable, "substituted A1A Car Wash",
// runner pass, Jev 24/100 with no reason shown). Such a scenario goes to the human as needs_human, the substitution named.
const SUBSTITUTION = /\b(substitut\w*|swapped (?:in|for|to)\b|used [^.;\n]{0,80}\binstead of\b|instead of the seeded\b|in place of the seeded\b|fell back to\b)/i;

const mentions = (text: string, id: string): boolean => new RegExp(`\\b${id}\\b`).test(text);

export const flagSubstitutions = (qa: QaPassResult): QaPassResult => ({
    ...qa,
    scenarios: qa.scenarios.map((s) => {
        if (s.outcome !== "pass") return s;
        const own = SUBSTITUTION.exec(s.observation ?? "");
        const blocker = own ? null : qa.blockers.find((b) => SUBSTITUTION.test(b) && (mentions(b, s.id) || qa.scenarios.length === 1));
        if (!own && !blocker) return s;
        const where = own ? `"${own[0]}" in its observation` : `blocker: ${blocker}`;
        return { ...s, outcome: "needs_human" as const, observation: `the runner substituted data (${where}) — a pass must use the seeded records; check it yourself. Runner: ${s.observation}` };
    }),
});

// The run itself failed to reach the model or GitHub, not the work: worth one more attempt before the task parks.
export const isNetworkError = (text: string): boolean => /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b|Can't reach the API server|Connection refused|fetch failed|socket hang up|network error/i.test(text);
