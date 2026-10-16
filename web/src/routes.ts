import { useMemo, useSyncExternalStore } from "react";
import { STAGE_ORDER, type Stage } from "./api";

// Every location the app can show has exactly one hash path, and every hash path opens exactly one location — so a
// reload, back/forward, a pasted link, or an assistant reading the path all land on the same screen. Components take
// their view from the route and change it through `navigate`; nothing view-affecting lives in component state.
//
//   #/dashboard                                    #/dashboard/<taskId>/<tab>…   (a task opened from the Dashboard stays there)
//   #/tasks[?env=<envId>]                          #/tasks/new[?env=<envId>]
//   #/tasks/<taskId>/work[/<stage>[/<proposal|qa|po>]]       #/tasks/<taskId>/code[?repo=<dir>&scope=all|uncommitted|<sha>,<sha>&kind=tests]
//   #/tasks/<taskId>/pr[/<repo>]                             #/tasks/<taskId>/conversation[/<user|pr|automation>][?repo=<dir>]
//   #/tasks/<taskId>/details[/<runs[/<runId>]|cost|setup>]
//   #/sessions[/new | /<sessionId>/<terminal|changes>[?repo&scope&kind]]           #/analytics[?days=<n>]   #/timing[?days=<n>]
//   #/envs[/new | /<envId>[/<tab>]]                #/config-dirs[/new | /<dirId>[/<tab>]]
//   #/accounts[/new | /<accountId>[/<tab>]]        #/integrations[/<id>[/<tab>]]  #/resources[/<tab>]
//   #/prompter[/<tab>]
//   #/product[/new | /context | /memory][?env=<envId>]                              #/product/<poId>[/<tab>[/<ticketKey>[/<tab>]]]
// The rule (CLAUDE.md, Web UI standards): a page, an opened entity, its tab, an opened item inside it, a create dialog and
// a view selector (environment picker, Files/Tests, diff scope) are all part of the path. An EntityView's tab is routed
// through `tab`/`onTab`; only transient UI (hover, expanded rows, menus, an inline edit) may live in component state.
// Older shapes (#/env/<id>, #/dir/<id>, #/dirs, #/managers, and the task tabs runs / design / comments / chat / ticket / cost)
// still parse and are rewritten to the current one.

export const TASK_TABS = ["work", "code", "pr", "conversation", "details"] as const;
export type TaskTab = (typeof TASK_TABS)[number];
// The Conversation tab: the agent chat (default) or the comment lists; the Details tab: the ticket (default), the runs, the cost, the setup.
export type ConversationSub = "user" | "pr" | "automation";
export type DetailsPart = "runs" | "cost" | "setup";
export type DesignSection = "proposal" | "qa" | "po";
export type CodeScope = { kind: "all" } | { kind: "uncommitted" } | { kind: "commits"; shas: string[] };
// The diff view's own location (task Code tab, session Changes): repository, which changes, files or tests.
export interface DiffRoute {
    repo?: string;
    scope?: CodeScope;
    tests?: boolean;
}

export interface TaskView {
    tab: TaskTab;
    // work: the workflow step shown (default: the task's current stage).
    step?: Stage;
    // work, design proposal step: the part of the proposal opened (the document by default).
    section?: DesignSection;
    // code / pr / conversation: the repository (multi-repo envs).
    repo?: string;
    // code: which changes are shown, and the Tests tab instead of Files.
    scope?: CodeScope;
    tests?: boolean;
    // conversation: which comment list (the agent chat when absent).
    sub?: ConversationSub;
    // details: which part (the ticket when absent), and for the runs the run opened.
    part?: DetailsPart;
    run?: string;
}

export type Route =
    | { page: "dashboard"; task?: string; view?: TaskView }
    | { page: "tasks"; env?: string; task?: string; view?: TaskView; create?: boolean }
    | { page: "sessions"; session?: string; view?: "terminal" | "changes"; diff?: DiffRoute; create?: boolean }
    | { page: "analytics"; days?: number }
    | { page: "timing"; days?: number }
    // An entity page's `tab` is its EntityView tab; `create` is the "Create new" dialog over the list.
    | { page: "envs"; env?: string; tab?: string; create?: boolean }
    | { page: "config-dirs"; dir?: string; tab?: string; create?: boolean }
    | { page: "accounts"; account?: string; tab?: string; create?: boolean }
    | { page: "integrations"; integration?: string; tab?: string }
    | { page: "prompter"; tab?: string }
    | { page: "resources"; tab?: string }
    // The Product page: `home` is its subtab (Product owners when absent) with the environment its context/memory show;
    // `po` opens a Product Owner on its `tab`, and `ticket` one ticket of its Tickets tab.
    | { page: "product"; home?: ProductHomeTab; env?: string; create?: boolean; po?: string; tab?: PoTab; ticket?: string; ticketTab?: string };
export type ProductHomeTab = "context" | "memory";
export type PoTab = "context" | "design" | "questions" | "tickets" | "events" | "corrections";
export const PO_TABS: readonly PoTab[] = ["design", "questions", "corrections", "context", "tickets", "events"];

