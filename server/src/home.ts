import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The project was called Stagehand before Vortex. Everything that persists a name on a user's machine (data dir, database file,
// env vars, tmux sessions, git refs, template worktrees) keeps working under the old name: every lookup below prefers the
// Vortex name and falls back to the legacy one, and nothing is ever moved or deleted behind the user's back.
const LEGACY = "STAGEHAND_";
const CURRENT = "VORTEX_";

// An environment variable: VORTEX_<name>, else the legacy STAGEHAND_<name>.
export const env = (name: string): string | undefined => {
    const v = process.env[name];
    if (v !== undefined) return v;
    return name.startsWith(CURRENT) ? process.env[LEGACY + name.slice(CURRENT.length)] : undefined;
};

// The variables Vortex hands to commands it runs (env commands, agents, tmux panes): each VORTEX_* also under its
// legacy STAGEHAND_* name, so commands an environment wrote before the rename keep seeing them.
export const withLegacyEnv = <T extends Record<string, string | undefined>>(vars: T): T => {
    const out: Record<string, string | undefined> = { ...vars };
    for (const [k, v] of Object.entries(vars)) if (k.startsWith(CURRENT) && !((LEGACY + k.slice(CURRENT.length)) in out)) out[LEGACY + k.slice(CURRENT.length)] = v;
    return out as T;
};

// The default data directory: ~/.vortex; when that does not exist and the legacy ~/.stagehand does, the legacy one is
// used in place. dataHome() is $VORTEX_HOME (or legacy $STAGEHAND_HOME) when set, else that.
export const userDataDir = (home: string = homedir()): string => {
    const current = join(home, ".vortex");
    const legacy = join(home, ".stagehand");
    return !existsSync(current) && existsSync(legacy) ? legacy : current;
};

export const dataHome = (): string => env("VORTEX_HOME") ?? userDataDir();

// The first of these files that exists, else the first: the database is vortex.sqlite, or a legacy stagehand.sqlite
// that has not been renamed.
export const existingOrFirst = (...paths: string[]): string => paths.find((p) => existsSync(p)) ?? paths[0]!;
