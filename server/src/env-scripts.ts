import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvVars, type EnvRow } from "./db.js";

// An environment's own scripts (a QA teardown, a session-cookie helper, the datastores it needs up): part of its
// config (envs.scripts, JSON [{ name, content }]), never files of Stagehand. Stagehand writes them to
// <dataDir>/env-scripts/<envId>/ and exports that folder as $STAGEHAND_SCRIPTS to every command and agent run of the
// env, so its commands, seed hints and QA steps say `$STAGEHAND_SCRIPTS/qa-teardown.py`. Stagehand itself knows
// nothing about what they do.

export interface EnvScript { name: string; content: string }

let root = "";
export const setEnvScriptsRoot = (dataDir: string): void => {
    root = join(dataDir, "env-scripts");
};
export const envScriptsDir = (envId: string): string => join(root, envId);

export const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export const envScriptsOf = (env: Pick<EnvRow, "scripts">): EnvScript[] => {
    try {
        const v: unknown = env.scripts ? JSON.parse(env.scripts) : [];
        return Array.isArray(v) ? v.filter((s): s is EnvScript => !!s && typeof s.name === "string" && SCRIPT_NAME.test(s.name) && typeof s.content === "string") : [];
    } catch {
        return [];
    }
};

// The folder holds exactly the env's scripts: written (executable), the ones removed from the config deleted.
export const materializeEnvScripts = (env: Pick<EnvRow, "id" | "scripts">): void => {
    if (!root) return;
    const dir = envScriptsDir(env.id);
    mkdirSync(dir, { recursive: true });
    const scripts = envScriptsOf(env);
    const keep = new Set(scripts.map((s) => s.name));
    for (const f of existsSync(dir) ? readdirSync(dir) : []) if (!keep.has(f)) rmSync(join(dir, f), { recursive: true, force: true });
    for (const s of scripts) {
        const p = join(dir, s.name);
        writeFileSync(p, s.content.endsWith("\n") ? s.content : `${s.content}\n`);
        chmodSync(p, 0o755);
    }
};

// The env's variables for its commands and runs: its own KEY=VALUE lines, and $STAGEHAND_SCRIPTS.
export const envVarsOf = (env: Pick<EnvRow, "id" | "env_vars">): Record<string, string> => ({ STAGEHAND_SCRIPTS: envScriptsDir(env.id), ...parseEnvVars(env.env_vars) });
