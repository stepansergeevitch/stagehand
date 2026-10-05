import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseCookies, withPrepare } from "./env-config.js";

const run = (shell: string, cmd: string): string => execFileSync(shell, ["-c", cmd], { encoding: "utf8" }).trim();

describe("withPrepare", () => {
    const prep = 'set -u\nok() { [ -n "${1:-}" ]; }\nfor x in $(seq 1 2); do echo "prep $x"; done\nexit 0';
    const cmd = "python3 - a b <<'PY'\nimport sys; print('cmd', sys.argv[1:])\nPY";
    it("runs the prepare text, then a command with its own heredoc, from bash and zsh", () => {
        for (const sh of ["bash", "zsh"]) expect(run(sh, `( ${withPrepare({ prepare_command: prep }, cmd)}\n )`)).toBe("prep 1\nprep 2\ncmd ['a', 'b']");
    });
    it("stops the command when the prepare text fails, and leaves a command alone without one", () => {
        expect(() => run("bash", withPrepare({ prepare_command: "exit 3" }, "echo never"))).toThrow();
        expect(withPrepare({ prepare_command: null }, "echo x")).toBe("echo x");
    });
});

describe("parseCookies", () => {
    it("reads a Cookie header value and name=value lines alike", () => {
        expect(parseCookies("token=a.b=c; theme=dark")).toEqual([
            { name: "token", value: "a.b=c" },
            { name: "theme", value: "dark" },
        ]);
        expect(parseCookies("authRefresh=1\n# a note\n\nflag = on")).toEqual([
            { name: "authRefresh", value: "1" },
            { name: "flag", value: "on" },
        ]);
        expect(parseCookies(null)).toEqual([]);
        expect(parseCookies("no-equals-sign")).toEqual([]);
    });
});

