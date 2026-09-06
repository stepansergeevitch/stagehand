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
