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
];

describe("routes", () => {
    for (const r of routes) it(formatRoute(r), () => expect(parseRoute(formatRoute(r))).toEqual(r));
});
