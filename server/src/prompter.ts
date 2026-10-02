import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { renderSharedFiles } from "./tickets.js";
import type { SharedFile } from "./db.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { now, type AccountRow, type DB, type EnvRow, type TaskRow } from "./db.js";
import { authEnv } from "./claude/accounts.js";
import { startClaude, type ActivityEvent, type ClaudeRun, type ResultEvent } from "./claude/runner.js";
import { recordUsage } from "./usage.js";
import { parseRoute, type Route, type TaskView } from "./routes.js";
import { STAGE_DEFS } from "./stages/registry.js";
import type { Palace } from "./palace.js";

// Prompter — the assistant in the bottom-right corner of the web app. A theatre prompter feeds lines from the prompt
// box; this one knows how Stagehand works (its own MemPalace), sees where the human is (the URL hash, described per
// turn), and acts through the local API. It lives in its own data folder:
//
//   ~/.stagehand/mempalace/           = MEMPALACE_HOME: Stagehand's own palace (palace.ts), shared with the Product
//                                       Owners; it started as a copy of the palace that used to live in this folder
//   ~/.stagehand/prompter/claude/     = CLAUDE_CONFIG_DIR (CLAUDE.md, settings.json, skills/ — synced from the repo's
//                                       prompter/ folder at every start; .claude.json copied once from the main dir)
//   ~/.stagehand/prompter/.mcp.json   = the mempalace MCP server, pointed at Stagehand's palace
//   ~/.stagehand/prompter/logs/       = one stream-json event log per turn
//
// Every chat is a claude session of its own (first turn --session-id, later turns --resume); the palace is the only
// memory between chats. Several chats can be open at once (the widget's session strip); a chat ends when the human
// closes it or when it saw no activity for `idleHours` (a message, or an open window's ping); before it ends, one
// short farewell turn asks it to file what is not filed yet. Closed chats are removed after `purgeDays`. A server
// restart ends no chat: a turn that died with the server is sent again when the server is back.

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES = join(REPO_ROOT, "prompter");

export interface PrompterSessionRow {
    id: string;
    claude_session_id: string;
    model: string | null;
    account_id: string | null;
    created_at: string;
    last_at: string;
    pinged_at: string;
    closed_at: string | null;
    turns: number;
    // The first message, trimmed — the chat's name in the widget's session strip.
    title: string | null;
}
export interface PrompterMessageRow {
    id: string;
    session_id: string;
    role: "user" | "assistant" | "system";
    text: string;
    path: string | null;
    created_at: string;
    // "queued": sent by the human while a turn was running; goes to the assistant with the next turn, and can still be
    // taken back into the input (ArrowUp) until then. "sent": part of a turn.
    state: "sent" | "queued";
}
export type PrompterEvent =
    | { sessionId: string; kind: "text"; text: string }
    | { sessionId: string; kind: "activity"; text: string }
    | { sessionId: string; kind: "done"; message: PrompterMessageRow | null; error: string | null }
    // A message stacked behind the running turn / taken back out of the stack / a turn started with these messages.
    | { sessionId: string; kind: "queued"; message: PrompterMessageRow }
    | { sessionId: string; kind: "removed"; messageId: string }
    | { sessionId: string; kind: "turn"; messageIds: string[] }
    // The session list changed (a chat was created or named): widgets re-read GET /sessions.
    | { sessionId: string; kind: "updated" }
    | { sessionId: string; kind: "closed" };

