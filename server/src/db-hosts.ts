import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseEnvVars, type EnvRow } from "./db.js";
import { withPrepare } from "./env-config.js";
import { loginShellArgs, loginShellEnv } from "./git.js";

// Which databases a task may touch: the env's DB host check (envs.db_hosts_command, inline, run from the worktree)
// prints the hosts the worktree's app would connect to; every one must be in envs.allowed_db_hosts (JSON array,
// default localhost / 127.0.0.1 / ::1). Stagehand runs it before agent runs, service starts and migrations, and a host
// outside the list blocks the task — so a worktree whose config points at a shared database never migrates or seeds it
// (INV-155, 2026-10-02: its .env copy pointed at a remote dev database).

const execFileAsync = promisify(execFile);
const DEFAULT_ALLOWED = ["localhost", "127.0.0.1", "::1"];
const FRESH_MS = 2 * 60_000;
const verified = new Map<string, number>();

export const allowedDbHostsOf = (env: Pick<EnvRow, "allowed_db_hosts">): string[] => {
    try {
        const v: unknown = env.allowed_db_hosts ? JSON.parse(env.allowed_db_hosts) : [];
        const list = Array.isArray(v) ? v.filter((h): h is string => typeof h === "string" && !!h.trim()).map((h) => h.trim().toLowerCase()) : [];
        return list.length ? list : DEFAULT_ALLOWED;
    } catch {
        return DEFAULT_ALLOWED;
    }
};

// Host names in the check's output: whitespace- or comma-separated, each optionally `alias=` and `:port`.
export const parseDbHosts = (out: string): string[] => {
    const hosts = new Set<string>();
    for (const raw of out.split(/[\s,]+/)) {
        let t = raw.trim().replace(/^[\w.-]+=/, "");
        if (!t) continue;
        const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(t);
        t = v6 ? v6[1]! : t.includes("::") ? t : t.replace(/:\d+$/, "");
        if (t && t !== "None" && t !== "null") hosts.add(t.toLowerCase());
    }
    return [...hosts];
};

// Throws when the worktree's app would use a database host the env does not allow. No check configured: no-op.
export const assertDbHosts = async (env: EnvRow, worktree: string): Promise<void> => {
    const tpl = env.db_hosts_command?.trim();
    if (!tpl) return;
    const key = `${env.id}:${worktree}`;
    if (Date.now() - (verified.get(key) ?? 0) < FRESH_MS) return;
    const cmd = withPrepare(env, tpl.replace(/\{\{worktree\}\}/g, worktree).replace(/\{\{envPath\}\}/g, env.path));
    let out: string;
    try {
        out = (await execFileAsync("bash", loginShellArgs(cmd), { cwd: worktree, env: loginShellEnv(parseEnvVars(env.env_vars)), timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout;
    } catch (e) {
        const err = e as { stderr?: string; message?: string };
        throw new Error(`the environment's DB host check failed — nothing that touches the database runs until it passes: ${String(err.stderr?.trim() || err.message || e).split("\n").slice(-2).join(" ").slice(0, 200)}`);
    }
    const hosts = parseDbHosts(out.trim().split("\n").filter((l) => l.trim()).pop() ?? "");
    if (!hosts.length) throw new Error("the environment's DB host check printed no host — nothing that touches the database runs until it does");
    const allowed = allowedDbHostsOf(env);
    const bad = hosts.filter((h) => !allowed.includes(h));
    if (bad.length) {
        verified.delete(key);
        throw new Error(`this worktree's app would use database host ${bad.join(", ")}, which the environment does not allow (allowed: ${allowed.join(", ")}) — fix the worktree's config (e.g. its .env), then Retry`);
    }
    verified.set(key, Date.now());
};
