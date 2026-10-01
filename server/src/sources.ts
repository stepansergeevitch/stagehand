import type { Config } from "./config.js";

// What a Product Owner reads and writes outside Stagehand, always by API key, never through an MCP server: Linear
// projects and issues, ClickUp epics and tasks, Notion pages, plain web pages. Every read comes back as markdown (the
// PO's artifacts are markdown files); every write creates one issue/task.

export interface FetchedSource {
    kind: "linear" | "clickup" | "notion" | "url";
    title: string;
    markdown: string;
    url: string;
}

// A Product Owner's scope: which unit of the task manager counts as one project.
export interface PoScope {
    source: "linear" | "clickup";
    kind: "project" | "epic";
    id: string;
    url: string;
    title: string;
    // Linear: the team new issues go to (the project's first team). ClickUp: the list the epic lives in.
    teamId: string | null;
    markdown: string;
}

const LINEAR_PROJECT_URL = /^https?:\/\/linear\.app\/[^/]+\/project\/([^/?#]+)/;
const LINEAR_ISSUE_URL = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)/;
const CLICKUP_TASK_URL = /^https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9-]+)/;
const NOTION_URL = /^https?:\/\/(?:www\.)?notion\.(?:so|site)\/.*?([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#].*)?$/i;

const linear = async <T>(cfg: Config, query: string, variables: Record<string, unknown>): Promise<T> => {
    if (!cfg.linearApiKey) throw new Error("no Linear API key configured — add one under Integrations");
    const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: cfg.linearApiKey },
        body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
    if (!res.ok || body.errors?.length) throw new Error(`Linear ${res.status}: ${body.errors?.[0]?.message ?? "request failed"}`);
    return body.data as T;
};

const clickup = async <T>(cfg: Config, path: string, init: RequestInit = {}): Promise<T> => {
    if (!cfg.clickupToken) throw new Error("no ClickUp token configured — add one under Integrations");
    const res = await fetch(`https://api.clickup.com/api/v2${path}`, { ...init, headers: { "content-type": "application/json", Authorization: cfg.clickupToken, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
};

// ---------- Linear ----------

// A project URL ends in `<name-slug>-<slugId>`; the API takes the slugId (the last dash-separated part) as the id.
const linearProjectId = (url: string): string | null => {
    const m = LINEAR_PROJECT_URL.exec(url);
    if (!m) return null;
    const last = m[1]!.split("-").pop();
    return last ?? null;
};

type LinearProject = {
    id: string; name: string; description?: string; content?: string; url: string; state?: string;
    teams: { nodes: Array<{ id: string; key: string; name: string }> };
    documents: { nodes: Array<{ title: string; content?: string; url?: string }> };
    issues: { nodes: Array<{ identifier: string; title: string; url: string; state?: { name: string }; description?: string; parent?: { identifier: string } | null }> };
};

const linearProject = async (cfg: Config, id: string): Promise<LinearProject> => {
    const q = `query($id: String!) { project(id: $id) { id name description content url state
        teams { nodes { id key name } }
        documents(first: 50) { nodes { title content url } }
        issues(first: 200) { nodes { identifier title url state { name } description parent { identifier } } } } }`;
    const d = await linear<{ project: LinearProject | null }>(cfg, q, { id });
    if (!d.project) throw new Error("Linear: project not found");
    return d.project;
};

const renderLinearProject = (p: LinearProject): string =>
    [
        `# ${p.name}`,
        `Linear project · ${p.url}${p.state ? ` · state: ${p.state}` : ""} · teams: ${p.teams.nodes.map((t) => `${t.key} (${t.name})`).join(", ") || "none"}`,
        p.description ? `\n**Summary:** ${p.description}` : "",
        p.content ? `\n## Project description\n\n${p.content}` : "",
        ...p.documents.nodes.map((d) => `\n## Document: ${d.title}${d.url ? ` (${d.url})` : ""}\n\n${d.content ?? ""}`),
        p.issues.nodes.length
            ? `\n## Issues (${p.issues.nodes.length})\n\n${p.issues.nodes.map((i) => `- **${i.identifier}** ${i.title} — ${i.state?.name ?? "?"}${i.parent ? ` (sub-issue of ${i.parent.identifier})` : ""} · ${i.url}${i.description ? `\n  ${i.description.slice(0, 600).replace(/\n/g, "\n  ")}` : ""}`).join("\n")}`
            : "",
    ]
        .filter(Boolean)
        .join("\n");

const linearIssue = async (cfg: Config, id: string): Promise<FetchedSource> => {
    const q = `query($id: String!) { issue(id: $id) { identifier title description url state { name } project { name } parent { identifier title } comments(first: 100) { nodes { body createdAt user { name } } } } }`;
    const d = await linear<{ issue: { identifier: string; title: string; description?: string; url: string; state?: { name: string }; project?: { name: string } | null; parent?: { identifier: string; title: string } | null; comments: { nodes: Array<{ body: string; createdAt: string; user?: { name?: string } | null }> } } | null }>(cfg, q, { id });
    const i = d.issue;
    if (!i) throw new Error("Linear: issue not found");
    const comments = i.comments.nodes.filter((c) => c.body.trim()).map((c) => `**${c.user?.name ?? "unknown"}** (${c.createdAt}):\n${c.body}`).join("\n\n");
    return {
        kind: "linear",
        title: `${i.identifier} ${i.title}`,
        url: i.url,
        markdown: `# ${i.identifier} — ${i.title}\nLinear issue · ${i.url} · ${i.state?.name ?? ""}${i.project ? ` · project: ${i.project.name}` : ""}${i.parent ? ` · parent: ${i.parent.identifier} ${i.parent.title}` : ""}\n\n${i.description ?? ""}${comments ? `\n\n## Comments\n\n${comments}` : ""}`,
    };
};

export const createLinearIssue = async (
    cfg: Config,
    input: { teamId: string; projectId: string; title: string; description: string; parentId?: string | null; estimate?: number | null },
): Promise<{ id: string; identifier: string; url: string }> => {
    const q = `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`;
    const d = await linear<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(cfg, q, {
        input: { teamId: input.teamId, projectId: input.projectId, title: input.title, description: input.description, ...(input.parentId ? { parentId: input.parentId } : {}), ...(input.estimate != null ? { estimate: input.estimate } : {}) },
    });
    if (!d.issueCreate.success || !d.issueCreate.issue) throw new Error("Linear: issueCreate did not succeed");
    return d.issueCreate.issue;
};

// ---------- ClickUp ----------

type ClickUpTask = { id: string; custom_id?: string; name: string; url: string; markdown_description?: string; description?: string; status?: { status: string }; list?: { id: string; name: string }; subtasks?: Array<{ id: string; custom_id?: string; name: string; status?: { status: string } }> };

const clickupTask = async (cfg: Config, id: string): Promise<ClickUpTask> => {
    const teamQ = cfg.clickupTeamId && /^[A-Z]+-\d+$/i.test(id) ? `&custom_task_ids=true&team_id=${cfg.clickupTeamId}` : "";
    return clickup<ClickUpTask>(cfg, `/task/${encodeURIComponent(id)}?include_markdown_description=true&subtasks=true${teamQ}`);
};

const renderClickUpTask = (t: ClickUpTask, what: string): string =>
    `# ${t.custom_id ?? t.id} — ${t.name}\nClickUp ${what} · ${t.url}${t.status ? ` · ${t.status.status}` : ""}${t.list ? ` · list: ${t.list.name}` : ""}\n\n${t.markdown_description ?? t.description ?? ""}` +
    (t.subtasks?.length ? `\n\n## Subtasks (${t.subtasks.length})\n\n${t.subtasks.map((s) => `- **${s.custom_id ?? s.id}** ${s.name} — ${s.status?.status ?? "?"}`).join("\n")}` : "");

export const createClickUpTask = async (cfg: Config, input: { listId: string; parentId: string; name: string; description: string }): Promise<{ id: string; identifier: string; url: string }> => {
    const t = await clickup<{ id: string; custom_id?: string; url: string }>(cfg, `/list/${encodeURIComponent(input.listId)}/task`, {
        method: "POST",
        body: JSON.stringify({ name: input.name, markdown_description: input.description, parent: input.parentId }),
    });
    return { id: t.id, identifier: t.custom_id ?? t.id, url: t.url };
};

// ---------- Notion ----------

type NotionRich = { plain_text: string; href?: string | null; annotations?: { bold?: boolean; italic?: boolean; code?: boolean } };
type NotionBlock = { id: string; type: string; has_children?: boolean; [k: string]: unknown };

const notion = async <T>(cfg: Config, path: string): Promise<T> => {
    if (!cfg.notionApiKey) throw new Error("no Notion API key configured — add one under Integrations");
    const res = await fetch(`https://api.notion.com/v1${path}`, { headers: { Authorization: `Bearer ${cfg.notionApiKey}`, "Notion-Version": "2022-06-28" } });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
};

const rich = (r: NotionRich[] | undefined): string =>
    (r ?? [])
        .map((t) => {
            let s = t.plain_text;
            if (t.annotations?.code) s = `\`${s}\``;
            if (t.annotations?.bold) s = `**${s}**`;
            if (t.annotations?.italic) s = `*${s}*`;
            return t.href ? `[${s}](${t.href})` : s;
        })
        .join("");

const notionChildren = async (cfg: Config, id: string): Promise<NotionBlock[]> => {
    const out: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
        const page = await notion<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>(cfg, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
        out.push(...page.results);
        cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor && out.length < 2000);
    return out;
};

const notionBlocks = async (cfg: Config, blocks: NotionBlock[], depth: number): Promise<string> => {
    const lines: string[] = [];
    const pad = "  ".repeat(depth);
    for (const b of blocks) {
        const v = (b[b.type] ?? {}) as { rich_text?: NotionRich[]; checked?: boolean; language?: string; title?: string; url?: string; file?: { url?: string }; external?: { url?: string } };
        const text = rich(v.rich_text);
        switch (b.type) {
            case "heading_1": lines.push(`\n# ${text}`); break;
            case "heading_2": lines.push(`\n## ${text}`); break;
            case "heading_3": lines.push(`\n### ${text}`); break;
            case "bulleted_list_item": lines.push(`${pad}- ${text}`); break;
            case "numbered_list_item": lines.push(`${pad}1. ${text}`); break;
            case "to_do": lines.push(`${pad}- [${v.checked ? "x" : " "}] ${text}`); break;
            case "quote": lines.push(`> ${text}`); break;
            case "callout": lines.push(`> **Note:** ${text}`); break;
            case "code": lines.push(`\`\`\`${v.language ?? ""}\n${text}\n\`\`\``); break;
            case "divider": lines.push("---"); break;
            case "child_page": lines.push(`- Sub-page: ${v.title ?? ""}`); break;
            case "image": lines.push(`![image](${v.file?.url ?? v.external?.url ?? ""})`); break;
            case "bookmark": case "embed": case "link_preview": lines.push(`- Link: ${v.url ?? ""}`); break;
            case "toggle": lines.push(`${pad}- ${text}`); break;
            case "paragraph": lines.push(text ? `${pad}${text}` : ""); break;
            default: if (text) lines.push(`${pad}${text}`);
        }
        if (b.has_children && depth < 3 && b.type !== "child_page") lines.push(await notionBlocks(cfg, await notionChildren(cfg, b.id), depth + 1));
    }
    return lines.join("\n");
};

const notionPage = async (cfg: Config, id: string, url: string): Promise<FetchedSource> => {
    const page = await notion<{ properties?: Record<string, { type: string; title?: NotionRich[] }> }>(cfg, `/pages/${id}`);
    const titleProp = Object.values(page.properties ?? {}).find((p) => p.type === "title");
    const title = rich(titleProp?.title) || "Notion page";
    const body = await notionBlocks(cfg, await notionChildren(cfg, id), 0);
    return { kind: "notion", title, url, markdown: `# ${title}\nNotion page · ${url}\n\n${body}` };
};

// ---------- any URL ----------

const plainPage = async (url: string): Promise<FetchedSource> => {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    const type = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim() || url;
    const text = /html/i.test(type)
        ? raw
              .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
              .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/[ \t]+/g, " ")
              .replace(/\n\s*\n+/g, "\n\n")
              .trim()
        : raw;
    return { kind: "url", title, url, markdown: `# ${title}\n${url}\n\n${text.slice(0, 400_000)}` };
};

// Any source a human (or the PO agent) hands over, as markdown.
export const fetchSource = async (cfg: Config, url: string): Promise<FetchedSource> => {
    const u = url.trim();
    const project = linearProjectId(u);
    if (project) {
        const p = await linearProject(cfg, project);
        return { kind: "linear", title: p.name, url: p.url, markdown: renderLinearProject(p) };
    }
    const issue = LINEAR_ISSUE_URL.exec(u);
    if (issue) return linearIssue(cfg, issue[1]!.toUpperCase());
    const cu = CLICKUP_TASK_URL.exec(u);
    if (cu) {
        const t = await clickupTask(cfg, cu[1]!);
        return { kind: "clickup", title: `${t.custom_id ?? t.id} ${t.name}`, url: t.url, markdown: renderClickUpTask(t, "task") };
    }
    const no = NOTION_URL.exec(u);
    if (no) return notionPage(cfg, no[1]!.replace(/-/g, ""), u);
    if (!/^https?:\/\//i.test(u)) throw new Error(`"${u}" is not a URL`);
    return plainPage(u);
};

// ---------- the issues of a scope, tracked ----------

// One issue of a PO's project or epic as a refresh sees it: every field a human can change, normalised so that the
// same state always hashes the same (sorted labels, comments in order). `updatedAt` is left out of the hash.
export interface TrackedIssue {
    identifier: string;
    remoteId: string;
    url: string;
    title: string;
    status: string | null;
    description: string;
    labels: string[];
    assignee: string | null;
    priority: string | null;
    estimate: number | null;
    parent: string | null;
    comments: Array<{ id: string; author: string; at: string; body: string }>;
}

type LinearTrackedNode = {
    id: string; identifier: string; title: string; url: string; description?: string | null; state?: { name: string } | null;
    labels: { nodes: Array<{ name: string }> }; assignee?: { name: string } | null; priorityLabel?: string | null; estimate?: number | null;
    parent?: { identifier: string } | null; comments: { nodes: Array<{ id: string; body: string; createdAt: string; user?: { name?: string } | null }> };
};

const linearScopeIssues = async (cfg: Config, projectId: string): Promise<TrackedIssue[]> => {
    // 50 issues a page keeps the query under Linear's complexity limit with 100 comments each.
    const q = `query($id: String!, $after: String) { project(id: $id) { issues(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes {
        id identifier title url description state { name } labels { nodes { name } } assignee { name } priorityLabel estimate parent { identifier }
        comments(first: 100) { nodes { id body createdAt user { name } } } } } } }`;
    const out: TrackedIssue[] = [];
    let after: string | null = null;
    do {
        const d: { project: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: LinearTrackedNode[] } } | null } = await linear(cfg, q, { id: projectId, after });
        if (!d.project) throw new Error("Linear: project not found");
        for (const i of d.project.issues.nodes)
            out.push({
                identifier: i.identifier,
                remoteId: i.id,
                url: i.url,
                title: i.title,
                status: i.state?.name ?? null,
                description: (i.description ?? "").trim(),
                labels: i.labels.nodes.map((l) => l.name).sort(),
                assignee: i.assignee?.name ?? null,
                priority: i.priorityLabel ?? null,
                estimate: i.estimate ?? null,
                parent: i.parent?.identifier ?? null,
                comments: i.comments.nodes
                    .filter((c) => c.body.trim())
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                    .map((c) => ({ id: c.id, author: c.user?.name ?? "unknown", at: c.createdAt, body: c.body.trim() })),
            });
        after = d.project.issues.pageInfo.hasNextPage ? d.project.issues.pageInfo.endCursor : null;
    } while (after && out.length < 1000);
    return out;
};

type ClickUpFullTask = ClickUpTask & { tags?: Array<{ name: string }>; assignees?: Array<{ username?: string; email?: string }>; priority?: { priority?: string } | null; points?: number | null; time_estimate?: number | null; parent?: string | null };
type ClickUpComment = { id: string; comment_text: string; date: string; user?: { username?: string; email?: string } };

const clickupScopeIssues = async (cfg: Config, epicId: string): Promise<TrackedIssue[]> => {
    const epic = await clickupTask(cfg, epicId);
    const out: TrackedIssue[] = [];
    for (const s of (epic.subtasks ?? []).slice(0, 300)) {
        const t = await clickup<ClickUpFullTask>(cfg, `/task/${encodeURIComponent(s.id)}?include_markdown_description=true`);
        const c = await clickup<{ comments: ClickUpComment[] }>(cfg, `/task/${encodeURIComponent(s.id)}/comment`).catch(() => ({ comments: [] as ClickUpComment[] }));
        out.push({
            identifier: t.custom_id ?? t.id,
            remoteId: t.id,
            url: t.url,
            title: t.name,
            status: t.status?.status ?? null,
            description: (t.markdown_description ?? t.description ?? "").trim(),
            labels: (t.tags ?? []).map((x) => x.name).sort(),
            assignee: (t.assignees ?? []).map((a) => a.username ?? a.email ?? "?").sort().join(", ") || null,
            priority: t.priority?.priority ?? null,
            estimate: t.points ?? null,
            parent: epic.custom_id ?? epic.id,
            comments: c.comments
                .filter((x) => x.comment_text.trim())
                .sort((a, b) => Number(a.date) - Number(b.date))
                .map((x) => ({ id: x.id, author: x.user?.username ?? x.user?.email ?? "unknown", at: new Date(Number(x.date)).toISOString(), body: x.comment_text.trim() })),
        });
    }
    return out;
};

// Every issue of a PO's scope, with its comments: the issues of a Linear project, or the subtasks of a ClickUp epic.
export const fetchScopeIssues = (cfg: Config, source: "linear" | "clickup", scopeId: string): Promise<TrackedIssue[]> =>
    source === "linear" ? linearScopeIssues(cfg, scopeId) : clickupScopeIssues(cfg, scopeId);

// The scope a new Product Owner is created from: a Linear project, or a ClickUp epic (a task whose subtasks are the tickets).
export const fetchScope = async (cfg: Config, url: string): Promise<PoScope> => {
    const u = url.trim();
    const project = linearProjectId(u);
    if (project) {
        const p = await linearProject(cfg, project);
        return { source: "linear", kind: "project", id: p.id, url: p.url, title: p.name, teamId: p.teams.nodes[0]?.id ?? null, markdown: renderLinearProject(p) };
    }
    const cu = CLICKUP_TASK_URL.exec(u);
    if (cu) {
        const t = await clickupTask(cfg, cu[1]!);
        return { source: "clickup", kind: "epic", id: t.id, url: t.url, title: t.name, teamId: t.list?.id ?? null, markdown: renderClickUpTask(t, "epic") };
    }
    throw new Error("a Product Owner starts from a Linear project URL (linear.app/<workspace>/project/…) or a ClickUp epic URL (app.clickup.com/t/…)");
};

// Which scope a ticket belongs to, for assigning its Product Owner: the Linear project id, or the ClickUp parent (epic) id.
export const ticketScopeId = async (cfg: Config, source: "linear" | "clickup", ticketId: string): Promise<string | null> => {
    try {
        if (source === "linear") {
            const d = await linear<{ issue: { project?: { id: string } | null } | null }>(cfg, `query($id: String!) { issue(id: $id) { project { id } } }`, { id: ticketId });
            return d.issue?.project?.id ?? null;
        }
        const t = await clickup<{ parent?: string | null }>(cfg, `/task/${encodeURIComponent(ticketId)}${cfg.clickupTeamId && /^[A-Z]+-\d+$/i.test(ticketId) ? `?custom_task_ids=true&team_id=${cfg.clickupTeamId}` : ""}`);
        return t.parent ?? null;
    } catch {
        return null;
    }
};

// An issue that already exists, by its identifier (INV-154, or a ClickUp custom id / task id): its id and URL.
export const findIssue = async (cfg: Config, source: "linear" | "clickup", identifier: string): Promise<{ id: string; identifier: string; url: string } | null> => {
    if (source === "linear") {
        const d = await linear<{ issue: { id: string; identifier: string; url: string } | null }>(cfg, `query($id: String!) { issue(id: $id) { id identifier url } }`, { id: identifier });
        return d.issue ?? null;
    }
    const t = await clickupTask(cfg, identifier);
    return { id: t.id, identifier: t.custom_id ?? t.id, url: t.url };
};
