import { describe, expect, it } from "vitest";
import { applyMotion, lineEnd, lineStart, moveVertical, motionOf, wordBackward, wordForward } from "./emacsMark";

const text = "alpha beta\nxy\ngamma delta";

describe("emacs motions", () => {
    it("finds line bounds", () => {
        expect(lineStart(text, 3)).toBe(0);
        expect(lineEnd(text, 3)).toBe(10);
        expect(lineStart(text, 12)).toBe(11);
        expect(lineEnd(text, 12)).toBe(13);
        expect(lineEnd(text, 20)).toBe(text.length);
    });
    it("moves up and down keeping the column, clamped to the shorter line", () => {
        expect(moveVertical(text, 8, 1)).toBe(13); // column 8 -> end of "xy"
        expect(moveVertical(text, 13, 1)).toBe(14 + 2);
        expect(moveVertical(text, 16, -1)).toBe(13);
        expect(moveVertical(text, 3, -1)).toBe(0);
        expect(moveVertical(text, text.length, 1)).toBe(text.length);
    });
    it("moves by words", () => {
        expect(wordForward("foo  bar baz", 0)).toBe(3);
        expect(wordForward("foo  bar baz", 3)).toBe(8);
        expect(wordBackward("foo  bar baz", 12)).toBe(9);
        expect(wordBackward("foo  bar baz", 8)).toBe(5);
        expect(wordBackward("foo", 0)).toBe(0);
    });
    it("applies simple motions at the ends", () => {
        expect(applyMotion("abc", 0, "left")).toBe(0);
        expect(applyMotion("abc", 3, "right")).toBe(3);
        expect(applyMotion(text, 5, "home")).toBe(0);
        expect(applyMotion(text, 5, "end")).toBe(10);
        expect(applyMotion(text, 5, "finish")).toBe(text.length);
        expect(applyMotion(text, 5, "start")).toBe(0);
    });
    it("reads Emacs keys and the arrows", () => {
        const k = (code: string, o: Partial<Record<"ctrlKey" | "altKey" | "metaKey" | "shiftKey", boolean>> = {}) => motionOf({ code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...o });
        expect(k("KeyF", { ctrlKey: true })).toBe("right");
        expect(k("KeyP", { ctrlKey: true })).toBe("up");
        expect(k("KeyB", { altKey: true })).toBe("wordLeft");
        expect(k("Comma", { altKey: true, shiftKey: true })).toBe("start");
        expect(k("ArrowDown")).toBe("down");
        expect(k("KeyF")).toBeNull();
        expect(k("KeyF", { ctrlKey: true, metaKey: true })).toBeNull();
    });
});
