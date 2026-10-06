import { describe, expect, it } from "vitest";
import { classifierDenials, toolCalls } from "./runner.js";

describe("classifierDenials", () => {
    it("finds the classifier's reason and the denied tool call's id", () => {
        const ev = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Git Destructive]. If you have other tasks…" }] } };
        expect(classifierDenials(ev)).toEqual([{ toolUseId: "t1", reason: "Git Destructive" }]);
        expect(classifierDenials({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } })).toEqual([]);
    });
    it("describes the tool calls of an assistant event", () => {
        const ev = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git cherry-pick  abc\\n" } }, { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/a.ts" } }] } };
        expect(toolCalls(ev)).toEqual([{ id: "t1", what: "git cherry-pick abc\\n" }, { id: "t2", what: "Edit /a.ts" }]);
    });
});
