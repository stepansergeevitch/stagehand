import { describe, expect, it } from "vitest";
import { pickLocalStorage, withoutRefreshTokens } from "./chrome-storage.js";

describe("pickLocalStorage", () => {
    const rows = [
        { origin: "https://localhost:13001", key: "token", value: "other-port" },
        { origin: "https://localhost:13001", key: "only-there", value: "1" },
        { origin: "https://localhost:13000", key: "token", value: "own" },
        { origin: "http://localhost:13000", key: "insecure", value: "x" },
        { origin: "https://example.com", key: "foreign", value: "y" },
    ];
    it("takes the origin's own entries over other ports of the same scheme and host, and nothing else", () => {
        expect(pickLocalStorage(rows, "https://localhost:13000/home")).toEqual({ token: "own", "only-there": "1" });
    });
});

describe("withoutRefreshTokens", () => {
    it("drops refresh_token at any depth and leaves other values alone", () => {
        const v = JSON.stringify({ body: { access_token: "a", refresh_token: "r", nested: [{ refresh_token: "r2", k: 1 }] }, expiresAt: 5 });
        expect(JSON.parse(withoutRefreshTokens(v))).toEqual({ body: { access_token: "a", nested: [{ k: 1 }] }, expiresAt: 5 });
        expect(withoutRefreshTokens("plain refresh_token text")).toBe("plain refresh_token text");
        expect(withoutRefreshTokens("x")).toBe("x");
    });
});
