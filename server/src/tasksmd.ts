import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Config } from "./config.js";
import type { Ticket } from "./tickets.js";

// Tasks.md (github.com/BaldissaraMatheus/Tasks.md) as a task manager, read and written on disk — its TASKS_DIR, the
// folder its container mounts at /tasks. A board is a folder whose sub-folders are its lanes; a lane holds the cards,
// one `<title>.md` each; a board may sit inside another (Tasks.md opens a sub-path as its own project). Tasks.md keeps
// tags in the card text as `[tag:<name>]` and a due date as `[due:<date>]`, and pasted images under CONFIG_DIR/images
// (linked as `…/_api/image/<file>`). It has no ids: Vortex gives a card one as a tag, `[tag:<PREFIX>-<n>]`, the first
// time it needs it — a rename or a move to another lane keeps it.

// envs.ticket_config for an env whose tickets are Tasks.md cards.
export interface TasksMdEnvConfig {
    // The board, relative to TASKS_DIR ("" = TASKS_DIR itself).
    board: string;
    // The id prefix of the cards this env numbers (VX → VX-1, VX-2, …).
    idPrefix: string;
    // "My tickets" are the board's cards with this tag; empty = every card.
    tag: string;
    // Where Vortex moves a card as its task goes (empty = leave it): `new` takes the cards a Product Owner creates.
    lanes: { new: string; inProgress: string; review: string; done: string };
}

export const tasksMdEnvConfigOf = (json: string | null | undefined): TasksMdEnvConfig => {
    let v: Record<string, unknown> = {};
    try {
        const parsed: unknown = json ? JSON.parse(json) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) v = parsed as Record<string, unknown>;
    } catch {
        v = {};
    }
    const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
    const lanes = (v.lanes && typeof v.lanes === "object" ? v.lanes : {}) as Record<string, unknown>;
    return {
        board: str(v.board).replace(/^\/+|\/+$/g, ""),
        idPrefix: (str(v.idPrefix) || "TASK").toUpperCase(),
        tag: str(v.tag),
        lanes: { new: str(lanes.new), inProgress: str(lanes.inProgress), review: str(lanes.review), done: str(lanes.done) },
    };
};

export interface Card {
    board: string;
    lane: string;
    title: string;
    // Absolute path of the .md file.
    path: string;
    content: string;
    id: string | null;
    tags: string[];
    updatedAt: string;
}

const TAG = /\[tag:([^\]]*)\]/g;
const ID_TAG = /^[A-Z][A-Z0-9]*-\d+$/;

const tasksDirOf = (cfg: Config): string => {
    const dir = cfg.tasksMd.tasksDir?.trim();
    if (!dir) throw new Error("no Tasks.md folder configured — set it under Integrations → Tasks.md");
    if (!existsSync(dir)) throw new Error(`the Tasks.md folder ${dir} does not exist`);
    return dir;
};

export const tasksMdConfigured = (cfg: Config): boolean => !!cfg.tasksMd.tasksDir?.trim() && existsSync(cfg.tasksMd.tasksDir.trim());

const readCard = (root: string, path: string): Card => {
    const content = readFileSync(path, "utf8");
    const tags = [...content.matchAll(TAG)].map((m) => m[1]!.trim());
    const laneDir = dirname(path);
    return {
        board: relative(root, dirname(laneDir)).split(sep).join("/"),
        lane: basename(laneDir),
        title: basename(path).replace(/\.md$/, ""),
        path,
        content,
        id: tags.find((t) => ID_TAG.test(t)) ?? null,
        tags: tags.filter((t) => !ID_TAG.test(t)),
        updatedAt: statSync(path).mtime.toISOString(),
    };
};

const visible = (name: string): boolean => !name.startsWith(".");

// One board's cards, lane by lane: its direct sub-folders are the lanes.
export const boardCards = (cfg: Config, board: string): Card[] => {
    const root = tasksDirOf(cfg);
    const dir = join(root, board);
    if (!existsSync(dir)) throw new Error(`Tasks.md board "${board || "/"}" does not exist in ${root}`);
    return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && visible(d.name))
        .flatMap((lane) =>
            readdirSync(join(dir, lane.name))
                .filter((f) => f.endsWith(".md") && visible(f))
                .map((f) => readCard(root, join(dir, lane.name, f))),
        );
};

export const boardLanes = (cfg: Config, board: string): string[] => {
    const dir = join(tasksDirOf(cfg), board);
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && visible(d.name)).map((d) => d.name) : [];
};

// Every card under TASKS_DIR, any board.
export const allCards = (cfg: Config): Card[] => {
    const root = tasksDirOf(cfg);
    const out: Card[] = [];
    const walk = (dir: string, depth: number): void => {
        if (depth > 8) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (!visible(e.name)) continue;
            const p = join(dir, e.name);
            // A card is a .md file inside a lane, i.e. at least one folder below TASKS_DIR.
            if (e.isFile() && e.name.endsWith(".md") && dir !== root) out.push(readCard(root, p));
            else if (e.isDirectory()) walk(p, depth + 1);
        }
    };
    walk(root, 0);
    return out;
};

export const findCard = (cfg: Config, id: string): Card => {
    const want = id.trim().toUpperCase();
    const card = allCards(cfg).find((c) => c.id === want);
    if (!card) throw new Error(`no Tasks.md card has the id tag [tag:${want}]`);
    return card;
};

