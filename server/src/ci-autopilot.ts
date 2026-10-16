import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// CI autopilot (docs/ci-autopilot.md): when a PR's checks finish red, a read-only triage run names each failure and
// says whether it is the branch's own; Vortex verifies every "allow" against git and CI facts (this file), and only
// the verified failures go to a PR Fix round, an AI review of the fix, and a push.
//
//   own_migration  a migration conflict or failure, the migration added by the branch
//   own_test       a test the branch added or changed fails
//   affected_test  a test the branch did not touch fails, and it passes on base (CI green there, or a local base run)
//   own_lint       a lint error on a line the branch added or changed
//   custom         a failure an env rule allows (the triage's judgement — no mechanical check)
//   other          anything else — the human's
//
// Each env can switch built-in kinds off and add its own rules (envs.ci_autopilot_rules): an allow rule widens the
// list, a deny rule ("generated FE types of an unmerged backend change: leave red") wins over every kind.

export const BUILTIN_KINDS = [
    { key: "own_migration", title: "Migrations of this branch", detail: "a migration conflict, or a migration the branch added that fails to apply" },
    { key: "own_test", title: "Tests of this branch", detail: "a test the branch added or changed fails" },
    { key: "affected_test", title: "Tests this branch broke", detail: "a test the branch did not touch fails because of it, and passes on base (a query budget, a snapshot)" },
    { key: "own_lint", title: "Lint on this branch's lines", detail: "lint or format errors on lines the branch added or changed — not elsewhere in a touched file" },
] as const;
export type BuiltinKind = (typeof BUILTIN_KINDS)[number]["key"];
export interface AutopilotRule { key: string; title: string; verdict: "allow" | "deny"; detail: string }
export interface AutopilotRules { disabled: string[]; custom: AutopilotRule[] }
export const autopilotRulesOf = (json: string | null | undefined): AutopilotRules => {
    try {
        const v = json ? (JSON.parse(json) as Partial<AutopilotRules>) : null;
        return {
            disabled: Array.isArray(v?.disabled) ? v.disabled.filter((k): k is string => typeof k === "string") : [],
            custom: Array.isArray(v?.custom) ? v.custom.filter((r): r is AutopilotRule => !!r && typeof r.title === "string" && !!r.key).map((r) => ({ key: r.key, title: r.title, verdict: r.verdict === "allow" ? "allow" : "deny", detail: r.detail ?? "" })) : [],
        };
    } catch {
        return { disabled: [], custom: [] };
    }
};
// The list as the triage reads it.
export const describeRules = (rules: AutopilotRules): string => {
    const on = BUILTIN_KINDS.filter((k) => !rules.disabled.includes(k.key));
    const off = BUILTIN_KINDS.filter((k) => rules.disabled.includes(k.key));
    const allow = rules.custom.filter((r) => r.verdict === "allow");
    const deny = rules.custom.filter((r) => r.verdict === "deny");
    return [
        `Kinds the autopilot may fix here:\n${on.map((k) => `- **${k.key}** — ${k.detail}`).join("\n") || "- (none)"}`,
        off.length ? `Switched off in this environment (always \`other\`): ${off.map((k) => `\`${k.key}\``).join(", ")}.` : "",
        allow.length ? `This environment's own allow rules — kind \`custom\`, \`rule\` = the key:\n${allow.map((r) => `- \`${r.key}\` **${r.title}** — ${r.detail}`).join("\n")}` : "",
        deny.length ? `This environment's deny rules — they win over every kind: when one applies, set \`rule\` to its key and \`verdict\` to \`deny\`:\n${deny.map((r) => `- \`${r.key}\` **${r.title}** — ${r.detail}`).join("\n")}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");
};

export const TriageFailure = z.object({
    check: z.string(),
    kind: z.enum(["own_migration", "own_test", "affected_test", "own_lint", "custom", "other"]),
    // The key of the env rule that applies (custom allow, or a deny rule), else null.
    rule: z.string().nullable().default(null),
    what: z.string().default(""),
    // Test ids as the runner names them: `tests/test_items.py::TestList::test_budget`, `src/items.test.ts`.
    tests: z.array(z.string()).default([]),
    // `path:line` of each lint error; the path of each failing migration.
    locations: z.array(z.string()).default([]),
    evidence: z.string().default(""),
    verdict: z.enum(["allow", "deny"]),
    reason: z.string().default(""),
});
export const TriageResult = z.object({ summary: z.string().default(""), failures: z.array(TriageFailure) });
export type TriageFailure = z.infer<typeof TriageFailure>;
export type TriageResult = z.infer<typeof TriageResult>;

