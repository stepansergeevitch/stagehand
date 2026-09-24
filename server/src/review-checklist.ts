// The Code Review stage's checklist, configurable per environment (envs.review_checklist, JSON): which of gstack's
// built-in categories the reviewer runs, extra points the team adds, and extra "do not flag" rules. Null = gstack's
// full checklist as is. The engine renders the result into the code-review prompt ({{reviewCategories}}).
import type { EnvRow } from "./db.js";

export type ReviewPass = "critical" | "informational";

export interface ReviewCategoryDef {
    key: string;
    title: string;
    pass: ReviewPass;
    // One line: what the category looks for (the UI hint, and the prompt's fallback when the checklist file is absent).
    detail: string;
}

// A point added by the team, in the same shape; `key` is stable across edits (the UI keeps it), `title` is the
// finding category the reviewer reports.
export interface ReviewPoint {
    key: string;
    title: string;
    pass: ReviewPass;
    detail: string;
}

export interface ReviewChecklist {
    // Keys of built-in categories switched off for this environment.
    disabled: string[];
    custom: ReviewPoint[];
    // One rule per entry, appended to the checklist's own "DO NOT flag" list.
    doNotFlag: string[];
}

// gstack's review/checklist.md categories (v1.88), in checklist order. Keys are stable identifiers stored in the DB;
// titles match the checklist's headings so the reviewer finds the section.
export const REVIEW_CATEGORIES: ReviewCategoryDef[] = [
    { key: "sql_data_safety", title: "SQL & Data Safety", pass: "critical", detail: "String interpolation in SQL, check-then-set races that should be one atomic UPDATE, writes that bypass model validation, N+1 queries in loops." },
    { key: "race_conditions", title: "Race Conditions & Concurrency", pass: "critical", detail: "Read-check-write without a unique constraint, find-or-create without a unique index, non-atomic status transitions, unsafe HTML rendering of user data (XSS)." },
    { key: "llm_trust_boundary", title: "LLM Output Trust Boundary", pass: "critical", detail: "Model-generated values persisted or mailed without validation, tool output accepted without shape checks, model-generated URLs fetched without an allowlist (SSRF), unsanitised output stored for later prompts." },
    { key: "shell_injection", title: "Shell Injection", pass: "critical", detail: "subprocess with shell=True plus interpolated strings, os.system with variables, eval/exec on generated code." },
    { key: "enum_completeness", title: "Enum & Value Completeness", pass: "critical", detail: "A new enum value, status, tier or type constant traced through every consumer, allowlist and case chain — requires reading code outside the diff." },
    { key: "async_sync", title: "Async/Sync Mixing", pass: "informational", detail: "Blocking calls (subprocess, open, requests, time.sleep, sync DB) inside async code." },
    { key: "column_field_names", title: "Column/Field Name Safety", pass: "informational", detail: "Column names in ORM queries and result reads checked against the real schema; a wrong name silently returns nothing." },
    { key: "dead_code", title: "Dead Code & Consistency", pass: "informational", detail: "Version or changelog mismatches with the change itself." },
    { key: "llm_prompt_issues", title: "LLM Prompt Issues", pass: "informational", detail: "0-indexed lists in prompts, prompts naming tools that are not wired up, limits stated in several places that can drift." },
    { key: "completeness_gaps", title: "Completeness Gaps", pass: "informational", detail: "Shortcut implementations where the complete version is cheap: partial enum handling, incomplete error paths, missing negative-path tests, 80–90 % features." },
    { key: "time_window_safety", title: "Time Window Safety", pass: "informational", detail: "Date-key lookups that assume 'today' covers 24 h, related features that use different time buckets for the same data." },
    { key: "type_coercion", title: "Type Coercion at Boundaries", pass: "informational", detail: "Values that change type across serialisation boundaries (numeric vs string), hash or digest inputs not normalised." },
    { key: "view_frontend", title: "View/Frontend", pass: "informational", detail: "Inline style blocks re-parsed on every render, O(n·m) lookups in views, filtering in code that belongs in a WHERE clause." },
    { key: "distribution_ci", title: "Distribution & CI/CD Pipeline", pass: "informational", detail: "Workflow changes: tool versions, artifact paths, secrets handling, cross-platform matrix, tag format, publish idempotency. The checklist says not to flag auto-deployed web services or test-only CI changes." },
];

const PASSES: ReviewPass[] = ["critical", "informational"];
export const POINT_KEY = /^[a-z][a-z0-9_-]{0,40}$/;
export const slugKey = (title: string): string =>
    title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/^[^a-z]+/, "")
        .slice(0, 40) || "point";

const isPass = (v: unknown): v is ReviewPass => PASSES.includes(v as ReviewPass);

