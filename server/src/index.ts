import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig, saveConfig } from "./config.js";
import { isPublicRequest, publicAuth } from "./public-access.js";
import { listMyTickets } from "./my-tickets.js";
import { GUARD_HOOK, prTemplates, Rules, rulesOf } from "./rules.js";
import { inspectConfigDir } from "./config-dirs.js";
import { recordUsage, usageReport } from "./usage.js";

const MODEL_OPTIONS = [
    { value: "", label: "Account default" },
    { value: "fable", label: "Fable 5.1 (claude-fable-5-1)" },
    { value: "opus", label: "Opus 5 (claude-opus-5)" },
    { value: "sonnet", label: "Sonnet 5 (claude-sonnet-5)" },
];
import { accountOrderOf, accountUsableWith, chromeBrowserLabel, chromeBrowsersOf, migrateAccountsToConfigDirs, now, openDb, parseEnvVars, STAGES, type AccountRow, type ChromeBrowser, type ConfigDirRow, type EnvRow, type Stage } from "./db.js";
import { matchChromeProfiles, openInProfile } from "./chrome-profiles.js";
import { Engine } from "./engine.js";
import { Services } from "./services.js";
import { authDirFor, authEnv, OAUTH_TOKEN_RE, probeChrome, probeDefaultModel, readAuthStatus, SETUP_TOKEN_COMMAND } from "./claude/accounts.js";
import { isGitRepo, repoPaths } from "./git.js";
import { attach, capturePane, ensureSession, killSession, loginSessionName, pipePane, sessionExists, taskSessionName } from "./tmux.js";

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
migrateAccountsToConfigDirs(db, { mainConfigDir: cfg.mainConfigDir, scratchAccountsDir: cfg.accountsDir });
const services = new Services(db, cfg);
const engine = new Engine(db, cfg, services);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
// Guard first: requests on the public listener need a login; the loopback listener stays open for local dev.
app.use("*", publicAuth(cfg));
app.use("/api/*", cors());

const json = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return parsed.data;
};

app.onError((err, c) => c.json({ error: err.message }, 400));

// ---------- accounts ----------

const accountsAll = (): AccountRow[] => db.prepare(`SELECT * FROM accounts ORDER BY created_at`).all() as AccountRow[];
const accountById = (id: string): AccountRow | undefined => db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
const configDirsAll = (): ConfigDirRow[] => db.prepare(`SELECT * FROM config_dirs ORDER BY created_at`).all() as ConfigDirRow[];
const configDirById = (id: string): ConfigDirRow | undefined => db.prepare(`SELECT * FROM config_dirs WHERE id = ?`).get(id) as ConfigDirRow | undefined;

// The token never leaves the server; the UI only learns whether one is stored.
const publicAccount = (a: AccountRow) => {
    const { oauth_token, ...rest } = a;
    return { ...rest, has_token: !!oauth_token };
};
const emitAccount = (id: string): void => {
    const acc = accountById(id);
    if (acc) engine.emit("account", publicAccount(acc));
};

// Token accounts are verified by a trivial run in the server's own config dir (also yields the default model);
// legacy accounts by `claude auth status` inside the dir that holds their browser login.
interface Verification {
    ok: boolean;
    detail: string;
}
const refreshAccount = async (acc: AccountRow): Promise<Verification> => {
    let result: Verification;
    if (acc.oauth_token) {
        const r = await probeDefaultModel(cfg.mainConfigDir, cfg.dataDir, authEnv(acc));
        if (r.result) recordUsage(db, { accountId: acc.id, envId: null, taskId: null, runId: null, kind: "probe", stage: null }, r.result);
        db.prepare(`UPDATE accounts SET logged_in = ?, default_model = COALESCE(?, default_model) WHERE id = ?`).run(r.ok ? 1 : 0, r.model, acc.id);
        result = r.ok ? { ok: true, detail: `token works — a trivial run answered on ${r.model}` } : { ok: false, detail: `token rejected: ${r.error ?? "run failed"}` };
    } else {
        const status = await readAuthStatus(acc.auth_dir);
        db.prepare(`UPDATE accounts SET logged_in = ?, email = COALESCE(?, email), org = COALESCE(?, org), plan = COALESCE(?, plan) WHERE id = ?`).run(
            status.loggedIn ? 1 : 0,
            status.email ?? null,
            status.orgName ?? null,
            status.subscriptionType ?? null,
            acc.id,
        );
        if (status.loggedIn && !acc.default_model) {
            const r = await probeDefaultModel(acc.auth_dir, cfg.dataDir);
            if (r.result) recordUsage(db, { accountId: acc.id, envId: null, taskId: null, runId: null, kind: "probe", stage: null }, r.result);
            if (r.model) db.prepare(`UPDATE accounts SET default_model = ? WHERE id = ?`).run(r.model, acc.id);
        }
        result = status.loggedIn
            ? { ok: true, detail: `legacy login in ${acc.auth_dir} is valid (${status.email ?? "no email"}, ${status.subscriptionType ?? "unknown plan"}) — only usable in that dir; set up a token to use it anywhere` }
            : { ok: false, detail: `no valid login in ${acc.auth_dir} — set up a token` };
    }
    emitAccount(acc.id);
    return result;
};

