import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { EventEmitter } from "node:events";
import { z } from "zod";

export interface RunSpec {
    prompt: string;
    cwd: string;
    configDir: string;
    sessionId?: string;
    resume?: string;
    name?: string;
    chrome?: boolean;
    maxTurns?: number;
    model?: string;
    addDirs?: string[];
    allowedTools?: string[];
    appendSystemPrompt?: string;
    eventLogPath?: string;
}

export const RateLimitInfo = z.object({
    status: z.string(),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
    unifiedWindows: z
        .record(z.object({ utilization: z.number(), resetsAt: z.number() }))
        .optional(),
});
export type RateLimitInfo = z.infer<typeof RateLimitInfo>;

export const ResultEvent = z.object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    session_id: z.string(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
});
export type ResultEvent = z.infer<typeof ResultEvent>;

export interface ActivityEvent {
    kind: "init" | "text" | "tool_use" | "tool_result" | "rate_limit" | "hook" | "other";
    summary: string;
    raw: unknown;
}

export interface RunOutcome {
    result: ResultEvent | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    lastRateLimit: RateLimitInfo | null;
}

export interface ClaudeRun extends EventEmitter {
    pid: number | undefined;
    done: Promise<RunOutcome>;
    kill(): void;
}

const summarize = (ev: Record<string, unknown>): ActivityEvent => {
    const type = ev["type"];
    if (type === "system" && ev["subtype"] === "init") {
        return { kind: "init", summary: `session ${String(ev["session_id"])} · ${String(ev["model"])}`, raw: ev };
    }
    if (type === "system") return { kind: "hook", summary: String(ev["subtype"] ?? "system"), raw: ev };
    if (type === "rate_limit_event") {
        const info = ev["rate_limit_info"] as Record<string, unknown> | undefined;
        return { kind: "rate_limit", summary: `rate limit ${String(info?.["status"])}`, raw: ev };
    }
    if (type === "assistant" || type === "user") {
        const msg = ev["message"] as { content?: Array<Record<string, unknown>> } | undefined;
        const block = msg?.content?.[0];
        if (!block) return { kind: "other", summary: String(type), raw: ev };
        if (block["type"] === "tool_use") {
            const input = block["input"] as Record<string, unknown> | undefined;
            const hint =
                (input?.["command"] as string | undefined) ??
                (input?.["file_path"] as string | undefined) ??
                (input?.["description"] as string | undefined) ??
                "";
            return { kind: "tool_use", summary: `${String(block["name"])} ${hint}`.trim().slice(0, 160), raw: ev };
        }
        if (block["type"] === "tool_result") {
            const content = block["content"];
            const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
            return { kind: "tool_result", summary: text.split("\n")[0]?.slice(0, 160) ?? "", raw: ev };
        }
        if (block["type"] === "text") {
            return { kind: "text", summary: String(block["text"] ?? "").split("\n")[0]?.slice(0, 160) ?? "", raw: ev };
        }
    }
    return { kind: "other", summary: String(type), raw: ev };
};

export const buildArgs = (spec: RunSpec): string[] => {
    const args = ["-p", spec.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto"];
    if (spec.resume) args.push("--resume", spec.resume);
    else if (spec.sessionId) args.push("--session-id", spec.sessionId);
    if (spec.name && !spec.resume) args.push("--name", spec.name);
    if (spec.chrome) args.push("--chrome");
    else args.push("--no-chrome");
    if (spec.maxTurns) args.push("--max-turns", String(spec.maxTurns));
    if (spec.model) args.push("--model", spec.model);
    for (const d of spec.addDirs ?? []) args.push("--add-dir", d);
    if (spec.allowedTools?.length) args.push("--allowedTools", spec.allowedTools.join(","));
    if (spec.appendSystemPrompt) args.push("--append-system-prompt", spec.appendSystemPrompt);
    return args;
};

export const startClaude = (spec: RunSpec): ClaudeRun => {
    const emitter = new EventEmitter() as ClaudeRun;
    const child: ChildProcess = spawn("claude", buildArgs(spec), {
        cwd: spec.cwd,
        env: { ...process.env, CLAUDE_CONFIG_DIR: spec.configDir },
        stdio: ["ignore", "pipe", "pipe"],
    });
    emitter.pid = child.pid;
    const log = spec.eventLogPath ? createWriteStream(spec.eventLogPath, { flags: "a" }) : null;

    let result: ResultEvent | null = null;
    let lastRateLimit: RateLimitInfo | null = null;
    let stderr = "";
    let buffer = "";

    const handleLine = (line: string): void => {
        if (!line.trim()) return;
        log?.write(line + "\n");
        let ev: Record<string, unknown>;
        try {
            ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
            emitter.emit("activity", { kind: "other", summary: line.slice(0, 160), raw: line } satisfies ActivityEvent);
            return;
        }
        if (ev["type"] === "result") {
            const parsed = ResultEvent.safeParse(ev);
            if (parsed.success) result = parsed.data;
        }
        if (ev["type"] === "rate_limit_event") {
            const parsed = RateLimitInfo.safeParse(ev["rate_limit_info"]);
            if (parsed.success) {
                lastRateLimit = parsed.data;
                emitter.emit("rate_limit", parsed.data);
            }
        }
        emitter.emit("activity", summarize(ev));
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const l of lines) handleLine(l);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
    });

    emitter.done = new Promise<RunOutcome>((resolve) => {
        child.on("close", (code, signal) => {
            if (buffer) handleLine(buffer);
            log?.end();
            resolve({ result, exitCode: code, signal, stderr: stderr.slice(-4000), lastRateLimit });
        });
        child.on("error", (err) => {
            stderr += String(err);
            log?.end();
            resolve({ result: null, exitCode: null, signal: null, stderr: stderr.slice(-4000), lastRateLimit });
        });
    });

    emitter.kill = () => {
        if (!child.killed) child.kill("SIGTERM");
    };
    return emitter;
};
