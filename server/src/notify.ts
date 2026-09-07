import { execFile } from "node:child_process";
import type { Config } from "./config.js";

// Pushes a human-needed event to the desktop (macOS notification centre) and, when a topic is configured, to the phone
// through ntfy (https://ntfy.sh — the app subscribes to a private topic; the server just POSTs to it). Never throws.

export interface Notice {
    title: string;
    message: string;
    url?: string;
    priority?: "low" | "default" | "high";
    tags?: string[];
}

const NTFY_PRIORITY: Record<NonNullable<Notice["priority"]>, string> = { low: "2", default: "3", high: "4" };

const macos = (n: Notice): Promise<void> =>
    new Promise((resolve) => {
        const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        execFile("osascript", ["-e", `display notification "${esc(n.message.slice(0, 200))}" with title "${esc(n.title.slice(0, 80))}" subtitle "Stagehand"`], () => resolve());
    });

const ntfy = async (cfg: Config, n: Notice): Promise<void> => {
    const { ntfyServer, ntfyTopic, ntfyToken } = cfg.notifications;
    if (!ntfyTopic) return;
    const headers: Record<string, string> = {
        Title: n.title.slice(0, 120),
        Priority: NTFY_PRIORITY[n.priority ?? "default"],
        Tags: (n.tags ?? ["clapper"]).join(","),
    };
    if (n.url) headers["Click"] = n.url;
    if (ntfyToken) headers["Authorization"] = `Bearer ${ntfyToken}`;
    const res = await fetch(`${ntfyServer.replace(/\/+$/, "")}/${encodeURIComponent(ntfyTopic)}`, { method: "POST", headers, body: n.message.slice(0, 1500) });
    if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 120)}`);
};

export const notify = async (cfg: Config, n: Notice): Promise<{ macos: boolean; ntfy: boolean | null; error?: string }> => {
    const out: { macos: boolean; ntfy: boolean | null; error?: string } = { macos: false, ntfy: cfg.notifications.ntfyTopic ? false : null };
    if (cfg.notifications.macos && process.platform === "darwin") {
        await macos(n);
        out.macos = true;
    }
    if (cfg.notifications.ntfyTopic) {
        try {
            await ntfy(cfg, n);
            out.ntfy = true;
        } catch (e) {
            out.error = String((e as Error).message ?? e);
            console.warn(`[stagehand] ntfy push failed: ${out.error}`);
        }
    }
    return out;
};

// Where a push should take the human: the public UI when configured, else nothing (desktop notifications have no link anyway).
export const taskLink = (cfg: Config, taskId: string): string | undefined => {
    const base = cfg.notifications.baseUrl?.replace(/\/+$/, "");
    return base ? `${base}/#/tasks/${taskId}/work` : undefined;
};
