import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig, PREVIEW, saveConfig } from "./config.js";
import { isPublicRequest, publicAuth } from "./public-access.js";
import { listMyTickets } from "./my-tickets.js";
import { mimeOf, renderSharedFiles, sharedFileName } from "./tickets.js";
import type { ServiceKind, SharedFile } from "./db.js";
import { Resources } from "./resources.js";
import { REVIEW_CATEGORIES, reviewChecklistJson } from "./review-checklist.js";
import { GUARD_HOOK, prTemplates, Rules, rulesOf } from "./rules.js";
import { inspectConfigDir } from "./config-dirs.js";
import { recordUsage, taskUsage, usageReport, windowShares } from "./usage.js";
import { timingReport } from "./timing.js";
import { type ResultEvent } from "./claude/runner.js";
import { desktopNotifier, notify } from "./notify.js";
import { jevProbe } from "./jev.js";

import { ModelCatalog } from "./claude/models.js";
import { accountOrderOf, accountUsableWith, chromeBrowserLabel, chromeBrowsersOf, COMPONENT_KEY, componentsOf, migrateAccountsToConfigDirs, now, openDb, parseEnvVars, prTemplateOverridesOf, STAGES, type AccountRow, type ChromeBrowser, type ConfigDirRow, type EnvRow, type Stage, type TaskRow } from "./db.js";
import { matchChromeProfiles, openInProfile, restartChrome } from "./chrome-profiles.js";
import { Engine } from "./engine.js";
import { Services, DEPENDENCY_KIND } from "./services.js";
import { Sessions } from "./sessions.js";
import { Palace } from "./palace.js";
import { ProductOwners, PoTickets, readReview, readReviewState, reviewNotes } from "./product-owners.js";
import { Prompter } from "./prompter.js";
import { authDirFor, authEnv, browserDirFor, OAUTH_TOKEN_RE, probeChrome, probeDefaultModel, probeRateLimits, readAuthStatus, SETUP_TOKEN_COMMAND } from "./claude/accounts.js";
import { collapseLargeFiles, envRepos, isGitRepo, repoPaths, type DiffGroup } from "./git.js";
import { attach, capturePane, ensureSession, killSession, loginSessionName, pipePane, sessionExists, taskSessionName } from "./tmux.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfg = loadConfig();
const db = openDb(cfg.dataDir);
migrateAccountsToConfigDirs(db, { mainConfigDir: cfg.mainConfigDir, scratchAccountsDir: cfg.accountsDir });
const services = new Services(db, cfg);
if (!PREVIEW) services.startWatch();
const engine = new Engine(db, cfg, services);
services.onNotice = (taskId, text) => engine.serviceNotice(taskId, text);
const sessions = new Sessions(db, cfg, engine);
// Every resource Stagehand started, judged and reaped by policy; the Resources page reads the same snapshot.
const resources = new Resources(db, cfg, {
    clones: () => engine.cloneList(),
    stopService: (taskId, kind) => services.stop(taskId, kind as ServiceKind),
    stopDependency: (env) => services.stopDependency(env),
    stopBrowser: (f) => engine.stopGstackBrowser(f),
    releaseClone: (key) => engine.releaseClone(key),
    notice: (taskId, text) => engine.serviceNotice(taskId, text),
});
if (!PREVIEW) resources.start();
// The in-app assistant; its events ride the same websocket as everything else (kind "prompter").
const palace = new Palace(cfg.dataDir);
{
    const { migrated } = palace.ensure(join(cfg.dataDir, "prompter"));
    if (migrated) console.log(`[stagehand] palace: the Prompter's palace copied to ${palace.home} (the old one stays as a backup)`);
}
const prompter = new Prompter(db, cfg, (ev) => engine.emit("prompter", ev), palace);
const productOwners = new ProductOwners(db, cfg, palace, (ev) => engine.emit("po", ev), `http://127.0.0.1:${cfg.port}`, (taskId) => engine.touchTask(taskId));
productOwners.ensureHome();
productOwners.backfillEnvs();
void productOwners.migrateGlobalContext().catch((e: unknown) => console.warn(`[po] product context migration: ${String((e as Error).message ?? e)}`));
productOwners.startIssueRefresh();
engine.setPoBriefer((task, taskDir) => productOwners.briefTask(task, taskDir, () => engine.touchTask(task.id)));

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
// The model picker's entries come from the Models API, fetched with the first token account and cached for hours.
const modelCatalog = new ModelCatalog(join(cfg.dataDir, "models.json"), () => accountsAll().find((a) => a.oauth_token)?.oauth_token ?? null);

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
            chromeCloneQa: z.boolean().optional(),
        }),
        await c.req.json(),
    );
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const chosen = body.chromeDeviceId === undefined ? undefined : body.chromeDeviceId ? chromeBrowsersOf(acc).find((b) => b.deviceId === body.chromeDeviceId) ?? null : null;
    db.prepare(`UPDATE accounts SET name = ?, failover_enabled = ?, failover_threshold = ?, chrome_device_id = ?, chrome_browser_name = ?, chrome_clone_qa = ? WHERE id = ?`).run(
        body.name ?? acc.name,
        body.failover_enabled === undefined ? acc.failover_enabled : body.failover_enabled ? 1 : 0,
        body.failover_threshold ?? acc.failover_threshold,
        chosen === undefined ? acc.chrome_device_id : chosen?.deviceId ?? null,
        chosen === undefined ? acc.chrome_browser_name : chosen ? chromeBrowserLabel(chosen) : null,
        body.chromeCloneQa === undefined ? acc.chrome_clone_qa : body.chromeCloneQa ? 1 : 0,
        acc.id,
    );
    emitAccount(acc.id);
    return c.json(publicAccount(accountById(acc.id)!));
});

