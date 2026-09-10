import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig, saveConfig } from "./config.js";
import { isPublicRequest, publicAuth } from "./public-access.js";
import { listMyTickets } from "./my-tickets.js";
import { mimeOf } from "./tickets.js";
import { GUARD_HOOK, prTemplates, Rules, rulesOf } from "./rules.js";
import { inspectConfigDir } from "./config-dirs.js";
import { recordUsage, taskUsage, usageReport, windowShares } from "./usage.js";
import { type ResultEvent } from "./claude/runner.js";
import { desktopNotifier, notify } from "./notify.js";

const MODEL_OPTIONS = [
    { value: "", label: "Account default" },
    { value: "fable", label: "Fable 5.1 (claude-fable-5-1)" },
    { value: "opus", label: "Opus 5 (claude-opus-5)" },
    { value: "sonnet", label: "Sonnet 5 (claude-sonnet-5)" },
];
import { accountOrderOf, accountUsableWith, chromeBrowserLabel, chromeBrowsersOf, migrateAccountsToConfigDirs, now, openDb, parseEnvVars, STAGES, type AccountRow, type ChromeBrowser, type ConfigDirRow, type EnvRow, type Stage } from "./db.js";
import { matchChromeProfiles, openInProfile, restartChrome } from "./chrome-profiles.js";
import { Engine } from "./engine.js";
import { Services } from "./services.js";
import { authDirFor, authEnv, browserDirFor, OAUTH_TOKEN_RE, probeChrome, probeDefaultModel, probeRateLimits, readAuthStatus, SETUP_TOKEN_COMMAND } from "./claude/accounts.js";
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
    return { ...rest, has_token: !!oauth_token, browsers: chromeBrowsersOf(a), browser_dir: browserDirFor(cfg, a) };
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
    const limits = db.prepare(`SELECT * FROM rate_limits`).all() as Array<{ account_id: string; window: string; utilization: number; resets_at: number; updated_at: string }>;
    const shares = windowShares(db);
    return c.json(
        accountsAll().map((a) => ({
            ...publicAccount(a),
            setting_up: tokenCaptures.has(a.id),
            refreshing_limits: limitRefreshes.has(a.id),
            // A window whose reset instant has passed no longer says anything: the utilisation is unknown (0 at the reset,
            // plus whatever ran since) until the next run or a refresh reports it.
            limits: limits.filter((l) => l.account_id === a.id).map(({ window, utilization, resets_at, updated_at }) => ({ window, utilization, resetsAt: resets_at, updatedAt: updated_at, expired: resets_at * 1000 < Date.now() })),
            usage: accountUsage(a.id),
            windows: shares.filter((s) => s.accountId === a.id).map(({ window, usdPerWindow, samples }) => ({ window, usdPerWindow, samples })),
        })),
    );
});

// Refreshes an account's rate-limit windows with one trivial streamed turn (the stream reports the current utilisation).
const limitRefreshes = new Set<string>();
const refreshLimits = async (acc: AccountRow): Promise<{ ok: boolean; detail: string }> => {
    if (limitRefreshes.has(acc.id)) return { ok: false, detail: "already refreshing" };
    limitRefreshes.add(acc.id);
    emitAccount(acc.id);
    try {
        const dir = acc.oauth_token ? cfg.mainConfigDir : acc.auth_dir;
        const r = await probeRateLimits(dir, cfg.dataDir, authEnv(acc));
        if (r.result) recordUsage(db, { accountId: acc.id, envId: null, taskId: null, runId: null, kind: "probe", stage: null }, r.result);
        if (r.limits) engine.recordRateLimit(acc.id, r.limits);
        const w = r.limits?.unifiedWindows ?? {};
        return r.limits
            ? { ok: true, detail: `windows refreshed: ${Object.entries(w).map(([k, v]) => `${k} ${Math.round(v.utilization * 100)}%`).join(", ")}` }
            : { ok: false, detail: r.error ?? "no rate-limit information in the run" };
    } finally {
        limitRefreshes.delete(acc.id);
        emitAccount(acc.id);
    }
};

app.post("/api/accounts/:id/refresh-limits", async (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    if (!acc.logged_in) return c.json({ ok: false, detail: "account is not logged in" });
    return c.json(await refreshLimits(acc));
});

