import { describe, expect, it } from "vitest";
import { parseEtime, parseLsof, parsePs, parseSwapUsage, parseTmux, parseVmStat, subtree } from "./host.js";

describe("host parsers", () => {
    it("vm_stat: page size and named counters", () => {
        const { pageSize, pages } = parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                   328066.\nPages occupied by compressor:                1672079.\n"Translation faults":                     1919026646.\n');
        expect(pageSize).toBe(16384);
        expect(pages["pages free"]).toBe(328066);
        expect(pages["pages occupied by compressor"]).toBe(1672079);
        expect(pages["translation faults"]).toBe(1919026646);
    });

    it("swapusage with a locale decimal comma", () => {
        expect(parseSwapUsage("total = 49152,00M  used = 47549,94M  free = 1602,06M  (encrypted)")).toEqual({ totalMb: 49152, usedMb: 47549.94 });
        expect(parseSwapUsage("total = 1024.00M  used = 0.00M  free = 1024.00M")).toEqual({ totalMb: 1024, usedMb: 0 });
    });

    it("etime in every shape", () => {
        expect(parseEtime("05:44")).toBe(344);
        expect(parseEtime("01:02:03")).toBe(3723);
        expect(parseEtime("01-14:15:42")).toBe(86400 + 14 * 3600 + 15 * 60 + 42);
    });

    it("ps table and subtree", () => {
        const table = parsePs(
            "  PID  PPID    RSS  %CPU     ELAPSED ARGS\n" +
                "  100     1   1024   0,0    01:00:00 tmux server\n" +
                "  200   100   2048   1,5       05:00 zsh -c unset NODE_OPTIONS; npm exec next dev\n" +
                "  300   200 409600  12.0       04:59 next-server (v16)\n" +
                "  301   300  25600   0.0       04:50 node worker\n" +
                "  400     1   3072   0.0       00:10 unrelated\n",
        );
        expect(table).toHaveLength(5);
        expect(table[1]).toEqual({ pid: 200, ppid: 100, rssMb: 2, cpu: 1.5, ageS: 300, args: "zsh -c unset NODE_OPTIONS; npm exec next dev" });
        const tree = subtree(200, table);
        expect(tree.map((p) => p.pid)).toEqual([200, 300, 301]);
        expect(tree.reduce((s, p) => s + p.rssMb, 0)).toBe(2 + 400 + 25);
        expect(subtree(999, table)).toEqual([]);
    });

    it("lsof -Fpn", () => {
        expect(parseLsof("p123\nn127.0.0.1:18003\nn[::1]:18003\np456\nn*:5432\n")).toEqual([
            { pid: 123, port: 18003 },
            { pid: 456, port: 5432 },
        ]);
    });

    it("tmux sessions with pane pids", () => {
        const s = parseTmux("0\t1790247297\t1790250574\t1\nsh-inv-63-fe\t1790247469\t1790247469\t0\n", "0\t29644\n0\t30418\nsh-inv-63-fe\t47200\n");
        expect(s).toEqual([
            { name: "0", createdAt: 1790247297000, activityAt: 1790250574000, attached: true, panePids: [29644, 30418] },
            { name: "sh-inv-63-fe", createdAt: 1790247469000, activityAt: 1790247469000, attached: false, panePids: [47200] },
        ]);
    });
});