// Runs `claude setup-token` in a terminal the human completes in the browser. The pane output is mirrored to a file and the
// pane's scrollback is read as well; both are polled for the printed token, which is then stored and the terminal closed.
const tokenCaptures = new Map<string, NodeJS.Timeout>();
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const watchTokenSetup = (acc: AccountRow): void => {
    const tmuxName = loginSessionName(acc.name);
    const logFile = join(acc.auth_dir, "setup-token.log");
    const started = Date.now();
    clearInterval(tokenCaptures.get(acc.id));
    let busy = false;
    const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
            const fromFile = existsSync(logFile) ? stripAnsi(readFileSync(logFile, "utf8")) : "";
            const m = OAUTH_TOKEN_RE.exec(fromFile) ?? OAUTH_TOKEN_RE.exec(stripAnsi(await capturePane(tmuxName)));
            if (m) {
                clearInterval(timer);
                tokenCaptures.delete(acc.id);
                rmSync(logFile, { force: true });
                db.prepare(`UPDATE accounts SET oauth_token = ?, logged_in = 1 WHERE id = ?`).run(m[0], acc.id);
                await killSession(tmuxName);
                emitAccount(acc.id);
                await refreshAccount(accountById(acc.id)!);
            } else if (Date.now() - started > 20 * 60_000 || !(await sessionExists(tmuxName))) {
                clearInterval(timer);
                tokenCaptures.delete(acc.id);
                rmSync(logFile, { force: true });
            }
        })().finally(() => {
            busy = false;
        });
    }, 2_000);
    tokenCaptures.set(acc.id, timer);
};

const startTokenSetup = async (acc: AccountRow): Promise<string> => {
    const tmuxName = loginSessionName(acc.name);
    await killSession(tmuxName);
    const logFile = join(acc.auth_dir, "setup-token.log");
    rmSync(logFile, { force: true });
    await ensureSession(
        tmuxName,
        acc.auth_dir,
        `${SETUP_TOKEN_COMMAND}; echo; echo '[stagehand] token setup finished — Stagehand stores the token and closes this terminal.'; sleep 900`,
        { CLAUDE_CONFIG_DIR: acc.auth_dir },
    );
    if (!(await pipePane(tmuxName, logFile))) console.warn(`[stagehand] could not mirror the ${tmuxName} pane; relying on scrollback capture`);
    watchTokenSetup(acc);
    return tmuxName;
};

// A server restart must not lose a token that was printed in a login terminal that is still open.
const resumeTokenSetups = async (): Promise<void> => {
    for (const acc of accountsAll()) {
        if (acc.oauth_token) continue;
        if (await sessionExists(loginSessionName(acc.name))) watchTokenSetup(acc);
    }
};

// Tokens (all kinds) and estimated cost this account consumed since local midnight and over the last 7 days.
const accountUsage = (accountId: string): { today: { tokens: number; cost: number }; week: { tokens: number; cost: number } } => {
    const q = db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE account_id = ? AND at >= ?`);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = q.get(accountId, midnight.toISOString()) as { tokens: number; cost: number };
    const week = q.get(accountId, new Date(Date.now() - 7 * 86_400_000).toISOString()) as { tokens: number; cost: number };
    return { today, week };
};

app.get("/api/accounts", (c) => {
    const limits = db.prepare(`SELECT * FROM rate_limits`).all() as Array<{ account_id: string; window: string; utilization: number; resets_at: number }>;
    return c.json(
        accountsAll().map((a) => ({
            ...publicAccount(a),
            setting_up: tokenCaptures.has(a.id),
            limits: limits.filter((l) => l.account_id === a.id).map(({ window, utilization, resets_at }) => ({ window, utilization, resetsAt: resets_at })),
            usage: accountUsage(a.id),
        })),
    );
});

app.post("/api/accounts", async (c) => {
    const body = json(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), email: z.string().email().optional(), provider: z.literal("anthropic").default("anthropic") }), await c.req.json());
    const id = randomUUID();
    db.prepare(`INSERT INTO accounts (id, name, provider, auth_dir, email, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, body.name, body.provider, authDirFor(cfg, body.name), body.email ?? null, now());
    const terminal = await startTokenSetup(accountById(id)!);
    return c.json({ account: publicAccount(accountById(id)!), terminal });
});

app.post("/api/accounts/:id/setup-token", async (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    return c.json({ terminal: await startTokenSetup(acc) });
});

app.post("/api/accounts/:id/refresh", async (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const verification = await refreshAccount(acc);
    return c.json({ ...verification, account: publicAccount(accountById(acc.id)!) });
});

app.patch("/api/accounts/:id", async (c) => {
    const body = json(
        z.object({ name: z.string().regex(/^[a-z0-9-]+$/).optional(), failover_enabled: z.boolean().optional(), failover_threshold: z.number().min(0).max(1).optional() }),
        await c.req.json(),
    );
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    db.prepare(`UPDATE accounts SET name = ?, failover_enabled = ?, failover_threshold = ? WHERE id = ?`).run(
        body.name ?? acc.name,
        body.failover_enabled === undefined ? acc.failover_enabled : body.failover_enabled ? 1 : 0,
        body.failover_threshold ?? acc.failover_threshold,
        acc.id,
    );
    emitAccount(acc.id);
    return c.json(publicAccount(accountById(acc.id)!));
});

