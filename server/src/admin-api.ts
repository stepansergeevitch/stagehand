import { z } from "zod";
import type { Config } from "./config.js";

// Anthropic Admin API — organization token usage over time (Claude Enterprise plans; key needs the read:analytics scope).
// Daily buckets, at most 31 days per call, data refreshed roughly every 4 hours, tokens only (no cost).
// https://platform.claude.com/docs/en/api/admin/analytics/usage/list

const Row = z.object({
    product: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    uncached_input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cache_read_input_tokens: z.number().default(0),
    cache_creation: z.object({ ephemeral_1h_input_tokens: z.number().default(0), ephemeral_5m_input_tokens: z.number().default(0) }).optional(),
    requests: z.number().nullable().optional(),
});
const Page = z.object({
    data: z.array(z.object({ starting_at: z.string(), ending_at: z.string(), results: z.array(Row) })),
    data_refreshed_at: z.string().nullable(),
    has_more: z.boolean(),
    next_page: z.string().nullable(),
    organization_id: z.string(),
});

export interface OrgUsageRow {
    day: string;
    product: string | null;
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    requests: number;
}
export interface OrgUsage {
    organizationId: string;
    refreshedAt: string | null;
    since: string;
    rows: OrgUsageRow[];
}

export const fetchOrgUsage = async (cfg: Config, days: number): Promise<OrgUsage> => {
    if (!cfg.anthropicAdminKey) throw new Error("Anthropic Admin API key is not set in Settings");
    const span = Math.min(Math.max(days, 1), 31);
    const start = new Date(Date.now() - span * 86_400_000);
    start.setUTCHours(0, 0, 0, 0);
    const rows: OrgUsageRow[] = [];
    let page: string | null = null;
    let orgId = "";
    let refreshedAt: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
        const params = new URLSearchParams({ starting_at: start.toISOString(), bucket_width: "1d", limit: "31" });
        params.append("group_by[]", "product");
        params.append("group_by[]", "model");
        if (cfg.anthropicUserId) params.append("user_ids[]", cfg.anthropicUserId);
        if (page) params.set("page", page);
        const res = await fetch(`https://api.anthropic.com/v1/organizations/analytics/usage_report?${params.toString()}`, {
            headers: { "anthropic-version": "2023-06-01", "X-Api-Key": cfg.anthropicAdminKey },
        });
        if (!res.ok) throw new Error(`Admin API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const parsed = Page.safeParse(await res.json());
        if (!parsed.success) throw new Error(`Admin API: unexpected response (${parsed.error.issues[0]?.message ?? "schema"})`);
        orgId = parsed.data.organization_id;
        refreshedAt = parsed.data.data_refreshed_at;
        for (const bucket of parsed.data.data) {
            for (const r of bucket.results) {
                rows.push({
                    day: bucket.starting_at.slice(0, 10),
                    product: r.product ?? null,
                    model: r.model ?? null,
                    input: r.uncached_input_tokens,
                    output: r.output_tokens,
                    cacheRead: r.cache_read_input_tokens,
                    cacheWrite: (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0),
                    requests: r.requests ?? 0,
                });
            }
        }
        if (!parsed.data.has_more || !parsed.data.next_page) break;
        page = parsed.data.next_page;
    }
    return { organizationId: orgId, refreshedAt, since: start.toISOString(), rows };
};
