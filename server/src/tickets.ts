import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { claudeEnv } from "./claude/env.js";

// A file attached to the ticket (explicitly, or embedded as an image/link in its description or comments). `file` is
// the path relative to the task dir once downloaded; null with `error` set when the download failed — the URL stays.
export const TicketAttachment = z.object({
    name: z.string(),
    url: z.string(),
    mime: z.string().nullable().default(null),
    file: z.string().nullable().default(null),
    size: z.number().nullable().default(null),
    error: z.string().nullable().default(null),
    // Where it came from: the ticket's own attachment list, or a link inside the description / a comment.
    origin: z.enum(["attachment", "description", "comment"]).default("attachment"),
});
export type TicketAttachment = z.infer<typeof TicketAttachment>;

export type TicketSource = "clickup" | "linear";

export interface TicketRef {
    source: TicketSource;
    id: string;
    url: string | null;
}

export const Ticket = z.object({
    source: z.enum(["clickup", "linear"]),
    id: z.string(),
    url: z.string().nullable(),
    title: z.string(),
    status: z.string().nullable().default(null),
    description: z.string().default(""),
    acceptanceCriteria: z.array(z.string()).default([]),
    parent: z.object({ id: z.string(), title: z.string(), description: z.string().default("") }).nullable().default(null),
    // Chronological (oldest first) — often carries scope clarifications and decisions the description never got updated with.
    comments: z.array(z.object({ author: z.string(), body: z.string(), at: z.string() })).default([]),
    attachments: z.array(TicketAttachment).default([]),
    fetchedVia: z.enum(["rest", "mcp"]),
});
export type Ticket = z.infer<typeof Ticket>;

// ---------- attachments ----------