// Deleting an account only forgets it in Stagehand (its token and auth dir go, config dirs stay); refused while an env or task still points at it.
app.delete("/api/accounts/:id", (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const envs = db.prepare(`SELECT name FROM envs WHERE default_account_id = ?`).all(acc.id) as Array<{ name: string }>;
    const tasks = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE account_id = ?`).get(acc.id) as { n: number };
    if (envs.length || tasks.n) return c.json({ error: `in use by ${envs.map((e) => `env ${e.name}`).concat(tasks.n ? [`${tasks.n} task(s)`] : []).join(", ")} — reassign first` }, 400);
    clearInterval(tokenCaptures.get(acc.id));
    tokenCaptures.delete(acc.id);
    db.prepare(`DELETE FROM rate_limits WHERE account_id = ?`).run(acc.id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(acc.id);
    return c.json({ deleted: acc.id });
});

// ---------- Claude config dirs ----------

const configDirView = (d: ConfigDirRow) => ({
    ...d,
    contents: inspectConfigDir(d.path),
    envs: envsAll().filter((e) => e.config_dir_id === d.id).map((e) => e.name),
    usable_accounts: accountsAll().filter((a) => accountUsableWith(a, d.path)).map((a) => a.name),
    browsers: chromeBrowsersOf(d),
});

// The dir's own browser login (what the Chrome bridge needs); the account it belongs to is matched by email.
const refreshDirLogin = async (dir: ConfigDirRow): Promise<ConfigDirRow> => {
    const status = await readAuthStatus(dir.path);
    db.prepare(`UPDATE config_dirs SET login_ok = ?, login_email = ? WHERE id = ?`).run(status.loggedIn ? 1 : 0, status.email ?? null, dir.id);
    return configDirById(dir.id)!;
};

app.get("/api/config-dirs", (c) => c.json(configDirsAll().map(configDirView)));

app.post("/api/config-dirs", async (c) => {
    const body = json(z.object({ name: z.string().min(1), path: z.string().min(1) }), await c.req.json());
    const path = body.path.replace(/\/+$/, "");
    if (!existsSync(path) || !statSync(path).isDirectory()) return c.json({ error: `${path} is not a directory` }, 400);
    const id = randomUUID();
    db.prepare(`INSERT INTO config_dirs (id, name, path, created_at) VALUES (?, ?, ?, ?)`).run(id, body.name, path, now());
    return c.json(configDirView(configDirById(id)!));
});

app.patch("/api/config-dirs/:id", async (c) => {
    const body = json(z.object({ name: z.string().min(1).optional(), rules: Rules.partial().optional() }), await c.req.json());
    const dir = configDirById(c.req.param("id"));
    if (!dir) return c.json({ error: "not found" }, 404);
    const rules = body.rules === undefined ? dir.rules : JSON.stringify(Rules.parse({ ...rulesOf(dir), ...body.rules }));
    db.prepare(`UPDATE config_dirs SET name = ?, rules = ? WHERE id = ?`).run(body.name ?? dir.name, rules, dir.id);
    return c.json(configDirView(configDirById(dir.id)!));
});

// Forgets the dir in Stagehand (nothing on disk changes); refused while an environment uses it.
app.delete("/api/config-dirs/:id", (c) => {
    const dir = configDirById(c.req.param("id"));
    if (!dir) return c.json({ error: "not found" }, 404);
    const envs = envsAll().filter((e) => e.config_dir_id === dir.id);
    if (envs.length) return c.json({ error: `used by ${envs.map((e) => `env ${e.name}`).join(", ")} — switch them first` }, 400);
    db.prepare(`DELETE FROM config_dirs WHERE id = ?`).run(dir.id);
    return c.json({ deleted: dir.id });
});

// Chrome is a property of the dir's browser login (the extension is bound to the claude.ai account signed in there;
// token sessions get no bridge), so the probe runs under that login and records the connected Chrome profiles.
app.post("/api/config-dirs/:id/probe", async (c) => {
    const dir0 = configDirById(c.req.param("id"));
    if (!dir0) return c.json({ error: "not found" }, 404);
    const dir = await refreshDirLogin(dir0);
    if (!dir.login_ok) {
        db.prepare(`UPDATE config_dirs SET chrome_capable = 0, chrome_browsers = NULL WHERE id = ?`).run(dir.id);
        return c.json({ ...configDirView(configDirById(dir.id)!), probe: { ok: false, detail: "no browser login in this dir — click Log in (browser) first" } });
    }
    const owner = accountsAll().find((a) => a.email && dir.login_email && a.email.toLowerCase() === dir.login_email.toLowerCase()) ?? null;
    const r = await probeChrome(dir.path, cfg.dataDir, 3, (res) => recordUsage(db, { accountId: owner?.id ?? null, envId: null, taskId: null, runId: null, kind: "probe", stage: null }, res));
    const matches = matchChromeProfiles(r.browsers.map((b) => b.deviceId));
    const browsers: ChromeBrowser[] = r.browsers.map((b) => {
        const m = matches.get(b.deviceId);
        return m ? { ...b, profile: m.profile, account: m.account, profileDir: m.profileDir, browser: m.browser } : b;
    });
    db.prepare(`UPDATE config_dirs SET chrome_capable = ?, chrome_browsers = ? WHERE id = ?`).run(r.ok ? 1 : 0, r.ok ? JSON.stringify(browsers) : null, dir.id);
    // Environments that picked one of these profiles get the resolved name too.
    for (const b of browsers) db.prepare(`UPDATE envs SET chrome_browser_name = ? WHERE chrome_device_id = ?`).run(chromeBrowserLabel(b), b.deviceId);
    return c.json({
        ...configDirView(configDirById(dir.id)!),
        probe: {
            ok: r.ok,
            detail: r.ok
                ? `Chrome bridge answered as ${dir.login_email}; ${browsers.length} connected profile(s): ${browsers.map((b) => `${chromeBrowserLabel(b)}${b.account ? ` (${b.account})` : ""}`).join(", ") || "none listed"}`
                : `no Chrome bridge under ${dir.login_email} — is the extension installed and signed into that claude.ai account?`,
        },
    });
});

// Opens `claude auth login` for this dir in a terminal (the browser OAuth form); the login is what the Chrome bridge uses.
app.post("/api/config-dirs/:id/login", async (c) => {
    const dir = configDirById(c.req.param("id"));
    if (!dir) return c.json({ error: "not found" }, 404);
    const name = `sh-dirlogin-${dir.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
    await killSession(name);
    await ensureSession(name, dir.path, `claude auth login --claudeai; echo; echo '[stagehand] login finished — run Probe Chrome on the Config dirs page, then close this terminal.'; sleep 600`, { CLAUDE_CONFIG_DIR: dir.path });
    return c.json({ terminal: name });
});

app.post("/api/config-dirs/:id/refresh-login", async (c) => {
    const dir = configDirById(c.req.param("id"));
    if (!dir) return c.json({ error: "not found" }, 404);
    return c.json(configDirView(await refreshDirLogin(dir)));
});

app.get("/api/config-dirs/:id/rules", (c) => {
    const dir = configDirById(c.req.param("id"));
    if (!dir) return c.json({ error: "not found" }, 404);
    return c.json({ rules: rulesOf(dir), defaults: Rules.parse({}), guardHook: GUARD_HOOK });
});

// ---------- envs ----------

const envsAll = (): EnvRow[] => db.prepare(`SELECT * FROM envs ORDER BY created_at`).all() as EnvRow[];

// Every checkout the env claims (the path itself, or each sub-repo) must exist and be a git repo.
const badCheckouts = async (env: { path: string; base_branch: string; repos: string | null }): Promise<string | null> => {
    for (const p of repoPaths(env)) {
        if (!existsSync(p) || !(await isGitRepo(p))) return `${p} is not a git checkout`;
    }
    return null;
};

app.get("/api/envs", (c) => c.json(envsAll()));

// Deleting an env is refused while it has tasks (delete those first — each delete offers worktree cleanup).
app.delete("/api/envs/:id", (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    const tasks = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE env_id = ?`).get(env.id) as { n: number };
    if (tasks.n) return c.json({ error: `${tasks.n} task(s) still belong to this environment — delete them first` }, 400);
    db.prepare(`DELETE FROM envs WHERE id = ?`).run(env.id);
    return c.json({ deleted: env.id });
});

// ---------- task managers (ClickUp / Linear integrations) ----------

const taskManagers = () => [
    { source: "clickup" as const, label: "ClickUp", configured: !!cfg.clickupToken, token: mask(cfg.clickupToken), teamId: cfg.clickupTeamId, envs: envsAll().filter((e) => e.ticket_source === "clickup").map((e) => e.name) },
    { source: "linear" as const, label: "Linear", configured: !!cfg.linearApiKey, token: mask(cfg.linearApiKey), teamId: null, envs: envsAll().filter((e) => e.ticket_source === "linear").map((e) => e.name) },
];

app.get("/api/task-managers", (c) => c.json(taskManagers()));

app.patch("/api/task-managers/:source", async (c) => {
    const source = c.req.param("source");
    const body = json(z.object({ token: z.string().nullable().optional(), teamId: z.string().nullable().optional() }), await c.req.json());
    if (source === "clickup") {
        if (body.token !== undefined) cfg.clickupToken = body.token || null;
        if (body.teamId !== undefined) cfg.clickupTeamId = body.teamId || null;
        if (body.token !== undefined) cfg.clickupUserId = null;
    } else if (source === "linear") {
        if (body.token !== undefined) cfg.linearApiKey = body.token || null;
    } else return c.json({ error: "unknown task manager" }, 404);
    saveConfig(cfg);
    return c.json(taskManagers().find((t) => t.source === source));
});

// Live check: fetch the user's tickets with the stored credentials.
app.post("/api/task-managers/:source/test", async (c) => {
    const source = c.req.param("source");
    if (source !== "clickup" && source !== "linear") return c.json({ error: "unknown task manager" }, 404);
    try {
        const tickets = await listMyTickets(source, cfg);
        return c.json({ ok: true, count: tickets.length, sample: tickets.slice(0, 3).map((t) => `${t.id} ${t.title}`) });
    } catch (e) {
        return c.json({ ok: false, error: String((e as Error).message ?? e) });
    }
});

// The rules the env inherits from its config dir, plus the PR templates found in its checkouts, for the environment page.
app.get("/api/envs/:id/rules", (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    const cd = engine.configDirOf(env);
    const rules = rulesOf(cd);
    return c.json({ rules, prTemplates: prTemplates(env, rules), configDir: { id: cd.id, name: cd.name, path: cd.path }, usableAccounts: engine.usableAccounts(cd.path).map((a) => a.id) });
});

// Tickets assigned to the configured user in this env's task system, for the new-task dropdown.
app.get("/api/envs/:id/my-tickets", async (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    try {
        return c.json({ source: env.ticket_source, tickets: await listMyTickets(env.ticket_source, cfg) });
    } catch (e) {
        return c.json({ source: env.ticket_source, tickets: [], error: String((e as Error).message ?? e) });
    }
});

app.post("/api/envs", async (c) => {
    const body = json(
        z.object({
            name: z.string().min(1),
            path: z.string().min(1),
            baseBranch: z.string().default("main"),
            defaultAccountId: z.string().optional(),
            accountOrder: z.array(z.string()).optional(),
            configDirId: z.string().optional(),
            appUrl: z.string().optional(),
            qaScript: z.string().optional(),
            beCommand: z.string().optional(),
            feCommand: z.string().optional(),
            beUrlTemplate: z.string().optional(),
            feUrlTemplate: z.string().optional(),
            bePort: z.number().int().positive().optional(),
            fePort: z.number().int().positive().optional(),
            setupCommand: z.string().optional(),
            repos: z.array(z.string().min(1)).optional(),
            branchPrefix: z.string().optional(),
            ticketSource: z.enum(["clickup", "linear"]).default("clickup"),
            envVars: z.string().optional(),
        }),
        await c.req.json(),
    );
    const repos = body.repos && body.repos.length ? JSON.stringify(body.repos) : null;
    const bad = await badCheckouts({ path: body.path, base_branch: body.baseBranch ?? "main", repos });
    if (bad) return c.json({ error: bad }, 400);
    const id = randomUUID();
    // A dir registered at <env>/.claude is the natural default; otherwise the first registered dir.
    const configDirId = body.configDirId ?? (configDirsAll().find((d) => d.path === join(body.path, ".claude")) ?? configDirsAll()[0])?.id ?? null;
    const order = body.accountOrder ?? (body.defaultAccountId ? [body.defaultAccountId] : []);
    db.prepare(
        `INSERT INTO envs (id, name, path, base_branch, default_account_id, account_order, config_dir_id, app_url, qa_script, be_command, fe_command, be_url_template, fe_url_template, be_port, fe_port, setup_command, repos, branch_prefix, ticket_source, env_vars, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        body.name,
        body.path,
        body.baseBranch,
        order[0] ?? null,
        JSON.stringify(order),
        configDirId,
        body.appUrl ?? null,
        body.qaScript ?? null,
        body.beCommand ?? null,
        body.feCommand ?? null,
        body.beUrlTemplate ?? null,
        body.feUrlTemplate ?? null,
        body.bePort ?? null,
        body.fePort ?? null,
        body.setupCommand ?? null,
        repos,
        body.branchPrefix ?? null,
        body.ticketSource ?? "clickup",
        body.envVars ?? null,
        now(),
    );
    return c.json(db.prepare(`SELECT * FROM envs WHERE id = ?`).get(id));
});

app.patch("/api/envs/:id", async (c) => {
    const body = json(
        z.object({
            name: z.string().min(1).optional(),
            defaultAccountId: z.string().nullable().optional(),
            accountOrder: z.array(z.string()).optional(),
            configDirId: z.string().nullable().optional(),
            chromeDeviceId: z.string().nullable().optional(),
            chromeBrowserName: z.string().nullable().optional(),
            baseBranch: z.string().optional(),
            appUrl: z.string().nullable().optional(),
            qaScript: z.string().nullable().optional(),
            beCommand: z.string().nullable().optional(),
            feCommand: z.string().nullable().optional(),
            beUrlTemplate: z.string().nullable().optional(),
            feUrlTemplate: z.string().nullable().optional(),
            bePort: z.number().int().positive().nullable().optional(),
            fePort: z.number().int().positive().nullable().optional(),
            setupCommand: z.string().nullable().optional(),
            repos: z.array(z.string().min(1)).nullable().optional(),
            branchPrefix: z.string().nullable().optional(),
            ticketSource: z.enum(["clickup", "linear"]).optional(),
            envVars: z.string().nullable().optional(),
        }),
        await c.req.json(),
    );
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    if (body.configDirId && !configDirById(body.configDirId)) return c.json({ error: "unknown config dir" }, 400);
    if (body.accountOrder?.some((id) => !accountById(id))) return c.json({ error: "unknown account in accountOrder" }, 400);
    const pick = <T,>(next: T | undefined, cur: T): T => (next === undefined ? cur : next);
    // The ordered list is the source of truth; default_account_id mirrors its head for older readers.
    const order = body.accountOrder ?? (body.defaultAccountId !== undefined ? (body.defaultAccountId ? [body.defaultAccountId] : []) : accountOrderOf(env));
    const repos = body.repos === undefined ? env.repos : body.repos && body.repos.length ? JSON.stringify(body.repos) : null;
    if (repos !== env.repos) {
        const bad = await badCheckouts({ path: env.path, base_branch: env.base_branch, repos });
        if (bad) return c.json({ error: bad }, 400);
    }
    db.prepare(
        `UPDATE envs SET name = ?, default_account_id = ?, account_order = ?, config_dir_id = ?, chrome_device_id = ?, chrome_browser_name = ?, base_branch = ?, app_url = ?, qa_script = ?, be_command = ?, fe_command = ?, be_url_template = ?, fe_url_template = ?, be_port = ?, fe_port = ?, setup_command = ?, repos = ?, branch_prefix = ?, ticket_source = ?, env_vars = ? WHERE id = ?`,
    ).run(
        body.name ?? env.name,
        order[0] ?? null,
        JSON.stringify(order),
        pick(body.configDirId, env.config_dir_id),
        pick(body.chromeDeviceId, env.chrome_device_id),
        pick(body.chromeBrowserName, env.chrome_browser_name),
        body.baseBranch ?? env.base_branch,
        pick(body.appUrl, env.app_url),
        pick(body.qaScript, env.qa_script),
        pick(body.beCommand, env.be_command),
        pick(body.feCommand, env.fe_command),
        pick(body.beUrlTemplate, env.be_url_template),
        pick(body.feUrlTemplate, env.fe_url_template),
        pick(body.bePort, env.be_port),
        pick(body.fePort, env.fe_port),
        pick(body.setupCommand, env.setup_command),
        repos,
        pick(body.branchPrefix, env.branch_prefix),
        body.ticketSource ?? env.ticket_source,
        pick(body.envVars, env.env_vars),
        env.id,
    );
    return c.json(db.prepare(`SELECT * FROM envs WHERE id = ?`).get(env.id));
});

// ---------- usage analytics ----------

// ?days=7|30|… (0 or absent = everything). Cost and tokens as reported by claude's result events, one row per model per invocation.
app.get("/api/usage", (c) => {
    const days = Number(c.req.query("days") ?? "0");
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
    return c.json(usageReport(db, since));
});

// ---------- tasks ----------

app.get("/api/tasks", (c) => c.json(engine.listTasks(c.req.query("env"))));

app.post("/api/tasks", async (c) => {
    const body = json(
        z.object({ envId: z.string(), ticket: z.string().min(3), accountId: z.string().optional(), model: z.string().optional() }),
        await c.req.json(),
    );
    return c.json(engine.createTask(body.envId, body.ticket, body.accountId, body.model));
});

// ---------- settings (integrations, defaults) ----------

const mask = (s: string | null): string | null => (s ? `${s.slice(0, 4)}…${s.slice(-3)}` : null);

app.get("/api/settings", (c) =>
    c.json({
        clickupToken: mask(cfg.clickupToken),
        clickupTeamId: cfg.clickupTeamId,
        linearApiKey: mask(cfg.linearApiKey),
        defaultModel: cfg.defaultModel,
        models: MODEL_OPTIONS,
    }),
);

app.patch("/api/settings", async (c) => {
    const body = json(
        z.object({
            clickupToken: z.string().nullable().optional(),
            clickupTeamId: z.string().nullable().optional(),
            linearApiKey: z.string().nullable().optional(),
            defaultModel: z.string().nullable().optional(),
        }),
        await c.req.json(),
    );
    if (body.clickupToken !== undefined) cfg.clickupToken = body.clickupToken;
    if (body.clickupTeamId !== undefined) cfg.clickupTeamId = body.clickupTeamId;
    if (body.linearApiKey !== undefined) cfg.linearApiKey = body.linearApiKey;
    if (body.defaultModel !== undefined) cfg.defaultModel = body.defaultModel;
    saveConfig(cfg);
    return c.json({ ok: true });
});

app.get("/api/tasks/:id", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const artifacts = engine.artifacts(task.id);
    return c.json({
        task,
        runs: engine.listRuns(task.id),
        artifacts,
        research: engine.readArtifactJson(task.id, "research.json"),
        design: engine.readArtifactJson(task.id, "design.json"),
        impl: engine.readArtifactJson(task.id, "impl.json"),
        qaBefore: engine.readArtifactJson(task.id, "qa/before.json"),
        qaAfter: engine.readArtifactJson(task.id, "qa/after.json"),
        pr: engine.readArtifactJson(task.id, "pr.json"),
        ticket: engine.readArtifactJson(task.id, "ticket.json"),
        reviews: db.prepare(`SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at`).all(task.id),
        prState: db.prepare(`SELECT * FROM pr_state WHERE task_id = ?`).get(task.id) ?? null,
    });
});