export interface VerifiedFailure extends TriageFailure {
    allowed: boolean;
    why: string;
    // For own_lint: only the locations on the branch's lines; for tests: the tests that qualified.
    keep: string[];
}

// ---------- git facts ----------

export type Ranges = Map<string, Array<[number, number]>>;

// The new-side line ranges each file's hunks add or change, from `git diff -U0 <base>..HEAD`.
export const changedRanges = (diff: string): Ranges => {
    const out: Ranges = new Map();
    let file: string | null = null;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+++ ")) {
            const p = line.slice(4).trim();
            file = p === "/dev/null" ? null : p.replace(/^b\//, "");
            if (file && !out.has(file)) out.set(file, []);
            continue;
        }
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (h && file) {
            const start = Number(h[1]);
            const count = h[2] === undefined ? 1 : Number(h[2]);
            if (count > 0) out.get(file)!.push([start, start + count - 1]);
        }
    }
    return out;
};

// Files the branch added, from `git diff --name-status <base>..HEAD`.
export const addedFiles = (nameStatus: string): Set<string> =>
    new Set(
        nameStatus
            .split("\n")
            .map((l) => l.split("\t"))
            .filter((p) => p[0]?.startsWith("A") && p[1])
            .map((p) => p[1]!),
    );

const inRanges = (ranges: Array<[number, number]> | undefined, a: number, b = a): boolean => !!ranges?.some(([s, e]) => a <= e && b >= s);

// A path from a CI log, as a repository-relative path: the longest suffix that names a file the repository knows
// (`/home/runner/work/app/app/src/x.py` → `src/x.py`).
export const repoPath = (raw: string, known: (p: string) => boolean): string | null => {
    const clean = raw.trim().replace(/^\.\//, "").replace(/^["'`]|["'`]$/g, "");
    const parts = clean.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        const p = parts.slice(i).join("/");
        if (known(p)) return p;
    }
    return null;
};

// `path:line[:col]` → its parts.
export const location = (loc: string): { path: string; line: number } | null => {
    const m = /^(.+?):(\d+)(?::\d+)?\b/.exec(loc.trim());
    return m ? { path: m[1]!, line: Number(m[2]) } : null;
};

// The lines of one test in its file: a Python `def test_x` (with its decorators and indented body), or a JS
// `it("…")` / `test("…")` block. 1-based, inclusive; null when the file has no such test.
export const testSpan = (source: string, name: string): [number, number] | null => {
    const lines = source.split("\n");
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const py = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+${esc}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
        const m = py.exec(lines[i]!);
        if (!m) continue;
        const indent = m[1]!.length;
        let start = i;
        while (start > 0 && /^\s*@/.test(lines[start - 1]!) && lines[start - 1]!.search(/\S/) === indent) start--;
        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j]!;
            if (!l.trim()) continue;
            if (l.search(/\S/) <= indent) break;
            end = j;
        }
        return [start + 1, end + 1];
    }
    const js = new RegExp(`\\b(?:it|test)(?:\\.\\w+)?\\(\\s*(['"\`])${esc}\\1`);
    for (let i = 0; i < lines.length; i++) {
        if (!js.test(lines[i]!)) continue;
        let depth = 0;
        let opened = false;
        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]!) {
                if (ch === "(" || ch === "{") { depth++; opened = true; }
                else if (ch === ")" || ch === "}") depth--;
            }
            if (opened && depth <= 0) return [i + 1, j + 1];
        }
        return [i + 1, lines.length];
    }
    return null;
};

// `tests/test_x.py::TestA::test_b[param]` → file and test name; a JS id is a file path (and maybe ` › name`).
export const testId = (id: string): { file: string; name: string | null } => {
    const [file, ...rest] = id.split("::");
    if (rest.length) return { file: file!.trim(), name: rest[rest.length - 1]!.replace(/\[.*\]$/, "").trim() };
    const js = id.split(/\s+›\s+|\s+>\s+/);
    return { file: js[0]!.trim(), name: js.length > 1 ? js[js.length - 1]!.trim() : null };
};

// ---------- verification ----------

export interface VerifyCtx {
    changed: Ranges;
    added: Set<string>;
    // Whether the path names a file of the repository at HEAD; its text.
    known: (path: string) => boolean;
    headFile: (path: string) => string | null;
    baseHasFile: (path: string) => Promise<boolean>;
    // The conclusion of the check of this name on the base commit.
    baseCheck: (check: string) => Promise<"success" | "failure" | "none">;
    // The named tests run on a checkout of the base: null when the env has no test command.
    localBase: (tests: string[]) => Promise<"pass" | "fail" | null>;
}

