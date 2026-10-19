import { mkdtempSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkUploads, copyUploadsIntoTask, pruneUploads, removeUploads, saveUpload } from "./uploads.js";

describe("env uploads", () => {
    it("saves under an opaque token and copies a separate file into each task", () => {
        const up = mkdtempSync(join(tmpdir(), "up-"));
        const a = mkdtempSync(join(tmpdir(), "ta-"));
        const b = mkdtempSync(join(tmpdir(), "tb-"));
        const f = saveUpload(up, "Screen shot.PNG", Buffer.from("png"), "application/octet-stream");
        expect(f).toMatchObject({ name: "Screen shot.PNG", mime: "image/png", size: 3 });
        expect(f.file).toMatch(/^[0-9a-f]{12}-Screen_shot\.png$/);
        expect(checkUploads(up, [f])).toBeNull();
        expect(checkUploads(up, [{ ...f, file: "../etc/passwd" }])).toMatch(/attach it again/);
        const ca = copyUploadsIntoTask(up, [f], a);
        const cb = copyUploadsIntoTask(up, [f], b);
        expect(ca[0]!.file).toMatch(/^shared\//);
        expect(readFileSync(join(a, ca[0]!.file), "utf8")).toBe("png");
        expect(readFileSync(join(b, cb[0]!.file), "utf8")).toBe("png");
        removeUploads(up, [f]);
        expect(existsSync(join(up, f.file))).toBe(false);
        expect(existsSync(join(a, ca[0]!.file))).toBe(true);
    });
    it("prunes only stale uploads", () => {
        const up = mkdtempSync(join(tmpdir(), "up-"));
        const old = saveUpload(up, "a.txt", Buffer.from("x"), null);
        const fresh = saveUpload(up, "b.txt", Buffer.from("x"), null);
        const t = new Date(Date.now() - 2 * 86400_000);
        utimesSync(join(up, old.file), t, t);
        expect(pruneUploads(up)).toBe(1);
        expect(existsSync(join(up, fresh.file))).toBe(true);
    });
});
