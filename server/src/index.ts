import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig, saveConfig } from "./config.js";

const MODEL_OPTIONS = [
    { value: "", label: "Account default" },
    { value: "fable", label: "Fable 5.1 (claude-fable-5-1)" },
    { value: "opus", label: "Opus 5 (claude-opus-5)" },
    { value: "sonnet", label: "Sonnet 5 (claude-sonnet-5)" },
];
import { now, openDb, STAGES, type AccountRow, type EnvRow, type Stage } from "./db.js";
import { Engine } from "./engine.js";
import { Services } from "./services.js";
import { loginCommand, probeChrome, readAuthStatus, scaffoldAccountDir } from "./claude/accounts.js";
import { isGitRepo, repoPaths } from "./git.js";
import { attach, ensureSession, killSession, loginSessionName, sessionExists, taskSessionName } from "./tmux.js";

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const services = new Services(db, cfg);
const engine = new Engine(db, cfg, services);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
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

const refreshAccount = async (acc: AccountRow, probe: boolean): Promise<AccountRow> => {
    const status = await readAuthStatus(acc.config_dir);
    db.prepare(`UPDATE accounts SET logged_in = ?, email = ?, org = ?, plan = ? WHERE id = ?`).run(
        status.loggedIn ? 1 : 0,
        status.email ?? null,
        status.orgName ?? null,
        status.subscriptionType ?? null,
        acc.id,
    );
    if (probe && status.loggedIn) {
        const capable = await probeChrome(acc.config_dir, cfg.dataDir);
        db.prepare(`UPDATE accounts SET chrome_capable = ? WHERE id = ?`).run(capable ? 1 : 0, acc.id);
    }
    return accountById(acc.id)!;
};

app.get("/api/accounts", (c) => {
    const limits = db.prepare(`SELECT * FROM rate_limits`).all() as Array<{ account_id: string; window: string; utilization: number; resets_at: number }>;
    return c.json(
        accountsAll().map((a) => ({
            ...a,
            limits: limits.filter((l) => l.account_id === a.id).map(({ window, utilization, resets_at }) => ({ window, utilization, resetsAt: resets_at })),
        })),
    );
});

app.post("/api/accounts", async (c) => {
    const body = json(
        z.object({
            name: z.string().regex(/^[a-z0-9-]+$/),
            email: z.string().email().optional(),
            configDir: z.string().optional(),
            adopt: z.boolean().default(false),
        }),
        await c.req.json(),
    );
    const dir = body.configDir ?? scaffoldAccountDir(cfg, body.name);
    const id = randomUUID();
    db.prepare(`INSERT INTO accounts (id, name, config_dir, created_at) VALUES (?, ?, ?, ?)`).run(id, body.name, dir, now());
    if (body.adopt) return c.json({ account: await refreshAccount(accountById(id)!, c.req.query("probe") === "1"), terminal: null });
    const tmuxName = loginSessionName(body.name);
    const cmd = `${loginCommand(dir, body.email).replace(/^CLAUDE_CONFIG_DIR=\S+ /, "")}; echo; echo 'Login finished — you can close this terminal.'; sleep 600`;
    await ensureSession(tmuxName, cfg.dataDir, cmd, { CLAUDE_CONFIG_DIR: dir });
    return c.json({ account: accountById(id), terminal: tmuxName });
});

app.post("/api/accounts/:id/refresh", async (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const probe = c.req.query("probe") === "1";
    return c.json(await refreshAccount(acc, probe));
});

app.post("/api/accounts/:id/login", async (c) => {
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    const tmuxName = loginSessionName(acc.name);
    const cmd = `claude auth login --claudeai${acc.email ? ` --email ${JSON.stringify(acc.email)}` : ""}; echo; echo 'Login finished — you can close this terminal.'; sleep 600`;
    await ensureSession(tmuxName, cfg.dataDir, cmd, { CLAUDE_CONFIG_DIR: acc.config_dir });
    return c.json({ terminal: tmuxName });
});

