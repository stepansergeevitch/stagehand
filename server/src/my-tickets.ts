import { saveConfig, type Config } from "./config.js";
import type { TicketSource } from "./tickets.js";

// "My tickets" for the new-task dropdown: assigned to the token's user, open, sorted by priority (urgent first, unset last).
export interface MyTicket {
    id: string;
    title: string;
    priority: number | null; // 1 = urgent … 4 = low
    priorityLabel: string;
    status: string;
    url: string | null;
    group: string; // sprint / cycle name for the option group
}

const byPriority = (a: MyTicket, b: MyTicket): number => (a.priority ?? 99) - (b.priority ?? 99) || a.id.localeCompare(b.id);

// ---------- ClickUp: assigned to me, in the sprint list(s) whose date range includes today ----------

interface ClickUpList {
    id: string;
    name: string;
    start_date?: string | null;
    due_date?: string | null;
}

const clickUp = async <T>(cfg: Config, path: string): Promise<T> => {
    const res = await fetch(`https://api.clickup.com/api/v2${path}`, { headers: { Authorization: cfg.clickupToken! } });
    if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
};

// Sprint lists carry start/due dates; fall back to a "(M/D - M/D)" suffix in the name when they don't.
const listCoversToday = (l: ClickUpList, now: Date): boolean => {
    if (l.start_date && l.due_date) return Number(l.start_date) <= now.getTime() && now.getTime() <= Number(l.due_date) + 86_400_000;
    const m = /\((\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\)/.exec(l.name);
    if (!m) return false;
    const y = now.getFullYear();
    const start = new Date(y, Number(m[1]) - 1, Number(m[2]));
    let end = new Date(y, Number(m[3]) - 1, Number(m[4]), 23, 59, 59);
    if (end < start) end = new Date(y + 1, Number(m[3]) - 1, Number(m[4]), 23, 59, 59); // sprint spanning new year
    return start <= now && now <= end;
};

const currentSprintLists = async (cfg: Config): Promise<ClickUpList[]> => {
    const teamId = cfg.clickupTeamId;
    if (!teamId) throw new Error("ClickUp team id is not set in Settings");
    const { spaces } = await clickUp<{ spaces: Array<{ id: string; name: string }> }>(cfg, `/team/${teamId}/space?archived=false`);
    const now = new Date();
    const found: ClickUpList[] = [];
    for (const s of spaces) {
        const { folders } = await clickUp<{ folders: Array<{ name: string; lists: ClickUpList[] }> }>(cfg, `/space/${s.id}/folder?archived=false`);
        for (const f of folders) for (const l of f.lists) if (/sprint/i.test(`${f.name} ${l.name}`) && listCoversToday(l, now)) found.push(l);
    }
    return found;
};

const clickUpUserId = async (cfg: Config): Promise<string> => {
    if (cfg.clickupUserId) return cfg.clickupUserId;
    const { user } = await clickUp<{ user: { id: number } }>(cfg, "/user");
    cfg.clickupUserId = String(user.id);
    saveConfig(cfg);
    return cfg.clickupUserId;
};

const myClickUpTickets = async (cfg: Config): Promise<MyTicket[]> => {
    if (!cfg.clickupToken) throw new Error("ClickUp token is not set in Settings");
    const [userId, lists] = await Promise.all([clickUpUserId(cfg), currentSprintLists(cfg)]);
    if (lists.length === 0) return [];
    const out: MyTicket[] = [];
    for (const l of lists) {
        const { tasks } = await clickUp<{
            tasks: Array<{ id: string; custom_id?: string | null; name: string; url?: string; status?: { status: string; type?: string }; priority?: { id: string; priority: string } | null }>;
        }>(cfg, `/list/${l.id}/task?assignees[]=${encodeURIComponent(userId)}&include_closed=false&subtasks=true`);
        for (const t of tasks) {
            if (t.status?.type === "closed" || t.status?.type === "done") continue;
            out.push({
                id: t.custom_id ?? t.id,
                title: t.name,
                priority: t.priority ? Number(t.priority.id) : null,
                priorityLabel: t.priority?.priority ?? "none",
                status: t.status?.status ?? "",
                url: t.url ?? null,
                group: l.name,
            });
        }
    }
    return out.sort(byPriority);
};

// ---------- Linear: issues assigned to the key's user that are not completed/canceled ----------

const myLinearTickets = async (cfg: Config): Promise<MyTicket[]> => {
    if (!cfg.linearApiKey) throw new Error("Linear API key is not set in Settings");
    const query = `{ viewer { assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { identifier title priority priorityLabel url state { name } cycle { name number } } } } }`;
    const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: cfg.linearApiKey },
        body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Linear ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
        data?: { viewer: { assignedIssues: { nodes: Array<{ identifier: string; title: string; priority: number; priorityLabel: string; url: string; state: { name: string }; cycle: { name?: string | null; number: number } | null }> } } };
        errors?: Array<{ message: string }>;
    };
    if (!body.data) throw new Error(`Linear: ${body.errors?.[0]?.message ?? "no data"}`);
    return body.data.viewer.assignedIssues.nodes
        .map((n) => ({
            id: n.identifier,
            title: n.title,
            priority: n.priority === 0 ? null : n.priority, // Linear: 0 none, 1 urgent … 4 low
            priorityLabel: n.priorityLabel,
            status: n.state.name,
            url: n.url,
            group: n.cycle ? (n.cycle.name ?? `Cycle ${n.cycle.number}`) : "No cycle",
        }))
        .sort(byPriority);
};

const cache = new Map<TicketSource, { at: number; tickets: MyTicket[] }>();

export const listMyTickets = async (source: TicketSource, cfg: Config): Promise<MyTicket[]> => {
    const hit = cache.get(source);
    if (hit && Date.now() - hit.at < 60_000) return hit.tickets;
    const tickets = source === "clickup" ? await myClickUpTickets(cfg) : await myLinearTickets(cfg);
    cache.set(source, { at: Date.now(), tickets });
    return tickets;
};