app.get("/api/tasks/:id/artifacts/*", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const rel = normalize(c.req.path.split("/artifacts/")[1] ?? "");
    if (rel.startsWith("..") || rel.includes("/../")) return c.json({ error: "bad path" }, 400);
    const full = join(engine.taskDir(task.id), rel);
    if (!existsSync(full)) return c.json({ error: "not found" }, 404);
    const body = readFileSync(full);
    const type = rel.endsWith(".jpg") ? "image/jpeg" : rel.endsWith(".png") ? "image/png" : rel.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
    return new Response(body, { headers: { "content-type": type } });
});

app.get("/api/tasks/:id/runs/:runId/events", (c) => {
    const path = join(cfg.dataDir, "runs", `${c.req.param("runId")}.ndjson`);
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    return new Response(readFileSync(path), { headers: { "content-type": "application/x-ndjson" } });
});

app.post("/api/tasks/:id/review", async (c) => {
    const body = json(
        z.object({
            verdict: z.enum(["approve", "changes"]),
            routeTo: z.enum(["implementation", "design_proposal"]).optional(),
            notes: z.string().optional(),
            comments: z
                .array(z.object({ path: z.string().min(1), line: z.number().int().positive(), side: z.enum(["new", "old"]), snippet: z.string(), text: z.string().min(1) }))
                .optional(),
        }),
        await c.req.json(),
    );
    engine.review(c.req.param("id"), body);
    return c.json(engine.getTask(c.req.param("id")));
});

