// What the host is doing right now, read from the OS (macOS): memory, processes, listening ports, tmux sessions.
// resources.ts joins this with what Vortex meant to start. Everything here is a plain read; nothing is changed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const run = async (cmd: string, args: string[], timeout = 15_000): Promise<string> => {
    try {
        const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 });
        return stdout;
    } catch (e) {
        // lsof exits 1 when nothing matches; ps/tmux print nothing when empty. Whatever was printed is still usable.
        const out = (e as { stdout?: string }).stdout;
        return typeof out === "string" ? out : "";
    }
};

export interface HostMemory {
    totalMb: number;
    // Pages free + inactive + speculative: what the kernel can hand out without swapping.
    availableMb: number;
    // Pages active + wired: in use right now.
    usedMb: number;
    compressedMb: number;
    swapUsedMb: number;
    swapTotalMb: number;
}

const MB = 1024 * 1024;

// `vm_stat` lines look like "Pages free:                                   328066." — the page size is in the header.
export const parseVmStat = (text: string): { pageSize: number; pages: Record<string, number> } => {
    const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
    const pages: Record<string, number> = {};
    for (const line of text.split("\n")) {
        const m = /^"?([A-Za-z -]+?)"?:\s+(\d+)\.?$/.exec(line.trim());
        if (m) pages[m[1]!.toLowerCase()] = Number(m[2]);
    }
    return { pageSize, pages };
};

// `vm.swapusage: total = 49152,00M  used = 47549,94M  free = 1602,06M  (encrypted)` — the decimal separator follows the locale.
export const parseSwapUsage = (text: string): { totalMb: number; usedMb: number } => {
    const num = (s: string | undefined): number => Number((s ?? "0").replace(",", "."));
    return { totalMb: num(/total = ([\d.,]+)M/.exec(text)?.[1]), usedMb: num(/used = ([\d.,]+)M/.exec(text)?.[1]) };
};

export const hostMemory = async (): Promise<HostMemory> => {
    const [memsize, vm, swap] = await Promise.all([run("sysctl", ["-n", "hw.memsize"]), run("vm_stat", []), run("sysctl", ["-n", "vm.swapusage"])]);
    const { pageSize, pages } = parseVmStat(vm);
    const p = (k: string): number => ((pages[k] ?? 0) * pageSize) / MB;
    const s = parseSwapUsage(swap);
    return {
        totalMb: Math.round(Number(memsize) / MB),
        availableMb: Math.round(p("pages free") + p("pages inactive") + p("pages speculative")),
        usedMb: Math.round(p("pages active") + p("pages wired down")),
        compressedMb: Math.round(p("pages occupied by compressor")),
        swapUsedMb: Math.round(s.usedMb),
        swapTotalMb: Math.round(s.totalMb),
    };
};

export interface Proc {
    pid: number;
    ppid: number;
    rssMb: number;
    cpu: number;
    // Seconds since the process started (ps etime).
    ageS: number;
    args: string;
}

// ps etime: [[dd-]hh:]mm:ss
export const parseEtime = (s: string): number => {
    const [days, rest] = s.includes("-") ? s.split("-") : ["0", s];
    const parts = rest!.split(":").map(Number);
    const [h, m, sec] = parts.length === 3 ? parts : [0, ...parts];
    return Number(days) * 86400 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (sec ?? 0);
};

export const parsePs = (text: string): Proc[] => {
    const out: Proc[] = [];
    for (const line of text.split("\n").slice(1)) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m) continue;
        out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssMb: Math.round(Number(m[3]) / 1024), cpu: Number(m[4]!.replace(",", ".")), ageS: parseEtime(m[5]!), args: m[6]!.trim() });
    }
    return out;
};

export const processTable = async (): Promise<Proc[]> => parsePs(await run("ps", ["-Ao", "pid,ppid,rss,pcpu,etime,args"]));

// The process and every descendant of it (a tmux pane's shell, its npm, its next-server, its workers …).
export const subtree = (root: number, table: Proc[]): Proc[] => {
    const byParent = new Map<number, Proc[]>();
    for (const p of table) {
        const l = byParent.get(p.ppid) ?? [];
        l.push(p);
        byParent.set(p.ppid, l);
    }
    const out: Proc[] = [];
    const self = table.find((p) => p.pid === root);
    if (self) out.push(self);
    const queue = [root];
    const seen = new Set<number>([root]);
    while (queue.length) {
        const pid = queue.shift()!;
        for (const c of byParent.get(pid) ?? []) {
            if (seen.has(c.pid)) continue;
            seen.add(c.pid);
            out.push(c);
            queue.push(c.pid);
        }
    }
    return out;
};

export interface Listener {
    pid: number;
    port: number;
}

// `lsof -Fpn` prints one field per line: p<pid>, then n<addr>:<port> lines for that pid.
export const parseLsof = (text: string): Listener[] => {
    const out: Listener[] = [];
    let pid = 0;
    for (const line of text.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n")) {
            const port = Number(/:(\d+)$/.exec(line.trim())?.[1] ?? 0);
            if (pid && port && !out.some((l) => l.pid === pid && l.port === port)) out.push({ pid, port });
        }
    }
    return out;
};

export const listeners = async (): Promise<Listener[]> => parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));

export interface TmuxSession {
    name: string;
    createdAt: number;
    // Last output or input in any pane (epoch seconds).
    activityAt: number;
    attached: boolean;
    panePids: number[];
}

export const parseTmux = (sessions: string, panes: string): TmuxSession[] => {
    const byName = new Map<string, TmuxSession>();
    for (const line of sessions.split("\n")) {
        const [name, created, activity, attached] = line.split("\t");
        if (!name) continue;
        byName.set(name, { name, createdAt: Number(created) * 1000, activityAt: Number(activity) * 1000, attached: attached === "1", panePids: [] });
    }
    for (const line of panes.split("\n")) {
        const [name, pid] = line.split("\t");
        const s = name ? byName.get(name) : undefined;
        if (s && pid) s.panePids.push(Number(pid));
    }
    return [...byName.values()];
};

export const tmuxSessions = async (): Promise<TmuxSession[]> =>
    parseTmux(
        await run("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}"]),
        await run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]),
    );

// Disk used by a directory, in MB (du -sk); slow on a big worktree, so callers sample it rarely.
export const dirSizeMb = async (path: string): Promise<number> => {
    const out = await run("du", ["-sk", path], 120_000);
    const kb = Number(/^(\d+)/.exec(out)?.[1] ?? 0);
    return Math.round(kb / 1024);
};

export const killPid = (pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean => {
    try {
        process.kill(pid, signal);
        return true;
    } catch {
        return false;
    }
};
