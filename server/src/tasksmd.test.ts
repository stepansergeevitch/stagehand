import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { boardCards, cardText, cardTicket, createCard, ensureCardId, findCard, moveCard, setCardText, tasksMdEnvConfigOf } from "./tasksmd.js";

// A Tasks.md folder: TASKS_DIR/<board>/<lane>/<card>.md, CONFIG_DIR/images/<file>.
const setup = (): { cfg: Config; tasks: string; config: string } => {
    const root = mkdtempSync(join(tmpdir(), "vx-tmd-"));
    const tasks = join(root, "tasks");
    const config = join(root, "config");
    mkdirSync(join(tasks, "app", "Todo"), { recursive: true });
    mkdirSync(join(tasks, "app", "Done"), { recursive: true });
    mkdirSync(join(config, "images"), { recursive: true });
    writeFileSync(join(tasks, "app", "Todo", "Add login.md"), "[tag:me] [due:2026-11-01]\n\nUsers sign in.\n\n## Acceptance criteria\n\n- [ ] email works\n- [ ] google works\n\n![shot](/_api/image/abc.png)\n");
    writeFileSync(join(tasks, "app", "Todo", "Fix footer.md"), "Plain text, no tags");
    writeFileSync(join(config, "images", "abc.png"), "png");
    return { cfg: { tasksMd: { tasksDir: tasks, configDir: config } } as unknown as Config, tasks, config };
};

describe("Tasks.md", () => {
    it("reads a board's lanes and cards, with tags and no id yet", () => {
        const { cfg } = setup();
        const cards = boardCards(cfg, "app");
        expect(cards.map((c) => `${c.lane}/${c.title}`).sort()).toEqual(["Todo/Add login", "Todo/Fix footer"]);
        const login = cards.find((c) => c.title === "Add login")!;
        expect(login.tags).toEqual(["me"]);
        expect(login.id).toBeNull();
        expect(cardText(login.content)).toMatch(/^Users sign in\./);
    });

    it("numbers cards once with the prefix, as a tag in front of the text", () => {
        const { cfg } = setup();
        const [a, b] = boardCards(cfg, "app").map((c) => ensureCardId(cfg, c, "VX"));
        expect([a!.id, b!.id].sort()).toEqual(["VX-1", "VX-2"]);
        expect(ensureCardId(cfg, a!, "VX").id).toBe(a!.id);
        const footer = findCard(cfg, b!.title === "Fix footer" ? b!.id! : a!.id!);
        expect(footer.content).toMatch(/^\[tag:VX-\d\]\n\nPlain text, no tags$/);
    });

    it("moves a card between lanes, keeping its id, and finds it after", () => {
        const { cfg, tasks } = setup();
        const card = ensureCardId(cfg, boardCards(cfg, "app").find((c) => c.title === "Add login")!, "VX");
        expect(moveCard(cfg, card.id!, "Review")?.lane).toBe("Review");
        expect(existsSync(join(tasks, "app", "Review", "Add login.md"))).toBe(true);
        expect(findCard(cfg, card.id!).lane).toBe("Review");
        expect(moveCard(cfg, card.id!, "Review")).toBeNull();
    });

    it("creates cards numbered after the existing ones and rewrites text keeping tags", () => {
        const { cfg } = setup();
        ensureCardId(cfg, boardCards(cfg, "app")[0]!, "VX");
        const created = createCard(cfg, { board: "app", lane: "Backlog", title: "New: thing/one", description: "Do it", prefix: "VX", tags: ["me"] });
        expect(created.id).toBe("VX-2");
        expect(created.lane).toBe("Backlog");
        expect(created.title).toBe("New  thing one".replace(/\s+/g, " "));
        setCardText(cfg, "VX-2", "Done differently");
        const after = readFileSync(created.path, "utf8");
        expect(after).toBe("[tag:VX-2] [tag:me]\n\nDone differently\n");
    });

    it("turns a card into a ticket with its criteria and its images copied", () => {
        const { cfg } = setup();
        const card = ensureCardId(cfg, boardCards(cfg, "app").find((c) => c.title === "Add login")!, "VX");
        const taskDir = mkdtempSync(join(tmpdir(), "vx-task-"));
        const t = cardTicket(cfg, card, taskDir);
        expect(t).toMatchObject({ source: "tasksmd", id: card.id, title: "Add login", status: "Todo", acceptanceCriteria: ["email works", "google works"] });
        expect(t.attachments[0]).toMatchObject({ file: "attachments/abc.png", error: null });
        expect(existsSync(join(taskDir, "attachments", "abc.png"))).toBe(true);
    });

    it("parses the env config with defaults", () => {
        expect(tasksMdEnvConfigOf(null)).toEqual({ board: "", idPrefix: "TASK", tag: "", lanes: { new: "", inProgress: "", review: "", done: "" } });
        expect(tasksMdEnvConfigOf(`{"board":"/app/","idPrefix":"vx","lanes":{"done":"Done"}}`)).toMatchObject({ board: "app", idPrefix: "VX", lanes: { done: "Done" } });
    });
});