app.get("/api/tasks/:id/pr-comments", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    try {
        return c.json(await engine.prComments(task.id));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 502);
    }
});

app.get("/api/tasks/:id/diff", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const env = db.prepare(`SELECT base_branch FROM envs WHERE id = ?`).get(task.env_id) as { base_branch: string };
    return c.json({ base: env.base_branch, files: await engine.diff(task.id) });
});

app.post("/api/tasks/:id/stop", (c) => {
    engine.stop(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
});

app.post("/api/tasks/:id/retry", (c) => {
    engine.retry(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
});

// Opens the task's app URL in the env's Chrome profile (the one browser QA uses) so the human can log in there — no agent.
app.post("/api/tasks/:id/open-app", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow;
    const url = engine.appUrlFor(task, env);
    const cd = engine.configDirOf(env);
    const browser = chromeBrowsersOf(cd).find((b) => b.deviceId === env.chrome_device_id);
    if (!browser?.profileDir) return c.json({ error: `the env's Chrome profile is not resolved — set it on the environment page after probing config dir ${cd.name}` , url }, 400);
    try {
        await openInProfile(browser.browser ?? "Google", browser.profileDir, url);
        return c.json({ opened: url, profile: chromeBrowserLabel(browser) });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e), url }, 500);
    }
});