// Deleting an account only forgets it in Stagehand (its token and auth dir go, config dirs stay); refused while an env,
// task, session or running run still points at it. Past runs and usage keep the id as history (no foreign key); the
// account's rate-limit and calibration rows go with it, and it leaves every env's failover order.
app.delete("/api/accounts/:id", (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const envs = db.prepare(`SELECT name FROM envs WHERE default_account_id = ?`).all(acc.id) as Array<{ name: string }>;
    const tasks = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE account_id = ?`).get(acc.id) as { n: number };
    const sess = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?`).get(acc.id) as { n: number };
    const running = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE account_id = ? AND status = 'running'`).get(acc.id) as { n: number };
    const uses = envs.map((e) => `env ${e.name}`).concat(tasks.n ? [`${tasks.n} task(s)`] : [], sess.n ? [`${sess.n} session(s)`] : [], running.n ? [`${running.n} running run(s)`] : []);
    if (uses.length) return c.json({ error: `in use by ${uses.join(", ")} — reassign first` }, 400);
    clearInterval(tokenCaptures.get(acc.id));
    tokenCaptures.delete(acc.id);
    db.transaction(() => {
        db.prepare(`DELETE FROM rate_limits WHERE account_id = ?`).run(acc.id);
        db.prepare(`DELETE FROM window_calibration WHERE account_id = ?`).run(acc.id);
        for (const env of envsAll()) {
            const order = accountOrderOf(env);
            if (order.includes(acc.id)) db.prepare(`UPDATE envs SET account_order = ? WHERE id = ?`).run(JSON.stringify(order.filter((id) => id !== acc.id)), env.id);
        }
        db.prepare(`DELETE FROM accounts WHERE id = ?`).run(acc.id);
    })();
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

// One copy of the account's QA Chrome profile: started, its extension awaited as a connected browser, then removed.
app.post("/api/accounts/:id/clone-test", async (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    return c.json(await engine.testClone(acc, acc.login_dir ?? browserDirFor(cfg, acc)));
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
        // Reopen the account's known QA profile so its extension actually loads after the relaunch.
        const known = chromeBrowsersOf(acc).find((b) => b.deviceId === acc.chrome_device_id) ?? chromeBrowsersOf(acc)[0];
        await restartChrome(known?.browser ?? "Google", known?.profileDir);
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
    // A failed probe keeps the last known browser list and choice: the profile directory in it is what a later
    // "Relaunch Chrome for QA" / probe restart needs to open the right profile window again. So does a probe that
    // answered but listed no browser — the bridge is up while the extension in the QA profile has not connected yet
    // (Chrome relaunched after a reboot, 2026-09-24): storing its empty list wiped the mapping, and every headless QA
    // run after that met the login page ("profile is not resolved").
    const fresh = r.ok && browsers.length > 0;
    db.prepare(`UPDATE accounts SET chrome_capable = ?, chrome_browsers = ?, chrome_device_id = ?, chrome_browser_name = ? WHERE id = ?`).run(
        r.ok ? 1 : 0,
        fresh ? JSON.stringify(browsers) : acc.chrome_browsers,
        fresh ? (chosen?.deviceId ?? null) : acc.chrome_device_id,
        fresh ? (chosen ? chromeBrowserLabel(chosen) : null) : acc.chrome_browser_name,
        acc.id,
    );
    emitAccount(acc.id);
    const kept = chromeBrowsersOf(acc).find((b) => b.deviceId === acc.chrome_device_id);
    return c.json({
        ok: r.ok,
        detail: !r.ok
            ? `no Chrome bridge under ${acc.email ?? acc.name} even after restarting Chrome — install the Claude extension in a Chrome profile and sign it into this claude.ai account, then probe again`
            : fresh
              ? `Chrome bridge answered as ${acc.email ?? acc.name}${restarted ? " (needed a Chrome restart first)" : ""}; ${browsers.length} connected profile(s): ${browsers.map((b) => `${chromeBrowserLabel(b)}${b.account ? ` (${b.account})` : ""}`).join(", ")}`
              : `Chrome bridge answered as ${acc.email ?? acc.name}${restarted ? " (needed a Chrome restart first)" : ""}, but no browser is connected yet${kept ? ` — kept the last known profile "${chromeBrowserLabel(kept)}"` : ""}; open the QA profile in Chrome, wait for the extension, then probe again`,
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
// gstack's built-in review categories, for the env page's Code review section (keys are what envs.review_checklist stores).
app.get("/api/review-categories", (c) => c.json(REVIEW_CATEGORIES));

// ---------- resources: everything Stagehand started on this host, with the policy verdict on each ----------
app.get("/api/resources", async (c) => {
    const s = c.req.query("refresh") === "1" || !resources.current() ? await resources.refresh() : resources.current()!;
    return c.json(s);
});
app.post("/api/resources/stop", async (c) => {
    const body = json(z.object({ id: z.string().min(1) }), await c.req.json());
    const r = resources.current()?.resources.find((x) => x.id === body.id);
    if (!r) return c.json({ error: "no such resource (refresh the page)" }, 404);
    await resources.stop(r, "stopped from the Resources page", "human");
    return c.json({ ok: true });
});
app.post("/api/resources/pin", async (c) => {
    const body = json(z.object({ id: z.string().min(1), pinned: z.boolean() }), await c.req.json());
    resources.pin(body.id, body.pinned);
    return c.json({ ok: true });
});
app.post("/api/resources/sweep", async (c) => c.json({ stopped: await resources.sweep() }));

// Deleting an env is refused while it has tasks (delete those first — each delete offers worktree cleanup).
app.delete("/api/envs/:id", (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    const tasks = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE env_id = ?`).get(env.id) as { n: number };
    if (tasks.n) return c.json({ error: `${tasks.n} task(s) still belong to this environment — delete them first` }, 400);
    const sess = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE env_id = ?`).get(env.id) as { n: number };
    if (sess.n) return c.json({ error: `${sess.n} session(s) still belong to this environment — delete them on the Sessions page first` }, 400);
    db.prepare(`DELETE FROM envs WHERE id = ?`).run(env.id);
    return c.json({ deleted: env.id });
});

// ---------- task managers (ClickUp / Linear integrations) ----------

const taskManagers = () => [
    { source: "clickup" as const, label: "ClickUp", configured: !!cfg.clickupToken, token: mask(cfg.clickupToken), teamId: cfg.clickupTeamId, envs: envsAll().filter((e) => e.ticket_source === "clickup").map((e) => e.name) },
    { source: "linear" as const, label: "Linear", configured: !!cfg.linearApiKey, token: mask(cfg.linearApiKey), teamId: null, envs: envsAll().filter((e) => e.ticket_source === "linear").map((e) => e.name) },
];

app.get("/api/task-managers", (c) => c.json(taskManagers()));

// Notion: Product Owners fetch pages by URL with this integration token (the pages must be shared with the integration).
app.get("/api/integrations/notion", (c) => c.json({ configured: !!cfg.notionApiKey, token: mask(cfg.notionApiKey) }));
app.patch("/api/integrations/notion", async (c) => {
    const body = json(z.object({ token: z.string().nullable() }), await c.req.json());
    cfg.notionApiKey = body.token || null;
    saveConfig(cfg);
    return c.json({ configured: !!cfg.notionApiKey, token: mask(cfg.notionApiKey) });
});

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

// The CLAUDE.md files an environment's runs read: the config dir's (every run, at once) and the repository's — the
// root and each sub-repository (committed in git: a task sees it once it is on the base branch). Read live from disk.
interface ClaudeMdFile {
    id: string;
    label: string;
    path: string;
    scope: "config-dir" | "repo";
    exists: boolean;
    content: string;
}
const claudeMdFiles = (env: EnvRow): ClaudeMdFile[] => {
    const cd = engine.configDirOf(env);
    const entries: Array<Omit<ClaudeMdFile, "exists" | "content">> = [
        { id: "config-dir", label: `Config dir · ${cd.name}`, path: join(cd.path, "CLAUDE.md"), scope: "config-dir" },
        { id: "repo", label: "Repository root", path: join(env.path, "CLAUDE.md"), scope: "repo" },
        ...envRepos(env).map((r) => ({ id: `repo:${r}`, label: `Repository · ${r}`, path: join(env.path, r, "CLAUDE.md"), scope: "repo" as const })),
    ];
    return entries.map((e) => {
        const exists = existsSync(e.path);
        let content = "";
        if (exists) {
            try {
                content = readFileSync(e.path, "utf8");
            } catch {
                content = "";
            }
        }
        return { ...e, exists, content };
    });
};
app.get("/api/envs/:id/claude-md", (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    return c.json({ files: claudeMdFiles(env) });
});
// Writes one of the files listed above (only those: the id is resolved server-side, never a path from the client).
app.put("/api/envs/:id/claude-md", async (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    const body = json(z.object({ id: z.string().min(1), content: z.string().max(200_000) }), await c.req.json());
    const file = claudeMdFiles(env).find((f) => f.id === body.id);
    if (!file) return c.json({ error: "no such CLAUDE.md for this environment" }, 400);
    if (!existsSync(dirname(file.path))) return c.json({ error: `${dirname(file.path)} does not exist` }, 400);
    writeFileSync(file.path, body.content);
    return c.json({ file: { ...file, exists: true, content: body.content } });
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

// Optional components as the API takes them (see db.ts EnvComponent); stored as JSON, an empty list as NULL.
const ComponentList = z.array(
    z.object({
        key: z.string().regex(COMPONENT_KEY, "key: lowercase letters, digits, - and _, starting with a letter").refine((k) => k !== "be" && k !== "fe", "be and fe are the core services"),
        label: z.string().optional(),
        command: z.string().min(1),
        autoStart: z.boolean().optional(),
    }),
);
const ReviewChecklistBody = z.object({
    disabled: z.array(z.string()).optional(),
    custom: z.array(z.object({ key: z.string().optional(), title: z.string().min(1), pass: z.enum(["critical", "informational"]).optional(), detail: z.string().optional() })).optional(),
    doNotFlag: z.array(z.string()).optional(),
});
const componentsJson = (list: z.infer<typeof ComponentList> | undefined): string | null =>
    list && list.length ? JSON.stringify(list.map((c) => ({ key: c.key, label: c.label?.trim() || c.key, command: c.command, autoStart: c.autoStart === true }))) : null;

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
            checkCommand: z.string().optional(),
            components: ComponentList.optional(),
            keepServices: z.boolean().optional(),
            prDraft: z.boolean().optional(),
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
        `INSERT INTO envs (id, name, path, base_branch, default_account_id, account_order, config_dir_id, app_url, qa_script, be_command, fe_command, be_url_template, fe_url_template, be_port, fe_port, setup_command, repos, branch_prefix, ticket_source, env_vars, cleanup_command, check_command, components, keep_services, pr_draft, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        body.checkCommand ?? null,
        componentsJson(body.components) ?? null,
        body.keepServices ? 1 : 0,
        body.prDraft ? 1 : 0,
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
            rebaseCommand: z.string().nullable().optional(),
            checkCommand: z.string().nullable().optional(),
            components: ComponentList.optional(),
            keepServices: z.boolean().optional(),
            qaBrowser: z.enum(["chrome", "gstack"]).optional(),
            qaAutoFix: z.enum(["off", "seeds", "seeds+steps", "seeds+steps+asserts"]).optional(),
            // The Code Review checklist for this env (null = gstack's full checklist).
            reviewChecklist: ReviewChecklistBody.nullable().optional(),
            // Per-repository PR template overrides: {"backend": ".github/pull_request_template.md"}; null/"" removes one.
            prTemplates: z.record(z.string().nullable()).optional(),
            prDraft: z.boolean().optional(),
            // Another env whose BE this one needs reachable to work (started once, shared across every task).
            dependsOnEnvId: z.string().nullable().optional(),
        }),
        await c.req.json(),
    );
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    if (body.configDirId && !configDirById(body.configDirId)) return c.json({ error: "unknown config dir" }, 400);
    if (body.accountOrder?.some((id) => !accountById(id))) return c.json({ error: "unknown account in accountOrder" }, 400);
    if (body.dependsOnEnvId) {
        if (body.dependsOnEnvId === env.id) return c.json({ error: "an env cannot depend on itself" }, 400);
        if (!envsAll().some((e) => e.id === body.dependsOnEnvId)) return c.json({ error: "unknown dependency env" }, 400);
    }
    const pick = <T,>(next: T | undefined, cur: T): T => (next === undefined ? cur : next);
    // The ordered list is the source of truth; default_account_id mirrors its head for older readers.
    const order = body.accountOrder ?? (body.defaultAccountId !== undefined ? (body.defaultAccountId ? [body.defaultAccountId] : []) : accountOrderOf(env));
    const repos = body.repos === undefined ? env.repos : body.repos && body.repos.length ? JSON.stringify(body.repos) : null;
    if (repos !== env.repos) {
        const bad = await badCheckouts({ path: env.path, base_branch: env.base_branch, repos });
        if (bad) return c.json({ error: bad }, 400);
    }
    const prTemplates = body.prTemplates === undefined ? env.pr_templates : ((): string | null => {
        const merged = { ...prTemplateOverridesOf(env) };
        for (const [dir, path] of Object.entries(body.prTemplates)) {
            if (path && path.trim()) merged[dir] = path.trim().replace(/^\/+/, "");
            else delete merged[dir];
        }
        return Object.keys(merged).length ? JSON.stringify(merged) : null;
    })();
    db.prepare(
        `UPDATE envs SET name = ?, default_account_id = ?, account_order = ?, config_dir_id = ?, chrome_device_id = ?, chrome_browser_name = ?, qa_seed_hints = ?, base_branch = ?, app_url = ?, qa_script = ?, be_command = ?, fe_command = ?, be_url_template = ?, fe_url_template = ?, be_port = ?, fe_port = ?, setup_command = ?, repos = ?, branch_prefix = ?, ticket_source = ?, env_vars = ?, cleanup_command = ?, check_command = ?, components = ?, keep_services = ?, pr_templates = ?, pr_draft = ?, depends_on_env_id = ?, rebase_command = ? WHERE id = ?`,
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
        pick(body.checkCommand, env.check_command),
        body.components === undefined ? env.components : componentsJson(body.components),
        body.keepServices === undefined ? env.keep_services : body.keepServices ? 1 : 0,
        prTemplates,
        body.prDraft === undefined ? env.pr_draft : body.prDraft ? 1 : 0,
        pick(body.dependsOnEnvId, env.depends_on_env_id),
        pick(body.rebaseCommand, env.rebase_command),
        env.id,
    );
    if (body.qaBrowser !== undefined) db.prepare(`UPDATE envs SET qa_browser = ? WHERE id = ?`).run(body.qaBrowser, env.id);
    if (body.qaAutoFix !== undefined) db.prepare(`UPDATE envs SET qa_auto_fix = ? WHERE id = ?`).run(body.qaAutoFix, env.id);
    if (body.reviewChecklist !== undefined) {
        const json = reviewChecklistJson(
            body.reviewChecklist && {
                disabled: body.reviewChecklist.disabled ?? [],
                custom: (body.reviewChecklist.custom ?? []).map((p) => ({ key: p.key ?? "", title: p.title, pass: p.pass ?? "informational", detail: p.detail ?? "" })),
                doNotFlag: body.reviewChecklist.doNotFlag ?? [],
            },
        );
        db.prepare(`UPDATE envs SET review_checklist = ? WHERE id = ?`).run(json, env.id);
    }
    return c.json(db.prepare(`SELECT * FROM envs WHERE id = ?`).get(env.id));
});

