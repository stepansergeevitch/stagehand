import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findTranscript } from "./transcripts.js";

describe("findTranscript", () => {
    it("finds the session file under any project folder of any config dir, with its size", () => {
        const a = mkdtempSync(join(tmpdir(), "sh-a-"));
        const b = mkdtempSync(join(tmpdir(), "sh-b-"));
        mkdirSync(join(b, "projects", "-Users-x-repo"), { recursive: true });
        writeFileSync(join(b, "projects", "-Users-x-repo", "abc.jsonl"), "x".repeat(2 * 1_048_576));
        const hit = findTranscript([a, b, b], "abc");
        expect(hit?.path).toBe(join(b, "projects", "-Users-x-repo", "abc.jsonl"));
        expect(hit?.sizeMb).toBe(2);
        expect(findTranscript([a, b], "nope")).toBeNull();
        expect(findTranscript(["/does/not/exist"], "abc")).toBeNull();
    });
});
