import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SharedFile } from "./db.js";
import { mimeOf, sharedFileName } from "./tickets.js";

// Files attached before the task they belong to exists (the New task form). They wait in a temp directory under the
// Vortex home as <token> = "<12 hex>-<safe name>"; the token is the `file` of the descriptor the upload returns, so a
// client can never name a path. Each task created from the form gets its own copies in its shared/ directory.
export const UPLOAD_TOKEN = /^[0-9a-f]{12}-[A-Za-z0-9._-]+$/;
export const UPLOAD_MAX_AGE_MS = 24 * 3600_000;

export const saveUpload = (dir: string, name: string, bytes: Buffer, type: string | null | undefined): SharedFile => {
    const safe = sharedFileName(name);
    const token = `${randomUUID().replace(/-/g, "").slice(0, 12)}-${safe}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, token), bytes);
    // Browsers send octet-stream for anything they do not know: the extension decides then.
    return { name, file: token, mime: type && type !== "application/octet-stream" ? type : mimeOf(safe), size: bytes.length };
};

// The uploaded files that are still there, or an error naming the first one that is not.
export const checkUploads = (dir: string, files: SharedFile[]): string | null => {
    for (const f of files) if (!UPLOAD_TOKEN.test(f.file) || !existsSync(join(dir, f.file))) return `${f.name} was not uploaded — attach it again`;
    return null;
};

// Copies the uploads into one task's shared/ directory (where POST /api/tasks/:id/files writes) and returns the
// descriptors as the task knows them.
export const copyUploadsIntoTask = (uploadDir: string, files: SharedFile[], taskDir: string): SharedFile[] => {
    if (files.length === 0) return [];
    mkdirSync(join(taskDir, "shared"), { recursive: true });
    return files.map((f) => {
        const rel = `shared/${randomUUID().slice(0, 8)}-${sharedFileName(f.name)}`;
        copyFileSync(join(uploadDir, f.file), join(taskDir, rel));
        return { name: f.name, file: rel, mime: f.mime, size: f.size };
    });
};

export const removeUploads = (dir: string, files: SharedFile[]): void => {
    for (const f of files) if (UPLOAD_TOKEN.test(f.file)) rmSync(join(dir, f.file), { force: true });
};

// Drops uploads nobody used within a day (a form abandoned, a crash between upload and create).
export const pruneUploads = (dir: string, maxAgeMs = UPLOAD_MAX_AGE_MS, at = Date.now()): number => {
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const name of readdirSync(dir)) {
        try {
            if (at - statSync(join(dir, name)).mtimeMs > maxAgeMs) {
                rmSync(join(dir, name), { force: true });
                n++;
            }
        } catch {
            /* gone already */
        }
    }
    return n;
};
