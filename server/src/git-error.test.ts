import { describe, expect, it } from "vitest";
import { gitErrorTail } from "./engine.js";

describe("gitErrorTail", () => {
    it("keeps a rejected push's reason, not GitHub's boilerplate", () => {
        const err = new Error(
            [
                "Command failed: git push origin HEAD",
                "remote: error: GH013: Repository rule violations found",
                "remote: ",
                "remote: Time 2026-10-07T16:56:23Z",
                "To https://github.com/org/backend.git",
                " ! [remote rejected]       feature/a-long-branch-name -> feature/a-long-branch-name (push declined due to repository rule violations)",
                "error: failed to push some refs to 'https://github.com/org/backend.git'",
            ].join("\n"),
        );
        expect(gitErrorTail(err)).toBe(
            "remote: error: GH013: Repository rule violations found · remote rejected: feature/a-long-branch-name (push declined due to repository rule violations) · error: failed to push some refs to 'https://github.com/org/backend.git'",
        );
    });
});
