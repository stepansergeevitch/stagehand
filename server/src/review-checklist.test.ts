import { describe, expect, it } from "vitest";
import { activeCategories, describeReviewChecklist, REVIEW_CATEGORIES, reviewChecklistJson, reviewChecklistOf, slugKey } from "./review-checklist.js";

describe("reviewChecklistOf", () => {
    it("null and garbage give the full default checklist", () => {
        expect(reviewChecklistOf({ review_checklist: null })).toEqual({ disabled: [], custom: [], doNotFlag: [] });
        expect(reviewChecklistOf({ review_checklist: "not json" })).toEqual({ disabled: [], custom: [], doNotFlag: [] });
        expect(reviewChecklistOf({ review_checklist: "[1,2]" })).toEqual({ disabled: [], custom: [], doNotFlag: [] });
    });

    it("drops unknown disabled keys, fills custom defaults, trims do-not-flag rules", () => {
        const raw = JSON.stringify({
            disabled: ["view_frontend", "nope", "view_frontend"],
            custom: [{ title: "  UoW only  ", detail: " never db= " }, { key: "bad key!", title: "Ports", pass: "critical" }, { title: "" }, null],
            doNotFlag: [" a ", "", 3],
        });
        expect(reviewChecklistOf({ review_checklist: raw })).toEqual({
            disabled: ["view_frontend"],
            custom: [
                { key: "uow_only", title: "UoW only", pass: "informational", detail: "never db=" },
                { key: "ports", title: "Ports", pass: "critical", detail: "" },
            ],
            doNotFlag: ["a"],
        });
    });
});

describe("reviewChecklistJson", () => {
    it("stores null for the default and compact JSON otherwise", () => {
        expect(reviewChecklistJson(null)).toBeNull();
        expect(reviewChecklistJson({ disabled: [], custom: [], doNotFlag: [] })).toBeNull();
        expect(reviewChecklistJson({ disabled: ["unknown"], custom: [], doNotFlag: [""] })).toBeNull();
        const json = reviewChecklistJson({ disabled: ["dead_code"], custom: [], doNotFlag: [] });
        expect(json).toBe(JSON.stringify({ disabled: ["dead_code"], custom: [], doNotFlag: [] }));
    });
});

describe("activeCategories", () => {
    it("keeps checklist order, appends custom points to their pass", () => {
        const env = { review_checklist: JSON.stringify({ disabled: ["shell_injection"], custom: [{ key: "uow", title: "UnitOfWork", pass: "critical", detail: "x" }], doNotFlag: [] }) };
        const a = activeCategories(env);
        expect(a.critical.map((c) => c.key)).toEqual(["sql_data_safety", "race_conditions", "llm_trust_boundary", "enum_completeness", "uow"]);
        expect(a.informational.length).toBe(REVIEW_CATEGORIES.filter((c) => c.pass === "informational").length);
        expect(a.disabled.map((c) => c.key)).toEqual(["shell_injection"]);
    });
});

describe("describeReviewChecklist", () => {
    it("default env: both passes list every built-in, enum note present, no env additions", () => {
        const text = describeReviewChecklist({ review_checklist: null }, true);
        expect(text).toContain("**Pass 1, CRITICAL:** SQL & Data Safety, Race Conditions & Concurrency, LLM Output Trust Boundary, Shell Injection, Enum & Value Completeness.");
        expect(text).toContain("**Pass 2, INFORMATIONAL:** Async/Sync Mixing,");
        expect(text).toContain("Enum & Value Completeness requires reading code outside the diff");
        expect(text).not.toContain("Switched off");
        expect(text).not.toContain("Points added");
        expect(text).not.toContain("Also do not flag");
        expect(text).not.toContain("built-in categories in short");
    });

    it("configured env: names the skipped sections, the added points with their pass, and extra do-not-flag rules", () => {
        const env = {
            review_checklist: JSON.stringify({
                disabled: ["enum_completeness", "distribution_ci"],
                custom: [{ key: "uow", title: "UnitOfWork usage", pass: "critical", detail: "Repositories and services take uow=, never db=." }],
                doNotFlag: ["Missing docstrings"],
            }),
        };
        const text = describeReviewChecklist(env, true);
        expect(text).toContain("Enum & Value Completeness");
        expect(text).toContain("**Switched off for this environment — do not apply these sections of the checklist and report nothing under them:** Enum & Value Completeness, Distribution & CI/CD Pipeline.");
        expect(text).not.toContain("requires reading code outside the diff");
        expect(text).toContain("UnitOfWork usage (added for this environment, below)");
        expect(text).toContain("- **UnitOfWork usage** (Pass 1, CRITICAL) — Repositories and services take uow=, never db=.");
        expect(text).toContain("**Also do not flag, for this environment:**\n- Missing docstrings");
    });

    it("a pass with nothing left says so; without the checklist file the built-ins get their one-liners", () => {
        const env = { review_checklist: JSON.stringify({ disabled: REVIEW_CATEGORIES.filter((c) => c.pass === "critical").map((c) => c.key), custom: [], doNotFlag: [] }) };
        const text = describeReviewChecklist(env, false);
        expect(text).toContain("**Pass 1, CRITICAL:** no categories for this environment — skip this pass.");
        expect(text).toContain("The built-in categories in short:\n- **Async/Sync Mixing** —");
    });
});

describe("slugKey", () => {
    it("makes a stable key from a title", () => {
        expect(slugKey("UnitOfWork usage!")).toBe("unitofwork_usage");
        expect(slugKey("123")).toBe("point");
    });
});
