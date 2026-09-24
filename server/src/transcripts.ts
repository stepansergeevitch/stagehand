// Where claude keeps a session's transcript: <config dir>/projects/<encoded cwd>/<session id>.jsonl. The encoded cwd
// is not always the run's cwd (a worktree's session lands under its repository's directory), so the file is found
// by its session id across every project folder of the config dirs a task may have run in.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Transcript {
    path: string;
    sizeMb: number;
}

export const findTranscript = (configDirs: string[], sessionId: string): Transcript | null => {
    for (const dir of [...new Set(configDirs)]) {
        const projects = join(dir, "projects");
        if (!existsSync(projects)) continue;
        for (const p of readdirSync(projects)) {
            const f = join(projects, p, `${sessionId}.jsonl`);
            if (existsSync(f)) return { path: f, sizeMb: Math.round((statSync(f).size / 1_048_576) * 10) / 10 };
        }
    }
    return null;
};
