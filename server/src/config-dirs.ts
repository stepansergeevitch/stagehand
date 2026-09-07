import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// What a Claude config dir contributes to every agent run in an environment, read live from disk for the UI.
export interface ConfigDirContents {
    exists: boolean;
    skills: string[];
    agents: string[];
    commands: string[];
    hooks: string[];
    plugins: number;
    mcpServers: string[];
    hasClaudeMd: boolean;
    hasSettings: boolean;
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const listDirs = (p: string): string[] => (isDir(p) ? readdirSync(p).filter((n) => !n.startsWith(".") && isDir(join(p, n))).sort() : []);
const listMd = (p: string): string[] => (isDir(p) ? readdirSync(p).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).sort() : []);
const readJson = (p: string): Record<string, unknown> | null => {
    try {
        return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

export const inspectConfigDir = (path: string): ConfigDirContents => {
    if (!isDir(path)) return { exists: false, skills: [], agents: [], commands: [], hooks: [], plugins: 0, mcpServers: [], hasClaudeMd: false, hasSettings: false };
    const settings = readJson(join(path, "settings.json"));
    const local = readJson(join(path, "settings.local.json"));
    const hookEvents = new Set<string>();
    for (const s of [settings, local]) {
        const hooks = s?.["hooks"];
        if (hooks && typeof hooks === "object") for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) if (Array.isArray(list) && list.length) hookEvents.add(event);
    }
    const claudeJson = readJson(join(path, ".claude.json"));
    const mcp = claudeJson?.["mcpServers"];
    return {
        exists: true,
        skills: listDirs(join(path, "skills")).filter((n) => existsSync(join(path, "skills", n, "SKILL.md"))),
        agents: listMd(join(path, "agents")),
        commands: listMd(join(path, "commands")),
        hooks: [...hookEvents].sort(),
        plugins: listDirs(join(path, "plugins", "repos")).length + listDirs(join(path, "plugins", "marketplaces")).length,
        mcpServers: mcp && typeof mcp === "object" ? Object.keys(mcp as Record<string, unknown>).sort() : [],
        hasClaudeMd: existsSync(join(path, "CLAUDE.md")),
        hasSettings: !!settings,
    };
};
