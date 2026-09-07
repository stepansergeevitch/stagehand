import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";

const execFileAsync = promisify(execFile);

const tmux = async (args: string[]): Promise<{ ok: boolean; stdout: string }> => {
    try {
        const { stdout } = await execFileAsync("tmux", args);
        return { ok: true, stdout: stdout.trim() };
    } catch {
        return { ok: false, stdout: "" };
    }
};

export const sessionExists = async (name: string): Promise<boolean> => (await tmux(["has-session", "-t", `=${name}`])).ok;

export const ensureSession = async (name: string, cwd: string, command: string, env: Record<string, string>): Promise<void> => {
    if (await sessionExists(name)) return;
    // `export`, not a `K=V cmd` prefix: the command may be a `cd …; ( … )` chain, and a prefix would only apply to its first word.
    const exports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
        .join(" ");
    // tmux inherits the server's environment; unset the dev-toolchain variables inside the pane too.
    await tmux(["new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd, `unset NODE_OPTIONS CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${exports} ${command}`]);
};

// pipe-pane / capture-pane want a pane target and reject the "=session" form; resolve the session's active pane id first.
const paneId = async (name: string): Promise<string | null> => {
    const r = await tmux(["list-panes", "-t", `=${name}`, "-F", "#{pane_active} #{pane_id}"]);
    if (!r.ok) return null;
    const line = r.stdout.split("\n").find((l) => l.startsWith("1 ")) ?? r.stdout.split("\n")[0];
    return line?.split(" ")[1] ?? null;
};

// Mirror everything the pane prints from now on into a file; used to pick a token out of an interactive command's output.
export const pipePane = async (name: string, file: string): Promise<boolean> => {
    const id = await paneId(name);
    if (!id) return false;
    return (await tmux(["pipe-pane", "-t", id, "-o", `cat >> ${JSON.stringify(file)}`])).ok;
};

// The pane's visible text plus scrollback (what a human would see), for output printed before a pipe was attached.
export const capturePane = async (name: string, lines = 500): Promise<string> => {
    const id = await paneId(name);
    if (!id) return "";
    return (await tmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", id])).stdout;
};

export const killSession = async (name: string): Promise<void> => {
    await tmux(["kill-session", "-t", `=${name}`]);
};

export const taskSessionName = (ticketId: string): string => `sh-${ticketId.toLowerCase()}`;
export const loginSessionName = (accountName: string): string => `sh-login-${accountName}`;

export const attach = (name: string, cols: number, rows: number): pty.IPty =>
    pty.spawn("tmux", ["attach-session", "-t", `=${name}`], {
        name: "xterm-256color",
        cols,
        rows,
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