app.post("/api/tasks/:id/fetch-ticket", async (c) => {
    try {
        return c.json(await engine.fetchTicketNow(c.req.param("id")));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.post("/api/tasks/:id/qa-login", (c) => {
    const id = c.req.param("id");
    void engine.qaLogin(id).catch((e: unknown) => console.error("[qa-login]", String((e as Error).message ?? e)));
    return c.json({ started: true });
});

app.post("/api/tasks/:id/rerun", async (c) => {
    const body = json(z.object({ stage: z.enum(STAGES as [Stage, ...Stage[]]) }), await c.req.json());
    engine.rerun(c.req.param("id"), body.stage);
    return c.json(engine.getTask(c.req.param("id")));
});

app.post("/api/tasks/:id/account", async (c) => {
    const body = json(z.object({ accountId: z.string() }), await c.req.json());
    engine.setAccount(c.req.param("id"), body.accountId);
    return c.json(engine.getTask(c.req.param("id")));
});

// ---------- per-task BE / FE services ----------

app.get("/api/tasks/:id/services", async (c) => c.json(await services.status(c.req.param("id"))));

app.post("/api/tasks/:id/services/:kind/start", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const kind = c.req.param("kind");
    if (kind !== "be" && kind !== "fe") return c.json({ error: "kind must be be|fe" }, 400);
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow;
    const row = await services.start(task, env, kind);
    return c.json(row);
});

app.post("/api/tasks/:id/services/:kind/stop", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "be" && kind !== "fe") return c.json({ error: "kind must be be|fe" }, 400);
    await services.stop(c.req.param("id"), kind);
    return c.json(await services.status(c.req.param("id")));
});

