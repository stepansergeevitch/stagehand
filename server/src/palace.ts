import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { now } from "./db.js";

// Stagehand's own MemPalace: one palace for everything Stagehand runs itself (the Prompter, the Product Owners), apart
// from the palaces the environments' config dirs use. Laid out like northspyre's:
//
//   ~/.stagehand/mempalace/                 = MEMPALACE_HOME (config.json → palace_path, knowledge_graph.sqlite3)
//   ~/.stagehand/mempalace/palace/          = the ChromaDB drawers
//   ~/.stagehand/mempalace/mcp.json         = the mempalace MCP server, pointed at this home (--mcp-config)
//
// Wings: `stagehand` and `wing_prompter` (the Prompter's, migrated from its old palace), `product` (the global product
// context), one `po-<slug>` per Product Owner, and `wing_po-<slug>` for that PO's diary.

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "palace.py");

export interface PalaceHit {
    text: string;
    wing: string;
    room: string;
    similarity?: number;
    source_file?: string;
}

export class Palace {
    readonly home: string;
    readonly palacePath: string;
    readonly mcpConfigPath: string;

    constructor(dataDir: string) {
        this.home = join(dataDir, "mempalace");
        this.palacePath = join(this.home, "palace");
        this.mcpConfigPath = join(this.home, "mcp.json");
    }

    // Creates the home. The first time, it starts as a copy of the Prompter's old palace (drawers and knowledge graph),
    // so nothing the Prompter learned is lost; the old folder stays as it was, as a backup.
    ensure(prompterHome: string): { migrated: boolean } {
        mkdirSync(this.home, { recursive: true });
        let migrated = false;
        const oldPalace = join(prompterHome, "palace");
        if (!existsSync(this.palacePath) && existsSync(oldPalace)) {
            cpSync(oldPalace, this.palacePath, { recursive: true });
            const kg = join(prompterHome, "knowledge_graph.sqlite3");
            if (existsSync(kg)) cpSync(kg, join(this.home, "knowledge_graph.sqlite3"));
            writeFileSync(join(this.home, "migrated.json"), JSON.stringify({ from: prompterHome, at: now() }, null, 2));
            migrated = true;
        }
        mkdirSync(this.palacePath, { recursive: true });
        writeFileSync(join(this.home, "config.json"), JSON.stringify({ palace_path: this.palacePath, collection_name: "mempalace_drawers" }, null, 2));
        writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers: this.mcpServers() }, null, 2));
        return { migrated };
    }

    mcpServers(): Record<string, unknown> {
        return { mempalace: { type: "stdio", command: "python3", args: ["-m", "mempalace.mcp_server"], env: { MEMPALACE_HOME: this.home } } };
    }

    private async run(args: string[], input?: string): Promise<unknown> {
        const child = execFileAsync("python3", [SCRIPT, "--palace", this.palacePath, ...args], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
        if (input !== undefined) {
            child.child.stdin?.write(input);
            child.child.stdin?.end();
        }
        const { stdout } = await child;
        return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    }

    async get(id: string): Promise<string | null> {
        const r = (await this.run(["get", "--id", id])) as { found: boolean; content?: string };
        return r.found ? (r.content ?? "") : null;
    }

    async put(id: string, wing: string, room: string, content: string, source = "stagehand"): Promise<void> {
        await this.run(["put", "--id", id, "--wing", wing, "--room", room, "--source", source], content);
    }

    // Many drawers in one call (an artifact's chunks): upserted by id, metadata as given plus who filed them and when.
    async putMany(drawers: Array<{ id: string; text: string; meta: Record<string, string | number> }>): Promise<void> {
        if (!drawers.length) return;
        await this.run(["put-many"], JSON.stringify({ ids: drawers.map((d) => d.id), documents: drawers.map((d) => d.text), metadatas: drawers.map((d) => d.meta) }));
    }

    // Removes every drawer whose metadata matches (one key: {"artifact_id": "…"}).
    async deleteWhere(where: Record<string, string> | null, ids: string[] = []): Promise<number> {
        const args = ["delete", ...(where ? ["--where", JSON.stringify(where)] : []), ...(ids.length ? ["--ids", ids.join(",")] : [])];
        const r = (await this.run(args)) as { deleted?: number };
        return r.deleted ?? 0;
    }

    async search(query: string, opts: { wing?: string | undefined; room?: string | undefined; limit?: number } = {}): Promise<PalaceHit[]> {
        const args = ["search", "--query", query, "--limit", String(opts.limit ?? 8)];
        if (opts.wing) args.push("--wing", opts.wing);
        if (opts.room) args.push("--room", opts.room);
        const r = (await this.run(args)) as { results?: PalaceHit[]; error?: string };
        if (r.error) throw new Error(r.error);
        return r.results ?? [];
    }

    async status(): Promise<{ total: number; wings: Record<string, Record<string, number>> }> {
        return (await this.run(["status"])) as { total: number; wings: Record<string, Record<string, number>> };
    }
}
