import { describe, expect, it } from "vitest";
import { renderSharedFiles, sharedFileName } from "./tickets.js";

describe("sharedFileName", () => {
    it("keeps plain names", () => {
        expect(sharedFileName("screen-1.png")).toBe("screen-1.png");
    });
    it("replaces spaces and drops non-ASCII", () => {
        expect(sharedFileName("Знімок екрана 2026-09-23 о 13.26.27.png")).toBe("2026-09-23_13.26.27.png");
        expect(sharedFileName("my file (1).csv")).toBe("my_file_1.csv");
    });
    it("falls back to `file` plus the extension when nothing is left", () => {
        expect(sharedFileName("Знімок.png")).toBe("file.png");
        expect(sharedFileName("Знімок")).toBe("file");
    });
});

describe("renderSharedFiles", () => {
    it("is empty without files", () => {
        expect(renderSharedFiles([], "/t")).toBe("");
    });
    it("names each file by absolute path with a hint", () => {
        const out = renderSharedFiles([{ name: "a.png", file: "shared/1-a.png", mime: "image/png", size: 2048 }, { name: "b.csv", file: "shared/2-b.csv", mime: "text/csv", size: 10 }], "/tasks/x");
        expect(out).toContain("### Files from the human (2)");
        expect(out).toContain("- a.png: `/tasks/x/shared/1-a.png` (image — view it with the Read tool, 2 kB)");
        expect(out).toContain("- b.csv: `/tasks/x/shared/2-b.csv` (text/csv, 10 B)");
    });
});
