import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Config } from "./config.js";
import { now, type AccountRow, type DB, type PoArtifactRow, type PoMessageRow, type PoPhase, type PoTicketLinkRow, type ProductOwnerRow, type TaskRow } from "./db.js";
import { authEnv } from "./claude/accounts.js";
import { startClaude, type ActivityEvent, type ClaudeRun } from "./claude/runner.js";
import { recordUsage } from "./usage.js";
import type { Palace } from "./palace.js";
import { createClickUpTask, createLinearIssue, fetchScope, fetchSource, findIssue, ticketScopeId } from "./sources.js";
import { sharedFileName } from "./tickets.js";

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

const PHASE_LABEL: Record<PoPhase, string> = { context: "Context", design: "Design", tickets: "Tickets", approved: "Approved", live: "Live" };

export class ProductOwners {
    readonly root: string;
    readonly configDir: string;
    readonly productDir: string;
    private readonly active = new Map<string, ClaudeRun>();
    // PO reviews of task designs in flight, by task id.
    private readonly reviews = new Map<string, ClaudeRun>();

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
        for (const t of ["po_messages", "po_artifacts", "po_ticket_links"]) this.db.prepare(`DELETE FROM ${t} WHERE po_id = ?`).run(poId);
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
        const po = this.get(a.po_id);
        // Text sources are searchable in the PO's wing; the file on disk stays the verbatim copy.
        if (po && (a.mime?.startsWith("text/") || /\.(md|txt|csv|json)$/i.test(a.file))) {
            const text = readFileSync(join(this.dir(a.po_id), a.file), "utf8").slice(0, 200_000);
            void this.palace.put(`art_${a.id}`, this.wing(po), "artifacts", `${a.title}\n${a.source_url ?? ""}\n\n${text}`, a.file).catch(() => undefined);
        }
        this.emit({ poId: a.po_id, kind: "updated" });
        return a;
    }
    async fetchArtifact(poId: string, url: string): Promise<PoArtifactRow> {
        if (!this.get(poId)) throw new Error("product owner not found");
        const src = await fetchSource(this.cfg, url);
        return this.addArtifactText(poId, src.kind, src.title, src.url, src.markdown);
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
        rmSync(join(this.dir(poId), a.file), { force: true });
        this.db.prepare(`DELETE FROM po_artifacts WHERE id = ?`).run(artifactId);
        this.emit({ poId, kind: "updated" });
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
            `## Artifacts (${arts.length})\n\n${arts.map((a) => `- ${a.file} — ${a.title}${a.source_url ? ` (${a.source_url})` : ""} [${a.kind}]`).join("\n") || "(none)"}`,
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