export type Page = Route["page"];

const isStage = (s: string | undefined): s is Stage => !!s && (STAGE_ORDER as readonly string[]).includes(s);
const isSub = (s: string | undefined): s is ConversationSub => s === "user" || s === "pr" || s === "automation";
const isPart = (s: string | undefined): s is DetailsPart => s === "runs" || s === "cost" || s === "setup";
const isSection = (s: string | undefined): s is DesignSection => s === "proposal" || s === "qa" || s === "po";

const parseScope = (s: string | null): CodeScope | undefined => {
    if (!s || s === "all") return undefined;
    if (s === "uncommitted") return { kind: "uncommitted" };
    const shas = s.split(",").filter(Boolean);
    return shas.length ? { kind: "commits", shas } : undefined;
};
const formatScope = (scope: CodeScope | undefined): string | null => (!scope || scope.kind === "all" ? null : scope.kind === "uncommitted" ? "uncommitted" : scope.shas.join(","));

const parseDiff = (q: URLSearchParams): DiffRoute => {
    const repo = q.get("repo") ?? undefined;
    const scope = parseScope(q.get("scope"));
    return { ...(repo !== undefined ? { repo } : {}), ...(scope ? { scope } : {}), ...(q.get("kind") === "tests" ? { tests: true } : {}) };
};
const diffQuery = (d: DiffRoute | undefined) => ({ repo: d?.repo, scope: formatScope(d?.scope), kind: d?.tests ? "tests" : null });

// The task tabs of before the workspace rework: runs / design / comments / chat / ticket / cost fold into the five tabs.
const parseTaskView = (tab: string | undefined, x: string | undefined, y: string | undefined, q: URLSearchParams): TaskView | undefined => {
    const repo = q.get("repo") ?? undefined;
    switch (tab) {
        case "work": return { tab: "work", ...(isStage(x) ? { step: x, ...(isSection(y) ? { section: y } : {}) } : {}) };
        case "code": return { tab: "code", ...parseDiff(q) };
        case "pr": return { tab: "pr", ...(x ? { repo: x } : {}) };
        case "conversation": return { tab: "conversation", ...(isSub(x) ? { sub: x } : {}), ...(repo !== undefined ? { repo } : {}) };
        case "details": return { tab: "details", ...(isPart(x) ? { part: x } : {}), ...(x === "runs" && y ? { run: y } : {}) };
        case "design": return { tab: "work", step: "design_proposal", ...(isSection(x) ? { section: x } : {}) };
        case "comments": return { tab: "conversation", sub: isSub(x) ? x : "user", ...(repo !== undefined ? { repo } : {}) };
        case "chat": return { tab: "conversation" };
        case "runs": return { tab: "details", part: "runs", ...(x ? { run: x } : {}) };
        case "cost": return { tab: "details", part: "cost" };
        case "ticket": return { tab: "details" };
        default: return undefined;
    }
};

export const parseRoute = (hash: string): Route => {
    const raw = hash.replace(/^#\/?/, "");
    const qi = raw.indexOf("?");
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const q = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    const [head = "dashboard", a, b, c, d] = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    const env = q.get("env") ?? undefined;
    switch (head) {
        case "dashboard":
            return a ? { page: "dashboard", task: a, ...(parseTaskView(b, c, d, q) ? { view: parseTaskView(b, c, d, q) } : {}) } : { page: "dashboard" };
        case "tasks":
            if (a === "new") return { page: "tasks", create: true, ...(env ? { env } : {}) };
            if (a) return { page: "tasks", task: a, ...(parseTaskView(b, c, d, q) ? { view: parseTaskView(b, c, d, q) } : {}) };
            return { page: "tasks", ...(env ? { env } : {}) };
        case "sessions":
            if (a === "new") return { page: "sessions", create: true };
            return { page: "sessions", ...(a ? { session: a } : {}), ...(b === "changes" || b === "terminal" ? { view: b } : {}), ...(b === "changes" ? { diff: parseDiff(q) } : {}) };
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
            if (a === "new") return { page: "envs", create: true };
            return { page: "envs", ...(a ? { env: a } : {}), ...(a && b ? { tab: b } : {}) };
        case "config-dirs":
        case "dirs":
        case "dir":
            if (a === "new") return { page: "config-dirs", create: true };
            return { page: "config-dirs", ...(a ? { dir: a } : {}), ...(a && b ? { tab: b } : {}) };
        case "accounts":
            if (a === "new") return { page: "accounts", create: true };
            return { page: "accounts", ...(a ? { account: a } : {}), ...(a && b ? { tab: b } : {}) };
        case "integrations":
        case "managers":
            return { page: "integrations", ...(a ? { integration: a } : {}), ...(a && b ? { tab: b } : {}) };
        case "prompter":
            return { page: "prompter", ...(a ? { tab: a } : {}) };
        case "resources":
            return { page: "resources", ...(a ? { tab: a } : {}) };
        case "product":
            if (a === "new") return { page: "product", create: true };
            if (a === "context" || a === "memory") return { page: "product", home: a, ...(env ? { env } : {}) };
            return {
                page: "product",
                ...(a ? { po: a } : {}),
                ...(PO_TABS.includes(b as PoTab) ? { tab: b as PoTab } : {}),
                ...(b === "tickets" && c ? { ticket: c } : {}),
                ...(b === "tickets" && c && d ? { ticketTab: d } : {}),
            };
        default:
            return { page: "dashboard" };
    }
};

const enc = encodeURIComponent;
const withQuery = (path: string, params: Record<string, string | null | undefined>): string => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `${path}?${s}` : path;
};