// Status of an env's shared dependency service (e.g. Deal → Core), for a small indicator on the env page — not
// started here, only read; ensureDependency() starts it lazily the next time a task of the dependent env needs it.
app.get("/api/envs/:id/dependency", async (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    if (!env.depends_on_env_id) return c.json({ configured: false });
    const dep = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(env.depends_on_env_id) as EnvRow | undefined;
    const row = services.envServiceRow(env.depends_on_env_id);
    return c.json({ configured: true, dependencyEnvName: dep?.name ?? "(deleted env)", running: row ? await sessionExists(row.tmux) : false, port: row?.port ?? null, url: row?.url ?? null, startedAt: row?.started_at ?? null });
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
// Time instead of cost: run wall time by stage / operation / day, and per task how long it worked, waited for the
// human, waited for GitHub or sat rate-limited (timing.ts).
app.get("/api/timing", (c) => {
    const days = Number(c.req.query("days") ?? "0");
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
    return c.json(timingReport(db, since));
});

// ---------- tasks ----------

app.get("/api/tasks", (c) => c.json(engine.listTasks(c.req.query("env"))));

// Remote branch names of one repository of an env (`repo` = sub-repo dir, "" or omitted for a single repo), for the
// base-branch pickers. `git ls-remote --heads` against the env's own checkout, cached a minute per repo.
const branchCache = new Map<string, { at: number; names: string[] }>();
app.get("/api/envs/:id/branches", async (c) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    const repo = c.req.query("repo") ?? "";
    const cwd = repo ? join(env.path, repo) : env.path;
    const hit = branchCache.get(cwd);
    if (hit && Date.now() - hit.at < 60_000) return c.json({ branches: hit.names });
    try {
        const { stdout } = await execFileAsync("git", ["-C", cwd, "ls-remote", "--heads", "origin"], { env: { ...process.env, ...parseEnvVars(env.env_vars) }, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
        const names = stdout.split("\n").map((l) => l.split("\t")[1] ?? "").filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length));
        // Trunk first, then the rest alphabetically.
        names.sort((a, b) => (a === env.base_branch ? -1 : b === env.base_branch ? 1 : a.localeCompare(b)));
        branchCache.set(cwd, { at: Date.now(), names });
        return c.json({ branches: names });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e).slice(0, 200) }, 400);
    }
});

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
            // Branch the work starts from and the PR targets; omitted = the env's base_branch. Another task's branch = a
            // stacked PR. A multi-repo env may give one branch per repository directory ({"backend": "…", "frontend": "…"}).
            baseBranch: z.union([z.string().trim().min(1), z.record(z.string())]).optional(),
            // The Product Owner reviewing the design; omitted = the one whose project the ticket belongs to (if any).
            productOwnerId: z.string().nullable().optional(),
        }),
        await c.req.json(),
    );
    const tickets = [...new Set([...(body.ticket ? [body.ticket] : []), ...(body.tickets ?? [])].map((t) => t.trim()).filter(Boolean))];
    if (tickets.length === 0) return c.json({ error: "no ticket given" }, 400);
    if (body.productOwnerId && productOwners.get(body.productOwnerId)?.env_id !== body.envId) return c.json({ error: "that Product Owner belongs to another environment" }, 400);
    const created = body.mode === "batch" || tickets.length === 1 ? [engine.createTask(body.envId, tickets, body.accountId, body.model, body.notes, body.baseBranch)] : tickets.map((t) => engine.createTask(body.envId, [t], body.accountId, body.model, body.notes, body.baseBranch));
    for (const t of created) {
        if (body.productOwnerId !== undefined) engine.setProductOwner(t.id, body.productOwnerId);
        else void productOwners.ownerOfTicket(t.env_id, t.source, t.ticket_id).then((po) => po && engine.setProductOwner(t.id, po)).catch(() => undefined);
    }
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
            baseBranch: z.union([z.string(), z.record(z.string())]).nullable().optional(),
            // Files attached to the instructions: listed by path at the end of the notes, so every stage sees them.
            files: z.array(SharedFileSchema).optional(),
            productOwnerId: z.string().nullable().optional(),
        }),
        await c.req.json(),
    );
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    if (body.productOwnerId !== undefined) {
        const po = body.productOwnerId ? productOwners.get(body.productOwnerId) : null;
        if (body.productOwnerId && !po) return c.json({ error: "no such Product Owner" }, 400);
        if (po && po.env_id !== task.env_id) return c.json({ error: "that Product Owner belongs to another environment" }, 400);
        engine.setProductOwner(task.id, body.productOwnerId);
    }
    const files = sharedFilesOf(task.id, body.files);
    if (body.notes !== undefined || files.length) engine.setNotes(task.id, `${body.notes === undefined ? (task.notes ?? "") : (body.notes ?? "")}${renderSharedFiles(files, engine.taskDir(task.id))}`.trim() || null);
    if (body.labels !== undefined) engine.setLabels(task.id, body.labels);
    if (body.baseBranch !== undefined) engine.setBaseBranch(task.id, body.baseBranch);
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
            // Skip the browser QA stages on the way back to User Review this once.
            skipQa: z.boolean().optional(),
            files: z.array(SharedFileSchema).optional(),
        }),
        await c.req.json(),
    );
    engine.returnTo(c.req.param("id"), body.stage, body.notes, body.comments, body.skipQa === true, sharedFilesOf(c.req.param("id"), body.files));
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