app.patch("/api/accounts/:id", async (c) => {
    const body = json(z.object({ failover_enabled: z.boolean().optional(), failover_threshold: z.number().min(0).max(1).optional() }), await c.req.json());
    const acc = accountById(c.req.param("id"));
    if (!acc) return c.json({ error: "not found" }, 404);
    db.prepare(`UPDATE accounts SET failover_enabled = ?, failover_threshold = ? WHERE id = ?`).run(
        body.failover_enabled === undefined ? acc.failover_enabled : body.failover_enabled ? 1 : 0,
        body.failover_threshold ?? acc.failover_threshold,
        acc.id,
    );
    return c.json(accountById(acc.id));
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

app.post("/api/envs", async (c) => {
    const body = json(
        z.object({
            name: z.string().min(1),
            path: z.string().min(1),
            baseBranch: z.string().default("main"),
            defaultAccountId: z.string().optional(),
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
        }),
        await c.req.json(),
    );
    const repos = body.repos && body.repos.length ? JSON.stringify(body.repos) : null;
    const bad = await badCheckouts({ path: body.path, base_branch: body.baseBranch ?? "main", repos });
    if (bad) return c.json({ error: bad }, 400);
    const id = randomUUID();
    db.prepare(
        `INSERT INTO envs (id, name, path, base_branch, default_account_id, app_url, qa_script, be_command, fe_command, be_url_template, fe_url_template, be_port, fe_port, setup_command, repos, branch_prefix, ticket_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        body.name,
        body.path,
        body.baseBranch,
        body.defaultAccountId ?? null,
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
        now(),
    );
    return c.json(db.prepare(`SELECT * FROM envs WHERE id = ?`).get(id));
});

app.patch("/api/envs/:id", async (c) => {
    const body = json(
        z.object({
            name: z.string().min(1).optional(),
            defaultAccountId: z.string().nullable().optional(),
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
        }),
        await c.req.json(),
    );
    const env = db.prepare(`SELECT * FROM envs WHERE id = ?`).get(c.req.param("id")) as EnvRow | undefined;
    if (!env) return c.json({ error: "not found" }, 404);
    const pick = <T,>(next: T | undefined, cur: T): T => (next === undefined ? cur : next);
    const repos = body.repos === undefined ? env.repos : body.repos && body.repos.length ? JSON.stringify(body.repos) : null;
    if (repos !== env.repos) {
        const bad = await badCheckouts({ path: env.path, base_branch: env.base_branch, repos });
        if (bad) return c.json({ error: bad }, 400);
    }
    db.prepare(
        `UPDATE envs SET name = ?, default_account_id = ?, base_branch = ?, app_url = ?, qa_script = ?, be_command = ?, fe_command = ?, be_url_template = ?, fe_url_template = ?, be_port = ?, fe_port = ?, setup_command = ?, repos = ?, branch_prefix = ?, ticket_source = ? WHERE id = ?`,
    ).run(
        body.name ?? env.name,
        pick(body.defaultAccountId, env.default_account_id),
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
        env.id,
    );
    return c.json(db.prepare(`SELECT * FROM envs WHERE id = ?`).get(env.id));
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
        z.object({ verdict: z.enum(["approve", "changes"]), routeTo: z.enum(["implementation", "design_proposal"]).optional(), notes: z.string().optional() }),
        await c.req.json(),
    );
    engine.review(c.req.param("id"), body);
    return c.json(engine.getTask(c.req.param("id")));
});

app.post("/api/tasks/:id/stop", (c) => {
    engine.stop(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
});

app.post("/api/tasks/:id/retry", (c) => {
    engine.retry(c.req.param("id"));
    return c.json(engine.getTask(c.req.param("id")));
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
    const acc = task.account_id ? accountById(task.account_id) : accountsAll().find((a) => a.logged_in);
    if (!acc) return c.json({ error: "no logged-in account" }, 400);
    const env = db.prepare(`SELECT path FROM envs WHERE id = ?`).get(task.env_id) as { path: string };
    const name = taskSessionName(task.ticket_id);
    await ensureSession(
        name,
        task.worktree_path ?? env.path,
        `claude --resume ${task.session_id}; echo; echo '[stagehand] claude exited — press Enter to close'; read -r`,
        { CLAUDE_CONFIG_DIR: acc.config_dir },
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
                for (const kind of ["task", "activity", "rate_limit"]) {
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

app.get("/api/health", (c) => c.json({ ok: true, config: { ...cfg, dataDir: cfg.dataDir } }));

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    console.log(`stagehand server on http://localhost:${info.port}`);
});
injectWebSocket(server);
engine.startScheduler();

process.on("SIGINT", () => {
    engine.stopScheduler();
    process.exit(0);
});
