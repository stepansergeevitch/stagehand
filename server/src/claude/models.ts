import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

// The model picker's entries. `value` is what `claude --model` gets: "" for the account default, a family alias
// ("opus" = the newest Opus), or an exact model id.
export interface ModelOption { value: string; label: string }

// One model of GET https://api.anthropic.com/v1/models (only the fields Vortex reads).
export const ApiModel = z.object({ id: z.string(), display_name: z.string(), created_at: z.string() });
export type ApiModel = z.infer<typeof ApiModel>;
const ApiModels = z.object({ data: z.array(ApiModel) });

// Aliases `claude --model` accepts for the newest model of a family, in picker order.
const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

// The list shown until the first successful fetch (no token account yet, or offline at first start).
export const FALLBACK_MODELS: ApiModel[] = [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T16:24:00Z" },
    { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-08-28T00:00:00Z" },
    { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-06-29T00:00:00Z" },
];

const shortName = (m: ApiModel): string => m.display_name.replace(/^Claude\s+/, "");
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// The picker entries for a model list: the account default, then one alias per family that has a model (labelled with
// the family's newest model, which is what the installed Claude Code resolves the alias to), then every model, newest
// first. Labels end with "(<value>)" because the web's modelLabel() finds an id by that.
export const modelOptions = (models: ApiModel[]): ModelOption[] => {
    const sorted = [...models].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const options: ModelOption[] = [{ value: "", label: "Account default" }];
    for (const family of FAMILIES) {
        const newest = sorted.find((m) => m.id.startsWith(`claude-${family}-`));
        if (newest) options.push({ value: family, label: `Latest ${capitalise(family)} · ${shortName(newest)} (${family})` });
    }
    for (const m of sorted) options.push({ value: m.id, label: `${shortName(m)} (${m.id})` });
    return options;
};

const TTL_MS = 6 * 60 * 60 * 1000; // a fetched list is reused this long
const RETRY_MS = 10 * 60 * 1000; // after a failed fetch (or with no token), the next attempt waits this long
const FETCH_TIMEOUT_MS = 5000;
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";

const CacheFile = z.object({ fetchedAt: z.string(), models: z.array(ApiModel) });

// The models the API offers, fetched with an account's Claude Code OAuth token and cached in memory and in `file`
// (so a restart shows the last list at once). A stale list is refreshed on the next read; when the fetch fails, the
// last good list stays and the fetch is retried later.
export class ModelCatalog {
    private models: ApiModel[] | null = null;
    private fetchedAt: string | null = null;
    private nextTry = 0;
    private error: string | null = null;
    private inflight: Promise<void> | null = null;

    constructor(private readonly file: string, private readonly token: () => string | null) {
        if (!existsSync(file)) return;
        try {
            const parsed = CacheFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
            if (parsed.success) {
                this.models = parsed.data.models;
                this.fetchedAt = parsed.data.fetchedAt;
            }
        } catch {
            // an unreadable cache is the same as none
        }
    }

    // The picker entries; refreshes first when the cached list expired (bounded by the fetch timeout).
    async options(): Promise<ModelOption[]> {
        await this.refresh(false);
        return modelOptions(this.models ?? FALLBACK_MODELS);
    }

    // When the list was fetched, and why the last fetch failed (null when it worked).
    status(): { fetchedAt: string | null; error: string | null; live: boolean } {
        return { fetchedAt: this.fetchedAt, error: this.error, live: this.models !== null };
    }

    // Fetches the list when it expired (or always with `force`); concurrent callers share one request.
    async refresh(force: boolean): Promise<void> {
        const fresh = this.fetchedAt !== null && Date.now() - Date.parse(this.fetchedAt) < TTL_MS;
        if (!force && (fresh || Date.now() < this.nextTry)) return;
        if (!this.inflight) this.inflight = this.fetch().finally(() => (this.inflight = null));
        await this.inflight;
    }

    private async fetch(): Promise<void> {
        const token = this.token();
        if (!token) {
            this.error = "no account with a token";
            this.nextTry = Date.now() + RETRY_MS;
            return;
        }
        try {
            const res = await globalThis.fetch(MODELS_URL, {
                headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            const parsed = ApiModels.safeParse(await res.json());
            if (!parsed.success) throw new Error("unexpected response shape");
            if (parsed.data.data.length === 0) throw new Error("empty model list");
            this.models = parsed.data.data;
            this.fetchedAt = new Date().toISOString();
            this.error = null;
            try {
                writeFileSync(this.file, JSON.stringify({ fetchedAt: this.fetchedAt, models: this.models }, null, 2));
            } catch (e) {
                console.error(`[models] cache not written: ${String((e as Error).message ?? e)}`);
            }
        } catch (e) {
            this.error = String((e as Error).message ?? e).slice(0, 200);
            this.nextTry = Date.now() + RETRY_MS;
            console.error(`[models] fetch failed: ${this.error}`);
        }
    }
}
