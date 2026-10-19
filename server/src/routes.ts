// Server-side twin of web/src/routes.ts (parse only): the UI's hash path is the one description of where the human is,
// and the assistant (prompter.ts) turns it into words. Keep the grammar in step with the web module.
//
//   #/dashboard[/<taskId>/<tab>[/<x>]]      #/tasks[?env=]  #/tasks/new  #/tasks/<taskId>/<tab>[/<x>][?repo=&scope=]
//   #/sessions[/<id>/<terminal|changes>]    #/analytics[?days=]  #/envs[/<id>]  #/config-dirs[/<id>]  #/accounts  #/integrations

export const TASK_TABS = ["work", "runs", "design", "code", "pr", "comments", "chat", "ticket", "cost"] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export interface TaskView {
    tab: TaskTab;
    step?: string;
    run?: string;
    section?: string;
    repo?: string;
    scope?: { kind: "all" } | { kind: "uncommitted" } | { kind: "commits"; shas: string[] };
    sub?: "user" | "pr" | "automation";
}

export type Route =
    | { page: "dashboard"; task?: string; view?: TaskView }
    | { page: "tasks"; list?: "active" | "completed"; env?: string; task?: string; view?: TaskView; create?: boolean }
    | { page: "sessions"; session?: string; view?: "terminal" | "changes" }
    | { page: "analytics"; days?: number }
    | { page: "timing"; days?: number }
    | { page: "envs"; env?: string }
    | { page: "config-dirs"; dir?: string }
    | { page: "accounts" }
    | { page: "integrations" }
    | { page: "product"; po?: string; tab?: string };

const isTab = (s: string | undefined): s is TaskTab => !!s && (TASK_TABS as readonly string[]).includes(s);

const parseTaskView = (tab: string | undefined, x: string | undefined, q: URLSearchParams): TaskView | undefined => {
    if (!isTab(tab)) return undefined;
    const repo = q.get("repo") ?? undefined;
    const scopeRaw = q.get("scope");
    const scope: TaskView["scope"] = !scopeRaw || scopeRaw === "all" ? undefined : scopeRaw === "uncommitted" ? { kind: "uncommitted" } : { kind: "commits", shas: scopeRaw.split(",").filter(Boolean) };
    switch (tab) {
        case "work": return { tab, ...(x ? { step: x } : {}) };
        case "runs": return { tab, ...(x ? { run: x } : {}) };
        case "design": return { tab, ...(x ? { section: x } : {}) };
        case "code": return { tab, ...(repo !== undefined ? { repo } : {}), ...(scope ? { scope } : {}) };
        case "pr": return { tab, ...(x ? { repo: x } : {}) };
        case "comments": return { tab, ...(x === "user" || x === "pr" || x === "automation" ? { sub: x } : {}), ...(repo !== undefined ? { repo } : {}) };
        default: return { tab };
    }
};

export const parseRoute = (hash: string): Route => {
    const raw = hash.replace(/^#\/?/, "");
    const qi = raw.indexOf("?");
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const q = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    const [head = "dashboard", a, b, c] = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    const env = q.get("env") ?? undefined;
    const view = parseTaskView(b, c, q);
    switch (head) {
        case "dashboard":
            if (!a) return { page: "dashboard" };
            return view ? { page: "dashboard", task: a, view } : { page: "dashboard", task: a };
        case "tasks":
            if (a === "new") return { page: "tasks", create: true, ...(env ? { env } : {}) };
            // The list views (#/tasks/list, /completed, /active) and the Feed (#/tasks/feed, the bare #/tasks) have no task.
            if (a === "feed") return { page: "tasks", ...(env ? { env } : {}) };
            if (a === "list" || a === "completed" || a === "active") return { page: "tasks", list: a === "completed" ? "completed" : "active", ...(env ? { env } : {}) };
            if (a) return view ? { page: "tasks", task: a, view } : { page: "tasks", task: a };
            return { page: "tasks", ...(env ? { env } : {}) };
        case "sessions":
            return { page: "sessions", ...(a ? { session: a } : {}), ...(b === "changes" || b === "terminal" ? { view: b } : {}) };
        case "analytics": {
            const days = Number(q.get("days"));
            return { page: "analytics", ...(Number.isFinite(days) && days > 0 ? { days } : {}) };
        }
        case "timing": {
            const days = Number(q.get("days"));
            return { page: "timing", ...(Number.isFinite(days) && days > 0 ? { days } : {}) };
        }
        case "envs":
        case "env":
            return { page: "envs", ...(a ? { env: a } : {}) };
        case "config-dirs":
        case "dirs":
        case "dir":
            return { page: "config-dirs", ...(a ? { dir: a } : {}) };
        case "accounts":
            return { page: "accounts" };
        case "integrations":
        case "managers":
            return { page: "integrations" };
        case "product":
            return { page: "product", ...(a ? { po: a } : {}), ...(b ? { tab: b } : {}) };
        default:
            return { page: "dashboard" };
    }
};
