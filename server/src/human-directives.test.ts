import { describe, expect, it } from "vitest";
import { renderHumanDirectives } from "./human-directives.js";

describe("renderHumanDirectives", () => {
    it("says so when there is nothing", () => {
        expect(renderHumanDirectives([])).toMatch(/no instructions/);
        expect(renderHumanDirectives([{ at: "2026-09-24T10:00:00.000Z", source: "Chat", text: "   " }])).toMatch(/no instructions/);
    });

    it("numbers the items oldest first and keeps line comments under their round", () => {
        const out = renderHumanDirectives([
            { at: "2026-09-24T16:24:38.370Z", source: "Request changes at User Review → Implementation", text: "Remove the serial_number parameter.\nTOTALLY REMOVE." },
            { at: "2026-09-21T12:30:08.139Z", source: "Chat", text: "why a cost basis column?" },
            {
                at: "2026-09-24T13:51:02.163Z",
                source: "Request changes at User Review → Implementation",
                text: "",
                comments: [{ path: "frontend/app/x.ts", line: 34, side: "new", snippet: "    serial_number: serialValue,", text: "drop this\nuse initial_search" }],
            },
        ]);
        expect(out.startsWith("## What the human asked for, oldest first")).toBe(true);
        expect(out.indexOf("1. **Chat** (2026-09-21 12:30) — why a cost basis column?")).toBeGreaterThan(0);
        expect(out.indexOf("1. **Chat**")).toBeLessThan(out.indexOf("2. **Request changes"));
        expect(out.indexOf("2. **Request changes")).toBeLessThan(out.indexOf("3. **Request changes"));
        expect(out).toContain("   - `frontend/app/x.ts:34` — `serial_number: serialValue,`\n     → drop this\n     use initial_search");
        expect(out).toContain("Remove the serial_number parameter.\n   TOTALLY REMOVE.");
    });

    it("cuts long texts and keeps only the last 40 items, counting the omitted ones", () => {
        const items = Array.from({ length: 45 }, (_, i) => ({ at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:${String(i).padStart(2, "0")}:00.000Z`, source: "Chat", text: `item ${i}` }));
        const out = renderHumanDirectives([...items, { at: "2026-09-30T00:00:00.000Z", source: "Chat", text: "x".repeat(3000) }]);
        expect(out).toContain("(6 earlier item(s) omitted)");
        expect(out).toContain("\n7. **Chat**");
        expect(out).not.toContain("\n6. **Chat**");
        expect(out).toContain("… (truncated)");
        expect(out).toContain("46. **Chat**");
    });
});
