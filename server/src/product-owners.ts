import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Config } from "./config.js";
import { now, type AccountRow, type DB, type PoArtifactRow, type PoIssueRow, type PoMessageRow, type PoPhase, type PoTicketLinkRow, type ProductOwnerRow, type TaskRow } from "./db.js";
import { authEnv } from "./claude/accounts.js";
import { startClaude, type ActivityEvent, type ClaudeRun } from "./claude/runner.js";
import { recordUsage } from "./usage.js";
import type { Palace } from "./palace.js";
import { createClickUpTask, createLinearIssue, fetchScope, fetchScopeIssues, fetchSource, findIssue, ticketScopeId, type TrackedIssue } from "./sources.js";
import { sharedFileName } from "./tickets.js";
import { chunkText, drawerText, issueDrawers } from "./palace-index.js";

// Product Owners — one per project of the product (a Linear project, a ClickUp epic). The human plans the project with
// its PO in a chat while the PO keeps three documents the UI shows as pages: context.md (the living project context),
// design.md (the project design) and tickets.json (the ticket proposal). On approval Stagehand creates the tickets by
// API; afterwards the PO stays: it keeps its context current and reviews task designs on request.
//
//   ~/.stagehand/product/context.md           = the global product context (also a drawer: wing `product`, room `context`)
//   ~/.stagehand/product-owners/claude/       = CLAUDE_CONFIG_DIR of every PO run (from the repo's product-owner/ folder)
//   ~/.stagehand/product-owners/<id>/         = one PO: context.md, design.md, tickets.json, artifacts/, revisions/, logs/
//
// Memory is Stagehand's palace (palace.ts): wing `po-<slug>` per PO (rooms features / users / decisions / glossary, and
// `context` for context.md), diary in `wing_po-<slug>`. Runs load only the mempalace MCP server (--strict-mcp-config):
// Linear, ClickUp and Notion are reached by Stagehand with API keys, never by the agent.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES = join(REPO_ROOT, "product-owner");
const PALACE_SCRIPT = join(REPO_ROOT, "scripts", "palace.py");

export const DESIGN_SECTIONS = ["Goal", "Problem and users", "Scope", "Solution outline", "Decisions", "Open questions", "Risks"] as const;

export const PoTicket = z.object({
    key: z.string().regex(/^T\d+$/, "keys are T1, T2, …"),
    type: z.enum(["epic", "story", "task", "bug"]),
    title: z.string().min(1),
    parent: z.string().nullable().default(null),
    summary: z.string().default(""),
    description: z.string().default(""),
    acceptanceCriteria: z.array(z.string()).default([]),
    estimate: z.number().nullable().default(null),
    dependsOn: z.array(z.string()).default([]),
    labels: z.array(z.string()).default([]),
    // The identifier of an issue that already exists for this ticket (INV-154): Stagehand links it and never creates it.
    existing: z.string().nullable().default(null),
});
export const PoTickets = z.object({ tickets: z.array(PoTicket) });
export type PoTicket = z.infer<typeof PoTicket>;

export type PoEvent =
    | { poId: string; kind: "updated" }
    | { poId: string; kind: "text"; text: string }
    | { poId: string; kind: "activity"; text: string }
    | { poId: string; kind: "message"; message: PoMessageRow };

const slugify = (s: string): string =>
    s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "project";

// How often every PO's issues are read again; the timer looks every few minutes and refreshes the ones that are due.
const ISSUES_REFRESH_MS = 3600_000;
const ISSUES_TICK_MS = 5 * 60_000;

export const issueHash = (i: TrackedIssue): string => createHash("sha256").update(JSON.stringify(i)).digest("hex");

// The lines of `b` that are not in `a` (+) and the other way round (-), in order, by a longest common subsequence.
export const lineDiff = (a: string, b: string): string[] => {
    const x = a.split("\n");
    const y = b.split("\n");
    if (x.length * y.length > 4_000_000) return [...x.map((l) => `- ${l}`), ...y.map((l) => `+ ${l}`)];
    const L: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    const out: string[] = [];
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
        if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; }
        else if (j < y.length && (i >= x.length || L[i]![j + 1]! > L[i + 1]![j]!)) out.push(`+ ${y[j++]}`);
        else out.push(`- ${x[i++]}`);
    }
    return out;
};

const quote = (t: string): string => t.split("\n").map((l) => `> ${l}`).join("\n");

// What changed in one issue between two refreshes, as markdown bullets.
export const describeChange = (a: TrackedIssue, b: TrackedIssue): string[] => {
    const out: string[] = [];
    const field = (label: string, x: unknown, y: unknown): void => {
        if (x !== y) out.push(`- **${label}:** ${x ?? "none"} → ${y ?? "none"}`);
    };
    field("Title", a.title, b.title);
    field("Status", a.status, b.status);
    field("Assignee", a.assignee, b.assignee);
    field("Priority", a.priority, b.priority);
    field("Estimate", a.estimate, b.estimate);
    field("Parent", a.parent, b.parent);
    const added = b.labels.filter((l) => !a.labels.includes(l));
    const removed = a.labels.filter((l) => !b.labels.includes(l));
    if (added.length || removed.length) out.push(`- **Labels:** ${[...added.map((l) => `+${l}`), ...removed.map((l) => `−${l}`)].join(", ")}`);
    if (a.description !== b.description) out.push(`- **Description changed:**\n\n\`\`\`diff\n${lineDiff(a.description, b.description).join("\n")}\n\`\`\``);
    const before = new Map(a.comments.map((c) => [c.id, c]));
    const after = new Set(b.comments.map((c) => c.id));
    for (const c of b.comments) {
        const old = before.get(c.id);
        if (!old) out.push(`- **New comment** by ${c.author} (${c.at}):\n\n${quote(c.body)}`);
        else if (old.body !== c.body) out.push(`- **Comment edited** by ${c.author} (${c.at}):\n\n\`\`\`diff\n${lineDiff(old.body, c.body).join("\n")}\n\`\`\``);
    }
    for (const c of a.comments) if (!after.has(c.id)) out.push(`- **Comment deleted** (by ${c.author}, ${c.at}):\n\n${quote(c.body)}`);
    return out;
};

// The current state of every issue, as the PO reads it (issues.md in its folder).
const renderIssues = (issues: TrackedIssue[], at: string): string =>
    [
        `# Issues of the project (${issues.length}) — as of ${at}`,
        "Stagehand reads them again every hour. Do not edit this file.",
        ...issues.map((i) =>
            [
                `\n## ${i.identifier} — ${i.title}`,
                `${i.url} · **${i.status ?? "?"}**${i.assignee ? ` · ${i.assignee}` : ""}${i.priority ? ` · priority ${i.priority}` : ""}${i.estimate != null ? ` · ${i.estimate} pt` : ""}${i.parent ? ` · parent ${i.parent}` : ""}${i.labels.length ? ` · labels: ${i.labels.join(", ")}` : ""}`,
                i.description ? `\n${i.description}` : "",
                i.comments.length ? `\n### Comments (${i.comments.length})\n\n${i.comments.map((c) => `**${c.author}** (${c.at}):\n${c.body}`).join("\n\n")}` : "",
            ]
                .filter(Boolean)
                .join("\n"),
        ),
    ].join("\n");