// Background upkeep, so the UI learns about expired windows and lost logins before a run hits them:
// - a subscription account whose 5-hour window has reset and has had no event since is probed once (cheap, Sonnet, 1 turn);
// - every account's browser login is re-read (`claude auth status`, no agent) every 15 minutes.
const REFRESH_TICK_MS = 5 * 60_000;
const autoRefreshed = new Map<string, number>();
const autoRefresh = async (): Promise<void> => {
    for (const acc of accountsAll()) {
        if (!acc.logged_in || acc.plan === "enterprise") continue;
        const five = db.prepare(`SELECT resets_at, updated_at FROM rate_limits WHERE account_id = ? AND window = 'five_hour'`).get(acc.id) as { resets_at: number; updated_at: string } | undefined;
        if (!five) continue;
        const expired = five.resets_at * 1000 < Date.now();
        const stale = Date.now() - new Date(five.updated_at).getTime() > 15 * 60_000;
        const recently = Date.now() - (autoRefreshed.get(acc.id) ?? 0) < 60 * 60_000;
        const running = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE account_id = ? AND status = 'running'`).get(acc.id) as { n: number }).n > 0;
        if (expired && stale && !recently && !running) {
            autoRefreshed.set(acc.id, Date.now());
            await refreshLimits(acc).catch(() => undefined);
        }
    }
};
let loginTick = 0;
const autoLoginRefresh = async (): Promise<void> => {
    if (++loginTick % 3 !== 0) return; // every 15 min
    for (const acc of accountsAll()) {
        const before = acc.login_ok;
        const after = await refreshBrowserLogin(acc).catch(() => null);
        if (after && after.login_ok !== before) {
            emitAccount(acc.id);
            console.log(`[stagehand] browser login for ${acc.name}: ${after.login_ok ? "present" : "GONE"} (${after.login_dir ?? "no dir"})`);
        }
    }
};
setInterval(() => void autoRefresh().then(autoLoginRefresh), REFRESH_TICK_MS).unref();

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
        z.object({
            name: z.string().regex(/^[a-z0-9-]+$/).optional(),
            failover_enabled: z.boolean().optional(),
            failover_threshold: z.number().min(0).max(1).optional(),
            chromeDeviceId: z.string().nullable().optional(),
        }),
        await c.req.json(),
    );
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const chosen = body.chromeDeviceId === undefined ? undefined : body.chromeDeviceId ? chromeBrowsersOf(acc).find((b) => b.deviceId === body.chromeDeviceId) ?? null : null;
    db.prepare(`UPDATE accounts SET name = ?, failover_enabled = ?, failover_threshold = ?, chrome_device_id = ?, chrome_browser_name = ? WHERE id = ?`).run(
        body.name ?? acc.name,
        body.failover_enabled === undefined ? acc.failover_enabled : body.failover_enabled ? 1 : 0,
        body.failover_threshold ?? acc.failover_threshold,
        chosen === undefined ? acc.chrome_device_id : chosen?.deviceId ?? null,
        chosen === undefined ? acc.chrome_browser_name : chosen ? chromeBrowserLabel(chosen) : null,
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
});

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

// ---------- browser login + Chrome, per account ----------

// The Chrome extension is bound to the claude.ai account signed into a Chrome profile, and only a browser login (not a
// token) gets the bridge, so both live on the account: its browser dir holds the login, the probe runs there.
// A browser login may live in the account's auth dir (a real config dir such as the main one) or in the Stagehand-owned
// browser dir; the Stagehand-owned one wins when both are valid — it is the one every env can use via mirrorConfigDir
// (engine.browserDir), while the auth dir only ever satisfies the one env whose path happens to equal it. Checking
// auth_dir first would permanently starve the Stagehand dir: once auth_dir has a login (the common case — it is
// wherever the account was first set up), it never expires, so the Stagehand dir's login would never be picked up
// no matter how many times the human completes it there.
const refreshBrowserLogin = async (acc: AccountRow): Promise<AccountRow> => {
    const own = browserDirFor(cfg, acc);
    const candidates = [...new Set([own, acc.auth_dir])];
    let found: { dir: string; email: string | null; plan: string | null } | null = null;
    for (const dir of candidates) {
        const status = await readAuthStatus(dir);
        if (status.loggedIn && status.authMethod !== "oauth_token") {
            found = { dir, email: status.email ?? null, plan: status.subscriptionType ?? null };
            break;
        }
    }
    db.prepare(`UPDATE accounts SET login_ok = ?, login_dir = ?, email = COALESCE(email, ?), plan = COALESCE(plan, ?) WHERE id = ?`).run(found ? 1 : 0, found?.dir ?? null, found?.email ?? null, found?.plan ?? null, acc.id);
    return accountById(acc.id)!;
};

app.post("/api/accounts/:id/login", async (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const dir = browserDirFor(cfg, acc);
    const name = `sh-browserlogin-${acc.name}`;
    await killSession(name);
    await ensureSession(
        name,
        dir,
        `claude auth login --claudeai${acc.email ? ` --email ${JSON.stringify(acc.email)}` : ""}; echo; echo '[stagehand] login finished — run Probe Chrome on the AI accounts page, then close this terminal.'; sleep 600`,
        { CLAUDE_CONFIG_DIR: dir },
    );
    return c.json({ terminal: name, dir });
});

app.post("/api/accounts/:id/probe-chrome", async (c) => {
    const acc0 = accountById(c.req.param("id"));
    if (!acc0) return c.json({ error: "not found" }, 404);
    const acc = await refreshBrowserLogin(acc0);
    const dir = acc.login_dir ?? browserDirFor(cfg, acc);
    if (!acc.login_ok) {
        db.prepare(`UPDATE accounts SET chrome_capable = 0, chrome_browsers = NULL WHERE id = ?`).run(acc.id);
        emitAccount(acc.id);
        return c.json({ ok: false, detail: `no browser login in ${acc.auth_dir} or ${browserDirFor(cfg, acc)} — click Log in (browser) first`, account: publicAccount(accountById(acc.id)!) });
    }
    const onProbeResult = (res: ResultEvent) => recordUsage(db, { accountId: acc.id, envId: null, taskId: null, runId: null, kind: "probe", stage: null }, res);
    let r = await probeChrome(dir, cfg.dataDir, 3, onProbeResult);
    let restarted = false;
    if (!r.ok) {
        // A brand-new browser dir's first connection often needs Chrome restarted once before the extension notices it.
        await restartChrome();
        restarted = true;
        r = await probeChrome(dir, cfg.dataDir, 2, onProbeResult);
    }
    const matches = matchChromeProfiles(r.browsers.map((b) => b.deviceId));
    const browsers: ChromeBrowser[] = r.browsers.map((b) => {
        const m = matches.get(b.deviceId);
        return m ? { ...b, profile: m.profile, account: m.account, profileDir: m.profileDir, browser: m.browser } : b;
    });
    // Keep a chosen profile if it is still connected; otherwise pick the only one, if there is exactly one.
    const keep = acc.chrome_device_id && browsers.some((b) => b.deviceId === acc.chrome_device_id) ? acc.chrome_device_id : browsers.length === 1 ? browsers[0]!.deviceId : null;
    const chosen = browsers.find((b) => b.deviceId === keep);
    db.prepare(`UPDATE accounts SET chrome_capable = ?, chrome_browsers = ?, chrome_device_id = ?, chrome_browser_name = ? WHERE id = ?`).run(
        r.ok ? 1 : 0,
        r.ok ? JSON.stringify(browsers) : null,
        chosen?.deviceId ?? null,
        chosen ? chromeBrowserLabel(chosen) : null,
        acc.id,
    );
    emitAccount(acc.id);
    return c.json({
        ok: r.ok,
        detail: r.ok
            ? `Chrome bridge answered as ${acc.email ?? acc.name}${restarted ? " (needed a Chrome restart first)" : ""}; ${browsers.length} connected profile(s): ${browsers.map((b) => `${chromeBrowserLabel(b)}${b.account ? ` (${b.account})` : ""}`).join(", ") || "none listed"}`
            : `no Chrome bridge under ${acc.email ?? acc.name} even after restarting Chrome — install the Claude extension in a Chrome profile and sign it into this claude.ai account, then probe again`,
        account: publicAccount(accountById(acc.id)!),
    });
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
    return c.json({
        rules,
        prTemplates: prTemplates(env, rules),
        configDir: { id: cd.id, name: cd.name, path: cd.path },
        usableAccounts: engine.usableAccounts(cd.path).map((a) => a.id),
        browserAccounts: engine.browserAccounts(env).map((a) => a.id),
    });
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
            cleanupCommand: z.string().optional(),
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
        `INSERT INTO envs (id, name, path, base_branch, default_account_id, account_order, config_dir_id, app_url, qa_script, be_command, fe_command, be_url_template, fe_url_template, be_port, fe_port, setup_command, repos, branch_prefix, ticket_source, env_vars, cleanup_command, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        body.cleanupCommand ?? null,
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
            qaSeedHints: z.string().nullable().optional(),
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
            cleanupCommand: z.string().nullable().optional(),
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
        `UPDATE envs SET name = ?, default_account_id = ?, account_order = ?, config_dir_id = ?, chrome_device_id = ?, chrome_browser_name = ?, qa_seed_hints = ?, base_branch = ?, app_url = ?, qa_script = ?, be_command = ?, fe_command = ?, be_url_template = ?, fe_url_template = ?, be_port = ?, fe_port = ?, setup_command = ?, repos = ?, branch_prefix = ?, ticket_source = ?, env_vars = ?, cleanup_command = ? WHERE id = ?`,
    ).run(
        body.name ?? env.name,
        order[0] ?? null,
        JSON.stringify(order),
        pick(body.configDirId, env.config_dir_id),
        pick(body.chromeDeviceId, env.chrome_device_id),
        pick(body.chromeBrowserName, env.chrome_browser_name),
        pick(body.qaSeedHints, env.qa_seed_hints),
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
        pick(body.cleanupCommand, env.cleanup_command),
        env.id,
    );
    return c.json(db.prepare(`SELECT * FROM envs WHERE id = ?`).get(env.id));
});