app.get("/api/tasks/:id/services/:kind/log", (c) => {
    const kind = c.req.param("kind");
    if (kind !== "be" && kind !== "fe") return c.json({ error: "kind must be be|fe" }, 400);
    const path = join(engine.taskDir(c.req.param("id")), "logs", `${kind}.log`);
    if (!existsSync(path)) return new Response("", { headers: { "content-type": "text/plain" } });
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const tail = Number(c.req.query("lines") ?? "200");
    return new Response(lines.slice(-tail).join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
});

app.delete("/api/tasks/:id", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    await services.stopAll(task.id);
    await killSession(taskSessionName(task.ticket_id));
    await engine.deleteTask(task.id, c.req.query("worktree") !== "keep");
    return c.json({ deleted: task.id });
});

app.post("/api/tasks/:id/pin", (c) => {
    db.prepare(`UPDATE tasks SET pinned = 1 - pinned, updated_at = ? WHERE id = ?`).run(now(), c.req.param("id"));
    const task = engine.getTask(c.req.param("id"));
    engine.emit("task", task);
    return c.json(task);
});

app.post("/api/tasks/:id/terminal", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    if (task.status === "running") return c.json({ error: "a headless run owns this session right now; wait for it to finish" }, 409);
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow;
    const cd = engine.configDirOf(env);
    const usable = engine.usableAccounts(cd.path);
    const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === env.default_account_id) ?? usable[0];
    if (!acc) return c.json({ error: `no AI account can run in config dir ${cd.name}` }, 400);
    const name = taskSessionName(task.ticket_id);
    await ensureSession(
        name,
        task.worktree_path ?? env.path,
        `claude --resume ${task.session_id}; echo; echo '[stagehand] claude exited — press Enter to close'; read -r`,
        { ...parseEnvVars(env.env_vars), ...authEnv(acc), CLAUDE_CONFIG_DIR: cd.path },
    );
    return c.json({ terminal: name });
});

