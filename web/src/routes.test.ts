import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, type Route } from "./routes";

// Every view is in the path: each route survives format → parse unchanged (a reload lands on the same screen).
const routes: Route[] = [
    { page: "envs", create: true },
    { page: "envs", env: "e1", tab: "database" },
    { page: "config-dirs", create: true },
    { page: "config-dirs", dir: "d1", tab: "rules" },
    { page: "accounts", create: true },
    { page: "accounts", account: "a1", tab: "models" },
    { page: "integrations", integration: "tm:linear", tab: "settings" },
    { page: "prompter", tab: "palace" },
    { page: "resources", tab: "policies" },
    { page: "sessions", create: true },
    { page: "sessions", session: "s1", view: "changes", diff: { repo: "backend", scope: { kind: "uncommitted" }, tests: true } },
    { page: "product", create: true },
    { page: "product", home: "memory", env: "e1" },
    { page: "product", po: "p1", tab: "tickets", ticket: "T7", ticketTab: "tracker" },
    { page: "tasks", task: "t1", view: { tab: "code", repo: "frontend", scope: { kind: "commits", shas: ["abc", "def"] }, tests: true } },
    { page: "tasks", task: "t1", view: { tab: "work", step: "design_proposal", section: "qa" } },
    { page: "tasks", task: "t1", view: { tab: "pr", repo: "backend" } },
    { page: "tasks", task: "t1", view: { tab: "conversation" } },
    { page: "dashboard", task: "t1", view: { tab: "conversation", sub: "automation", repo: "backend" } },
    { page: "tasks", task: "t1", view: { tab: "details", part: "runs", run: "r9" } },
    { page: "tasks", task: "t1", view: { tab: "details", part: "cost" } },
];

// Links of before the workspace rework still open the right place and are rewritten to the current shape.
const legacy: Array<[string, Route]> = [
    ["#/tasks/t1/runs/r9", { page: "tasks", task: "t1", view: { tab: "details", part: "runs", run: "r9" } }],
    ["#/tasks/t1/design/qa", { page: "tasks", task: "t1", view: { tab: "work", step: "design_proposal", section: "qa" } }],
    ["#/tasks/t1/comments/pr?repo=api", { page: "tasks", task: "t1", view: { tab: "conversation", sub: "pr", repo: "api" } }],
    ["#/tasks/t1/chat", { page: "tasks", task: "t1", view: { tab: "conversation" } }],
    ["#/tasks/t1/ticket", { page: "tasks", task: "t1", view: { tab: "details" } }],
    ["#/dashboard/t1/cost", { page: "dashboard", task: "t1", view: { tab: "details", part: "cost" } }],
];

describe("routes", () => {
    for (const r of routes) it(formatRoute(r), () => expect(parseRoute(formatRoute(r))).toEqual(r));
});

describe("legacy task links", () => {
    for (const [hash, route] of legacy) it(hash, () => {
        expect(parseRoute(hash)).toEqual(route);
        expect(parseRoute(formatRoute(parseRoute(hash)))).toEqual(route);
    });
});