// Per environment: which accounts can run its agent stages and which can run its browser stages, and what is missing —
// shown up front (dashboard, new-task form) instead of being discovered when a stage blocks.
app.get("/api/readiness", (c) =>
    c.json(
        envsAll().map((env) => {
            const cd = engine.configDirOf(env);
            const run = engine.usableAccounts(cd.path);
            const browser = engine.browserAccounts(env).filter((a) => engine.browserDir(a, cd) !== null);
            const warnings: string[] = [];
            if (run.length === 0) warnings.push(`no AI account can run in config dir ${cd.name} — set up a token on the AI accounts page`);
            if (browser.length === 0) warnings.push("no account can drive Chrome for this environment — QA stages will block (AI accounts → Log in (browser), Probe Chrome)");
            if (env.ticket_source === "clickup" ? !cfg.clickupToken : !cfg.linearApiKey) warnings.push(`no ${env.ticket_source} token — tickets are fetched by an agent through MCP (slower, may fail)`);
            return { envId: env.id, envName: env.name, configDir: cd.name, run: run.map((a) => a.name), browser: browser.map((a) => a.name), warnings };
        }),
    ),
);

// ---------- usage analytics ----------

// ?days=7|30|… (0 or absent = everything). Cost and tokens as reported by claude's result events, one row per model per invocation.
app.get("/api/usage", (c) => {
    const days = Number(c.req.query("days") ?? "0");
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
    return c.json(usageReport(db, since));
});