// ---------- Prompter, the in-app assistant ----------

app.get("/api/prompter/status", (c) => c.json(prompter.status()));
app.post("/api/prompter/seed", async (c) => c.json(await prompter.seed()));
app.get("/api/prompter/describe", (c) => c.json(prompter.describe(c.req.query("path") ?? "#/dashboard")));
// The open chats (newest first), each with whether a turn is running — the widget's session strip.
app.get("/api/prompter/sessions", (c) => c.json(prompter.listSessions().map((s) => ({ ...s, busy: prompter.busy(s.id) }))));
app.post("/api/prompter/sessions", async (c) => {
    const body = json(z.object({ model: z.string().nullable().optional() }), await c.req.json().catch(() => ({})));
    try {
        return c.json(prompter.createSession(body.model ?? null));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});
app.get("/api/prompter/sessions/:id/messages", (c) => {
    const s = prompter.session(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    return c.json({ session: s, busy: prompter.busy(s.id), messages: prompter.messages(s.id) });
});
// The turn runs in the background; its text streams over the websocket and `done` carries the stored answer. Sent
// while a turn runs, the message is stacked (`queued: true`) and goes out with the next turn.
// A file for Prompter (a screenshot, an export): saved under <prompter home>/files/<session>/, named on the message.
const PrompterFileSchema = z.object({ name: z.string().min(1), file: z.string().regex(/^files\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/), mime: z.string().nullable(), size: z.number().int().nonnegative() });
app.post("/api/prompter/sessions/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!prompter.session(id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.parseBody();
    const f = body["file"];
    if (!(f instanceof File)) return c.json({ error: "send one file in the `file` field (multipart/form-data)" }, 400);
    if (f.size === 0) return c.json({ error: `${f.name} is empty` }, 400);
    if (f.size > MAX_SHARED_FILE_BYTES) return c.json({ error: `${f.name} is too large (${Math.round(f.size / 1e6)} MB; the cap is 200 MB)` }, 400);
    const safe = sharedFileName(f.name);
    const rel = `files/${id}/${randomUUID().slice(0, 8)}-${safe}`;
    mkdirSync(join(prompter.home, "files", id), { recursive: true });
    writeFileSync(join(prompter.home, rel), Buffer.from(await f.arrayBuffer()));
    const shared: SharedFile = { name: f.name, file: rel, mime: f.type && f.type !== "application/octet-stream" ? f.type : mimeOf(safe), size: f.size };
    return c.json(shared);
});

app.post("/api/prompter/sessions/:id/messages", async (c) => {
    const body = json(z.object({ text: z.string().min(1), path: z.string().nullable().optional(), files: z.array(PrompterFileSchema).optional() }), await c.req.json());
    const id = c.req.param("id");
    if (!prompter.session(id)) return c.json({ error: "not found" }, 404);
    for (const f of body.files ?? []) if (!f.file.startsWith(`files/${id}/`) || !existsSync(join(prompter.home, f.file))) return c.json({ error: `${f.name} was not uploaded to this chat — attach it again` }, 400);
    try {
        return c.json({ ok: true, ...prompter.submit(id, body.text, body.path ?? null, body.files ?? []) }, 202);
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});
// Takes a stacked message back (the human edits it); 409 once it went to the assistant.
app.delete("/api/prompter/sessions/:id/messages/:mid", (c) => {
    const ok = prompter.unqueue(c.req.param("id"), c.req.param("mid"));
    return ok ? c.json({ ok: true }) : c.json({ error: "that message already went to the assistant" }, 409);
});
// Ctrl-C for the running turn: kills it, keeps its partial answer, and the stacked messages (if any) go out next.
app.post("/api/prompter/sessions/:id/stop", (c) => c.json({ stopped: prompter.stop(c.req.param("id")) }));
app.post("/api/prompter/sessions/:id/ping", (c) => {
    prompter.ping(c.req.param("id"));
    return c.json({ ok: true });
});
app.delete("/api/prompter/sessions/:id", async (c) => {
    const farewell = c.req.query("farewell") !== "0";
    void prompter.close(c.req.param("id"), { farewell }).catch((e: unknown) => console.warn(`[prompter] close: ${String((e as Error).message ?? e).slice(0, 200)}`));
    return c.json({ ok: true });
});

// Restarts this server from inside the app (the assistant after a code change, or the human): the tmux pane that
// hosts it gets Ctrl-C and the start command again, from a detached shell that outlives this process. Refused while
// a run is going unless forced (a restart kills every run; Retry resumes them). Prompter chats survive: their
// sessions are rows plus claude transcripts, and the widget re-attaches when the server is back.
app.post("/api/server/restart", async (c) => {
    const body = json(z.object({ force: z.boolean().optional() }), await c.req.json().catch(() => ({})));
    const running = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`).get() as { n: number }).n;
    const busy = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running', 'queued')`).get() as { n: number }).n;
    if ((running || busy) && !body.force) return c.json({ error: `not a boundary: ${running} run(s) running, ${busy} task(s) running or queued — pass force to restart anyway (runs are killed; Retry resumes them)` }, 409);
    const session = cfg.server.tmuxSession;
    // The pane normally runs scripts/serve.sh, which starts the server again after Ctrl-C by itself; a pane without
    // that loop gets the start command.
    const command = cfg.server.startCommand ?? `cd ${REPO_ROOT} && scripts/serve.sh`;
    // "[s]cripts": the pattern must not match this detached shell, whose own command line contains it.
    const script = `cd /; sleep 1; tmux send-keys -t ${JSON.stringify(session)} C-c; sleep 3; pgrep -f '[s]cripts/serve.sh' >/dev/null || tmux send-keys -t ${JSON.stringify(session)} ${JSON.stringify(command)} Enter`;
    const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    console.log(`[stagehand] restart requested${body.force ? " (forced)" : ""} — tmux ${session}`);
    return c.json({ ok: true, detail: `restarting in tmux ${session}; the API answers again in a few seconds` }, 202);
});

// ---------- settings (integrations, defaults) ----------

const mask = (s: string | null): string | null => (s ? `${s.slice(0, 4)}…${s.slice(-3)}` : null);

const settingsJson = async () => {
    const models = await modelCatalog.options();
    const status = modelCatalog.status();
    return {
        clickupToken: mask(cfg.clickupToken),
        clickupTeamId: cfg.clickupTeamId,
        linearApiKey: mask(cfg.linearApiKey),
        typesafeApiKey: mask(cfg.typesafeApiKey),
        defaultModel: cfg.defaultModel,
        models,
        modelsFetchedAt: status.fetchedAt,
        modelsError: status.error,
        stageModels: cfg.stageModels,
        codeReview: cfg.codeReview,
        stageRerunModels: cfg.stageRerunModels,
        operationModels: cfg.operationModels,
        notifications: { ...cfg.notifications, ntfyToken: mask(cfg.notifications.ntfyToken) },
        desktopNotifier: desktopNotifier(),
        prompter: cfg.prompter,
        resources: cfg.resources,
    };
};

app.get("/api/settings", async (c) => c.json(await settingsJson()));

// Fetches the model list again now (the picker is otherwise refreshed hours apart); answers like GET /api/settings.
app.post("/api/models/refresh", async (c) => {
    await modelCatalog.refresh(true);
    return c.json(await settingsJson());
});

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

// One real Jev request with the stored configuration: proves the endpoint and the response contract.
app.post("/api/jev/test", async (c) => c.json(await jevProbe(cfg)));

