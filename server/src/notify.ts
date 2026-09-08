import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Config } from "./config.js";

// Pushes a human-needed event to the desktop (macOS notification centre) and, when a topic is configured, to the phone
// through ntfy (https://ntfy.sh — the app subscribes to a private topic; the server just POSTs to it). Never throws.

export interface Notice {
    title: string;
    message: string;
    // Where a tap on the phone push goes (public UI) and where a click on the desktop notification goes (local UI).
    url?: string;
    localUrl?: string;
    // Notifications with the same group replace each other in Notification Centre (one per task).
    group?: string;
    priority?: "low" | "default" | "high";
    tags?: string[];
}

const NTFY_PRIORITY: Record<NonNullable<Notice["priority"]>, string> = { low: "2", default: "3", high: "4" };

// `display notification` from osascript has no click action (a click opens Script Editor / a Finder window), so the
// desktop path uses terminal-notifier when it is installed: its -open makes the click land on the task in the browser.
const TERMINAL_NOTIFIER = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find(existsSync) ?? null;
export const desktopNotifier = (): string => (TERMINAL_NOTIFIER ? "terminal-notifier (click opens the task)" : "osascript (no click action — brew install terminal-notifier)");

const macos = (n: Notice): Promise<void> =>
    new Promise((resolve) => {
        if (TERMINAL_NOTIFIER) {
            const args = ["-title", "Stagehand", "-subtitle", n.title.slice(0, 80), "-message", n.message.slice(0, 200), "-sound", "default"];
            if (n.group) args.push("-group", n.group);
            const target = n.localUrl ?? n.url;
            if (target) args.push("-open", target);
            execFile(TERMINAL_NOTIFIER, args, () => resolve());
            return;
        }
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

// Where a push should take the human: the phone goes to the public UI when configured; the desktop click goes to the local UI.
export const taskLink = (cfg: Config, taskId: string): string | undefined => {
    const base = cfg.notifications.baseUrl?.replace(/\/+$/, "");
    return base ? `${base}/#/tasks/${taskId}/work` : undefined;
};
export const localTaskLink = (cfg: Config, taskId: string): string => `${cfg.notifications.localBaseUrl.replace(/\/+$/, "")}/#/tasks/${taskId}/work`;