// ---------- tasks ----------

app.get("/api/tasks", (c) => c.json(engine.listTasks(c.req.query("env"))));

// `tickets` + mode "each": one task per ticket; mode "batch": one task covering all of them (one branch, one PR per repo).
app.post("/api/tasks", async (c) => {
    const body = json(
        z.object({
            envId: z.string(),
            ticket: z.string().min(3).optional(),
            tickets: z.array(z.string().min(3)).optional(),
            mode: z.enum(["each", "batch"]).default("each"),
            accountId: z.string().optional(),
            model: z.string().optional(),
            notes: z.string().optional(),
        }),
        await c.req.json(),
    );
    const tickets = [...new Set([...(body.ticket ? [body.ticket] : []), ...(body.tickets ?? [])].map((t) => t.trim()).filter(Boolean))];
    if (tickets.length === 0) return c.json({ error: "no ticket given" }, 400);
    const created = body.mode === "batch" || tickets.length === 1 ? [engine.createTask(body.envId, tickets, body.accountId, body.model, body.notes)] : tickets.map((t) => engine.createTask(body.envId, [t], body.accountId, body.model, body.notes));
    return c.json({ tasks: created });
});

// Every label in use across tasks, most used first, with the colour it most often has — suggestions for the label editor.
app.get("/api/labels", (c) => {
    const rows = db.prepare(`SELECT labels FROM tasks WHERE labels IS NOT NULL`).all() as Array<{ labels: string }>;
    const byText = new Map<string, { text: string; count: number; colors: Map<string, number> }>();
    for (const r of rows) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(r.labels);
        } catch {
            continue;
        }
        if (!Array.isArray(parsed)) continue;
        for (const l of parsed as Array<{ text?: unknown; color?: unknown }>) {
            if (typeof l?.text !== "string" || typeof l?.color !== "string") continue;
            const key = l.text.trim().toLowerCase();
            if (!key) continue;
            const e = byText.get(key) ?? { text: l.text.trim(), count: 0, colors: new Map<string, number>() };
            e.count++;
            e.colors.set(l.color, (e.colors.get(l.color) ?? 0) + 1);
            byText.set(key, e);
        }
    }
    const out = [...byText.values()]
        .map((e) => ({ text: e.text, count: e.count, color: [...e.colors.entries()].sort((a, b) => b[1] - a[1])[0]![0] }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    return c.json(out);
});