const formatTaskView = (base: string, view: TaskView | undefined): string => {
    const v = view ?? { tab: "work" };
    switch (v.tab) {
        case "work": return `${base}/work${v.step ? `/${enc(v.step)}${v.section ? `/${v.section}` : ""}` : ""}`;
        case "code": return withQuery(`${base}/code`, diffQuery(v));
        case "pr": return `${base}/pr${v.repo ? `/${enc(v.repo)}` : ""}`;
        case "conversation": return withQuery(`${base}/conversation${v.sub ? `/${v.sub}` : ""}`, { repo: v.repo });
        case "details": return `${base}/details${v.part ? `/${v.part}${v.part === "runs" && v.run ? `/${enc(v.run)}` : ""}` : ""}`;
    }
};

const entityPath = (list: string, id: string | undefined, tab: string | undefined, create?: boolean): string =>
    create ? `#/${list}/new` : id ? `#/${list}/${enc(id)}${tab ? `/${enc(tab)}` : ""}` : `#/${list}`;

export const formatRoute = (r: Route): string => {
    switch (r.page) {
        case "dashboard": return r.task ? formatTaskView(`#/dashboard/${enc(r.task)}`, r.view) : "#/dashboard";
        case "tasks":
            if (r.task) return formatTaskView(`#/tasks/${enc(r.task)}`, r.view);
            return withQuery(r.create ? "#/tasks/new" : "#/tasks", { env: r.env });
        case "sessions":
            if (r.create) return "#/sessions/new";
            if (!r.session) return "#/sessions";
            return r.view === "changes" ? withQuery(`#/sessions/${enc(r.session)}/changes`, diffQuery(r.diff)) : `#/sessions/${enc(r.session)}/terminal`;
        case "analytics": return withQuery("#/analytics", { days: r.days ? String(r.days) : null });
        case "timing": return withQuery("#/timing", { days: r.days ? String(r.days) : null });
        case "envs": return entityPath("envs", r.env, r.tab, r.create);
        case "config-dirs": return entityPath("config-dirs", r.dir, r.tab, r.create);
        case "accounts": return entityPath("accounts", r.account, r.tab, r.create);
        case "integrations": return entityPath("integrations", r.integration, r.tab);
        case "prompter": return r.tab ? `#/prompter/${enc(r.tab)}` : "#/prompter";
        case "resources": return r.tab ? `#/resources/${enc(r.tab)}` : "#/resources";
        case "product":
            if (r.create) return "#/product/new";
            if (r.po) return `#/product/${enc(r.po)}${r.tab ? `/${r.tab}` : ""}${r.tab === "tickets" && r.ticket ? `/${enc(r.ticket)}${r.ticketTab ? `/${enc(r.ticketTab)}` : ""}` : ""}`;
            return r.home ? withQuery(`#/product/${r.home}`, { env: r.env }) : "#/product";
    }
};

// The current route, re-read on every hash change (links, back/forward, navigate()).
const subscribe = (fn: () => void): (() => void) => {
    window.addEventListener("hashchange", fn);
    window.addEventListener("popstate", fn);
    return () => {
        window.removeEventListener("hashchange", fn);
        window.removeEventListener("popstate", fn);
    };
};
const snapshot = (): string => location.hash;
export const useRoute = (): Route => {
    const hash = useSyncExternalStore(subscribe, snapshot, snapshot);
    return useMemo(() => parseRoute(hash), [hash]);
};

export const currentRoute = (): Route => parseRoute(location.hash);

// Changes the location. `replace` rewrites the current history entry (used to canonicalise an old-shaped link).
export const navigate = (to: Route | ((current: Route) => Route), opts: { replace?: boolean } = {}): void => {
    const next = typeof to === "function" ? to(currentRoute()) : to;
    const h = formatRoute(next);
    if (location.hash === h) return;
    if (opts.replace) history.replaceState(null, "", h);
    else history.pushState(null, "", h);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
};

// The task route the page is on (Dashboard keeps a task in place; everything else opens it on the Tasks page).
export const taskRoute = (current: Route, taskId: string, view?: TaskView): Route =>
    current.page === "dashboard" ? { page: "dashboard", task: taskId, ...(view ? { view } : {}) } : { page: "tasks", task: taskId, ...(view ? { view } : {}) };