const deny = (f: TriageFailure, why: string): VerifiedFailure => ({ ...f, allowed: false, why, keep: [] });
const allow = (f: TriageFailure, why: string, keep: string[]): VerifiedFailure => ({ ...f, allowed: true, why, keep });

// Each "allow" of the triage, checked on git and CI facts and the env's rules. Anything not proven stays the human's.
export const verifyFailure = async (f: TriageFailure, ctx: VerifyCtx, rules: AutopilotRules = { disabled: [], custom: [] }): Promise<VerifiedFailure> => {
    const rule = f.rule ? rules.custom.find((r) => r.key === f.rule) : undefined;
    if (rule?.verdict === "deny") return deny(f, `env rule "${rule.title}"`);
    if (f.verdict !== "allow" || f.kind === "other") return deny(f, f.reason || "not on the autopilot's list");
    if (f.kind === "custom") {
        if (rule?.verdict !== "allow") return deny(f, "no allow rule of this environment matches");
        return allow(f, `env rule "${rule.title}" (the triage's judgement)`, [...f.tests, ...f.locations]);
    }
    if (rules.disabled.includes(f.kind)) return deny(f, `"${f.kind.replace(/_/g, " ")}" is switched off for this environment`);
    if (f.kind === "own_lint") {
        const locs = f.locations.map((l) => ({ raw: l, loc: location(l) })).filter((x) => x.loc);
        if (!locs.length) return deny(f, "the triage named no file:line for the lint errors");
        const mine = locs.filter((x) => {
            const p = repoPath(x.loc!.path, ctx.known);
            return p && inRanges(ctx.changed.get(p), x.loc!.line);
        });
        if (!mine.length) return deny(f, "no reported lint error is on a line this branch added or changed");
        return allow(f, `${mine.length} of ${locs.length} lint error(s) are on this branch's lines${mine.length < locs.length ? " — the others stay" : ""}`, mine.map((x) => x.raw));
    }
    if (f.kind === "own_migration") {
        const files = f.locations.map((l) => repoPath(l.replace(/:\d+.*$/, ""), (p) => ctx.known(p) || ctx.added.has(p))).filter((p): p is string => !!p);
        const mine = files.filter((p) => ctx.added.has(p));
        if (!mine.length) return deny(f, files.length ? "the failing migration was not added by this branch" : "the triage named no migration file");
        return allow(f, `migration added by this branch: ${mine.join(", ")}`, mine);
    }
    // own_test and affected_test: each test qualifies on its own.
    if (!f.tests.length) return deny(f, "the triage named no failing test");
    const own: string[] = [];
    const affected: string[] = [];
    for (const id of f.tests) {
        const t = testId(id);
        const file = repoPath(t.file, ctx.known) ?? t.file;
        if (ctx.added.has(file)) { own.push(id); continue; }
        const src = ctx.changed.has(file) ? ctx.headFile(file) : null;
        const span = src && t.name ? testSpan(src, t.name) : null;
        if (span && inRanges(ctx.changed.get(file), span[0], span[1])) { own.push(id); continue; }
        affected.push(id);
    }
    const proven = [...own];
    let why = own.length ? `${own.length} test(s) added or changed by this branch` : "";
    if (affected.length) {
        const atBase = (await Promise.all(affected.map(async (id) => ((await ctx.baseHasFile(repoPath(testId(id).file, ctx.known) ?? testId(id).file)) ? id : null))))
            .filter((x): x is string => !!x);
        if (atBase.length) {
            const ci = await ctx.baseCheck(f.check);
            if (ci === "success") {
                proven.push(...atBase);
                why = [why, `${atBase.length} untouched test(s): "${f.check}" is green on the base commit`].filter(Boolean).join("; ");
            } else {
                const local = await ctx.localBase(atBase);
                if (local === "pass") {
                    proven.push(...atBase);
                    why = [why, `${atBase.length} untouched test(s) pass on a base checkout`].filter(Boolean).join("; ");
                } else if (!proven.length) {
                    return deny(f, local === "fail" ? "the untouched test(s) fail on base too" : ci === "failure" ? `"${f.check}" fails on base too, and the env has no test command to run the tests alone` : `no CI run of "${f.check}" on the base commit, and the env has no test command to run them there`);
                }
            }
        } else if (!proven.length) return deny(f, "the failing tests do not exist on base and the branch did not add them");
    }
    if (!proven.length) return deny(f, "no failing test is the branch's own or proven to pass on base");
    return allow(f, why, proven);
};

