// Environment for every `claude` child process. Strips what the dev toolchain injects (tsx's NODE_OPTIONS loader,
// npm's run-script variables) so claude's own helper processes start clean, and pins the account's config dir.
const STRIP_PREFIXES = ["npm_", "NODE_OPTIONS", "TSX_", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

export const claudeEnv = (configDir: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (STRIP_PREFIXES.some((p) => k === p || k.startsWith(p))) continue;
        env[k] = v;
    }
    env["CLAUDE_CONFIG_DIR"] = configDir;
    // Marker for user hooks (e.g. mempalace auto-save) to skip orchestrated runs.
    env["STAGEHAND_RUN"] = "1";
    return env;
};
