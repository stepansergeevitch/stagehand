import { describe, expect, it } from "vitest";
import { permissionProblem } from "./runner.js";

describe("permissionProblem", () => {
    it("flags an init event in default or plan mode, not auto or bypass", () => {
        expect(permissionProblem({ type: "system", subtype: "init", permissionMode: "default", model: null })).toBe('the CLI started in "default" permission mode instead of auto');
        expect(permissionProblem({ type: "system", subtype: "init", permissionMode: "plan" })).toMatch(/"plan"/);
        expect(permissionProblem({ type: "system", subtype: "init", permissionMode: "auto" })).toBeNull();
        expect(permissionProblem({ type: "system", subtype: "init", permissionMode: "bypassPermissions" })).toBeNull();
        // An older CLI says nothing about the mode: no verdict from init.
        expect(permissionProblem({ type: "system", subtype: "init" })).toBeNull();
    });

    it("flags a refused tool call from its result, string or block content", () => {
        const refusal = "Claude requested permissions to write to /x/definitions.py, but you haven't granted it yet.";
        expect(permissionProblem({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: refusal }] } })).toBe(`a tool call was refused: ${refusal}`);
        expect(permissionProblem({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `${refusal}\nmore` }] }] } })).toBe(`a tool call was refused: ${refusal}`);
    });

    it("ignores ordinary results, classifier notes and other events", () => {
        expect(permissionProblem({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1\timport x" }] } })).toBeNull();
        expect(permissionProblem({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "This Bash command contains multiple operations. The following part requires approval: rm -rf" }] } })).toBeNull();
        expect(permissionProblem({ type: "assistant", message: { content: [{ type: "text", text: "Claude requested permissions to write" }] } })).toBeNull();
        expect(permissionProblem({ type: "rate_limit_event" })).toBeNull();
    });
});