// Normalised view of the stored JSON; malformed or absent → the full default checklist.
export const reviewChecklistOf = (env: Pick<EnvRow, "review_checklist">): ReviewChecklist => {
    const empty: ReviewChecklist = { disabled: [], custom: [], doNotFlag: [] };
    if (!env.review_checklist) return empty;
    try {
        const v = JSON.parse(env.review_checklist) as Partial<ReviewChecklist> | null;
        if (!v || typeof v !== "object") return empty;
        const known = new Set(REVIEW_CATEGORIES.map((c) => c.key));
        const disabled = Array.isArray(v.disabled) ? v.disabled.filter((k): k is string => typeof k === "string" && known.has(k)) : [];
        const custom = Array.isArray(v.custom)
            ? v.custom
                  .filter((p): p is ReviewPoint => !!p && typeof p === "object" && typeof (p as ReviewPoint).title === "string" && (p as ReviewPoint).title.trim() !== "")
                  .map((p) => ({
                      key: typeof p.key === "string" && POINT_KEY.test(p.key) ? p.key : slugKey(p.title),
                      title: p.title.trim(),
                      pass: isPass(p.pass) ? p.pass : "informational",
                      detail: typeof p.detail === "string" ? p.detail.trim() : "",
                  }))
            : [];
        const doNotFlag = Array.isArray(v.doNotFlag) ? v.doNotFlag.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];
        return { disabled: [...new Set(disabled)], custom, doNotFlag };
    } catch {
        return empty;
    }
};

// What gets stored: null when the checklist is the default (nothing off, nothing added), else compact JSON.
export const reviewChecklistJson = (input: ReviewChecklist | null | undefined): string | null => {
    if (!input) return null;
    const norm = reviewChecklistOf({ review_checklist: JSON.stringify(input) });
    if (!norm.disabled.length && !norm.custom.length && !norm.doNotFlag.length) return null;
    return JSON.stringify(norm);
};

// The categories the reviewer runs for this env, per pass, built-ins first (in checklist order) then custom points.
export const activeCategories = (env: Pick<EnvRow, "review_checklist">): { critical: Array<ReviewCategoryDef | ReviewPoint>; informational: Array<ReviewCategoryDef | ReviewPoint>; disabled: ReviewCategoryDef[]; custom: ReviewPoint[]; doNotFlag: string[] } => {
    const cl = reviewChecklistOf(env);
    const off = new Set(cl.disabled);
    const on = REVIEW_CATEGORIES.filter((c) => !off.has(c.key));
    const all = [...on, ...cl.custom];
    return {
        critical: all.filter((c) => c.pass === "critical"),
        informational: all.filter((c) => c.pass === "informational"),
        disabled: REVIEW_CATEGORIES.filter((c) => off.has(c.key)),
        custom: cl.custom,
        doNotFlag: cl.doNotFlag,
    };
};

// The prompt text for {{reviewCategories}}: the two passes with the categories this env runs, the built-ins it
// skips (so the reviewer does not apply them from the checklist file anyway), the added points in full, and the
// extra do-not-flag rules. `checklistInstalled` decides whether the built-ins are described by name only (the
// reviewer reads the file) or with their one-line detail.
export const describeReviewChecklist = (env: Pick<EnvRow, "review_checklist">, checklistInstalled: boolean): string => {
    const a = activeCategories(env);
    const customKeys = new Set(a.custom.map((p) => p.key));
    const name = (c: ReviewCategoryDef | ReviewPoint): string => (customKeys.has(c.key) ? `${c.title} (added for this environment, below)` : c.title);
    const passLine = (label: string, list: Array<ReviewCategoryDef | ReviewPoint>): string =>
        list.length ? `**${label}:** ${list.map(name).join(", ")}.` : `**${label}:** no categories for this environment — skip this pass.`;
    const out: string[] = [];
    out.push(`Two passes. ${passLine("Pass 1, CRITICAL", a.critical)} ${passLine("Pass 2, INFORMATIONAL", a.informational)}`);
    if (!checklistInstalled) {
        const builtins = [...a.critical, ...a.informational].filter((c) => !customKeys.has(c.key));
        if (builtins.length) out.push(`The built-in categories in short:\n${builtins.map((c) => `- **${c.title}** — ${c.detail}`).join("\n")}`);
    }
    if (a.disabled.length) out.push(`**Switched off for this environment — do not apply these sections of the checklist and report nothing under them:** ${a.disabled.map((c) => c.title).join(", ")}.`);
    if (a.custom.length) {
        out.push(
            `**Points added for this environment** (apply them with the same rigour as the checklist's own: quote the motivating line, confidence 1–10, fix-first where mechanical; report them under the category name given):\n` +
                a.custom.map((p) => `- **${p.title}** (${p.pass === "critical" ? "Pass 1, CRITICAL" : "Pass 2, INFORMATIONAL"})${p.detail ? ` — ${p.detail}` : ""}`).join("\n"),
        );
    }
    out.push(
        `Respect the checklist's "DO NOT flag" list.${a.doNotFlag.length ? ` **Also do not flag, for this environment:**\n${a.doNotFlag.map((s) => `- ${s}`).join("\n")}` : ""}`,
    );
    if (!a.disabled.some((c) => c.key === "enum_completeness")) {
        out.push(`**Enum & Value Completeness requires reading code outside the diff:** when the diff adds an enum value, status, tier or type constant, grep for the places that handle sibling values and read them.`);
    }
    return out.join("\n\n");
};
