import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { claudeEnv } from "./claude/env.js";

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
    fetchedVia: z.enum(["rest", "mcp"]),
});
export type Ticket = z.infer<typeof Ticket>;

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

const fetchClickUpRest = async (ref: TicketRef, cfg: Config): Promise<Ticket> => {
    if (!cfg.clickupToken) throw new Error("no ClickUp token configured");
    const headers = { Authorization: cfg.clickupToken };
    const teamQ = cfg.clickupTeamId ? `?custom_task_ids=true&team_id=${cfg.clickupTeamId}` : "";
    const res = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(ref.id)}${teamQ}`, { headers });
    if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const t = (await res.json()) as { custom_id?: string; id: string; name: string; status?: { status: string }; markdown_description?: string; description?: string; url?: string; parent?: string | null };
    const description = t.markdown_description ?? t.description ?? "";
    let parent: Ticket["parent"] = null;
    if (t.parent) {
        const pr = await fetch(`https://api.clickup.com/api/v2/task/${t.parent}`, { headers });
        if (pr.ok) {
            const p = (await pr.json()) as { custom_id?: string; id: string; name: string; markdown_description?: string; description?: string };
            parent = { id: p.custom_id ?? p.id, title: p.name, description: p.markdown_description ?? p.description ?? "" };
        }
    }
    return Ticket.parse({
        source: "clickup",
        id: t.custom_id ?? t.id,
        url: t.url ?? ref.url,
        title: t.name,
        status: t.status?.status ?? null,
        description,
        acceptanceCriteria: extractAcceptanceCriteria(description),
        parent,
        fetchedVia: "rest",
    });
};

const fetchLinearRest = async (ref: TicketRef, cfg: Config): Promise<Ticket> => {
    if (!cfg.linearApiKey) throw new Error("no Linear API key configured");
    const query = `query($id: String!) { issue(id: $id) { identifier title description url state { name } parent { identifier title description } } }`;
    const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: cfg.linearApiKey },
        body: JSON.stringify({ query, variables: { id: ref.id } }),
    });
    if (!res.ok) throw new Error(`Linear ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { issue?: { identifier: string; title: string; description?: string; url: string; state?: { name: string }; parent?: { identifier: string; title: string; description?: string } | null } }; errors?: Array<{ message: string }> };
    const issue = body.data?.issue;
    if (!issue) throw new Error(`Linear: ${body.errors?.[0]?.message ?? "issue not found"}`);
    return Ticket.parse({
        source: "linear",
        id: issue.identifier,
        url: issue.url,
        title: issue.title,
        status: issue.state?.name ?? null,
        description: issue.description ?? "",
        acceptanceCriteria: extractAcceptanceCriteria(issue.description ?? ""),
        parent: issue.parent ? { id: issue.parent.identifier, title: issue.parent.title, description: issue.parent.description ?? "" } : null,
        fetchedVia: "rest",
    });
};

// ---------- MCP fetcher (no token needed; uses the account's connected MCP servers) ----------

const fetchViaClaude = (ref: TicketRef, configDir: string, cwd: string, outPath: string, extraEnv: Record<string, string>): Promise<Ticket> =>
    new Promise((resolve, reject) => {
        const tool = ref.source === "clickup" ? "mcp__clickup__clickup_get_task (task_id, include: [\"description\"]); if the task has a parent, fetch it too" : "the Linear MCP issue tool (e.g. mcp__linear__get_issue)";
        const prompt =
            `Fetch ${ref.source} ticket ${ref.id} using ${tool}. Do nothing else. ` +
            `MCP servers connect asynchronously: if ToolSearch does not list the tool yet, run \`sleep 10\` with Bash and search again — up to 4 times — before concluding it is unavailable. ` +
            `Then write ${outPath} as JSON with exactly this shape and reply DONE:\n` +
            `{"source":"${ref.source}","id":"${ref.id}","url":<url or null>,"title":<string>,"status":<string or null>,"description":<full markdown description>,` +
            `"acceptanceCriteria":[<each acceptance-criteria bullet verbatim, [] if none>],"parent":<{"id","title","description"} or null>,"fetchedVia":"mcp"}\n` +
            `If the tool is unavailable or the ticket cannot be fetched, write {"error":"<reason>"} to the same path and reply DONE.`;
        const child = spawn(
            "claude",
            ["-p", prompt, "--output-format", "json", "--permission-mode", "auto", "--max-turns", "16", "--no-session-persistence", "--no-chrome", "--model", "sonnet", "--add-dir", join(outPath, "..")],
            { cwd, env: claudeEnv(configDir, extraEnv), stdio: ["ignore", "pipe", "pipe"] },
        );
        let err = "";
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
        child.stdout.resume();
        const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
        child.on("close", () => {
            clearTimeout(timer);
            if (!existsSync(outPath)) return reject(new Error(`ticket fetch wrote nothing (${err.trim().slice(-200) || "no stderr"})`));
            const raw = JSON.parse(readFileSync(outPath, "utf8")) as { error?: string };
            if (raw.error) return reject(new Error(raw.error));
            const parsed = Ticket.safeParse(raw);
            parsed.success ? resolve(parsed.data) : reject(new Error(`ticket.json invalid: ${parsed.error.issues[0]?.message}`));
        });
        child.on("error", reject);
    });

export const fetchTicket = async (ref: TicketRef, cfg: Config, configDir: string, cwd: string, taskDir: string, extraEnv: Record<string, string> = {}): Promise<Ticket> => {
    const outPath = join(taskDir, "ticket.json");
    const restConfigured = ref.source === "clickup" ? !!cfg.clickupToken : !!cfg.linearApiKey;
    let ticket: Ticket;
    if (restConfigured) {
        ticket = ref.source === "clickup" ? await fetchClickUpRest(ref, cfg) : await fetchLinearRest(ref, cfg);
        writeFileSync(outPath, JSON.stringify(ticket, null, 2));
    } else {
        ticket = await fetchViaClaude(ref, configDir, cwd, outPath, extraEnv);
    }
    return ticket;
};

export const renderTicketForPrompt = (t: Ticket): string => {
    const ac = t.acceptanceCriteria.length ? t.acceptanceCriteria.map((a) => `- [ ] ${a}`).join("\n") : "(none listed — derive them from the description)";
    const parent = t.parent ? `\n\n### Parent: ${t.parent.id} — ${t.parent.title}\n\n${t.parent.description.slice(0, 4000)}` : "";
    return `## Ticket ${t.id} — ${t.title}\nSource: ${t.source}${t.url ? ` · ${t.url}` : ""}${t.status ? ` · status: ${t.status}` : ""}\n\n### Description (verbatim)\n\n${t.description}\n\n### Acceptance criteria (verbatim)\n\n${ac}${parent}`;
};