const nextId = (cfg: Config, prefix: string): string => {
    const re = new RegExp(`^${prefix.replace(/[^A-Z0-9]/g, "")}-(\\d+)$`);
    const max = allCards(cfg).reduce((m, c) => Math.max(m, Number(re.exec(c.id ?? "")?.[1] ?? 0)), 0);
    return `${prefix}-${max + 1}`;
};

// Tasks.md puts tags in front of the text, a blank line after the first one; the id goes there too.
const withTag = (content: string, tag: string): string => (/\[tag:[^\]]*\]/.test(content) ? `[tag:${tag}] ${content}` : `[tag:${tag}]\n\n${content}`);

// The card's id, giving it one when it has none yet.
export const ensureCardId = (cfg: Config, card: Card, prefix: string): Card => {
    if (card.id) return card;
    const id = nextId(cfg, prefix);
    writeFileSync(card.path, withTag(card.content, id));
    return readCard(tasksDirOf(cfg), card.path);
};

// The text without Tasks.md's tags and due date.
export const cardText = (content: string): string => content.replace(TAG, "").replace(/\[due:[^\]]*\]/g, "").replace(/^\s+/, "").trim();

const fileName = (title: string): string => title.replace(/[<>:"/\\|?*#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "Untitled";

// A new card in a lane of the board (the lane folder is created when missing), numbered like the env's others.
export const createCard = (cfg: Config, input: { board: string; lane: string; title: string; description: string; prefix: string; tags?: string[] }): Card => {
    const root = tasksDirOf(cfg);
    const dir = join(root, input.board, input.lane);
    mkdirSync(dir, { recursive: true });
    let name = fileName(input.title);
    for (let i = 2; existsSync(join(dir, `${name}.md`)); i++) name = `${fileName(input.title)} (${i})`;
    const id = nextId(cfg, input.prefix);
    const tags = [id, ...(input.tags ?? [])].map((t) => `[tag:${t}]`).join(" ");
    const path = join(dir, `${name}.md`);
    writeFileSync(path, `${tags}\n\n${input.description.trim()}\n`);
    return readCard(root, path);
};

// Replaces the card's text, keeping its tags and due date in front.
export const setCardText = (cfg: Config, id: string, description: string): void => {
    const card = findCard(cfg, id);
    const head = [...card.content.matchAll(/\[(?:tag|due):[^\]]*\]/g)].map((m) => m[0]).join(" ");
    writeFileSync(card.path, `${head}\n\n${description.trim()}\n`);
};

// Moves the card to another lane of its board (created when missing). No-op when it is there already.
export const moveCard = (cfg: Config, id: string, lane: string): Card | null => {
    const card = findCard(cfg, id);
    if (!lane || card.lane === lane) return null;
    const root = tasksDirOf(cfg);
    const dir = join(root, card.board, lane);
    mkdirSync(dir, { recursive: true });
    let target = join(dir, basename(card.path));
    for (let i = 2; existsSync(target); i++) target = join(dir, `${card.title} (${i}).md`);
    renameSync(card.path, target);
    return readCard(root, target);
};

const IMAGE = /!\[([^\]]*)\]\(([^)\s]*_api\/image\/([^)\s/]+))\)/g;

// A card as a ticket. Its pasted images (Tasks.md keeps them in CONFIG_DIR/images) are copied into the task dir.
export const cardTicket = (cfg: Config, card: Card, taskDir: string | null): Ticket => {
    const text = cardText(card.content);
    const attachments: Ticket["attachments"] = [];
    const images = cfg.tasksMd.configDir?.trim() ? join(cfg.tasksMd.configDir.trim(), "images") : null;
    for (const m of text.matchAll(IMAGE)) {
        const file = m[3]!;
        const src = images ? join(images, file) : null;
        if (!src || !existsSync(src) || !taskDir) {
            attachments.push({ name: m[1] || file, url: m[2]!, mime: null, file: null, size: null, error: images ? "not found in the Tasks.md images folder" : "no Tasks.md config folder set", origin: "description" });
            continue;
        }
        mkdirSync(join(taskDir, "attachments"), { recursive: true });
        copyFileSync(src, join(taskDir, "attachments", file));
        attachments.push({ name: m[1] || file, url: m[2]!, mime: null, file: `attachments/${file}`, size: statSync(src).size, error: null, origin: "description" });
    }
    const criteria: string[] = [];
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /acceptance criteria/i.test(l));
    if (start >= 0)
        for (const line of lines.slice(start + 1)) {
            if (/^#{1,6}\s/.test(line) && criteria.length) break;
            const cm = /^\s*(?:[-*]|\d+\.)\s*(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
            if (cm) criteria.push(cm[1]!.trim());
        }
    return {
        source: "tasksmd",
        id: card.id ?? card.title,
        url: null,
        title: card.title,
        status: card.lane,
        description: text,
        acceptanceCriteria: criteria,
        parent: null,
        comments: [],
        attachments,
        fetchedVia: "rest",
    };
};

// The card behind a ticket, as a ticket (ticket.json is written by the caller).
export const fetchCardTicket = (cfg: Config, id: string, taskDir: string): Ticket => cardTicket(cfg, findCard(cfg, id), taskDir);