// The key of a failure, to tell "the same failure came back".
export const failureKey = (f: Pick<TriageFailure, "check" | "kind" | "tests" | "locations" | "what">): string => `${f.check}|${f.kind}|${[...f.tests, ...f.locations].sort().join(",") || f.what}`;

// ---------- state (<taskDir>/ci-autopilot.json) ----------

export type AutopilotPhase = "triage" | "fixing" | "reviewing" | "addressing" | "pushing" | "pushed" | "denied" | "failed" | "stopped";
export const AutopilotReview = z.object({
    summary: z.string().default(""),
    findings: z.array(z.object({ severity: z.string(), confidence: z.number(), file: z.string().default(""), line: z.number().nullable().optional(), title: z.string(), detail: z.string().default("") })).default([]),
});
export type AutopilotReview = z.infer<typeof AutopilotReview>;
export type AutopilotFinding = AutopilotReview["findings"][number];
export interface AutopilotRound {
    id: string;
    repo: string;
    prNumber: number;
    headSha: string;
    at: string;
    phase: AutopilotPhase;
    triage?: TriageResult;
    verified?: VerifiedFailure[];
    // Each repository's HEAD before the fix: the review reads <fixFrom>..HEAD.
    fixFrom?: Record<string, string>;
    review?: { summary: string; findings: AutopilotFinding[] };
    pushed?: Record<string, string>;
    error?: string;
    endedAt?: string;
}
export interface AutopilotState {
    rounds: AutopilotRound[];
    // Rounds that fixed and pushed since the human last acted on the task.
    consecutive: number;
    // Why the autopilot stopped for this task (until the human acts).
    stopped: string | null;
}
export const MAX_AUTOPILOT_ROUNDS = 5;

export const readAutopilot = (taskDir: string): AutopilotState => {
    const p = join(taskDir, "ci-autopilot.json");
    if (!existsSync(p)) return { rounds: [], consecutive: 0, stopped: null };
    try {
        const s = JSON.parse(readFileSync(p, "utf8")) as Partial<AutopilotState>;
        return { rounds: s.rounds ?? [], consecutive: s.consecutive ?? 0, stopped: s.stopped ?? null };
    } catch {
        return { rounds: [], consecutive: 0, stopped: null };
    }
};
export const writeAutopilot = (taskDir: string, s: AutopilotState): void => writeFileSync(join(taskDir, "ci-autopilot.json"), JSON.stringify(s, null, 2));
export const activeRound = (s: AutopilotState): AutopilotRound | undefined => s.rounds.find((r) => ["triage", "fixing", "reviewing", "addressing", "pushing"].includes(r.phase));

// The PR Fix brief for the verified failures, with the others named as not to touch.
export const fixBrief = (prNumber: number, verified: VerifiedFailure[], rules: AutopilotRules = { disabled: [], custom: [] }): string => {
    const denyRules = rules.custom.filter((r) => r.verdict === "deny");
    const ok = verified.filter((v) => v.allowed);
    const no = verified.filter((v) => !v.allowed);
    const item = (v: VerifiedFailure): string =>
        [
            `- **${v.check}** — ${v.kind.replace(/_/g, " ")}: ${v.what}`,
            v.keep.length ? `  ${v.kind === "own_lint" ? "Errors to fix (only these lines)" : v.kind === "own_migration" ? "Migration" : "Tests"}: ${v.keep.map((k) => `\`${k}\``).join(", ")}` : "",
            v.evidence ? `  Log: ${v.evidence.replace(/\n+/g, " ").slice(0, 600)}` : "",
            `  Why it is yours: ${v.why}`,
        ]
            .filter(Boolean)
            .join("\n");
    return [
        `CI autopilot — PR #${prNumber}: fix ONLY these failures; this branch caused them (verified against the diff and the base):`,
        ok.map(item).join("\n"),
        no.length ? `Do NOT touch these — they are not this branch's to fix here:\n${no.map((v) => `- ${v.check}: ${v.what} (${v.why})`).join("\n")}` : "",
        denyRules.length ? `This environment never lets the autopilot fix:\n${denyRules.map((r) => `- **${r.title}** — ${r.detail}`).join("\n")}` : "",
        `Rules: change only what these failures need — no refactor, no other file. Never weaken, skip or delete a test or an assertion, never disable a lint rule or add an ignore comment, never edit a migration the base already has. A query-budget or snapshot test that fails because this branch does more work: make the code do less when that is right, else update the budget or snapshot and say why in the summary. Read the logs with \`gh pr checks ${prNumber}\` and \`gh run view --log-failed <run-id>\`.`,
    ]
        .filter(Boolean)
        .join("\n\n");
};
