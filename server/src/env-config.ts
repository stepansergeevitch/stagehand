import type { EnvRow } from "./db.js";

// Generic env settings the engine applies; what they hold is the env's own config, visible and edited on its page.

// The fixed login-callback ports of an env's identity provider (envs.callback_ports): JSON [{ port, relay }].
export const callbackPortsOf = (json: string | null | undefined): Array<{ port: number; relay: boolean }> => {
    try {
        const v: unknown = json ? JSON.parse(json) : [];
        return Array.isArray(v) ? v.filter((p): p is { port: number; relay?: boolean } => !!p && Number.isInteger(p.port) && p.port > 0 && p.port < 65536).map((p) => ({ port: p.port, relay: p.relay === true })) : [];
    } catch {
        return [];
    }
};

// envs.prepare_command: bash text that runs before every command of the env (setup, BE, FE, components, migrate,
// cleanup, rebase, verification) — e.g. bringing up the datastores it needs. It runs as its own `bash -s` (a heredoc
// closed before the command starts, so the command may carry heredocs of its own, and its `exit 0` ends only itself);
// a non-zero exit stops the command. Works the same from zsh (tmux panes) and bash.
export const withPrepare = (env: Pick<EnvRow, "prepare_command">, command: string): string => {
    const prep = env.prepare_command?.trim();
    return prep ? `{ bash -s <<'STAGEHAND_PREPARE'\n${prep}\nSTAGEHAND_PREPARE\n} && ${command}` : command;
};