const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const FILE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|heic|mp4|mov|webm|m4v|avi|mkv|gif|pdf|csv|xlsx?|docx?|pptx?|txt|md|json|zip|har|log)(?=$|[?#])/i;
// Hosts that serve the task managers' uploads; anything else embedded in a description is a plain link, not a file.
const FILE_HOST = /(^|\.)(clickup-attachments\.com|attachments\.clickup\.com|uploads\.linear\.app|files\.linear\.app)$/i;

const isFileUrl = (url: string): boolean => {
    try {
        const u = new URL(url);
        return FILE_HOST.test(u.hostname) || FILE_EXT.test(u.pathname);
    } catch {
        return false;
    }
};

const nameFromUrl = (url: string): string => {
    try {
        const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
        return last || "attachment";
    } catch {
        return "attachment";
    }
};

// Images and file links embedded in markdown: `![alt](url)`, `[text](url)`, `<img src="url">`, bare upload URLs.
const embeddedFiles = (markdown: string, origin: TicketAttachment["origin"]): TicketAttachment[] => {
    const out: TicketAttachment[] = [];
    const seen = new Set<string>();
    const push = (url: string, name: string | null) => {
        if (!url || seen.has(url) || !isFileUrl(url)) return;
        seen.add(url);
        out.push({ name: name?.trim() || nameFromUrl(url), url, mime: null, file: null, size: null, error: null, origin });
    };
    for (const m of markdown.matchAll(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)) push(m[2]!, m[1] ?? null);
    for (const m of markdown.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi)) push(m[1]!, null);
    for (const m of markdown.matchAll(/(?<![("'\]])https?:\/\/[^\s<>)"']+/g)) push(m[0], null);
    return out;
};

const safeFileName = (name: string, url: string): string => {
    const base = name.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "attachment";
    const urlExt = extname(nameFromUrl(url)).toLowerCase();
    return !extname(base) && urlExt && urlExt.length <= 6 ? `${base}${urlExt}` : base;
};

const authHeadersFor = (url: string, cfg: Config): Record<string, string> => {
    try {
        const host = new URL(url).hostname;
        if (/linear\.app$/i.test(host) && cfg.linearApiKey) return { Authorization: cfg.linearApiKey };
        if (/clickup\.com$/i.test(host) && cfg.clickupToken) return { Authorization: cfg.clickupToken };
    } catch {
        /* not a URL */
    }
    return {};
};

// Downloads every attachment into <taskDir>/attachments and records the local path; a failure keeps the URL and the
// reason. Already-downloaded files (same name, non-empty) are kept. Never throws — attachments are best effort.
export const downloadAttachments = async (ticket: Ticket, cfg: Config, taskDir: string): Promise<Ticket> => {
    if (ticket.attachments.length === 0) return ticket;
    const dir = join(taskDir, "attachments");
    mkdirSync(dir, { recursive: true });
    const used = new Set<string>();
    const attachments: TicketAttachment[] = [];
    for (const a of ticket.attachments) {
        let name = safeFileName(a.name, a.url);
        if (used.has(name.toLowerCase())) {
            const ext = extname(name);
            const stem = ext ? name.slice(0, -ext.length) : name;
            let i = 2;
            while (used.has(`${stem}-${i}${ext}`.toLowerCase())) i++;
            name = `${stem}-${i}${ext}`;
        }
        used.add(name.toLowerCase());
        const rel = `attachments/${name}`;
        const full = join(dir, name);
        if (existsSync(full) && statSync(full).size > 0) {
            attachments.push({ ...a, file: rel, size: statSync(full).size, error: null, mime: a.mime ?? mimeOf(name) });
            continue;
        }
        try {
            const res = await fetch(a.url, { headers: authHeadersFor(a.url, cfg), redirect: "follow", signal: AbortSignal.timeout(120_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const len = Number(res.headers.get("content-length") ?? 0);
            if (len > MAX_ATTACHMENT_BYTES) throw new Error(`too large (${Math.round(len / 1e6)} MB)`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`too large (${Math.round(buf.byteLength / 1e6)} MB)`);
            const ctype = res.headers.get("content-type")?.split(";")[0]?.trim() ?? null;
            // A "file" URL that answers with HTML is a login page or a web view, not the file.
            if (ctype && /^text\/html/i.test(ctype) && !/\.html?$/i.test(name)) throw new Error("server returned an HTML page instead of the file");
            writeFileSync(full, buf);
            attachments.push({ ...a, file: rel, size: buf.byteLength, error: null, mime: ctype && ctype !== "application/octet-stream" ? ctype : mimeOf(name) });
        } catch (e) {
            attachments.push({ ...a, file: null, size: null, error: String((e as Error).message ?? e).slice(0, 160) });
        }
    }
    return { ...ticket, attachments };
};

export const mimeOf = (name: string): string | null => {
    const ext = extname(name).toLowerCase().slice(1);
    const map: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", heic: "image/heic",
        mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/x-m4v", avi: "video/x-msvideo", mkv: "video/x-matroska",
        pdf: "application/pdf", json: "application/json", csv: "text/csv", txt: "text/plain", md: "text/markdown", log: "text/plain", html: "text/html", htm: "text/html",
        zip: "application/zip", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword",
    };
    return map[ext] ?? null;
};

const CLICKUP_URL = /^https?:\/\/app\.clickup\.com\/t\/(?:(\d+)\/)?([A-Za-z0-9-]+)\/?(?:[?#].*)?$/;
const LINEAR_URL = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)(?:\/.*)?$/;
const BARE_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export const parseTicketRef = (input: string, defaultSource: TicketSource = "clickup"): TicketRef => {
    const s = input.trim();
    const cu = CLICKUP_URL.exec(s);
    if (cu) return { source: "clickup", id: cu[2]!.toUpperCase().match(BARE_ID) ? cu[2]!.toUpperCase() : cu[2]!, url: s };
    const li = LINEAR_URL.exec(s);
    if (li) return { source: "linear", id: li[1]!.toUpperCase(), url: s };
    if (BARE_ID.test(s)) return { source: defaultSource, id: s.toUpperCase(), url: null };
    if (/^[a-z0-9]{6,12}$/i.test(s)) return { source: "clickup", id: s, url: null };
    throw new Error(`"${input}" is not a ClickUp/Linear ticket id or URL`);
};

// ---------- REST fetchers (used when a token is configured) ----------

const extractAcceptanceCriteria = (markdown: string): string[] => {
    const lines = markdown.split("\n");
    const start = lines.findIndex((l) => /acceptance criteria/i.test(l));
    if (start < 0) return [];
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (/^#{1,6}\s/.test(line) && out.length) break;
        const m = /^\s*(?:[-*]|\d+\.)\s*(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
        if (m) out.push(m[1]!.trim());
    }
    return out;
};

const fetchClickUpComments = async (taskId: string, headers: Record<string, string>, teamQ: string): Promise<Ticket["comments"]> => {
    try {
        const res = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/comment${teamQ}`, { headers });
        if (!res.ok) return [];
        const body = (await res.json()) as { comments?: Array<{ comment_text?: string; user?: { username?: string }; date?: string }> };
        // ClickUp returns newest first; the prompt wants a natural reading order.
        return (body.comments ?? [])
            .filter((c) => c.comment_text?.trim())
            .map((c) => ({ author: c.user?.username ?? "unknown", body: c.comment_text!.trim(), at: c.date ? new Date(Number(c.date)).toISOString() : "" }))
            .reverse();
    } catch {
        return [];
    }
};

const fetchClickUpRest = async (ref: TicketRef, cfg: Config): Promise<Ticket> => {
    if (!cfg.clickupToken) throw new Error("no ClickUp token configured");
    const headers = { Authorization: cfg.clickupToken };
    const teamQ = cfg.clickupTeamId ? `?custom_task_ids=true&team_id=${cfg.clickupTeamId}` : "";
    // ClickUp returns `description` as flattened plain text (headings, bold and lists gone) unless the markdown
    // rendition is asked for explicitly — that is what the Ticket tab renders and the prompts quote.
    const mdQ = `${teamQ ? "&" : "?"}include_markdown_description=true`;
    const res = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(ref.id)}${teamQ}${mdQ}`, { headers });
    if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const t = (await res.json()) as {
        custom_id?: string; id: string; name: string; status?: { status: string }; markdown_description?: string; description?: string; url?: string; parent?: string | null;
        attachments?: Array<{ id?: string; title?: string; extension?: string; mimetype?: string; url?: string; url_w_query?: string; size?: number }>;
    };
    const description = t.markdown_description ?? t.description ?? "";
    const explicit: TicketAttachment[] = (t.attachments ?? [])
        .filter((a) => a.url || a.url_w_query)
        .map((a) => ({ name: a.title || nameFromUrl(a.url ?? a.url_w_query!), url: a.url_w_query ?? a.url!, mime: a.mimetype ?? null, file: null, size: a.size ?? null, error: null, origin: "attachment" as const }));
    let parent: Ticket["parent"] = null;
    if (t.parent) {
        const pr = await fetch(`https://api.clickup.com/api/v2/task/${t.parent}?include_markdown_description=true`, { headers });
        if (pr.ok) {
            const p = (await pr.json()) as { custom_id?: string; id: string; name: string; markdown_description?: string; description?: string };
            parent = { id: p.custom_id ?? p.id, title: p.name, description: p.markdown_description ?? p.description ?? "" };
        }
    }
    const comments = await fetchClickUpComments(t.id, headers, teamQ);
    return Ticket.parse({
        source: "clickup",
        id: t.custom_id ?? t.id,
        url: t.url ?? ref.url,
        title: t.name,
        status: t.status?.status ?? null,
        description,
        acceptanceCriteria: extractAcceptanceCriteria(description),
        parent,
        comments,
        attachments: mergeAttachments(explicit, description, comments),
        fetchedVia: "rest",
    });
};

// Explicit attachments first, then files linked from the description and the comments, deduplicated by URL (an
// explicit ClickUp attachment is usually also embedded as an image in the description).
const mergeAttachments = (explicit: TicketAttachment[], description: string, comments: Ticket["comments"]): TicketAttachment[] => {
    const out: TicketAttachment[] = [];
    const seen = new Set<string>();
    const key = (url: string) => url.split(/[?#]/)[0]!;
    for (const a of [...explicit, ...embeddedFiles(description, "description"), ...comments.flatMap((c) => embeddedFiles(c.body, "comment"))]) {
        if (seen.has(key(a.url))) continue;
        seen.add(key(a.url));
        out.push(a);
    }
    return out;
};

const fetchLinearRest = async (ref: TicketRef, cfg: Config): Promise<Ticket> => {
    if (!cfg.linearApiKey) throw new Error("no Linear API key configured");
    const query = `query($id: String!) { issue(id: $id) { identifier title description url state { name } parent { identifier title description } comments(first: 100) { nodes { body createdAt user { name } } } attachments(first: 50) { nodes { title url } } } }`;
    const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: cfg.linearApiKey },
        body: JSON.stringify({ query, variables: { id: ref.id } }),
    });
    if (!res.ok) throw new Error(`Linear ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
        data?: {
            issue?: {
                identifier: string; title: string; description?: string; url: string; state?: { name: string };
                parent?: { identifier: string; title: string; description?: string } | null;
                comments?: { nodes: Array<{ body: string; createdAt: string; user?: { name?: string } | null }> };
                attachments?: { nodes: Array<{ title?: string | null; url: string }> };
            };
        };
        errors?: Array<{ message: string }>;
    };
    const issue = body.data?.issue;
    if (!issue) throw new Error(`Linear: ${body.errors?.[0]?.message ?? "issue not found"}`);
    const comments = (issue.comments?.nodes ?? []).filter((c) => c.body?.trim()).map((c) => ({ author: c.user?.name ?? "unknown", body: c.body.trim(), at: c.createdAt }));
    // Linear "attachments" are mostly links (GitHub, Figma, Slack); only the ones that are files get downloaded.
    const explicit: TicketAttachment[] = (issue.attachments?.nodes ?? [])
        .filter((a) => a.url && isFileUrl(a.url))
        .map((a) => ({ name: a.title || nameFromUrl(a.url), url: a.url, mime: null, file: null, size: null, error: null, origin: "attachment" as const }));
    return Ticket.parse({
        source: "linear",
        id: issue.identifier,
        url: issue.url,
        title: issue.title,
        status: issue.state?.name ?? null,
        description: issue.description ?? "",
        acceptanceCriteria: extractAcceptanceCriteria(issue.description ?? ""),
        parent: issue.parent ? { id: issue.parent.identifier, title: issue.parent.title, description: issue.parent.description ?? "" } : null,
        comments,
        attachments: mergeAttachments(explicit, issue.description ?? "", comments),
        fetchedVia: "rest",
    });
};

// ---------- MCP fetcher (no token needed; uses the account's connected MCP servers) ----------

const fetchViaClaude = (ref: TicketRef, configDir: string, cwd: string, outPath: string, extraEnv: Record<string, string>, onResult?: (result: unknown) => void): Promise<Ticket> =>
    new Promise((resolve, reject) => {
        const tool =
            ref.source === "clickup"
                ? "mcp__clickup__clickup_get_task (task_id, include: [\"description\"]) plus mcp__clickup__clickup_get_task_comments (task_id) for its comments; if the task has a parent, fetch it too"
                : "the Linear MCP issue tool (e.g. mcp__linear__get_issue) plus its comments (e.g. mcp__linear__list_comments or the issue's own comments field)";
        const prompt =
            `Fetch ${ref.source} ticket ${ref.id} using ${tool}. Do nothing else. ` +
            `MCP servers connect asynchronously: if ToolSearch does not list the tool yet, run \`sleep 10\` with Bash and search again — up to 4 times — before concluding it is unavailable. ` +
            `Then write ${outPath} as JSON with exactly this shape and reply DONE:\n` +
            `{"source":"${ref.source}","id":"${ref.id}","url":<url or null>,"title":<string>,"status":<string or null>,"description":<full markdown description>,` +
            `"acceptanceCriteria":[<each acceptance-criteria bullet verbatim, [] if none>],"parent":<{"id","title","description"} or null>,` +
            `"comments":[<each comment as {"author":<string>,"body":<verbatim text>,"at":<ISO timestamp>}, oldest first, [] if none>],` +
            `"attachments":[<each file attached to the ticket or embedded as an image/file link in the description or a comment, as {"name":<file name>,"url":<direct download URL>}, [] if none>],"fetchedVia":"mcp"}\n` +
            `If the tool is unavailable or the ticket cannot be fetched, write {"error":"<reason>"} to the same path and reply DONE.`;
        const child = spawn(
            "claude",
            ["-p", prompt, "--output-format", "json", "--permission-mode", "auto", "--max-turns", "16", "--no-session-persistence", "--no-chrome", "--model", "sonnet", "--add-dir", join(outPath, "..")],
            { cwd, env: claudeEnv(configDir, extraEnv), stdio: ["ignore", "pipe", "pipe"] },
        );
        let err = "";
        let out = "";
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
        child.on("close", () => {
            clearTimeout(timer);
            if (onResult && out.trim()) {
                try {
                    onResult(JSON.parse(out));
                } catch {
                    /* no usable result event */
                }
            }
            if (!existsSync(outPath)) return reject(new Error(`ticket fetch wrote nothing (${err.trim().slice(-200) || "no stderr"})`));
            const raw = JSON.parse(readFileSync(outPath, "utf8")) as { error?: string };
            if (raw.error) return reject(new Error(raw.error));
            const parsed = Ticket.safeParse(raw);
            parsed.success ? resolve(parsed.data) : reject(new Error(`ticket.json invalid: ${parsed.error.issues[0]?.message}`));
        });
        child.on("error", reject);
    });

export const fetchTicket = async (
    ref: TicketRef,
    cfg: Config,
    configDir: string,
    cwd: string,
    taskDir: string,
    extraEnv: Record<string, string> = {},
    onResult?: (result: unknown) => void,
    outFile = "ticket.json",
): Promise<Ticket> => {
    const outPath = join(taskDir, outFile);
    const restConfigured = ref.source === "clickup" ? !!cfg.clickupToken : !!cfg.linearApiKey;
    let ticket: Ticket;
    if (restConfigured) {
        ticket = ref.source === "clickup" ? await fetchClickUpRest(ref, cfg) : await fetchLinearRest(ref, cfg);
    } else {
        // The agent lists the files (name + URL); the server downloads them, so tokens never reach the agent.
        const raw = await fetchViaClaude(ref, configDir, cwd, outPath, extraEnv, onResult);
        ticket = { ...raw, attachments: mergeAttachments(raw.attachments, raw.description, raw.comments) };
    }
    ticket = await downloadAttachments(ticket, cfg, taskDir);
    writeFileSync(outPath, JSON.stringify(ticket, null, 2));
    return ticket;
};

// Server-side only (ClickUp/Linear REST); refuses instead of spawning an agent when no token is configured.
export const fetchTicketRest = async (ref: TicketRef, cfg: Config, taskDir: string, outFile = "ticket.json"): Promise<Ticket> => {
    const restConfigured = ref.source === "clickup" ? !!cfg.clickupToken : !!cfg.linearApiKey;
    if (!restConfigured) throw new Error(`no ${ref.source === "clickup" ? "ClickUp" : "Linear"} token configured — add one under Task managers, then fetch again`);
    const fetched = ref.source === "clickup" ? await fetchClickUpRest(ref, cfg) : await fetchLinearRest(ref, cfg);
    const ticket = await downloadAttachments(fetched, cfg, taskDir);
    writeFileSync(join(taskDir, outFile), JSON.stringify(ticket, null, 2));
    return ticket;
};

const fmtSize = (n: number | null): string => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);

// How the agent learns about the files: absolute paths it can Read (images) or inspect (videos: ffmpeg frames), and
// the URL for anything that could not be downloaded.
const renderAttachments = (t: Ticket, taskDir: string | null): string => {
    if (t.attachments.length === 0) return "";
    const lines = t.attachments.map((a) => {
        const where = a.origin === "attachment" ? "" : ` (from ${a.origin === "comment" ? "a comment" : "the description"})`;
        if (a.file) {
            const path = taskDir ? join(taskDir, a.file) : a.file;
            const kind = a.mime?.startsWith("image/") ? "image — view it with the Read tool" : a.mime?.startsWith("video/") ? "video — Read cannot play it; extract frames with `ffmpeg -i <file> -vf fps=1 frame-%03d.jpg` if you need to see it" : a.mime ?? "file";
            return `- ${a.name}${where}: \`${path}\` (${[kind, fmtSize(a.size)].filter(Boolean).join(", ")})`;
        }
        return `- ${a.name}${where}: ${a.url} (not downloaded${a.error ? `: ${a.error}` : ""})`;
    });
    return `\n\n### Attachments (${t.attachments.length})\n\n${lines.join("\n")}`;
};

// Where a batch task keeps the tickets beyond its first one.
export const extraTicketFile = (id: string): string => `tickets/${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;

// Several tickets rendered as one brief: the agent treats them as a single change set on one branch.
export const renderTicketsForPrompt = (tickets: Ticket[], taskDir: string | null = null): string => {
    if (tickets.length <= 1) return tickets[0] ? renderTicketForPrompt(tickets[0], taskDir) : "";
    const ids = tickets.map((t) => t.id).join(", ");
    return `## This task covers ${tickets.length} tickets: ${ids}\n\nImplement all of them together on this one branch as one change set (one PR per repository). The branch name, the design and the PR must cover every ticket; keep each ticket's acceptance criteria separately verifiable.\n\n${tickets.map((t) => renderTicketForPrompt(t, taskDir)).join("\n\n---\n\n")}`;
};

export const renderTicketForPrompt = (t: Ticket, taskDir: string | null = null): string => {
    const ac = t.acceptanceCriteria.length ? t.acceptanceCriteria.map((a) => `- [ ] ${a}`).join("\n") : "(none listed — derive them from the description)";
    const parent = t.parent ? `\n\n### Parent: ${t.parent.id} — ${t.parent.title}\n\n${t.parent.description.slice(0, 4000)}` : "";
    // Comments often carry scope clarifications, decisions, or "actually do X instead" that the description was never updated to reflect.
    const comments = t.comments.length ? `\n\n### Comments (verbatim, oldest first)\n\n${t.comments.map((c) => `**${c.author}**${c.at ? ` (${c.at})` : ""}:\n${c.body}`).join("\n\n")}` : "";
    return `## Ticket ${t.id} — ${t.title}\nSource: ${t.source}${t.url ? ` · ${t.url}` : ""}${t.status ? ` · status: ${t.status}` : ""}\n\n### Description (verbatim)\n\n${t.description}\n\n### Acceptance criteria (verbatim)\n\n${ac}${comments}${renderAttachments(t, taskDir)}${parent}`;
};
