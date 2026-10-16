import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Installs Playwright's Chromium into Vortex's own browsers dir (config.browsersDir) when it is not there yet, with
// the gstack checkout's own Playwright so the build matches what its `browse` binary launches. Runs in the background
// at startup; a failure is logged and the next start tries again (a QA run then reports "Executable doesn't exist").
export const ensureBrowsers = (gstackDir: string, browsersDir: string): void => {
    mkdirSync(browsersDir, { recursive: true });
    const have = readdirSync(browsersDir).some((d) => d.startsWith("chromium_headless_shell-"));
    if (have || !existsSync(join(gstackDir, "node_modules", "playwright"))) return;
    console.log(`[browsers] installing Chromium into ${browsersDir}`);
    execFile("npx", ["--no-install", "playwright", "install", "chromium"], { cwd: gstackDir, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir }, timeout: 15 * 60_000 }, (err, _out, stderr) => {
        if (err) console.error(`[browsers] Chromium install failed: ${String(stderr || err.message).split("\n").slice(-3).join(" ")}`);
        else console.log(`[browsers] Chromium installed into ${browsersDir}`);
    });
};