app.patch("/api/tasks/:id", async (c) => {
    const body = json(
        z.object({
            notes: z.string().nullable().optional(),
            labels: z.array(z.object({ text: z.string().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(20).optional(),
        }),
        await c.req.json(),
    );
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    if (body.notes !== undefined) engine.setNotes(task.id, body.notes);
    if (body.labels !== undefined) engine.setLabels(task.id, body.labels);
    return c.json(engine.getTask(task.id));
});

// Edit the drafted PR (title / markdown body / base) before it is created.
app.patch("/api/tasks/:id/pr-draft", async (c) => {
    const body = json(z.object({ repo: z.string().optional(), title: z.string().optional(), body: z.string().optional(), base: z.string().optional() }), await c.req.json());
    try {
        return c.json(engine.setPrDraft(c.req.param("id"), body));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Send a task back to an earlier stage (e.g. after an accidental Approve) with notes; allowed from any non-running state.
app.post("/api/tasks/:id/return", async (c) => {
    const body = json(
        z.object({
            stage: z.enum(STAGES as [Stage, ...Stage[]]),
            notes: z.string().optional(),
            comments: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive(), side: z.enum(["new", "old"]), snippet: z.string(), text: z.string().min(1) })).optional(),
        }),
        await c.req.json(),
    );
    engine.returnTo(c.req.param("id"), body.stage, body.notes, body.comments);
    return c.json(engine.getTask(c.req.param("id")));
});

// Stops the task's BE/FE and tmux session, runs the env's cleanup command, removes the worktree and local branch.
// ?force=1 discards unpushed commits / uncommitted changes instead of refusing.
app.post("/api/tasks/:id/cleanup", async (c) => {
    try {
        return c.json(await engine.cleanup(c.req.param("id"), c.req.query("force") === "1"));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
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
        notifications: { ...cfg.notifications, ntfyToken: mask(cfg.notifications.ntfyToken) },
        desktopNotifier: desktopNotifier(),
    }),
);

// Sends one test push through every configured channel.
app.post("/api/notifications/test", async (c) =>
    c.json(
        await notify(cfg, {
            title: "Stagehand test",
            message: "Pushes from Stagehand reach this device.",
            priority: "default",
            tags: ["white_check_mark"],
            ...(cfg.notifications.baseUrl ? { url: `${cfg.notifications.baseUrl.replace(/\/+$/, "")}/#/dashboard` } : {}),
            localUrl: `${cfg.notifications.localBaseUrl.replace(/\/+$/, "")}/#/dashboard`,
            group: "stagehand-test",
        }),
    ),
);

app.patch("/api/settings", async (c) => {
    const body = json(
        z.object({
            clickupToken: z.string().nullable().optional(),
            clickupTeamId: z.string().nullable().optional(),
            linearApiKey: z.string().nullable().optional(),
            defaultModel: z.string().nullable().optional(),
            notifications: z
                .object({
                    macos: z.boolean().optional(),
                    ntfyServer: z.string().optional(),
                    ntfyTopic: z.string().nullable().optional(),
                    ntfyToken: z.string().nullable().optional(),
                    baseUrl: z.string().nullable().optional(),
                    localBaseUrl: z.string().optional(),
                })
                .optional(),
        }),
        await c.req.json(),
    );
    if (body.clickupToken !== undefined) cfg.clickupToken = body.clickupToken;
    if (body.clickupTeamId !== undefined) cfg.clickupTeamId = body.clickupTeamId;
    if (body.linearApiKey !== undefined) cfg.linearApiKey = body.linearApiKey;
    if (body.notifications) {
        const n = body.notifications;
        if (n.macos !== undefined) cfg.notifications.macos = n.macos;
        if (n.ntfyServer !== undefined && n.ntfyServer.trim()) cfg.notifications.ntfyServer = n.ntfyServer.trim();
        if (n.ntfyTopic !== undefined) cfg.notifications.ntfyTopic = n.ntfyTopic?.trim() || null;
        if (n.ntfyToken !== undefined) cfg.notifications.ntfyToken = n.ntfyToken || null;
        if (n.baseUrl !== undefined) cfg.notifications.baseUrl = n.baseUrl?.trim() || null;
        if (n.localBaseUrl !== undefined && n.localBaseUrl.trim()) cfg.notifications.localBaseUrl = n.localBaseUrl.trim();
    }
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
        qaHistory: engine.qaHistory(task.id),
        pr: engine.readPrDraft(task.id),
        prFix: engine.readArtifactJson(task.id, "pr_fix.json"),
        ticket: engine.readArtifactJson(task.id, "ticket.json"),
        tickets: engine.tickets(task),
        messages: engine.listMessages(task.id),
        questions: engine.listQuestions(task.id),
        reviews: db.prepare(`SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at`).all(task.id),
        // One row per repository's PR (repo "" for a single-repo env); empty until a draft is approved or a PR is found by branch.
        prStates: engine.prRows(task.id),
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
    const mime = mimeOf(rel);
    const type = mime ? (mime.startsWith("text/") || mime === "application/json" ? `${mime}; charset=utf-8` : mime) : rel.includes("/attachments/") ? "application/octet-stream" : "text/plain; charset=utf-8";
    return new Response(body, { headers: { "content-type": type, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(rel.split("/").pop() ?? "file")}` } });
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
            // PR Creation Review: the repository whose draft this verdict is about ("" = single repo; omit when there is one).
            repo: z.string().optional(),
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

// ?repo=<sub-repo dir> picks which repository's PR (omit / "" for a single-repo env).
app.get("/api/tasks/:id/pr-comments", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    try {
        return c.json(await engine.prComments(task.id, c.req.query("repo") ?? ""));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 502);
    }
});

// Resolve / reopen the review thread a line comment belongs to (the human's own click; agents never do this).
app.post("/api/tasks/:id/pr-comments/:commentId/resolve", async (c) => {
    const body = json(z.object({ resolved: z.boolean().optional(), repo: z.string().optional() }), await c.req.json().catch(() => ({})));
    try {
        return c.json(await engine.resolvePrComment(c.req.param("id"), body.repo ?? "", Number(c.req.param("commentId")), body.resolved ?? true));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// ?commits=<sha>,<sha>… narrows the diff to those commits (contiguous runs become one group each); ?scope=uncommitted
// shows only what is not committed yet. Without either: everything versus the base branch, as one group.
app.get("/api/tasks/:id/diff", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const env = db.prepare(`SELECT base_branch FROM envs WHERE id = ?`).get(task.env_id) as { base_branch: string };
    const shas = (c.req.query("commits") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f]{7,40}$/i.test(s));
    const scope = c.req.query("scope");
    const groups = scope === "uncommitted" ? await engine.diffFiltered(task.id, { uncommitted: true }) : shas.length ? await engine.diffFiltered(task.id, { shas }) : null;
    if (groups) return c.json({ base: env.base_branch, filtered: true, groups, files: groups.flatMap((g) => g.files) });
    const files = await engine.diff(task.id);
    return c.json({ base: env.base_branch, filtered: false, groups: [{ label: `all changes vs origin/${env.base_branch}`, shas: [], files }], files });
});

app.get("/api/tasks/:id/commits", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(await engine.commits(task.id));
});

app.post("/api/tasks/:id/stop", (c) => {
    engine.stop(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
});

app.post("/api/tasks/:id/retry", (c) => {
    engine.retry(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
});

app.get("/api/tasks/:id/usage", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(taskUsage(db, task.id));
});

// Opens the task's app URL in the env's Chrome profile (the one browser QA uses) so the human can log in there — no agent.
app.post("/api/tasks/:id/open-app", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow;
    const url = engine.appUrlFor(task, env);
    const picked = engine.qaBrowser(task, env);
    if ("error" in picked) return c.json({ error: picked.error, url }, 400);
    try {
        await openInProfile(picked.browser.browser ?? "Google", picked.browser.profileDir!, url);
        return c.json({ opened: url, profile: chromeBrowserLabel(picked.browser) });
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

// Re-read the PR from GitHub now (checks, review decision, comments cache dropped).
app.post("/api/tasks/:id/pr/refresh", async (c) => {
    try {
        await engine.refreshPr(c.req.param("id"));
        return c.json({ task: engine.getTask(c.req.param("id")), prStates: engine.prRows(c.req.param("id")) });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Merge the PR as the human. Method per repo convention (squash by default); optionally delete the remote branch after.
app.post("/api/tasks/:id/pr/merge", async (c) => {
    const body = json(z.object({ repo: z.string().optional(), method: z.enum(["squash", "merge", "rebase"]).optional(), deleteBranch: z.boolean().optional() }), await c.req.json().catch(() => ({})));
    try {
        const result = await engine.mergePr(c.req.param("id"), body.repo ?? "", body.method ?? "squash", body.deleteBranch ?? false);
        return c.json({ ok: true, result, task: engine.getTask(c.req.param("id")) });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.post("/api/tasks/:id/fix-ci", async (c) => {
    const body = json(z.object({ repo: z.string().optional() }), await c.req.json().catch(() => ({})));
    try {
        await engine.startPrFix(c.req.param("id"), body.repo ?? "");
        return c.json({ started: true });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Human picks specific PR comments (checkboxes) and asks the agent to address just those, without the full pipeline.
app.post("/api/tasks/:id/fix-comments", async (c) => {
    const body = json(z.object({ repo: z.string().optional(), commentIds: z.array(z.number()).min(1) }), await c.req.json());
    try {
        await engine.startPrCommentFix(c.req.param("id"), body.repo ?? "", body.commentIds);
        return c.json({ started: true });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.post("/api/tasks/:id/rerun", async (c) => {
    const body = json(z.object({ stage: z.enum(STAGES as [Stage, ...Stage[]]) }), await c.req.json());
    engine.rerun(c.req.param("id"), body.stage);
    return c.json(engine.getTask(c.req.param("id")));
});

// The human answers the agent's questions (by question id); the stage that asked resumes with them.
app.post("/api/tasks/:id/questions/:qid/answer", async (c) => {
    const body = json(z.object({ answers: z.record(z.string()) }), await c.req.json());
    try {
        engine.answerQuestions(c.req.param("id"), c.req.param("qid"), body.answers);
        return c.json(engine.getTask(c.req.param("id")));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.get("/api/tasks/:id/messages", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(engine.listMessages(task.id));
});

app.post("/api/tasks/:id/messages", async (c) => {
    const body = json(z.object({ text: z.string().min(1) }), await c.req.json());
    try {
        return c.json(await engine.askAgent(c.req.param("id"), body.text));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
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

// ?worktree=keep skips worktree/branch removal (and the env's cleanup command, which assumes the worktree is gone).
// ?force=1 discards unpushed commits / uncommitted changes instead of refusing — same as the Clean up button.
app.delete("/api/tasks/:id", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    try {
        await engine.deleteTask(task.id, c.req.query("worktree") !== "keep", c.req.query("force") === "1");
        return c.json({ deleted: task.id });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
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
                for (const kind of ["task", "activity", "rate_limit", "account", "message"]) {
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

// True when any file under web/src is newer than the built index.html — the phone would be looking at a stale UI.
const webBundleStale = (): boolean => {
    const built = statSync(join(process.cwd(), WEB_DIST, "index.html")).mtimeMs;
    const src = join(process.cwd(), "../web/src");
    const newest = (dir: string): number => {
        let m = 0;
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            const st = statSync(p);
            m = Math.max(m, st.isDirectory() ? newest(p) : st.mtimeMs);
        }
        return m;
    };
    return existsSync(src) && newest(src) > built;
};
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
    else if (webBundleStale()) console.warn(`[stagehand] ${WEB_DIST} is older than web/src — phones on the public listener see an old UI; run \`npx vite build\` in web/`);
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
