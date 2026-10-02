import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { startClaude } from "./claude/runner.js";

// Non-text sources a Product Owner gets (images, documents): turned into text once, so search finds them and the PO
// reads a few lines instead of opening the file every turn. The file stays for the PO to open itself (Claude Code reads
// images and PDFs).
//
//   images     → a description by Claude (type, every visible text, structure), cached by the file's SHA-256 in
//                <dataDir>/media-cache/<sha>.json: the same image is never described twice, in any PO
//   .docx/.rtf → plain text by macOS textutil

const execFileAsync = promisify(execFile);

export const isImage = (mime: string | null, file: string): boolean => (mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/i.test(file);
export const isConvertibleDoc = (mime: string | null, file: string): boolean =>
    /\.(docx?|rtf|odt)$/i.test(file) || /officedocument\.wordprocessingml|msword|rtf/.test(mime ?? "");

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// The description of an image: from the cache, else one short Claude run that reads it.
export const describeImage = async (opts: { dataDir: string; path: string; configDir: string; env: Record<string, string>; model?: string | undefined }): Promise<string> => {
    const key = sha(opts.path);
    const cache = join(opts.dataDir, "media-cache", `${key}.json`);
    if (existsSync(cache)) return (JSON.parse(readFileSync(cache, "utf8")) as { description: string }).description;
    const run = startClaude({
        prompt: [
            `Read the image at ${opts.path} and describe it for a product owner who cannot see it.`,
            `Markdown, 250 words or fewer: the first line says what it is (screenshot, UI mockup, diagram, table, chart, photo) and what it shows. Then every visible text verbatim — headings, labels, column names, values, buttons. Then the structure: layout, flow or relations. No opinions. Reply with the description only.`,
        ].join("\n\n"),
        cwd: dirname(opts.path),
        configDir: opts.configDir,
        extraEnv: opts.env,
        maxTurns: 4,
        ...(opts.model ? { model: opts.model } : {}),
    });
    const outcome = await run.done;
    const description = outcome.result?.result?.trim();
    if (!description) throw new Error(`could not describe the image: ${outcome.stderr.trim().split("\n").pop()?.slice(0, 200) ?? "no answer"}`);
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, JSON.stringify({ description, at: new Date().toISOString(), file: opts.path }, null, 2));
    return description;
};

// Plain text of a .docx / .doc / .rtf / .odt (macOS textutil).
export const extractDocText = async (path: string): Promise<string> => {
    const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", path], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
};