export class Prompter {
    readonly home: string;
    readonly configDir: string;
    private readonly active = new Map<string, ClaudeRun>();
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly db: DB,
        private readonly cfg: Config,
        private readonly emit: (ev: PrompterEvent) => void,
        private readonly palace: Palace,
    ) {
        this.home = join(cfg.dataDir, "prompter");
        this.configDir = join(this.home, "claude");
    }

    // ---------- the data folder ----------

    // Creates the folder and refreshes the Stagehand-owned parts (identity, settings, skills, MCP) from the repo.
    ensureHome(): void {
        mkdirSync(join(this.configDir, "skills"), { recursive: true });
        mkdirSync(join(this.home, "logs"), { recursive: true });
        if (!existsSync(TEMPLATES)) return;
        const copyText = (from: string, to: string, subst?: (s: string) => string): void => {
            if (!existsSync(from)) return;
            const s = readFileSync(from, "utf8");
            writeFileSync(to, subst ? subst(s) : s);
        };
        copyText(join(TEMPLATES, "CLAUDE.md"), join(this.configDir, "CLAUDE.md"));
        copyText(join(TEMPLATES, "settings.json"), join(this.configDir, "settings.json"));
        copyText(join(TEMPLATES, "mcp.json"), join(this.home, ".mcp.json"), (s) => s.replace(/\{\{home\}\}/g, this.palace.home));
        const skills = join(TEMPLATES, "skills");
        if (existsSync(skills)) {
            rmSync(join(this.configDir, "skills"), { recursive: true, force: true });
            cpSync(skills, join(this.configDir, "skills"), { recursive: true });
        }
        // Onboarding flags and the trust of this folder come from the main config dir's .claude.json, once.
        const claudeJson = join(this.configDir, ".claude.json");
        if (!existsSync(claudeJson)) {
            let base: Record<string, unknown> = {};
            try {
                base = JSON.parse(readFileSync(join(this.cfg.mainConfigDir, ".claude.json"), "utf8")) as Record<string, unknown>;
            } catch {
                /* start from nothing */
            }
            const projects = (base["projects"] as Record<string, Record<string, unknown>> | undefined) ?? {};
            projects[this.home] = { ...(projects[this.home] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] };
            const { oauthAccount: _o, ...rest } = base;
            writeFileSync(claudeJson, JSON.stringify({ ...rest, projects }, null, 2));
        }
    }

    // The account whose token drives the assistant: the configured one, else the first account with a token.
    account(): AccountRow | null {
        const all = this.db.prepare(`SELECT * FROM accounts WHERE logged_in = 1 ORDER BY created_at`).all() as AccountRow[];
        const chosen = this.cfg.prompter.accountId ? all.find((a) => a.id === this.cfg.prompter.accountId) : undefined;
        return chosen ?? all.find((a) => a.oauth_token) ?? null;
    }

    status(): { home: string; configDir: string; account: string | null; model: string; open: number; seeded: { at: string; total: number; copied: number } | null; ready: boolean; reason: string | null } {
        const acc = this.account();
        const seeded = this.readSeedMarker();
        const open = (this.db.prepare(`SELECT COUNT(*) AS n FROM prompter_sessions WHERE closed_at IS NULL`).get() as { n: number }).n;
        const reason = !acc ? "no AI account with a token — set one up on the AI accounts page" : !acc.oauth_token ? `${acc.name} has no token (a browser-only login cannot run headless)` : null;
        return { home: this.home, configDir: this.configDir, account: acc?.name ?? null, model: this.cfg.prompter.model, open, seeded, ready: !reason, reason };
    }

    private readSeedMarker(): { at: string; total: number; copied: number } | null {
        try {
            return JSON.parse(readFileSync(join(this.home, "seeded.json"), "utf8")) as { at: string; total: number; copied: number };
        } catch {
            return null;
        }
    }

    // Copies the Stagehand knowledge out of another palace (see scripts/seed-prompter-palace.py). Re-runnable.
    async seed(): Promise<{ ok: boolean; detail: string; result?: unknown }> {
        if (!this.cfg.prompter.seedFrom.trim()) return { ok: false, detail: "no palace to seed from — set Prompter → Seed from first" };
        const script = join(REPO_ROOT, "scripts", "seed-prompter-palace.py");
        const args = [script, "--src", this.cfg.prompter.seedFrom, "--dst", this.palace.home, "--diary", "wing_claude", "--mention", "stagehand"];
        for (const w of this.cfg.prompter.seedWings) args.push("--wing", w);
        try {
            const { stdout, stderr } = await execFileAsync("python3", args, { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
            const line = stdout.trim().split("\n").pop() ?? "";
            const result = JSON.parse(line) as { copied: number; skipped: number; total: number; wings: Record<string, number>; extras: string[] };
            writeFileSync(join(this.home, "seeded.json"), JSON.stringify({ at: now(), total: result.total, copied: result.copied }));
            const wings = Object.entries(result.wings).map(([k, v]) => `${k}: ${v}`).join(", ");
            return { ok: true, detail: `${result.copied} drawer(s) copied, ${result.skipped} already there, ${result.total} in the palace (${wings})${result.extras.length ? `; copied ${result.extras.join(", ")}` : ""}${stderr.trim() ? ` — ${stderr.trim().slice(-200)}` : ""}`, result };
        } catch (e) {
            const err = e as Error & { stderr?: string; stdout?: string };
            return { ok: false, detail: `${err.message.slice(0, 200)}${err.stderr ? ` — ${err.stderr.trim().slice(-400)}` : ""}` };
        }
    }

    // ---------- sessions ----------

    listSessions(): PrompterSessionRow[] {
        return this.db.prepare(`SELECT * FROM prompter_sessions WHERE closed_at IS NULL ORDER BY created_at DESC`).all() as PrompterSessionRow[];
    }
    session(id: string): PrompterSessionRow | undefined {
        return this.db.prepare(`SELECT * FROM prompter_sessions WHERE id = ?`).get(id) as PrompterSessionRow | undefined;
    }
    messages(id: string): PrompterMessageRow[] {
        return this.db.prepare(`SELECT * FROM prompter_messages WHERE session_id = ? AND role != 'system' ORDER BY created_at`).all(id) as PrompterMessageRow[];
    }

    createSession(model?: string | null): PrompterSessionRow {
        this.ensureHome();
        const acc = this.account();
        const ts = now();
        const id = randomUUID();
        this.db
            .prepare(`INSERT INTO prompter_sessions (id, claude_session_id, model, account_id, created_at, last_at, pinged_at, closed_at, turns, title) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`)
            .run(id, randomUUID(), model?.trim() || this.cfg.prompter.model || null, acc?.id ?? null, ts, ts, ts);
        this.emit({ sessionId: id, kind: "updated" });
        return this.session(id)!;
    }

    ping(id: string): void {
        this.db.prepare(`UPDATE prompter_sessions SET pinged_at = ? WHERE id = ? AND closed_at IS NULL`).run(now(), id);
    }

    busy(id: string): boolean {
        return this.active.has(id);
    }

    // Ctrl-C for a turn: the in-flight claude run is killed; the text it had streamed so far stays in the chat marked
    // as stopped, and whatever the human stacked meanwhile goes out as the next turn (runTurn's flush). The chat
    // itself stays open. False when nothing was running.
    private readonly stopping = new Set<string>();
    stop(id: string): boolean {
        const run = this.active.get(id);
        if (!run) return false;
        this.stopping.add(id);
        run.kill();
        return true;
    }

    private addMessage(sessionId: string, role: PrompterMessageRow["role"], text: string, path: string | null, state: PrompterMessageRow["state"] = "sent"): PrompterMessageRow {
        const id = randomUUID();
        const ts = now();
        this.db.prepare(`INSERT INTO prompter_messages (id, session_id, role, text, path, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, sessionId, role, text, path, ts, state);
        this.db.prepare(`UPDATE prompter_sessions SET last_at = ?, pinged_at = ? WHERE id = ?`).run(ts, ts, sessionId);
        if (role === "user") {
            // The first message names the chat.
            const r = this.db.prepare(`UPDATE prompter_sessions SET title = ? WHERE id = ? AND title IS NULL`).run(text.replace(/\s+/g, " ").trim().slice(0, 60), sessionId);
            if (r.changes) this.emit({ sessionId, kind: "updated" });
        }
        return { id, session_id: sessionId, role, text, path, created_at: ts, state };
    }

    private queued(sessionId: string): PrompterMessageRow[] {
        return this.db.prepare(`SELECT * FROM prompter_messages WHERE session_id = ? AND state = 'queued' ORDER BY created_at`).all(sessionId) as PrompterMessageRow[];
    }

    // The human's message. While a turn runs it is stacked (state "queued") and goes to the assistant, together with
    // anything else stacked, as the next turn the moment the current one ends; otherwise a turn starts now (taking any
    // messages left stacked from before a restart with it).
    submit(id: string, text: string, path: string | null, files: SharedFile[] = []): { message: PrompterMessageRow; queued: boolean } {
        const s = this.session(id);
        if (!s || s.closed_at) throw new Error("session not found or closed");
        // Files ride in the text by absolute path (the assistant reads them; the human sees the same list).
        text += renderSharedFiles(files, this.home);
        if (this.active.has(id)) {
            const message = this.addMessage(id, "user", text, path, "queued");
            this.emit({ sessionId: id, kind: "queued", message });
            return { message, queued: true };
        }
        const earlier = this.queued(id);
        const message = this.addMessage(id, "user", text, path, "sent");
        const batch = [...earlier, message];
        if (earlier.length) {
            this.db.prepare(`UPDATE prompter_messages SET state = 'sent' WHERE session_id = ? AND state = 'queued'`).run(id);
            this.emit({ sessionId: id, kind: "turn", messageIds: batch.map((m) => m.id) });
        }
        void this.runTurn(id, batch, {}).catch((e: unknown) => console.warn(`[prompter] ${id}: ${String((e as Error).message ?? e).slice(0, 200)}`));
        return { message, queued: false };
    }

    // Takes a stacked message back (the human edits it in the input). False when it already went to the assistant.
    unqueue(id: string, messageId: string): boolean {
        const r = this.db.prepare(`DELETE FROM prompter_messages WHERE id = ? AND session_id = ? AND state = 'queued'`).run(messageId, id);
        if (r.changes === 0) return false;
        this.emit({ sessionId: id, kind: "removed", messageId });
        return true;
    }

    // Everything stacked while the last turn ran goes out as one turn.
    private flush(id: string): void {
        const s = this.session(id);
        if (!s || s.closed_at) return;
        const batch = this.queued(id);
        if (batch.length === 0) return;
        this.db.prepare(`UPDATE prompter_messages SET state = 'sent' WHERE session_id = ? AND state = 'queued'`).run(id);
        this.emit({ sessionId: id, kind: "turn", messageIds: batch.map((m) => m.id) });
        void this.runTurn(id, batch, {}).catch((e: unknown) => console.warn(`[prompter] ${id}: ${String((e as Error).message ?? e).slice(0, 200)}`));
    }

    // One turn: the human's message(s) with the location described in front of them. Streams text and tool activity as
    // `prompter` events; the final answer is stored and sent with `done`; whatever stacked up meanwhile follows as the
    // next turn.
    private async runTurn(id: string, messages: PrompterMessageRow[], opts: { system?: boolean; maxTurns?: number }): Promise<PrompterMessageRow | null> {
        const s = this.session(id);
        if (!s || s.closed_at) throw new Error("session not found or closed");
        if (this.active.has(id)) throw new Error("the assistant is still answering — wait for it");
        this.ensureHome();
        const acc = this.account();
        if (!acc?.oauth_token) throw new Error("no AI account with a token for the assistant");
        const last = messages[messages.length - 1]!;
        const path = last.path;
        const context = path ? this.describe(path) : null;
        const body =
            messages.length === 1
                ? last.text
                : `The human sent ${messages.length} messages while you were answering; read them all before you act:\n\n${messages.map((m, i) => `${i + 1}. ${m.text}`).join("\n\n")}`;
        const prompt = `${context ? `<stagehand-context>\nLocation: ${path}\n${context.context}\nLocal API: http://127.0.0.1:${this.cfg.port} (skill stagehand-api). Now: ${new Date().toLocaleString()}.\n</stagehand-context>\n\n` : ""}${body}`;
        const turn = s.turns + 1;
        const run = startClaude({
            prompt,
            cwd: this.home,
            configDir: this.configDir,
            extraEnv: authEnv(acc),
            ...(turn === 1 ? { sessionId: s.claude_session_id, name: "prompter" } : { resume: s.claude_session_id }),
            ...(s.model ? { model: s.model } : {}),
            maxTurns: opts.maxTurns ?? this.cfg.prompter.maxTurns,
            addDirs: [REPO_ROOT],
            eventLogPath: join(this.home, "logs", `${id}-${turn}.ndjson`),
        });
        this.active.set(id, run);
        this.db.prepare(`UPDATE prompter_sessions SET turns = ? WHERE id = ?`).run(turn, id);
        let answer = "";
        run.on("activity", (ev: ActivityEvent) => {
            const raw = ev.raw as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
            if (raw.type !== "assistant") return;
            for (const block of raw.message?.content ?? []) {
                if (block["type"] === "text" && typeof block["text"] === "string") {
                    answer = block["text"];
                    this.emit({ sessionId: id, kind: "text", text: block["text"] });
                } else if (block["type"] === "tool_use") {
                    const input = block["input"] as Record<string, unknown> | undefined;
                    const hint = String(input?.["query"] ?? input?.["command"] ?? input?.["description"] ?? input?.["file_path"] ?? "").slice(0, 90);
                    this.emit({ sessionId: id, kind: "activity", text: `${String(block["name"]).replace(/^mcp__mempalace__/, "palace: ")} ${hint}`.trim() });
                }
            }
        });
        const outcome = await run.done;
        this.active.delete(id);
        const result: ResultEvent | null = outcome.result;
        if (result) recordUsage(this.db, { accountId: acc.id, envId: null, taskId: null, runId: null, kind: "prompter", stage: null }, result);
        const stopped = this.stopping.delete(id);
        const partial = (result?.result?.trim() || answer.trim() || "").trim();
        // A stopped turn keeps what it had said so far, marked; a stopped turn with nothing said leaves no message.
        const finalText = stopped ? (partial ? `${partial}\n\n_(stopped here)_` : "") : partial;
        const error = stopped ? null : !finalText ? (outcome.signal ? `stopped (${outcome.signal})` : outcome.stderr.trim().split("\n").pop()?.slice(0, 300) || `exited with ${outcome.exitCode ?? "?"}`) : result?.is_error ? finalText.slice(0, 300) : null;
        const message = finalText && !opts.system ? this.addMessage(id, "assistant", finalText, path) : null;
        if (opts.system && finalText) this.addMessage(id, "system", finalText, path);
        this.emit({ sessionId: id, kind: "done", message, error });
        if (!opts.system) this.flush(id);
        return message;
    }

    // Ends a session: an in-flight turn is killed; otherwise one short farewell turn lets the assistant file its notes.
    async close(id: string, opts: { farewell?: boolean } = {}): Promise<void> {
        const s = this.session(id);
        if (!s || s.closed_at) return;
        const running = this.active.get(id);
        // Messages still stacked never go out: the chat ends.
        this.db.prepare(`DELETE FROM prompter_messages WHERE session_id = ? AND state = 'queued'`).run(id);
        if (running) running.kill();
        else if ((opts.farewell ?? this.cfg.prompter.farewell) && s.turns > 0) {
            const note = this.addMessage(id, "system", "This chat ends now. File anything durable from it into the palace (a drawer, or a diary line) that is not filed yet, then answer with one short line.", null);
            await this.runTurn(id, [note], { system: true, maxTurns: 8 }).catch((e: unknown) => console.warn(`[prompter] farewell ${id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
        }
        this.db.prepare(`UPDATE prompter_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL`).run(now(), id);
        this.emit({ sessionId: id, kind: "closed" });
    }

    // Chats with no activity for idleHours — no message and no ping from an open window — are ended; chats closed
    // longer than purgeDays ago are removed with their messages and logs. A server restart never ends a chat: the
    // widget re-attaches with its session id (the conversation itself lives in claude's transcript and resumes with
    // --resume), and a turn that died with the server goes out again (resumeInterrupted).
    startReaper(): void {
        this.ensureHome();
        this.db.prepare(`UPDATE prompter_sessions SET pinged_at = ? WHERE closed_at IS NULL`).run(now());
        // Chats from before titles existed take their first message as their name.
        this.db.prepare(`UPDATE prompter_sessions SET title = (SELECT substr(replace(replace(m.text, char(10), ' '), char(13), ' '), 1, 60) FROM prompter_messages m WHERE m.session_id = prompter_sessions.id AND m.role = 'user' ORDER BY m.created_at LIMIT 1) WHERE title IS NULL`).run();
        this.timer = setInterval(() => void this.reap(), 60_000);
        this.timer.unref();
        setTimeout(() => this.resumeInterrupted(), 3_000).unref();
    }
    async reap(): Promise<void> {
        const cutoff = Date.now() - this.cfg.prompter.idleHours * 3_600_000;
        const stale = this.db.prepare(`SELECT * FROM prompter_sessions WHERE closed_at IS NULL`).all() as PrompterSessionRow[];
        for (const s of stale) {
            if (this.active.has(s.id)) continue;
            const lastActivity = Math.max(new Date(s.pinged_at).getTime(), new Date(s.last_at).getTime());
            if (lastActivity < cutoff) await this.close(s.id);
        }
        this.purge();
    }

    // Closed chats older than purgeDays: rows and per-turn logs go.
    purge(): number {
        const cutoff = new Date(Date.now() - this.cfg.prompter.purgeDays * 86_400_000).toISOString();
        const old = this.db.prepare(`SELECT id FROM prompter_sessions WHERE closed_at IS NOT NULL AND closed_at < ?`).all(cutoff) as Array<{ id: string }>;
        if (old.length === 0) return 0;
        const logs = join(this.home, "logs");
        const names = existsSync(logs) ? readdirSync(logs) : [];
        for (const { id } of old) {
            this.db.prepare(`DELETE FROM prompter_messages WHERE session_id = ?`).run(id);
            this.db.prepare(`DELETE FROM prompter_sessions WHERE id = ?`).run(id);
            for (const f of names) if (f.startsWith(`${id}-`)) rmSync(join(logs, f), { force: true });
        }
        console.log(`[prompter] ${old.length} closed chat(s) older than ${this.cfg.prompter.purgeDays} day(s) removed`);
        return old.length;
    }

    // A turn that was running when the server went down left the human's message(s) without an answer: they are
    // stacked again and go out as one turn now (claude may have seen part of them; a repeat is harmless). Only recent
    // ones: an unanswered message from hours ago was a turn that ended without an answer, not one the restart cut
    // (the first restart with this replayed a 7-hour-old "land" whose branch had long been landed).
    private static readonly RESEND_MAX_AGE_MS = 2 * 3_600_000;
    resumeInterrupted(): void {
        const open = this.listSessions();
        const freshAfter = Date.now() - Prompter.RESEND_MAX_AGE_MS;
        for (const s of open) {
            if (this.active.has(s.id)) continue;
            const all = this.db.prepare(`SELECT * FROM prompter_messages WHERE session_id = ? ORDER BY created_at`).all(s.id) as PrompterMessageRow[];
            let lastAnswer = -1;
            all.forEach((m, i) => {
                if (m.role !== "user") lastAnswer = i;
            });
            if (new Date(all[all.length - 1]?.created_at ?? 0).getTime() < freshAfter) continue;
            const trailing = all.slice(lastAnswer + 1).filter((m) => m.role === "user" && m.state === "sent");
            if (trailing.length === 0) continue;
            this.db.prepare(`UPDATE prompter_messages SET state = 'queued' WHERE id IN (${trailing.map(() => "?").join(",")})`).run(...trailing.map((m) => m.id));
            console.log(`[prompter] chat ${s.id.slice(0, 8)}: ${trailing.length} message(s) had no answer when the server stopped — sending them again`);
            this.flush(s.id);
        }
    }

    // ---------- where the human is ----------

    // The URL hash as words: what the location is and what it holds right now, for the prompt and for the widget's chip.
    describe(path: string): { summary: string; context: string } {
        const r: Route = parseRoute(path);
        switch (r.page) {
            case "dashboard":
                return r.task ? this.describeTask(r.task, r.view, "Dashboard") : { summary: "Dashboard", context: "Page: Dashboard — tasks that need the human, per environment." };
            case "tasks": {
                if (r.task) return this.describeTask(r.task, r.view, "Tasks");
                const env = r.env ? (this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(r.env) as EnvRow | undefined) : undefined;
                const label = r.create ? `New task${env ? ` in ${env.name}` : ""}` : `Tasks${env ? ` · ${env.name}` : ""}`;
                return { summary: label, context: `Page: ${label}${env ? ` (environment ${env.name}, ${env.path}, base ${env.base_branch})` : ""}.` };
            }
            case "sessions": {
                const s = r.session ? (this.db.prepare(`SELECT s.*, e.name AS env_name FROM sessions s JOIN envs e ON e.id = s.env_id WHERE s.id = ?`).get(r.session) as { name: string; env_name: string; branch: string | null; worktree_path: string | null; tmux: string } | undefined) : undefined;
                return s
                    ? { summary: `Session ${s.name}`, context: `Page: Sessions — session "${s.name}" (${s.env_name}${s.branch ? `, branch ${s.branch}` : ""}${s.worktree_path ? `, worktree ${s.worktree_path}` : ", main checkout"}), sub-view ${r.view ?? "terminal"}.` }
                    : { summary: "Sessions", context: "Page: Sessions — free-form claude sessions in tmux." };
            }
            case "analytics":
                return { summary: "Analytics", context: `Page: Analytics — usage and cost, last ${r.days ?? 7} days.` };
            case "timing":
                return { summary: "Timing", context: `Page: Timing — how long runs and tasks take (per stage, operation, task, day; working vs waiting), last ${r.days ?? 7} days.` };
            case "envs": {
                const env = r.env ? (this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(r.env) as EnvRow | undefined) : undefined;
                return env
                    ? { summary: `Environment ${env.name}`, context: `Page: environment "${env.name}" configuration (id ${env.id}; path ${env.path}; base ${env.base_branch}; repos ${env.repos ?? "single"}; ticket source ${env.ticket_source}; BE port ${env.be_port ?? "free"}, FE port ${env.fe_port ?? "free"}).` }
                    : { summary: "Environments", context: "Page: Environments list." };
            }
            case "config-dirs": {
                const d = r.dir ? (this.db.prepare(`SELECT name, path FROM config_dirs WHERE id = ?`).get(r.dir) as { name: string; path: string } | undefined) : undefined;
                return d ? { summary: `Config dir ${d.name}`, context: `Page: Claude config dir "${d.name}" (${d.path}).` } : { summary: "Config dirs", context: "Page: Config dirs list." };
            }
            case "accounts":
                return { summary: "AI accounts", context: "Page: AI accounts (tokens, browser logins, Chrome profiles, usage)." };
            case "integrations":
                return { summary: "Integrations", context: "Page: Integrations (ClickUp, Linear, Notion, notifications, Jev)." };
            case "product": {
                if (!r.po) return { summary: "Product", context: "Page: Product — the Product Owners list (GET /api/product-owners; each belongs to one environment), the product context of an environment (GET/PUT /api/product/context?env=<envId>) and the memory of an environment (GET /api/product/search?q=&env=<envId>)." };
                const po = this.db.prepare(`SELECT title, phase, source, scope_url FROM product_owners WHERE id = ?`).get(r.po) as { title: string; phase: string; source: string; scope_url: string | null } | undefined;
                return {
                    summary: `Product Owner ${po?.title ?? r.po}`,
                    context: `Page: Product Owner "${po?.title ?? r.po}" (id ${r.po}), ${po ? `${po.source} ${po.scope_url ?? ""}, phase ${po.phase}` : "not found"}; tab ${r.tab ?? "context"}. Detail: GET /api/product-owners/${r.po}. Its folder: ~/.stagehand/product-owners/${r.po}/ (context.md, design.md, tickets.json, artifacts/).`,
                };
            }
            default:
                return { summary: path, context: `Page: ${path}` };
        }
    }

    private describeTask(taskId: string, view: TaskView | undefined, page: string): { summary: string; context: string } {
        const t = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
        if (!t) return { summary: "Task (not found)", context: `Page: ${page} — task ${taskId} does not exist any more.` };
        const env = this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(t.env_id) as EnvRow | undefined;
        const run = this.db.prepare(`SELECT stage, status, started_at, finished_at, last_event, error, attempt FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`).get(taskId) as { stage: string; status: string; started_at: string; finished_at: string | null; last_event: string | null; error: string | null; attempt: number } | undefined;
        const questions = (this.db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE task_id = ? AND answers IS NULL`).get(taskId) as { n: number }).n;
        const prs = this.db.prepare(`SELECT repo, number, state, approved_at FROM pr_state WHERE task_id = ?`).all(taskId) as Array<{ repo: string; number: number | null; state: string | null; approved_at: string | null }>;
        const services = this.db.prepare(`SELECT kind, port, url FROM services WHERE task_id = ? AND stopped_at IS NULL`).all(taskId) as Array<{ kind: string; port: number; url: string }>;
        const stageLabel = STAGE_DEFS[t.stage]?.label ?? t.stage;
        const lines = [
            `Task ${t.ticket_id}${t.title ? ` "${t.title}"` : ""} (id ${t.id}) in ${env?.name ?? t.env_id} · stage ${stageLabel} · status ${t.status}${t.status_line ? ` — "${t.status_line}"` : ""}.`,
            `Branch ${t.branch ?? "(none yet)"}${t.base_branch ? ` on base ${t.base_branch}` : env ? ` on base ${env.base_branch}` : ""}; worktree ${t.worktree_path ?? "(none yet)"}.`,
            run ? `Latest run: ${STAGE_DEFS[run.stage as keyof typeof STAGE_DEFS]?.label ?? run.stage} #${run.attempt} ${run.status} (started ${run.started_at}${run.finished_at ? `, finished ${run.finished_at}` : ""})${run.error ? `, error: ${run.error.slice(0, 160)}` : run.last_event ? `, last event: ${run.last_event.slice(0, 120)}` : ""}.` : "No run yet.",
            questions ? `${questions} open question round(s) from the agent wait for answers.` : "No open questions.",
            prs.length ? `PRs: ${prs.map((p) => `${p.repo || "repo"} ${p.number ? `#${p.number}` : "(not opened)"}${p.state ? ` ${p.state}` : ""}${p.approved_at ? " approved" : ""}`).join("; ")}.` : "No pull request yet.",
            services.length ? `Services up: ${services.map((s) => `${s.kind.toUpperCase()} ${s.url}`).join(", ")}.` : "No BE/FE service of this task is running.",
            t.notes ? `Human notes on the task: ${t.notes.slice(0, 300)}` : "",
        ].filter(Boolean);
        const v = view ?? { tab: "work" };
        const viewing =
            v.tab === "work" ? `Viewing: Work tab, step ${v.step ?? t.stage}.`
            : v.tab === "code" ? `Viewing: Code changes${v.repo ? `, repository ${v.repo}` : ""}${v.scope ? `, scope ${v.scope.kind === "commits" ? `commits ${v.scope.shas.join(",")}` : v.scope.kind}` : ", all changes vs base"}.`
            : v.tab === "pr" ? `Viewing: Pull request tab${v.repo ? `, repository ${v.repo}` : ""}.`
            : v.tab === "comments" ? `Viewing: PR comments, list ${v.sub ?? "user"}${v.repo ? `, repository ${v.repo}` : ""}.`
            : v.tab === "design" ? `Viewing: Design proposal${v.section ? `, section "${v.section}"` : ""}.`
            : v.tab === "runs" ? `Viewing: Runs${v.run ? `, run ${v.run}` : ""}.`
            : `Viewing: ${v.tab} tab.`;
        return { summary: `${t.ticket_id} · ${stageLabel} · ${v.tab}`, context: `Page: ${page}.\n${lines.join("\n")}\n${viewing}` };
    }
}