// ---------- websockets ----------

app.get(
    "/ws/events",
    upgradeWebSocket(() => {
        const listeners: Array<[string, (...args: unknown[]) => void]> = [];
        return {
            onOpen(_evt, ws) {
                for (const kind of ["task", "activity", "rate_limit", "account"]) {
                    const fn = (payload: unknown): void => ws.send(JSON.stringify({ kind, payload }));
                    engine.on(kind, fn);
                    listeners.push([kind, fn]);
                }
            },
            onClose() {
                for (const [kind, fn] of listeners) engine.off(kind, fn);
            },
        };
    }),
);

app.get(
    "/ws/term",
    upgradeWebSocket((c) => {
        const name = c.req.query("session") ?? "";
        let term: ReturnType<typeof attach> | null = null;
        return {
            async onOpen(_evt, ws) {
                if (!(await sessionExists(name))) {
                    ws.send(`\r\n[stagehand] tmux session "${name}" not found\r\n`);
                    ws.close();
                    return;
                }
                try {
                    term = attach(name, 120, 36);
                } catch (e) {
                    ws.send(`\r\n[stagehand] could not open a pty: ${String((e as Error).message ?? e)}\r\n`);
                    ws.close();
                    return;
                }
                term.onData((d) => ws.send(d));
                term.onExit(() => ws.close());
            },
            onMessage(evt) {
                if (!term) return;
                const raw = typeof evt.data === "string" ? evt.data : "";
                let msg: { t: "i"; d: string } | { t: "r"; cols: number; rows: number };
                try {
                    msg = JSON.parse(raw) as typeof msg;
                } catch {
                    return;
                }
                if (msg.t === "r") term.resize(msg.cols, msg.rows);
                else term.write(msg.d);
            },
            onClose() {
                term?.kill();
            },
        };
    }),
);

app.get("/api/health", (c) => c.json({ ok: true, config: { ...cfg, publicAccess: { ...cfg.publicAccess, passwordHash: null, sessionSecret: null } } }));

// The built web UI is served on the public listener only; locally the Vite dev server (5173) proxies to this process.
const WEB_DIST = "../web/dist";
const NATPMPC = existsSync("/opt/homebrew/bin/natpmpc") ? "/opt/homebrew/bin/natpmpc" : "natpmpc";
const staticFiles = serveStatic({ root: WEB_DIST });
const spaIndex = serveStatic({ path: `${WEB_DIST}/index.html` });
app.get("*", (c, next) => (isPublicRequest(c, cfg.publicAccess.port) ? staticFiles(c, next) : next()));
app.get("*", (c, next) => (isPublicRequest(c, cfg.publicAccess.port) && !c.req.path.startsWith("/api/") ? spaIndex(c, next) : next()));

// Second listener, HTTPS, reachable from outside the LAN; every request on it passes the publicAuth guard above.
const startPublicListener = (): void => {
    const pa = cfg.publicAccess;
    if (!pa.enabled) return;
    if (!pa.certPath || !pa.keyPath) throw new Error("publicAccess.enabled needs certPath and keyPath");
    if (!existsSync(join(process.cwd(), WEB_DIST, "index.html"))) console.warn(`[stagehand] ${WEB_DIST}/index.html missing — run \`npx vite build\` in web/ for the public UI`);
    const publicServer = serve(
        {
            fetch: app.fetch,
            port: pa.port,
            hostname: pa.host,
            createServer: createHttpsServer,
            serverOptions: { key: readFileSync(pa.keyPath), cert: readFileSync(pa.certPath) },
        },
        (info) => console.log(`stagehand public listener on https://${info.address}:${info.port} (user ${pa.user ?? "unset"})`),
    );
    injectWebSocket(publicServer);
    if (pa.natPmpGateway) {
        const gateway = pa.natPmpGateway;
        const renew = (): void => {
            execFile(NATPMPC, ["-g", gateway, "-a", String(pa.port), String(pa.port), "tcp", "7200"], (err, stdout) => {
                const line = stdout.split("\n").find((l) => /Mapped public port/.test(l));
                if (err || !line) console.warn(`[stagehand] NAT-PMP mapping failed: ${err?.message ?? stdout.trim().slice(-200)}`);
                else console.log(`[stagehand] ${line.trim()} via ${gateway}`);
            });
        };
        renew();
        setInterval(renew, 30 * 60_000).unref();
    }
};

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: "127.0.0.1" }, (info) => {
    console.log(`stagehand server on http://127.0.0.1:${info.port}`);
});
injectWebSocket(server);
startPublicListener();
engine.startScheduler();
void resumeTokenSetups();

process.on("SIGINT", () => {
    engine.stopScheduler();
    process.exit(0);
});
