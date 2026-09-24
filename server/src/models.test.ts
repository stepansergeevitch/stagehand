import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS, modelOptions, type ApiModel } from "./claude/models.js";

const list: ApiModel[] = [
    { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z" },
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T16:24:00Z" },
    { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-15T00:00:00Z" },
    { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-06-29T00:00:00Z" },
];

describe("modelOptions", () => {
    it("starts with the account default, then one alias per family labelled with its newest model, then every model newest first", () => {
        expect(modelOptions(list)).toEqual([
            { value: "", label: "Account default" },
            { value: "opus", label: "Latest Opus · Opus 5.5 (opus)" },
            { value: "sonnet", label: "Latest Sonnet · Sonnet 5 (sonnet)" },
            { value: "haiku", label: "Latest Haiku · Haiku 4.5 (haiku)" },
            { value: "claude-opus-5-5", label: "Opus 5.5 (claude-opus-5-5)" },
            { value: "claude-opus-5", label: "Opus 5 (claude-opus-5)" },
            { value: "claude-sonnet-5", label: "Sonnet 5 (claude-sonnet-5)" },
            { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (claude-haiku-4-5-20251001)" },
        ]);
    });

    it("skips the alias of a family without a model", () => {
        expect(modelOptions(list).some((o) => o.value === "fable")).toBe(false);
    });

    it("keeps the three original aliases available from the fallback list", () => {
        const values = modelOptions(FALLBACK_MODELS).map((o) => o.value);
        expect(values).toEqual(expect.arrayContaining(["", "fable", "opus", "sonnet"]));
    });
});