app.patch("/api/settings", async (c) => {
    const body = json(
        z.object({
            clickupToken: z.string().nullable().optional(),
            clickupTeamId: z.string().nullable().optional(),
            linearApiKey: z.string().nullable().optional(),
            typesafeApiKey: z.string().nullable().optional(),
            defaultModel: z.string().nullable().optional(),
            codeReview: z.boolean().optional(),
            resources: z
                .object({
                    enabled: z.boolean().optional(),
                    idleServiceMinutes: z.number().min(0).optional(),
                    doneServiceMinutes: z.number().min(0).optional(),
                    settleMinutes: z.number().min(0).optional(),
                    maxSessionMb: z.number().min(0).optional(),
                    terminalIdleHours: z.number().min(0).optional(),
                    sessionIdleHours: z.number().min(0).optional(),
                    loginMinutes: z.number().min(0).optional(),
                    orphanMinutes: z.number().min(0).optional(),
                    maxDevServerTasks: z.number().int().min(1).optional(),
                    minAvailableMb: z.number().min(0).optional(),
                    maxSwapMb: z.number().min(0).optional(),
                })
                .optional(),
            // Partial maps: only the keys present change; "" or null clears a key (back to the fallback).
            stageModels: z.record(z.string().nullable()).optional(),
            stageRerunModels: z.record(z.string().nullable()).optional(),
            operationModels: z.record(z.string().nullable()).optional(),
            prompter: z
                .object({
                    accountId: z.string().nullable().optional(),
                    model: z.string().optional(),
                    idleHours: z.number().min(0.1).optional(),
                    purgeDays: z.number().min(0.1).optional(),
                    farewell: z.boolean().optional(),
                    maxTurns: z.number().int().min(1).optional(),
                    seedFrom: z.string().optional(),
                })
                .optional(),
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
    if (body.typesafeApiKey !== undefined) cfg.typesafeApiKey = body.typesafeApiKey?.trim() || null;
    if (body.prompter) {
        const p = body.prompter;
        if (p.accountId !== undefined) cfg.prompter.accountId = p.accountId;
        if (p.model !== undefined) cfg.prompter.model = p.model.trim() || "fable";
        if (p.idleHours !== undefined) cfg.prompter.idleHours = p.idleHours;
        if (p.purgeDays !== undefined) cfg.prompter.purgeDays = p.purgeDays;
        if (p.farewell !== undefined) cfg.prompter.farewell = p.farewell;
        if (p.maxTurns !== undefined) cfg.prompter.maxTurns = p.maxTurns;
        if (p.seedFrom !== undefined && p.seedFrom.trim()) cfg.prompter.seedFrom = p.seedFrom.trim();
    }
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
    if (body.codeReview !== undefined) cfg.codeReview = body.codeReview;
    if (body.resources) for (const [k, v] of Object.entries(body.resources)) if (v !== undefined) (cfg.resources as unknown as Record<string, unknown>)[k] = v;
    const applyModels = (target: Record<string, string | null>, patch: Record<string, string | null> | undefined): void => {
        for (const [k, v] of Object.entries(patch ?? {})) if (k in target) target[k] = v?.trim() || null;
    };
    applyModels(cfg.stageModels as Record<string, string | null>, body.stageModels);
    applyModels(cfg.stageRerunModels as Record<string, string | null>, body.stageRerunModels);
    applyModels(cfg.operationModels as Record<string, string | null>, body.operationModels);
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
        review: engine.readArtifactJson(task.id, "review.json"),
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
            // Request changes only: skip the browser QA stages on the way back to User Review this once.
            skipQa: z.boolean().optional(),
            files: z.array(SharedFileSchema).optional(),
        }),
        await c.req.json(),
    );
    engine.review(c.req.param("id"), { ...body, files: sharedFilesOf(c.req.param("id"), body.files) });
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
// Generated / very large files come back without hunks (`collapsed: true`); ?file=<path> returns that one file in full.
app.get("/api/tasks/:id/diff", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const envRow = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow;
    // One name, or "backend: x, frontend: y" when the repositories of a stacked task target different bases.
    const env = { base_branch: engine.baseBranchLabel(task, envRow) };
    const shas = (c.req.query("commits") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f]{7,40}$/i.test(s));
    const scope = c.req.query("scope");
    const only = c.req.query("file") ?? null;
    const shape = (g: DiffGroup): DiffGroup => ({ ...g, files: collapseLargeFiles(only ? g.files.filter((f) => f.path === only) : g.files, only) });
    // Sub-repos whose base was rewritten under the branch (empty = none): the "all changes" diff would then show the
    // base's own commits as this task's, so the UI leads with a rebase instead.
    const baseDrift = await engine.baseDrift(task.id);
    const groups = scope === "uncommitted" ? await engine.diffFiltered(task.id, { uncommitted: true }) : shas.length ? await engine.diffFiltered(task.id, { shas }) : null;
    if (groups) {
        const shaped = groups.map(shape);
        return c.json({ base: env.base_branch, filtered: true, baseDrift, groups: shaped, files: shaped.flatMap((g) => g.files) });
    }
    const all = shape({ label: `all changes vs origin/${env.base_branch}`, shas: [], files: await engine.diff(task.id) });
    return c.json({ base: env.base_branch, filtered: false, baseDrift, groups: [all], files: all.files });
});

app.get("/api/tasks/:id/commits", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(await engine.commits(task.id));
});