const PHASE_LABEL: Record<PoPhase, string> = { context: "Context", design: "Design", tickets: "Tickets", approved: "Approved", live: "Live" };

export class ProductOwners {
    readonly root: string;
    readonly configDir: string;
    readonly productDir: string;
    private readonly active = new Map<string, ClaudeRun>();
    // PO reviews of task designs in flight, by task id.
    private readonly reviews = new Map<string, ClaudeRun>();
    private readonly refreshing = new Set<string>();
    private refreshTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly db: DB,
        private readonly cfg: Config,
        private readonly palace: Palace,
        private readonly emit: (ev: PoEvent) => void,
        private readonly apiUrl: string,
        private readonly onTaskChanged: (taskId: string) => void = () => undefined,
    ) {
        this.root = join(cfg.dataDir, "product-owners");
        this.configDir = join(this.root, "claude");
        this.productDir = join(cfg.dataDir, "product");
    }

    // ---------- the config dir and folders ----------

    ensureHome(): void {
        mkdirSync(join(this.configDir, "hooks"), { recursive: true });
        mkdirSync(this.productDir, { recursive: true });
        if (!existsSync(join(this.productDir, "context.md"))) writeFileSync(join(this.productDir, "context.md"), "");
        if (!existsSync(TEMPLATES)) return;
        const hooks = join(this.configDir, "hooks");
        copyFileSync(join(TEMPLATES, "CLAUDE.md"), join(this.configDir, "CLAUDE.md"));
        writeFileSync(join(this.configDir, "settings.json"), readFileSync(join(TEMPLATES, "settings.json"), "utf8").replace(/\{\{hooks\}\}/g, hooks));
        rmSync(hooks, { recursive: true, force: true });
        cpSync(join(TEMPLATES, "hooks"), hooks, { recursive: true });
        // Onboarding flags come from the main config dir's .claude.json, once (like the Prompter's).
        const claudeJson = join(this.configDir, ".claude.json");
        if (!existsSync(claudeJson)) {
            let base: Record<string, unknown> = {};
            try {
                base = JSON.parse(readFileSync(join(this.cfg.mainConfigDir, ".claude.json"), "utf8")) as Record<string, unknown>;
            } catch {
                /* start from nothing */
            }
            const { oauthAccount: _o, ...rest } = base;
            writeFileSync(claudeJson, JSON.stringify({ ...rest, projects: {} }, null, 2));
        }
    }

    dir(poId: string): string {
        return join(this.root, poId);
    }
    private trust(poId: string): void {
        const claudeJson = join(this.configDir, ".claude.json");
        try {
            const j = JSON.parse(readFileSync(claudeJson, "utf8")) as { projects?: Record<string, Record<string, unknown>> };
            const projects = j.projects ?? {};
            const d = this.dir(poId);
            if (projects[d]?.["hasTrustDialogAccepted"]) return;
            projects[d] = { ...(projects[d] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] };
            writeFileSync(claudeJson, JSON.stringify({ ...j, projects }, null, 2));
        } catch {
            /* the run asks nothing headless */
        }
    }

    // ---------- rows ----------

    list(): ProductOwnerRow[] {
        return this.db.prepare(`SELECT * FROM product_owners ORDER BY updated_at DESC`).all() as ProductOwnerRow[];
    }
    get(id: string): ProductOwnerRow | undefined {
        return this.db.prepare(`SELECT * FROM product_owners WHERE id = ?`).get(id) as ProductOwnerRow | undefined;
    }
    messages(id: string): PoMessageRow[] {
        return this.db.prepare(`SELECT * FROM po_messages WHERE po_id = ? ORDER BY created_at`).all(id) as PoMessageRow[];
    }
    artifacts(id: string): PoArtifactRow[] {
        return this.db.prepare(`SELECT * FROM po_artifacts WHERE po_id = ? ORDER BY created_at`).all(id) as PoArtifactRow[];
    }
    links(id: string): PoTicketLinkRow[] {
        return this.db.prepare(`SELECT * FROM po_ticket_links WHERE po_id = ? ORDER BY created_at`).all(id) as PoTicketLinkRow[];
    }
    wing(po: Pick<ProductOwnerRow, "slug">): string {
        return po.slug;
    }
    private touch(id: string, patch: Partial<Pick<ProductOwnerRow, "phase" | "status" | "status_line" | "title">> = {}): void {
        const cur = this.get(id);
        if (!cur) return;
        const next = { ...cur, ...patch };
        this.db.prepare(`UPDATE product_owners SET phase = ?, status = ?, status_line = ?, title = ?, updated_at = ? WHERE id = ?`).run(next.phase, next.status, next.status_line, next.title, now(), id);
        this.emit({ poId: id, kind: "updated" });
    }
    private addMessage(poId: string, role: PoMessageRow["role"], text: string): PoMessageRow {
        const m: PoMessageRow = { id: randomUUID(), po_id: poId, role, text, created_at: now() };
        this.db.prepare(`INSERT INTO po_messages (id, po_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(m.id, m.po_id, m.role, m.text, m.created_at);
        this.emit({ poId, kind: "message", message: m });
        return m;
    }

    // Everything the PO page shows, in one read.
    detail(id: string): Record<string, unknown> | null {
        const po = this.get(id);
        if (!po) return null;
        const d = this.dir(id);
        const read = (f: string): string | null => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
        let tickets: { tickets: PoTicket[] } | null = null;
        let ticketsError: string | null = null;
        const raw = read("tickets.json");
        if (raw) {
            try {
                const parsed = PoTickets.safeParse(JSON.parse(raw));
                if (parsed.success) tickets = parsed.data;
                else ticketsError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
            } catch (e) {
                ticketsError = String((e as Error).message ?? e);
            }
        }
        return {
            po,
            running: this.active.has(id),
            context: read("context.md") ?? "",
            design: read("design.md"),
            tickets,
            ticketsError,
            proposal: read("product-context-proposal.md"),
            messages: this.messages(id),
            artifacts: this.artifacts(id),
            links: this.links(id),
            revisions: this.revisions(id),
            issues: this.issues(id),
            refreshingIssues: this.refreshing.has(id),
        };
    }

    // ---------- the global product context ----------

    productContext(): string {
        const p = join(this.productDir, "context.md");
        return existsSync(p) ? readFileSync(p, "utf8") : "";
    }
    async setProductContext(text: string): Promise<void> {
        writeFileSync(join(this.productDir, "context.md"), text);
        await this.palace.put("ctx_product", "product", "context", text, "product/context.md").catch((e: unknown) => console.warn(`[po] palace product context: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }
    async acceptProposal(poId: string): Promise<void> {
        const p = join(this.dir(poId), "product-context-proposal.md");
        if (!existsSync(p)) throw new Error("no product context proposal");
        await this.setProductContext(readFileSync(p, "utf8"));
        rmSync(p);
        this.addMessage(poId, "system", "You accepted the proposed product context. It is now the product context of every Product Owner.");
        this.emit({ poId, kind: "updated" });
    }
    rejectProposal(poId: string): void {
        rmSync(join(this.dir(poId), "product-context-proposal.md"), { force: true });
        this.addMessage(poId, "system", "You rejected the proposed product context. The product context is unchanged.");
        this.emit({ poId, kind: "updated" });
    }

    // ---------- a PO's own context ----------

    async setContext(poId: string, text: string): Promise<void> {
        const po = this.get(poId);
        if (!po) throw new Error("product owner not found");
        writeFileSync(join(this.dir(poId), "context.md"), text);
        await this.syncContext(po);
        this.emit({ poId, kind: "updated" });
    }
    private async syncContext(po: ProductOwnerRow): Promise<void> {
        const p = join(this.dir(po.id), "context.md");
        if (!existsSync(p)) return;
        await this.palace.put(`ctx_${po.slug}`, this.wing(po), "context", readFileSync(p, "utf8"), "context.md").catch((e: unknown) => console.warn(`[po] palace context ${po.slug}: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }

    // ---------- creation ----------

    async create(url: string, accountId: string | null): Promise<ProductOwnerRow> {
        const scope = await fetchScope(this.cfg, url);
        const existing = this.db.prepare(`SELECT * FROM product_owners WHERE source = ? AND scope_id = ?`).get(scope.source, scope.id) as ProductOwnerRow | undefined;
        if (existing) return existing;
        let slug = `po-${slugify(scope.title)}`;
        for (let i = 2; this.db.prepare(`SELECT 1 FROM product_owners WHERE slug = ?`).get(slug); i++) slug = `po-${slugify(scope.title)}-${i}`;
        const row: ProductOwnerRow = {
            id: randomUUID(),
            title: scope.title,
            slug,
            source: scope.source,
            scope_kind: scope.kind,
            scope_id: scope.id,
            scope_url: scope.url,
            team_id: scope.teamId,
            phase: "context",
            status: "idle",
            status_line: null,
            session_id: randomUUID(),
            account_id: accountId,
            created_at: now(),
            updated_at: now(),
        };
        this.db
            .prepare(`INSERT INTO product_owners (id, title, slug, source, scope_kind, scope_id, scope_url, team_id, phase, status, status_line, session_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(row.id, row.title, row.slug, row.source, row.scope_kind, row.scope_id, row.scope_url, row.team_id, row.phase, row.status, row.status_line, row.session_id, row.account_id, row.created_at, row.updated_at);
        mkdirSync(join(this.dir(row.id), "artifacts"), { recursive: true });
        writeFileSync(join(this.dir(row.id), "context.md"), "");
        this.addArtifactText(row.id, scope.source, `${scope.kind === "project" ? "Linear project" : "ClickUp epic"}: ${scope.title}`, scope.url, scope.markdown);
        void this.assignExistingTasks(row);
        const what = scope.kind === "project" ? "Linear project" : "ClickUp epic";
        void this.send(row.id, `Start the Context phase. Read the ${what} artifact and the product context. Write a first context.md. Then tell me in a few bullets what this project is, what is still unclear, and which sources you need from me.`, { system: true });
        return this.get(row.id) ?? row;
    }

    async remove(poId: string): Promise<void> {
        this.active.get(poId)?.kill();
        this.db.prepare(`UPDATE tasks SET product_owner_id = NULL WHERE product_owner_id = ?`).run(poId);
        for (const t of ["po_messages", "po_artifacts", "po_ticket_links", "po_issues"]) this.db.prepare(`DELETE FROM ${t} WHERE po_id = ?`).run(poId);
        this.db.prepare(`DELETE FROM product_owners WHERE id = ?`).run(poId);
        rmSync(this.dir(poId), { recursive: true, force: true });
    }

    // ---------- artifacts ----------

    private addArtifactText(poId: string, kind: PoArtifactRow["kind"], title: string, sourceUrl: string | null, markdown: string): PoArtifactRow {
        const file = `artifacts/${randomUUID().slice(0, 8)}-${sharedFileName(`${title.slice(0, 60)}.md`)}`;
        writeFileSync(join(this.dir(poId), file), markdown);
        return this.insertArtifact({ id: randomUUID(), po_id: poId, kind, title, source_url: sourceUrl, file, mime: "text/markdown", size: Buffer.byteLength(markdown), created_at: now() });
    }
    private insertArtifact(a: PoArtifactRow): PoArtifactRow {
        this.db.prepare(`INSERT INTO po_artifacts (id, po_id, kind, title, source_url, file, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.po_id, a.kind, a.title, a.source_url, a.file, a.mime, a.size, a.created_at);
        this.queueIndex(a.po_id, a.id);
        this.emit({ poId: a.po_id, kind: "updated" });
        return a;
    }
    async fetchArtifact(poId: string, url: string): Promise<PoArtifactRow> {
        if (!this.get(poId)) throw new Error("product owner not found");
        const src = await fetchSource(this.cfg, url);
        return this.addArtifactText(poId, src.kind, src.title, src.url, src.markdown);
    }
    // Text the human pastes (a conversation with people, notes): a markdown source like any other. With `tell`, the PO
    // gets a turn to read it and bring its context and palace up to date (unless it is answering).
    pasteArtifact(poId: string, title: string, text: string, tell: boolean): PoArtifactRow {
        if (!this.get(poId)) throw new Error("product owner not found");
        const name = title.trim() || `Pasted text ${now().slice(0, 16).replace("T", " ")}`;
        const a = this.addArtifactText(poId, "text", name, null, `# ${name}\nPasted by the human · ${new Date().toLocaleString()}\n\n${text.trim()}`);
        if (tell)
            this.brief(poId, `I added a source: ${a.file} — "${name}", text I pasted (often a conversation with people). Read it. Bring context.md up to date with the decisions, facts and open questions it holds, and file them in your palace drawers (update, do not append). If it contradicts design.md or tickets.json, say so. Then answer with a short summary of what it changed.`);
        return a;
    }
    uploadArtifact(poId: string, name: string, bytes: Buffer, mime: string | null): PoArtifactRow {
        if (!this.get(poId)) throw new Error("product owner not found");
        const file = `artifacts/${randomUUID().slice(0, 8)}-${sharedFileName(name)}`;
        writeFileSync(join(this.dir(poId), file), bytes);
        return this.insertArtifact({ id: randomUUID(), po_id: poId, kind: "upload", title: name, source_url: null, file, mime, size: bytes.length, created_at: now() });
    }
    removeArtifact(poId: string, artifactId: string): void {
        const a = this.db.prepare(`SELECT * FROM po_artifacts WHERE id = ? AND po_id = ?`).get(artifactId, poId) as PoArtifactRow | undefined;
        if (!a) return;
        this.indexing = this.indexing.then(() => this.palace.deleteWhere({ artifact_id: a.id }, [`art_${a.id}`])).then(() => undefined, () => undefined);
        rmSync(join(this.dir(poId), a.file), { force: true });
        this.db.prepare(`DELETE FROM po_artifacts WHERE id = ?`).run(artifactId);
        this.emit({ poId, kind: "updated" });
    }

    // ---------- the palace index of sources and issues ----------

    // Palace writes run one at a time: each is a Python process on the same Chroma store.
    private indexing: Promise<void> = Promise.resolve();
    private queueIndex(poId: string, artifactId: string): void {
        this.indexing = this.indexing.then(() => this.indexArtifact(poId, artifactId)).catch((e: unknown) => console.warn(`[po] index ${artifactId}: ${String((e as Error).message ?? e).slice(0, 200)}`));
    }

    // Files a text source as verbatim chunks (see palace-index.ts), replacing the ones filed before. A text whose hash
    // matches the last filing is skipped. The old single drawer `art_<id>` goes too.
    private async indexArtifact(poId: string, artifactId: string): Promise<void> {
        const po = this.get(poId);
        const a = this.db.prepare(`SELECT * FROM po_artifacts WHERE id = ? AND po_id = ?`).get(artifactId, poId) as PoArtifactRow | undefined;
        if (!po || !a) return;
        if (!(a.mime?.startsWith("text/") || /\.(md|txt|csv|json)$/i.test(a.file))) return;
        const path = join(this.dir(poId), a.file);
        if (!existsSync(path)) return;
        const text = readFileSync(path, "utf8");
        const hash = createHash("sha256").update(text).digest("hex");
        if (a.indexed_hash === hash) return;
        const chunks = chunkText(text);
        await this.palace.deleteWhere({ artifact_id: a.id }, [`art_${a.id}`]);
        await this.palace.putMany(
            chunks.map((c, n) => ({
                id: `art_${a.id}_${n}`,
                text: drawerText(a.title, a.file, c),
                meta: { wing: this.wing(po), room: "artifacts", source_file: a.file, chunk_index: n, artifact_id: a.id, section: c.section.slice(0, 200) },
            })),
        );
        this.db.prepare(`UPDATE po_artifacts SET indexed_hash = ?, chunks = ? WHERE id = ?`).run(hash, chunks.length, a.id);
        this.emit({ poId, kind: "updated" });
    }

    // Files one issue (its head and description, each comment) in room `issues`, replacing what was filed before.
    private queueIssueIndex(po: ProductOwnerRow, identifier: string): void {
        this.indexing = this.indexing
            .then(async () => {
                const row = this.db.prepare(`SELECT * FROM po_issues WHERE po_id = ? AND identifier = ?`).get(po.id, identifier) as PoIssueRow | undefined;
                const ref = `${po.id}:${identifier}`;
                await this.palace.deleteWhere({ issue_ref: ref });
                if (!row) return;
                const issue = JSON.parse(row.data) as TrackedIssue;
                await this.palace.putMany(
                    issueDrawers(issue).map((d, n) => ({
                        id: `iss_${po.id.slice(0, 8)}_${identifier}_${d.part}`,
                        text: d.text,
                        meta: { wing: this.wing(po), room: "issues", source_file: "issues.md", chunk_index: n, issue_ref: ref, issue: identifier },
                    })),
                );
                this.db.prepare(`UPDATE po_issues SET indexed_hash = ? WHERE po_id = ? AND identifier = ?`).run(row.hash, po.id, identifier);
            })
            .catch((e: unknown) => console.warn(`[po] index issue ${identifier}: ${String((e as Error).message ?? e).slice(0, 200)}`));
    }

    // At start: file what is not filed yet, or changed since (sources from before chunking, issues of the first refresh).
    private reindexAll(): void {
        for (const po of this.list()) {
            for (const a of this.artifacts(po.id)) if (!a.indexed_hash) this.queueIndex(po.id, a.id);
            const rows = this.db.prepare(`SELECT identifier FROM po_issues WHERE po_id = ? AND (indexed_hash IS NULL OR indexed_hash != hash)`).all(po.id) as Array<{ identifier: string }>;
            for (const r of rows) this.queueIssueIndex(po, r.identifier);
        }
    }

    // ---------- revisions ----------

    // Every version of design.md and tickets.json the agent writes is kept, so the page can show what a round changed.
    private snapshot(poId: string): void {
        const d = this.dir(poId);
        mkdirSync(join(d, "revisions"), { recursive: true });
        for (const f of ["design.md", "tickets.json"]) {
            const p = join(d, f);
            if (!existsSync(p)) continue;
            const text = readFileSync(p, "utf8");
            const prev = this.revisions(poId).filter((r) => r.file === f).pop();
            if (prev && readFileSync(join(d, "revisions", prev.name), "utf8") === text) continue;
            writeFileSync(join(d, "revisions", `${f}.${Date.now()}`), text);
        }
    }
    revisions(poId: string): Array<{ file: string; name: string; at: string }> {
        const dir = join(this.dir(poId), "revisions");
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
            .map((name) => {
                const m = /^(.+)\.(\d+)$/.exec(name);
                return m ? { file: m[1]!, name, at: new Date(Number(m[2])).toISOString() } : null;
            })
            .filter((x): x is { file: string; name: string; at: string } => !!x)
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    revision(poId: string, name: string): string {
        if (!/^[\w.-]+$/.test(name)) throw new Error("bad revision name");
        return readFileSync(join(this.dir(poId), "revisions", name), "utf8");
    }

    // ---------- turns ----------

    private account(po: ProductOwnerRow): AccountRow | null {
        const all = this.db.prepare(`SELECT * FROM accounts WHERE logged_in = 1 ORDER BY created_at`).all() as AccountRow[];
        return (po.account_id ? all.find((a) => a.id === po.account_id) : undefined) ?? all.find((a) => a.oauth_token) ?? null;
    }

    private systemPrompt(po: ProductOwnerRow): string {
        const d = this.dir(po.id);
        const ctx = existsSync(join(d, "context.md")) ? readFileSync(join(d, "context.md"), "utf8") : "";
        const arts = this.artifacts(po.id);
        const phaseNote: Record<PoPhase, string> = {
            context: "Context: collect and understand the sources. Keep context.md current. Ask the questions that block a design. Write design.md when the human asks for it or the context is complete.",
            design: "Design: refine design.md with the human, section by section. Tickets come after the human approves the design.",
            tickets: "Tickets: the design is approved. Split it into tickets in tickets.json, and refine them with the human. Stagehand creates them after the human approves.",
            approved: "Approved: Stagehand is creating the tickets. Do not change tickets.json.",
            live: "Live: the tickets exist. Keep context.md current, answer questions, and review task designs on request.",
        };
        return [
            `You are the Product Owner of "${po.title}" — ${po.source === "linear" ? "a Linear project" : "a ClickUp epic"}: ${po.scope_url ?? po.scope_id}.`,
            `Your folder: ${d}. Your palace wing: ${this.wing(po)}. Your diary agent name: ${po.slug}.`,
            `Phase: ${PHASE_LABEL[po.phase]}. ${phaseNote[po.phase]}`,
            `## Product context (the whole product — read-only; propose a change in product-context-proposal.md)\n\n${this.productContext().trim() || "(empty — ask the human for it when you need it)"}`,
            `## Your project context (context.md)\n\n${ctx.trim() || "(empty — write it)"}`,
            `## Issues\n\nEvery issue of the project, with its comments, is in your wing, room \`issues\` (current state in full: issues.md). Stagehand reads them again every hour and tells you what changed.`,
            `## Artifacts (${arts.length}) — search them in your wing, room \`artifacts\`; read a file only when search is not enough\n\n${arts.map((a) => `- ${a.file} — ${a.title}${a.source_url ? ` (${a.source_url})` : ""} [${a.kind}${a.chunks ? `, ${a.chunks} chunks` : ""}]`).join("\n") || "(none)"}`,
            `Local API: ${this.apiUrl} (STAGEHAND_API). Now: ${new Date().toLocaleString()}.`,
        ].join("\n\n");
    }

    private runEnv(po: ProductOwnerRow, acc: AccountRow | null): Record<string, string> {
        return {
            ...authEnv(acc),
            STAGEHAND_API: this.apiUrl,
            STAGEHAND_PO_ID: po.id,
            STAGEHAND_PO_WING: this.wing(po),
            STAGEHAND_PO: "1",
            MEMPALACE_HOME: this.palace.home,
            STAGEHAND_PALACE_PATH: this.palace.palacePath,
            STAGEHAND_PALACE_SCRIPT: PALACE_SCRIPT,
        };
    }

    // One chat turn: the human's message (or a system brief), in the PO's own session.
    async send(poId: string, text: string, opts: { system?: boolean } = {}): Promise<void> {
        const po = this.get(poId);
        if (!po) throw new Error("product owner not found");
        if (this.active.has(poId)) throw new Error("the Product Owner is still answering — wait for it, or stop it");
        const acc = this.account(po);
        if (!acc?.oauth_token) throw new Error("no AI account with a token — set one up on the AI accounts page");
        this.addMessage(poId, opts.system ? "system" : "user", text);
        const first = !this.messages(poId).some((m) => m.role === "agent");
        this.trust(poId);
        mkdirSync(join(this.dir(poId), "logs"), { recursive: true });
        const run = startClaude({
            prompt: text,
            cwd: this.dir(poId),
            configDir: this.configDir,
            extraEnv: this.runEnv(po, acc),
            ...(first ? { sessionId: po.session_id, name: po.slug } : { resume: po.session_id }),
            ...(this.cfg.defaultModel ? { model: this.cfg.defaultModel } : {}),
            maxTurns: 80,
            appendSystemPrompt: this.systemPrompt(po),
            mcpConfig: this.palace.mcpConfigPath,
            eventLogPath: join(this.dir(poId), "logs", `${Date.now()}.ndjson`),
        });
        this.active.set(poId, run);
        this.touch(poId, { status: "running", status_line: "answering…" });
        let answer = "";
        run.on("activity", (ev: ActivityEvent) => {
            const raw = ev.raw as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
            if (raw.type !== "assistant") return;
            for (const block of raw.message?.content ?? []) {
                if (block["type"] === "text" && typeof block["text"] === "string") {
                    answer = block["text"];
                    this.emit({ poId, kind: "text", text: answer });
                } else if (block["type"] === "tool_use") {
                    const input = block["input"] as Record<string, unknown> | undefined;
                    const hint = String(input?.["query"] ?? input?.["file_path"] ?? input?.["command"] ?? "").slice(0, 90);
                    this.emit({ poId, kind: "activity", text: `${String(block["name"]).replace(/^mcp__mempalace__/, "palace: ")} ${hint}`.trim() });
                }
            }
        });
        const outcome = await run.done;
        this.active.delete(poId);
        if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: null, taskId: null, runId: null, kind: "product_owner", stage: null }, outcome.result);
        const reply = (outcome.result?.result?.trim() || answer.trim()).trim();
        if (reply) this.addMessage(poId, "agent", reply);
        await this.afterTurn(poId);
        const failed = !reply ? outcome.stderr.trim().split("\n").pop()?.slice(0, 300) || `exited with ${outcome.exitCode ?? "?"}` : null;
        this.touch(poId, { status: failed ? "failed" : "idle", status_line: failed });
    }

    stop(poId: string): void {
        this.active.get(poId)?.kill();
    }

    // After a turn: file context.md in the palace, keep a revision of what changed, and say what is wrong with tickets.json.
    private async afterTurn(poId: string): Promise<void> {
        const po = this.get(poId);
        if (!po) return;
        await this.syncContext(po);
        this.snapshot(poId);
        const p = join(this.dir(poId), "tickets.json");
        if (existsSync(p)) {
            try {
                const parsed = PoTickets.safeParse(JSON.parse(readFileSync(p, "utf8")));
                if (!parsed.success) this.addMessage(poId, "system", `tickets.json does not match its format: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. The next turn must fix it.`);
            } catch (e) {
                this.addMessage(poId, "system", `tickets.json is not valid JSON: ${String((e as Error).message ?? e).slice(0, 200)}`);
            }
        }
        if (po.phase === "context" && existsSync(join(this.dir(poId), "design.md"))) this.touch(poId, { phase: "design" });
        await this.linkExisting(po);
    }

    // Tickets that name an existing issue get their link (id, url) once, so the Tickets page and task assignment see them.
    private async linkExisting(po: ProductOwnerRow): Promise<void> {
        const p = join(this.dir(po.id), "tickets.json");
        if (!existsSync(p)) return;
        const parsed = PoTickets.safeParse(JSON.parse(readFileSync(p, "utf8")));
        if (!parsed.success) return;
        const have = new Set(this.links(po.id).map((l) => l.key));
        for (const t of parsed.data.tickets) {
            if (!t.existing || have.has(t.key)) continue;
            const found = await findIssue(this.cfg, po.source, t.existing).catch(() => null);
            if (!found) {
                this.addMessage(po.id, "system", `${t.key} names ${t.existing}, which Stagehand cannot find in ${po.source === "linear" ? "Linear" : "ClickUp"}.`);
                continue;
            }
            this.db.prepare(`INSERT OR IGNORE INTO po_ticket_links (po_id, key, remote_id, identifier, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(po.id, t.key, found.id, found.identifier, found.url, now());
        }
        this.emit({ poId: po.id, kind: "updated" });
    }

    // Open Stagehand tasks whose ticket belongs to this PO's project or epic get it as their Product Owner.
    private async assignExistingTasks(po: ProductOwnerRow): Promise<void> {
        const tasks = this.db.prepare(`SELECT id, source, ticket_id FROM tasks WHERE source = ? AND stage != 'done' AND product_owner_id IS NULL`).all(po.source) as Array<{ id: string; source: "linear" | "clickup"; ticket_id: string }>;
        for (const t of tasks) {
            const scope = await ticketScopeId(this.cfg, t.source, t.ticket_id);
            if (scope === po.scope_id) {
                this.db.prepare(`UPDATE tasks SET product_owner_id = ?, updated_at = ? WHERE id = ?`).run(po.id, now(), t.id);
                this.onTaskChanged(t.id);
            }
        }
    }

    // ---------- the project's issues, refreshed ----------

    issues(poId: string): TrackedIssue[] {
        return (this.db.prepare(`SELECT * FROM po_issues WHERE po_id = ? ORDER BY identifier`).all(poId) as PoIssueRow[])
            .map((r) => JSON.parse(r.data) as TrackedIssue)
            .sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
    }

    // Every few minutes: refresh the issues of each PO whose last refresh is an hour old. A PO that is answering waits
    // for the next look, so its brief never collides with a turn.
    startIssueRefresh(): void {
        if (this.refreshTimer) return;
        const tick = async (): Promise<void> => {
            for (const po of this.list()) {
                const last = po.issues_refreshed_at ? Date.parse(po.issues_refreshed_at) : 0;
                if (Date.now() - last < ISSUES_REFRESH_MS || this.active.has(po.id) || this.refreshing.has(po.id)) continue;
                await this.refreshIssues(po.id).catch((e: unknown) => console.warn(`[po] issues ${po.slug}: ${String((e as Error).message ?? e).slice(0, 200)}`));
            }
        };
        this.refreshTimer = setInterval(() => void tick(), ISSUES_TICK_MS);
        setTimeout(() => this.reindexAll(), 20_000);
        setTimeout(() => void tick(), 60_000);
    }

    // Reads every issue of the project again (fields and comments), compares each with the last state by its hash, and
    // when something changed briefs the PO with the differences, to bring context.md and its palace drawers up to date.
    // The first refresh only briefs the PO when the issues have comments it has not read.
    async refreshIssues(poId: string): Promise<{ total: number; added: number; changed: number; removed: number; briefed: boolean }> {
        const po = this.get(poId);
        if (!po) throw new Error("product owner not found");
        if (this.refreshing.has(poId)) throw new Error("the issues are already being refreshed");
        if (this.active.has(poId)) throw new Error("the Product Owner is answering — refresh after its turn");
        this.refreshing.add(poId);
        this.emit({ poId, kind: "updated" });
        try {
            let fetched: TrackedIssue[];
            try {
                fetched = await fetchScopeIssues(this.cfg, po.source, po.scope_id);
            } catch (e) {
                this.db.prepare(`UPDATE product_owners SET issues_error = ? WHERE id = ?`).run(String((e as Error).message ?? e).slice(0, 300), poId);
                throw e;
            }
            const at = now();
            const prev = new Map((this.db.prepare(`SELECT * FROM po_issues WHERE po_id = ?`).all(poId) as PoIssueRow[]).map((r) => [r.identifier, r]));
            const first = prev.size === 0;
            const sections: string[] = [];
            let added = 0;
            let changed = 0;
            let removed = 0;
            const upsert = this.db.prepare(
                `INSERT INTO po_issues (po_id, identifier, remote_id, hash, data, fetched_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (po_id, identifier) DO UPDATE SET remote_id = excluded.remote_id, hash = excluded.hash, data = excluded.data, fetched_at = excluded.fetched_at, changed_at = excluded.changed_at`,
            );
            this.db.transaction(() => {
                for (const i of fetched) {
                    const hash = issueHash(i);
                    const old = prev.get(i.identifier);
                    if (old && old.hash === hash) {
                        this.db.prepare(`UPDATE po_issues SET fetched_at = ? WHERE po_id = ? AND identifier = ?`).run(at, poId, i.identifier);
                        continue;
                    }
                    upsert.run(poId, i.identifier, i.remoteId, hash, JSON.stringify(i), at, at);
                    if (!old) {
                        added++;
                        if (!first) sections.push(`## New issue ${i.identifier} — ${i.title}\n${i.url} · **${i.status ?? "?"}**${i.labels.length ? ` · labels: ${i.labels.join(", ")}` : ""}\n\n${i.description}${i.comments.length ? `\n\n${i.comments.map((c) => `**${c.author}** (${c.at}):\n${quote(c.body)}`).join("\n\n")}` : ""}`);
                        continue;
                    }
                    changed++;
                    const lines = describeChange(JSON.parse(old.data) as TrackedIssue, i);
                    sections.push(`## ${i.identifier} — ${i.title}\n${i.url}\n\n${lines.join("\n") || "- Changed in a field Stagehand does not show."}`);
                }
                for (const [id, old] of prev) {
                    if (fetched.some((i) => i.identifier === id)) continue;
                    this.db.prepare(`DELETE FROM po_issues WHERE po_id = ? AND identifier = ?`).run(poId, id);
                    removed++;
                    sections.push(`## ${id} — ${(JSON.parse(old.data) as TrackedIssue).title}\n- **Left the project** (moved out or deleted).`);
                }
                this.db.prepare(`UPDATE product_owners SET issues_refreshed_at = ?, issues_error = NULL WHERE id = ?`).run(at, poId);
            })();
            writeFileSync(join(this.dir(poId), "issues.md"), renderIssues(fetched, at));
            for (const i of fetched) if (prev.get(i.identifier)?.hash !== issueHash(i)) this.queueIssueIndex(po, i.identifier);
            for (const id of prev.keys()) if (!fetched.some((i) => i.identifier === id)) this.queueIssueIndex(po, id);
            this.assignTasksOfIssues(po, fetched);
            let briefed = false;
            const commented = fetched.filter((i) => i.comments.length).length;
            if (first && commented) {
                briefed = this.brief(poId, `Stagehand now tracks every issue of the project: issues.md in your folder holds each one with its status, labels and comments (${commented} of ${fetched.length} have comments). Read the comments. Bring context.md up to date with the decisions, answers and changes of scope they record. File them in your palace drawers (update, do not append). Then answer with a short summary: what the comments changed in what you know, and what conflicts with design.md or tickets.json.`);
            } else if (sections.length) {
                const report = `# Issue changes — ${new Date(at).toLocaleString()}\n\n${added} new, ${changed} changed, ${removed} gone.\n\n${sections.join("\n\n")}`;
                const art = this.addArtifactText(poId, po.source, `Issue changes ${at.slice(0, 16).replace("T", " ")}`, po.scope_url, report);
                briefed = this.brief(
                    poId,
                    `The project's issues changed since the last refresh (the full report is ${art.file}; issues.md holds the current state):\n\n${report.length > 30_000 ? `${report.slice(0, 30_000)}\n\n… (cut; read the report)` : report}\n\nBring context.md up to date where a change alters what you know. Update the palace drawers it touches (update, do not append). If a change contradicts design.md or tickets.json, say so; change tickets.json only for tickets that are not created yet. Then answer with a short summary: what changed and what you updated.`,
                );
            }
            this.emit({ poId, kind: "updated" });
            return { total: fetched.length, added, changed, removed, briefed };
        } finally {
            this.refreshing.delete(poId);
            this.emit({ poId, kind: "updated" });
        }
    }

    // A system turn for the PO, unless one is running (then the report artifact and issues.md carry the change).
    private brief(poId: string, text: string): boolean {
        if (this.active.has(poId)) return false;
        void this.send(poId, text, { system: true }).catch((e: unknown) => console.warn(`[po] brief ${poId}: ${String((e as Error).message ?? e).slice(0, 160)}`));
        return true;
    }

    // Open tasks for one of the project's issues get this PO, so a product ticket and its task are linked.
    private assignTasksOfIssues(po: ProductOwnerRow, issues: TrackedIssue[]): void {
        const ids = new Set(issues.flatMap((i) => [i.identifier.toUpperCase(), i.remoteId]));
        const tasks = this.db.prepare(`SELECT id, ticket_id FROM tasks WHERE source = ? AND product_owner_id IS NULL`).all(po.source) as Array<{ id: string; ticket_id: string }>;
        for (const t of tasks) {
            if (!ids.has(t.ticket_id.toUpperCase()) && !ids.has(t.ticket_id)) continue;
            this.db.prepare(`UPDATE tasks SET product_owner_id = ?, updated_at = ? WHERE id = ?`).run(po.id, now(), t.id);
            this.onTaskChanged(t.id);
        }
    }

    // ---------- approvals and ticket creation ----------

    async approveDesign(poId: string): Promise<void> {
        const po = this.get(poId);
        if (!po) throw new Error("product owner not found");
        if (!existsSync(join(this.dir(poId), "design.md"))) throw new Error("there is no design.md yet");
        this.touch(poId, { phase: "tickets" });
        void this.send(poId, "I approve the design. Split it into tickets in tickets.json, in the format of your CLAUDE.md. Then summarise the split for me: the epics, the ticket count, and the dependencies.", { system: true }).catch((e: unknown) => console.warn(`[po] ${po.slug}: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }

    // Creates the approved tickets in the task manager, parents first, skipping the ones created before (a retry).
    async approveTickets(poId: string): Promise<{ created: number; skipped: number }> {
        const po = this.get(poId);
        if (!po) throw new Error("product owner not found");
        if (this.active.has(poId)) throw new Error("the Product Owner is still answering — wait for it");
        const raw = join(this.dir(poId), "tickets.json");
        if (!existsSync(raw)) throw new Error("there is no tickets.json yet");
        const { tickets } = PoTickets.parse(JSON.parse(readFileSync(raw, "utf8")));
        if (!po.team_id) throw new Error(po.source === "linear" ? "the Linear project has no team to create issues in" : "the ClickUp epic has no list to create tasks in");
        this.touch(poId, { phase: "approved", status: "running", status_line: `creating ${tickets.length} ticket(s)…` });
        const done = new Map(this.links(poId).map((l) => [l.key, l]));
        const order = [...tickets].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
        let created = 0;
        try {
            for (const t of order) {
                if (done.has(t.key)) continue;
                if (t.existing) {
                    const found = await findIssue(this.cfg, po.source, t.existing);
                    if (!found) throw new Error(`${t.key} names ${t.existing}, which does not exist`);
                    const link: PoTicketLinkRow = { po_id: poId, key: t.key, remote_id: found.id, identifier: found.identifier, url: found.url, created_at: now() };
                    this.db.prepare(`INSERT OR IGNORE INTO po_ticket_links (po_id, key, remote_id, identifier, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(link.po_id, link.key, link.remote_id, link.identifier, link.url, link.created_at);
                    done.set(t.key, link);
                    continue;
                }
                const parent = t.parent ? done.get(t.parent) : undefined;
                const byKey = new Map(tickets.map((x) => [x.key, x]));
                const deps = t.dependsOn.map((k) => done.get(k)?.identifier ?? byKey.get(k)?.title ?? k);
                const description = [
                    t.description,
                    t.acceptanceCriteria.length ? `## Acceptance criteria\n\n${t.acceptanceCriteria.map((a) => `- [ ] ${a}`).join("\n")}` : "",
                    deps.length ? `**Depends on:** ${deps.join(", ")}` : "",
                ]
                    .filter(Boolean)
                    .join("\n\n");
                const res =
                    po.source === "linear"
                        ? await createLinearIssue(this.cfg, { teamId: po.team_id, projectId: po.scope_id, title: t.title, description, parentId: parent?.remote_id ?? null, estimate: t.estimate })
                        : await createClickUpTask(this.cfg, { listId: po.team_id, parentId: parent?.remote_id ?? po.scope_id, name: t.title, description });
                const link: PoTicketLinkRow = { po_id: poId, key: t.key, remote_id: res.id, identifier: res.identifier, url: res.url, created_at: now() };
                this.db.prepare(`INSERT INTO po_ticket_links (po_id, key, remote_id, identifier, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(link.po_id, link.key, link.remote_id, link.identifier, link.url, link.created_at);
                done.set(t.key, link);
                created++;
                this.touch(poId, { status_line: `created ${created} ticket(s)…` });
            }
        } catch (e) {
            this.touch(poId, { status: "failed", status_line: `ticket creation stopped: ${String((e as Error).message ?? e).slice(0, 200)} — Approve again to create the rest` });
            throw e;
        }
        const list = tickets.map((t) => `- ${t.key} → ${done.get(t.key)?.identifier ?? "?"} ${t.title}`).join("\n");
        this.touch(poId, { phase: "live", status: "idle", status_line: null });
        this.addMessage(poId, "system", `Stagehand created ${created} ticket(s) in ${po.source === "linear" ? "Linear" : "ClickUp"}.`);
        void this.send(
            poId,
            `The tickets exist now:\n${list}\n\nConsolidate what this project taught you: bring context.md up to date; file the product knowledge in your wing's features, users, decisions and glossary rooms (update, do not append); add knowledge-graph facts for product entities; write a diary entry for this planning round. If the project changes the product-wide picture, write product-context-proposal.md. Then answer with a short summary of what you filed.`,
            { system: true },
        ).catch((e: unknown) => console.warn(`[po] consolidation ${po.slug}: ${String((e as Error).message ?? e).slice(0, 160)}`));
        return { created, skipped: tickets.length - created };
    }

    setPhase(poId: string, phase: PoPhase): void {
        this.touch(poId, { phase });
    }

    // ---------- tasks ----------

    // The PO of a ticket: one that created it, else the one whose project or epic the ticket belongs to.
    async ownerOfTicket(source: string, ticketId: string): Promise<string | null> {
        const link = this.db.prepare(`SELECT l.po_id FROM po_ticket_links l JOIN product_owners p ON p.id = l.po_id WHERE p.source = ? AND (UPPER(l.identifier) = UPPER(?) OR l.remote_id = ?)`).get(source, ticketId, ticketId) as { po_id: string } | undefined;
        if (link) return link.po_id;
        if (source !== "linear" && source !== "clickup") return null;
        const owners = this.db.prepare(`SELECT * FROM product_owners WHERE source = ?`).all(source) as ProductOwnerRow[];
        if (!owners.length) return null;
        const scope = await ticketScopeId(this.cfg, source, ticketId);
        return owners.find((o) => o.scope_id === scope)?.id ?? null;
    }

    // Briefs in flight, by task id.
    private readonly briefs = new Map<string, ClaudeRun>();
    briefing(taskId: string): boolean {
        return this.briefs.has(taskId);
    }

    // The PO's brief on a task's ticket, before research: a fresh session in the PO's context writes po-brief.md — what
    // the research agent must pay attention to beyond the ticket text (decisions, comments, related tickets, open
    // questions). Resolves when the run ends; po-brief.json holds the state.
    async briefTask(task: TaskRow, taskDir: string, onChange: () => void = () => undefined): Promise<void> {
        if (!task.product_owner_id) throw new Error("this task has no Product Owner");
        const po = this.get(task.product_owner_id);
        if (!po) throw new Error("the task's Product Owner no longer exists");
        if (this.briefs.has(task.id)) throw new Error("the Product Owner is already writing this brief");
        const acc = this.account(po);
        if (!acc?.oauth_token) throw new Error("no AI account with a token — set one up on the AI accounts page");
        this.trust(po.id);
        const out = join(taskDir, "po-brief.md");
        const state = (s: Record<string, unknown>): void => writeFileSync(join(taskDir, "po-brief.json"), JSON.stringify({ ...s, at: now() }, null, 2));
        state({ status: "running" });
        const prompt = [
            `Write a brief on ticket ${task.ticket_id}${task.title ? ` (${task.title})` : ""} for the agent that researches it next, as the Product Owner of "${po.title}".`,
            `Read ${taskDir}/ticket.json${existsSync(join(taskDir, "tickets")) ? ` and ${taskDir}/tickets/` : ""}. Search your wing for what you know about this ticket and its area: rooms \`issues\` (its comments and the neighbouring issues), \`decisions\`, \`features\`, \`artifacts\`. Read a file only when search is not enough.`,
            `Give only what the ticket text does not already say and the research must not miss: product decisions that apply (name the source — a decision id, a comment and its author), constraints, related or dependent tickets and how they touch this one, open questions and contradictions, the user intent behind the ticket.`,
            `Write ${out}: 200 words or fewer, bullets only, each with a **bold lead-in**. When you know nothing beyond the ticket, write "Nothing beyond the ticket." Do not change any other file of the task.`,
            `Then answer with one line: DONE.`,
        ].join("\n\n");
        const run = startClaude({
            prompt,
            cwd: this.dir(po.id),
            configDir: this.configDir,
            extraEnv: this.runEnv(po, acc),
            sessionId: randomUUID(),
            name: `${po.slug}-brief-${task.ticket_id}`,
            ...(this.cfg.defaultModel ? { model: this.cfg.defaultModel } : {}),
            maxTurns: 40,
            addDirs: [taskDir],
            appendSystemPrompt: this.systemPrompt(po),
            mcpConfig: this.palace.mcpConfigPath,
            eventLogPath: join(taskDir, `po-brief-${Date.now()}.ndjson`),
        });
        this.briefs.set(task.id, run);
        onChange();
        const started = Date.now();
        const outcome = await run.done;
        this.briefs.delete(task.id);
        if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: task.env_id, taskId: task.id, runId: null, kind: "product_owner", stage: null }, outcome.result);
        const ok = existsSync(out) && statSync(out).mtimeMs >= started - 1000;
        state(ok ? { status: "done" } : { status: "failed", error: outcome.stderr.trim().split("\n").pop()?.slice(0, 300) || `exited with ${outcome.exitCode ?? "?"}` });
        onChange();
    }

    reviewing(taskId: string): boolean {
        return this.reviews.has(taskId);
    }

    // "Review by Product owner": a fresh session in the PO's context reads the task's proposal and writes po-review.md
    // into the task folder. It never edits the proposal itself; the human edits the review and sends it on.
    async reviewTask(task: TaskRow, taskDir: string, onDone: () => void): Promise<void> {
        if (!task.product_owner_id) throw new Error("this task has no Product Owner");
        const po = this.get(task.product_owner_id);
        if (!po) throw new Error("the task's Product Owner no longer exists");
        if (this.reviews.has(task.id)) throw new Error("the Product Owner is already reviewing this task");
        if (!existsSync(join(taskDir, "design.md"))) throw new Error("the task has no design proposal yet");
        const acc = this.account(po);
        if (!acc?.oauth_token) throw new Error("no AI account with a token — set one up on the AI accounts page");
        this.trust(po.id);
        const out = join(taskDir, "po-review.md");
        const state = (s: Record<string, unknown>): void => writeFileSync(join(taskDir, "po-review.json"), JSON.stringify({ ...s, at: now() }, null, 2));
        state({ status: "running" });
        const prompt = [
            `Review the design proposal of task ${task.ticket_id}${task.title ? ` (${task.title})` : ""} as the Product Owner of "${po.title}".`,
            `Read ${taskDir}/design.md, ${taskDir}/design.json (its QA scenarios), ${taskDir}/research.md and ${taskDir}/ticket.json. Search the palace for the product facts that matter. ${task.worktree_path ? `The code is in ${task.worktree_path}; read it only to check a claim.` : ""}`,
            `Judge the proposal as product, not as code: does it solve the ticket's problem for its users, does the scope match the ticket and the project, do the QA scenarios test what the user needs, what does it miss or break for other parts of the product.`,
            `Write ${out} with exactly these \`## \` sections: \`Verdict\` (one line: **approve** or **changes** — and why, 20 words or fewer), \`Product concerns\`, \`Scope gaps\`, \`Acceptance criteria\` (each one: met, missed or unclear), \`QA scenarios\`, \`Questions\`. Every bullet opens with a bold lead-in. Leave a section with "None." when it has nothing. Do not change any other file of the task.`,
            `Then answer with one line: DONE.`,
        ].join("\n\n");
        const run = startClaude({
            prompt,
            cwd: this.dir(po.id),
            configDir: this.configDir,
            extraEnv: this.runEnv(po, acc),
            sessionId: randomUUID(),
            name: `${po.slug}-review-${task.ticket_id}`,
            ...(this.cfg.defaultModel ? { model: this.cfg.defaultModel } : {}),
            maxTurns: 60,
            addDirs: [taskDir, ...(task.worktree_path ? [task.worktree_path] : [])],
            appendSystemPrompt: this.systemPrompt(po),
            mcpConfig: this.palace.mcpConfigPath,
            eventLogPath: join(taskDir, `po-review-${Date.now()}.ndjson`),
        });
        this.reviews.set(task.id, run);
        onDone();
        void run.done.then((outcome) => {
            this.reviews.delete(task.id);
            if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: task.env_id, taskId: task.id, runId: null, kind: "product_owner", stage: null }, outcome.result);
            const ok = existsSync(out) && statSync(out).mtimeMs > Date.now() - 2 * 3600_000;
            state(ok ? { status: "done" } : { status: "failed", error: outcome.stderr.trim().split("\n").pop()?.slice(0, 300) || `exited with ${outcome.exitCode ?? "?"}` });
            onDone();
        });
    }
}