// Reword: a pure metadata edit (relinks commits, no patch is re-applied — cannot conflict), runs synchronously.
app.post("/api/tasks/:id/commits/:sha/reword", async (c) => {
    const body = json(z.object({ repo: z.string().optional(), message: z.string().min(1) }), await c.req.json());
    try {
        return c.json(await engine.rewordCommit(c.req.param("id"), body.repo ?? "", c.req.param("sha"), body.message));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Remove: a real rewrite (everything after the commit is replayed without it) — goes through the agent in the task's
// own session so it can resolve conflicts; never pushes. Starts in the background; the result lands in Chat.
app.post("/api/tasks/:id/commits/:sha/remove", async (c) => {
    const body = json(z.object({ repo: z.string().optional(), note: z.string().optional(), files: z.array(SharedFileSchema).optional() }), await c.req.json().catch(() => ({})));
    try {
        await engine.removeCommit(c.req.param("id"), body.repo ?? "", c.req.param("sha"), body.note, sharedFilesOf(c.req.param("id"), body.files));
        return c.json({ started: true });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Push rewritten history (after Remove/Reword) with --force-with-lease. Always a deliberate human click, never automatic.
app.post("/api/tasks/:id/commits/force-push", async (c) => {
    const body = json(z.object({ repo: z.string().optional(), force: z.boolean().optional() }), await c.req.json().catch(() => ({})));
    try {
        return c.json({ ok: true, result: await engine.forcePushBranch(c.req.param("id"), body.repo ?? "", body.force ?? false) });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.post("/api/tasks/:id/stop", (c) => {
    engine.stop(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
});

app.post("/api/tasks/:id/retry", (c) => {
    engine.retry(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
});

// Quits and reopens the QA browser with QA_CHROME_FLAGS (see chrome-profiles.ts), then retries the task's blocked stage.
// A human-only action: it closes the user's whole Chrome (tabs restore on relaunch).
app.post("/api/tasks/:id/relaunch-chrome", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow;
    const picked = engine.qaBrowser(task, env);
    await restartChrome("browser" in picked ? (picked.browser.browser ?? "Google") : "Google", "browser" in picked ? picked.browser.profileDir : undefined);
    engine.retry(task.id);
    return c.json(engine.getTask(task.id));
});

// The task session: its id and transcript size (what every resumed run pays for), and a way to start a fresh one.
app.get("/api/tasks/:id/session", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(engine.sessionInfo(task.id));
});
app.post("/api/tasks/:id/session/rotate", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    if (["running", "queued"].includes(task.status as string)) return c.json({ error: "the task is running — stop it or wait for the run to end" }, 409);
    return c.json(engine.rotateSession(task.id, "started by you"));
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

// Push and open the PR for every approved repository that has none yet (after the rules changed, or a manual commit).
app.post("/api/tasks/:id/pr/create", async (c) => {
    try {
        const done = await engine.createApprovedPrs(c.req.param("id"));
        return c.json({ ok: true, done, task: engine.getTask(c.req.param("id")), prStates: engine.prRows(c.req.param("id")) });
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

// "Rebase onto latest base": the task's agent rebases the branch onto origin/<base> and resolves conflicts; Stagehand
// force-pushes with lease afterwards where the env allows pushes. Errors (run in progress, dirty tree, up to date) → 400.
app.post("/api/tasks/:id/rebase", async (c) => {
    // `repos`: only these repository directories; omitted/empty = every repository of the task.
    const body = json(z.object({ repos: z.array(z.string()).optional() }), await c.req.json().catch(() => ({})));
    try {
        await engine.startRebase(c.req.param("id"), body.repos?.length ? { repos: body.repos } : {});
        return c.json({ started: true });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Batched PR jobs in one agent run: rebase (mechanical first), fix failing CI, address picked comments, instructions.
app.post("/api/tasks/:id/pr-jobs", async (c) => {
    const body = json(
        z.object({
            rebase: z.object({ repos: z.array(z.string()).optional() }).nullable().optional(),
            fixCi: z.object({ repos: z.array(z.string()).optional() }).nullable().optional(),
            comments: z.array(z.object({ repo: z.string(), ids: z.array(z.number().int()) })).optional(),
            instructions: z.string().optional(),
            files: z.array(SharedFileSchema).optional(),
        }),
        await c.req.json(),
    );
    try {
        return c.json(await engine.startPrJobs(c.req.param("id"), { ...body, files: sharedFilesOf(c.req.param("id"), body.files) }));
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

// Line comments / notes left in Stagehand's own Code changes view at a PR stage → a PR-fix round (nothing posted to GitHub).
app.post("/api/tasks/:id/fix-local-comments", async (c) => {
    const body = json(
        z.object({
            notes: z.string().optional(),
            comments: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive(), side: z.enum(["new", "old"]), snippet: z.string(), text: z.string().min(1) })).default([]),
        }),
        await c.req.json(),
    );
    try {
        await engine.startLocalCommentFix(c.req.param("id"), body.notes, body.comments ?? []);
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

// Human picks PR comments and asks the agent what it thinks of them (Chat answer, no code change, no fix round).
app.post("/api/tasks/:id/ask-comments", async (c) => {
    const body = json(z.object({ repo: z.string().optional(), commentIds: z.array(z.number()).min(1), question: z.string().optional() }), await c.req.json());
    try {
        return c.json(await engine.askAboutPrComments(c.req.param("id"), body.repo ?? "", body.commentIds, body.question));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// A Manual QA pass stuck on the environment: move on to User Review without it.
app.post("/api/tasks/:id/skip-manual-qa", (c) => {
    try {
        engine.skipManualQa(c.req.param("id"));
        return c.json(engine.getTask(c.req.param("id")));
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
// A file the human attached in the app, as returned by POST /api/tasks/:id/files; the text routes below take a list.
const SharedFileSchema = z.object({ name: z.string().min(1), file: z.string().regex(/^shared\/[A-Za-z0-9._-]+$/), mime: z.string().nullable(), size: z.number().int().nonnegative() });
const MAX_SHARED_FILE_BYTES = 200 * 1024 * 1024;
// Only files of this task that the upload route saved: anything else in the list is refused before the agent sees it.
const sharedFilesOf = (taskId: string, files: SharedFile[] | undefined): SharedFile[] => {
    for (const f of files ?? []) if (!existsSync(join(engine.taskDir(taskId), f.file))) throw new Error(`${f.name} was not uploaded to this task — attach it again`);
    return files ?? [];
};

// Upload one file (multipart, field `file`) to hand to the agent: saved under <taskDir>/shared/ — never the worktree,
// where it would show up in git status and the diff — and served back by /artifacts/. Returns the descriptor to put
// in `files` of a Chat message, a Do instruction or an answer.
app.post("/api/tasks/:id/files", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const body = await c.req.parseBody();
    const f = body["file"];
    if (!(f instanceof File)) return c.json({ error: "send one file in the `file` field (multipart/form-data)" }, 400);
    if (f.size === 0) return c.json({ error: `${f.name} is empty` }, 400);
    if (f.size > MAX_SHARED_FILE_BYTES) return c.json({ error: `${f.name} is too large (${Math.round(f.size / 1e6)} MB; the cap is 200 MB)` }, 400);
    const safe = sharedFileName(f.name);
    const rel = `shared/${randomUUID().slice(0, 8)}-${safe}`;
    mkdirSync(join(engine.taskDir(task.id), "shared"), { recursive: true });
    writeFileSync(join(engine.taskDir(task.id), rel), Buffer.from(await f.arrayBuffer()));
    // Browsers send octet-stream for anything they do not know (a CSV drop, curl): the extension decides then.
    const shared: SharedFile = { name: f.name, file: rel, mime: f.type && f.type !== "application/octet-stream" ? f.type : mimeOf(safe), size: f.size };
    return c.json(shared);
});

app.post("/api/tasks/:id/questions/:qid/answer", async (c) => {
    const body = json(z.object({ answers: z.record(z.string()), files: z.array(SharedFileSchema).optional() }), await c.req.json());
    try {
        engine.answerQuestions(c.req.param("id"), c.req.param("qid"), body.answers, sharedFilesOf(c.req.param("id"), body.files));
        return c.json(engine.getTask(c.req.param("id")));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// QA corrections applied to design.json (by the human's answers or Jev), and their revert.
app.get("/api/tasks/:id/qa-changes", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json({ changes: engine.listQaChanges(task.id) });
});
app.post("/api/tasks/:id/qa-changes/:cid/revert", (c) => {
    try {
        return c.json({ change: engine.revertQaChangeById(c.req.param("id"), c.req.param("cid")) });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.get("/api/tasks/:id/messages", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(engine.listMessages(task.id));
});

// `anchor` ties the question to one diff line (Code changes → tap a line → Ask); the reply carries the same anchor.
app.post("/api/tasks/:id/messages", async (c) => {
    const body = json(
        z.object({
            text: z.string().min(1),
            anchor: z
                .object({
                    path: z.string(),
                    side: z.enum(["new", "old"]),
                    line: z.number().int().nonnegative(),
                    snippet: z.string(),
                    prComment: z.object({ repo: z.string(), number: z.number().int().positive(), id: z.number().int().positive(), author: z.string(), url: z.string() }).optional(),
                })
                // A diff-line thread needs a file; a PR-comment thread may hang under a review verdict with no path.
                .refine((a) => !!a.prComment || a.path.length > 0, { message: "anchor.path is required for a diff-line thread" })
                .nullable()
                .optional(),
            files: z.array(SharedFileSchema).optional(),
        }),
        await c.req.json(),
    );
    try {
        return c.json(await engine.askAgent(c.req.param("id"), body.text, body.anchor ?? null, sharedFilesOf(c.req.param("id"), body.files)));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Chat → Do: the agent carries the text out in the task's session/worktree; the report lands in Chat when it finishes.
app.post("/api/tasks/:id/instructions", async (c) => {
    const body = json(z.object({ text: z.string().min(1), files: z.array(SharedFileSchema).optional() }), await c.req.json());
    try {
        return c.json(await engine.instruct(c.req.param("id"), body.text, sharedFilesOf(c.req.param("id"), body.files)));
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

// The task's BE/FE and optional components, and — first, since the BE needs it — the env's shared dependency (kind
// "dependency", listed even while stopped so it can be started from here).
const taskServices = async (task: TaskRow) => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow | undefined;
    const dep = env ? await services.dependencyStatus(env, task.id) : null;
    return [...(dep ? [dep] : []), ...(await services.status(task.id))];
};

app.get("/api/tasks/:id/services", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(await taskServices(task));
});

// "be", "fe", "dependency" (the env's shared dependency, when one is configured) or the key of one of the task env's
// optional components (a worker, a scheduler) — the agents start those on demand through these same routes.
const serviceKindOf = (task: TaskRow, kind: string): { kind: string; env: EnvRow } | { error: string } => {
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow;
    if (kind === "be" || kind === "fe" || componentsOf(env).some((c) => c.key === kind)) return { kind, env };
    if (kind === DEPENDENCY_KIND && env.depends_on_env_id) return { kind, env };
    const keys = [...(env.depends_on_env_id ? [DEPENDENCY_KIND] : []), ...componentsOf(env).map((c) => c.key)];
    return { error: `kind must be be, fe or one of this env's optional components (${keys.join(", ") || "none defined"})` };
};

app.post("/api/tasks/:id/services/:kind/start", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const k = serviceKindOf(task, c.req.param("kind"));
    if ("error" in k) return c.json({ error: k.error }, 400);
    try {
        if (k.kind === DEPENDENCY_KIND) return c.json(await services.startDependency(k.env, task.id));
        const row = await services.start(task, k.env, k.kind);
        // Started by the human: the resource policy leaves it alone until they stop it or the task is cleaned up.
        resources.pin(`service:${row.id}`, true);
        return c.json(row);
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.post("/api/tasks/:id/services/:kind/stop", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const k = serviceKindOf(task, c.req.param("kind"));
    if ("error" in k) return c.json({ error: k.error }, 400);
    if (k.kind === DEPENDENCY_KIND) await services.stopDependency(k.env);
    else await services.stop(task.id, k.kind);
    return c.json(await taskServices(task));
});

// A failed BE/FE start handed to the task's agent; resolves once the run has started, the outcome (and the automatic
// restart's result) lands in Chat.
app.post("/api/tasks/:id/services/:kind/fix", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "be" && kind !== "fe") return c.json({ error: "kind must be be|fe" }, 400);
    try {
        await engine.fixService(c.req.param("id"), kind);
        return c.json({ started: true });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.get("/api/tasks/:id/services/:kind/log", (c) => {
    const kind = c.req.param("kind");
    if (kind !== "be" && kind !== "fe" && !COMPONENT_KEY.test(kind)) return c.json({ error: "kind must be be, fe or a component key" }, 400);
    let path = join(engine.taskDir(c.req.param("id")), "logs", `${kind}.log`);
    if (kind === DEPENDENCY_KIND) {
        // The shared dependency's log lives with its env, not with the task.
        const task = engine.getTask(c.req.param("id"));
        const env = task ? (db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow | undefined) : undefined;
        const depPath = env ? services.dependencyLogPath(env) : null;
        if (!depPath) return c.json({ error: "this env has no dependency configured" }, 400);
        path = depPath;
    }
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

// ---------- free-form claude sessions (Sessions page) ----------

app.get("/api/sessions", async (c) => c.json(await sessions.list()));

app.post("/api/sessions", async (c) => {
    const body = json(
        z.object({
            envId: z.string().min(1),
            accountId: z.string().nullable().optional(),
            model: z.string().nullable().optional(),
            name: z.string().optional(),
            // A branch name → the session gets its own worktree (created from the env's base branch, setup command run in the pane).
            branch: z.string().nullable().optional(),
        }),
        await c.req.json(),
    );
    try {
        return c.json(await sessions.create(body));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.post("/api/sessions/:id/open", async (c) => {
    try {
        return c.json(await sessions.open(c.req.param("id")));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.post("/api/sessions/:id/close", async (c) => {
    await sessions.close(c.req.param("id"));
    return c.json(await sessions.list());
});

app.patch("/api/sessions/:id", async (c) => {
    const body = json(z.object({ name: z.string().min(1) }), await c.req.json());
    return c.json(sessions.rename(c.req.param("id"), body.name));
});

// ?worktree=remove also removes the session's worktree and local branch (refused while it holds unpushed work unless ?force=1).
app.delete("/api/sessions/:id", async (c) => {
    try {
        await sessions.remove(c.req.param("id"), c.req.query("worktree") === "remove", c.req.query("force") === "1");
        return c.json({ deleted: c.req.param("id") });
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// Same shape as the task diff: ?commits=… / ?scope=uncommitted narrow it; a session in the env's main checkout (no
// worktree of its own) only ever shows what is uncommitted there.
app.get("/api/sessions/:id/diff", async (c) => {
    const shas = (c.req.query("commits") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f]{7,40}$/i.test(s));
    try {
        return c.json(await sessions.diff(c.req.param("id"), c.req.query("scope") === "uncommitted" ? { uncommitted: true } : shas.length ? { shas } : null, c.req.query("file") ?? null));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

app.get("/api/sessions/:id/commits", async (c) => {
    try {
        return c.json(await sessions.commits(c.req.param("id")));
    } catch (e) {
        return c.json({ error: String((e as Error).message ?? e) }, 400);
    }
});

// ---------- product: the global product context and the Product Owners ----------

const poErr = (c: { json: (b: unknown, s?: number) => Response }, e: unknown) => c.json({ error: String((e as Error).message ?? e).slice(0, 400) }, 400);

// The product context of one environment (?env=<envId>).
app.get("/api/product/context", (c) => {
    const env = c.req.query("env");
    if (!env) return c.json({ error: "env is required" }, 400);
    return c.json({ text: productOwners.productContext(env) });
});
app.put("/api/product/context", async (c) => {
    const body = json(z.object({ env: z.string(), text: z.string() }), await c.req.json());
    await productOwners.setProductContext(body.env, body.text);
    return c.json({ text: productOwners.productContext(body.env) });
});
// Search Stagehand's palace: one PO's wing (`wing`), or all of it.
app.get("/api/product/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ results: [] });
    try {
        // ?env= searches that environment's memory (its product wing and its POs' wings); ?wing= one wing.
        const env = c.req.query("env");
        const opts = { limit: Number(c.req.query("limit") ?? 10) };
        return c.json({ results: env ? await palace.search(q, { ...opts, wings: productOwners.envWings(env) }) : await palace.search(q, { ...opts, wing: c.req.query("wing") || undefined }) });
    } catch (e) {
        return poErr(c, e);
    }
});
app.get("/api/product/palace", async (c) => {
    try {
        return c.json({ home: palace.home, ...(await palace.status()) });
    } catch (e) {
        return poErr(c, e);
    }
});

app.get("/api/product-owners", (c) =>
    c.json(
        productOwners.list().map((po) => {
            // Progress by the issues' own statuses: done ÷ all, canceled ones counted in neither.
            const issues = productOwners.issues(po.id);
            const canceled = issues.filter((i) => /cancel|duplicate|won.?t/i.test(i.status ?? "")).length;
            const done = issues.filter((i) => /done|complete|closed|merged|released|shipped|resolved/i.test(i.status ?? "")).length;
            const counted = issues.length - canceled;
            return {
                ...po,
                tasks: (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE product_owner_id = ?`).get(po.id) as { n: number }).n,
                created: productOwners.links(po.id).length,
                tickets: issues.length,
                ticketsDone: done,
                progress: counted > 0 ? Math.round((done / counted) * 100) : null,
            };
        }),
    ),
);
app.post("/api/product-owners", async (c) => {
    const body = json(z.object({ url: z.string().min(8), envId: z.string(), accountId: z.string().nullable().optional(), start: z.boolean().optional() }), await c.req.json());
    try {
        return c.json(await productOwners.create(body.url, body.envId, body.accountId ?? null, { start: body.start ?? true }));
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/start", (c) => {
    try {
        productOwners.start(c.req.param("id"));
        return c.json({ ok: true });
    } catch (e) {
        return poErr(c, e);
    }
});
app.get("/api/product-owners/:id", (c) => {
    const d = productOwners.detail(c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    const tasks = db.prepare(`SELECT id, ticket_id, title, stage, status, env_id FROM tasks WHERE product_owner_id = ? ORDER BY updated_at DESC`).all(c.req.param("id"));
    return c.json({ ...d, tasks });
});
app.delete("/api/product-owners/:id", async (c) => {
    await productOwners.remove(c.req.param("id"));
    return c.json({ ok: true });
});
// A chat turn runs in the background; the page follows it over the websocket ("po" events).
app.post("/api/product-owners/:id/messages", async (c) => {
    const body = json(z.object({ text: z.string().min(1) }), await c.req.json());
    const po = productOwners.get(c.req.param("id"));
    if (!po) return c.json({ error: "not found" }, 404);
    try {
        const turn = productOwners.send(po.id, body.text);
        turn.catch((e: unknown) => console.warn(`[po] ${po.slug}: ${String((e as Error).message ?? e).slice(0, 200)}`));
        await Promise.race([turn, new Promise((r) => setTimeout(r, 50))]);
        return c.json({ started: true });
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/stop", (c) => {
    productOwners.stop(c.req.param("id"));
    return c.json({ ok: true });
});
app.put("/api/product-owners/:id/context", async (c) => {
    const body = json(z.object({ text: z.string() }), await c.req.json());
    try {
        await productOwners.setContext(c.req.param("id"), body.text);
        return c.json({ ok: true });
    } catch (e) {
        return poErr(c, e);
    }
});
// The human edits tickets inline on the Tickets page: the whole list, validated like the agent's.
app.put("/api/product-owners/:id/tickets", async (c) => {
    const po = productOwners.get(c.req.param("id"));
    if (!po) return c.json({ error: "not found" }, 404);
    const parsed = PoTickets.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    writeFileSync(join(productOwners.dir(po.id), "tickets.json"), JSON.stringify(parsed.data, null, 2));
    engine.emit("po", { poId: po.id, kind: "updated" });
    return c.json({ ok: true });
});
app.post("/api/product-owners/:id/artifacts/fetch", async (c) => {
    const body = json(z.object({ url: z.string().min(8) }), await c.req.json());
    try {
        return c.json(await productOwners.fetchArtifact(c.req.param("id"), body.url));
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/artifacts/text", async (c) => {
    const body = json(z.object({ title: z.string().max(200).default(""), text: z.string().min(1).max(2_000_000), tell: z.boolean().default(true) }), await c.req.json());
    try {
        return c.json(productOwners.pasteArtifact(c.req.param("id"), body.title ?? "", body.text, body.tell ?? true));
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/artifacts", async (c) => {
    const body = await c.req.parseBody();
    const f = body["file"];
    if (!(f instanceof File)) return c.json({ error: "send one file in the `file` field (multipart/form-data)" }, 400);
    if (f.size === 0 || f.size > MAX_SHARED_FILE_BYTES) return c.json({ error: `${f.name}: empty or over 200 MB` }, 400);
    try {
        return c.json(productOwners.uploadArtifact(c.req.param("id"), f.name, Buffer.from(await f.arrayBuffer()), f.type && f.type !== "application/octet-stream" ? f.type : mimeOf(f.name)));
    } catch (e) {
        return poErr(c, e);
    }
});
app.delete("/api/product-owners/:id/artifacts/:aid", (c) => {
    productOwners.removeArtifact(c.req.param("id"), c.req.param("aid"));
    return c.json({ ok: true });
});
app.get("/api/product-owners/:id/files/*", (c) => {
    const rel = c.req.path.replace(/^\/api\/product-owners\/[^/]+\/files\//, "");
    if (!rel || rel.includes("..")) return c.json({ error: "bad path" }, 400);
    const p = join(productOwners.dir(c.req.param("id")), decodeURIComponent(rel));
    if (!existsSync(p)) return c.json({ error: "not found" }, 404);
    return new Response(readFileSync(p), { headers: { "content-type": mimeOf(p) ?? "application/octet-stream" } });
});
app.get("/api/product-owners/:id/revisions/:name", (c) => {
    try {
        return c.json({ text: productOwners.revision(c.req.param("id"), c.req.param("name")) });
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/approve-design", async (c) => {
    try {
        await productOwners.approveDesign(c.req.param("id"));
        return c.json({ ok: true });
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/approve-tickets", async (c) => {
    try {
        return c.json(await productOwners.approveTickets(c.req.param("id")));
    } catch (e) {
        return poErr(c, e);
    }
});
// Read the project's issues again now (the timer does it every hour) and brief the PO on what changed.
app.post("/api/product-owners/:id/refresh-issues", async (c) => {
    try {
        return c.json(await productOwners.refreshIssues(c.req.param("id")));
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/phase", async (c) => {
    const body = json(z.object({ phase: z.enum(["context", "design", "tickets", "approved", "live"]) }), await c.req.json());
    productOwners.setPhase(c.req.param("id"), body.phase);
    return c.json({ ok: true });
});
app.post("/api/product-owners/:id/proposal/accept", async (c) => {
    try {
        await productOwners.acceptProposal(c.req.param("id"));
        return c.json({ ok: true });
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/product-owners/:id/proposal/reject", (c) => {
    productOwners.rejectProposal(c.req.param("id"));
    return c.json({ ok: true });
});

// ---------- a task's Product Owner review (Design proposal → Product owner review) ----------

const poReviewOf = (taskId: string) => {
    const dir = engine.taskDir(taskId);
    const st = readReviewState(dir);
    const review = readReview(dir);
    // A review from before the structured format: its markdown, read-only.
    const legacy = !review && existsSync(join(dir, "po-review.md")) ? readFileSync(join(dir, "po-review.md"), "utf8") : null;
    return { running: productOwners.reviewing(taskId), status: st.status ?? null, error: st.error ?? null, at: st.at ?? null, asking: st.asking ?? null, review, text: legacy };
};
app.get("/api/tasks/:id/po-review", (c) => (engine.getTask(c.req.param("id")) ? c.json(poReviewOf(c.req.param("id"))) : c.json({ error: "not found" }, 404)));
// The PO's brief on the ticket (written before research): read it, or have the PO write it again.
const poBriefOf = (taskId: string) => {
    const dir = engine.taskDir(taskId);
    const read = (f: string): string | null => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
    let state: { status?: string; error?: string; at?: string } = {};
    try {
        state = JSON.parse(read("po-brief.json") ?? "{}") as typeof state;
    } catch {
        /* no state yet */
    }
    return { running: productOwners.briefing(taskId), status: state.status ?? null, error: state.error ?? null, at: state.at ?? null, text: read("po-brief.md") };
};
app.get("/api/tasks/:id/po-brief", (c) => (engine.getTask(c.req.param("id")) ? c.json(poBriefOf(c.req.param("id"))) : c.json({ error: "not found" }, 404)));
app.post("/api/tasks/:id/po-brief", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    if (!task.product_owner_id) return c.json({ error: "this task has no Product Owner" }, 400);
    if (productOwners.briefing(task.id)) return c.json({ error: "the Product Owner is already writing this brief" }, 409);
    void productOwners.briefTask(task, engine.taskDir(task.id), () => engine.touchTask(task.id)).catch((e: unknown) => console.warn(`[po] brief ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`));
    return c.json({ ...poBriefOf(task.id), running: true });
});
app.post("/api/tasks/:id/po-review", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    try {
        await productOwners.reviewTask(task, engine.taskDir(task.id), () => engine.touchTask(task.id));
        return c.json(poReviewOf(task.id));
    } catch (e) {
        return poErr(c, e);
    }
});
// Pick or skip one comment for the next design round.
app.patch("/api/tasks/:id/po-review/comments/:cid", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const body = json(z.object({ include: z.boolean() }), await c.req.json());
    const dir = engine.taskDir(task.id);
    const review = readReview(dir);
    const cm = review?.comments.find((x) => x.id === c.req.param("cid"));
    if (!review || !cm) return c.json({ error: "no such review comment" }, 404);
    cm.include = body.include;
    writeFileSync(join(dir, "po-review.json"), JSON.stringify(review, null, 2));
    engine.touchTask(task.id);
    return c.json(poReviewOf(task.id));
});
// Discuss one comment with the PO; the answer lands in the comment's thread.
app.post("/api/tasks/:id/po-review/comments/:cid/ask", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const body = json(z.object({ text: z.string().trim().min(1).max(8000) }), await c.req.json());
    try {
        await productOwners.askReviewComment(task, engine.taskDir(task.id), c.req.param("cid"), body.text, () => engine.touchTask(task.id));
        return c.json(poReviewOf(task.id));
    } catch (e) {
        return poErr(c, e);
    }
});
app.post("/api/tasks/:id/po-review/send", (c) => {
    const task = engine.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const dir = engine.taskDir(task.id);
    const review = readReview(dir);
    if (!review) return c.json({ error: "there is no Product Owner review to send" }, 400);
    if (task.stage !== "design_proposal" || task.status !== "waiting_user") return c.json({ error: "the design proposal is not waiting for review" }, 400);
    if (!review.comments.some((x) => x.include && !x.withdrawn)) return c.json({ error: "pick at least one comment for the next round" }, 400);
    const po = task.product_owner_id ? productOwners.get(task.product_owner_id) : undefined;
    const notes = reviewNotes(review, po?.title ?? null);
    const at = new Date().toISOString();
    for (const x of review.comments) if (x.include && !x.withdrawn) x.sentAt = at;
    writeFileSync(join(dir, "po-review.json"), JSON.stringify(review, null, 2));
    engine.review(task.id, { verdict: "changes", notes });
    return c.json(engine.getTask(task.id));
});

// ---------- websockets ----------

app.get(
    "/ws/events",
    upgradeWebSocket(() => {
        const listeners: Array<[string, (...args: unknown[]) => void]> = [];
        return {
            onOpen(_evt, ws) {
                for (const kind of ["task", "activity", "rate_limit", "account", "message", "prompter", "po"]) {
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
if (PREVIEW) {
    // scripts/preview.sh: a second instance from a worktree branch — API + UI for testing, nothing that acts on its own.
    console.log("[stagehand] PREVIEW instance: no scheduler, no pollers, no public listener, no runs started");
} else {
    startPublicListener();
    engine.startScheduler();
    prompter.startReaper();
    void resumeTokenSetups();
}

process.on("SIGINT", () => {
    engine.stopScheduler();
    process.exit(0);
});
