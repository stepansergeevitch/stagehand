// A QA pass split into shards that run at the same time, each as its own claude run with its own output file (and,
// on accounts that clone their QA Chrome profile per run, its own Chrome):
//   - every API scenario goes into one Chrome-less shard "api";
//   - browser scenarios get one shard each when the account clones its profile per run (packed round-robin into at
//     most `maxBrowser` shards), or one shared shard "browser" when a single Chrome profile is all there is;
//   - scenarios marked `exclusive` run alone, one shard after every parallel shard has finished (the "solo" phase).
// A pass with a single shard runs the way it always did (no group, the pass file is written directly).

export interface ShardScenario {
    id: string;
    kind?: "browser" | "api" | undefined;
    exclusive?: boolean | undefined;
}

export interface QaShard {
    // The group is one pass dispatch; every shard of it shares the seeds, the pass id and the merge at the end.
    group: string;
    id: string;
    scenarios: string[];
    browser: boolean;
    // "solo": runs after the parallel phase, alone.
    phase: "parallel" | "solo";
}

export interface ShardPlanOptions {
    // The account clones its Chrome profile per run: browser scenarios may run in parallel, each in its own copy.
    cloneMode: boolean;
    // Upper bound on browser shards at once (the clone cap); 1 in shared-profile mode.
    maxBrowser: number;
    // Upper bound on shards per pass (config qaShards); 0 = no sharding.
    maxShards: number;
}

const sortIds = (ids: string[]): string[] => [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// Spreads items over at most `n` buckets, round-robin, keeping order inside a bucket.
const pack = <T>(items: T[], n: number): T[][] => {
    const buckets: T[][] = [];
    const count = Math.max(1, Math.min(n, items.length));
    for (let i = 0; i < count; i++) buckets.push([]);
    items.forEach((it, i) => buckets[i % count]!.push(it));
    return buckets;
};

export const planQaShards = (group: string, scenarios: ShardScenario[], opts: ShardPlanOptions): QaShard[] => {
    if (opts.maxShards <= 0 || scenarios.length <= 1) {
        return scenarios.length ? [{ group, id: "all", scenarios: sortIds(scenarios.map((s) => s.id)), browser: scenarios.some((s) => (s.kind ?? "browser") === "browser"), phase: "parallel" }] : [];
    }
    const api = scenarios.filter((s) => (s.kind ?? "browser") === "api" && !s.exclusive);
    const browser = scenarios.filter((s) => (s.kind ?? "browser") === "browser" && !s.exclusive);
    const solo = scenarios.filter((s) => s.exclusive);
    const shards: QaShard[] = [];
    if (api.length) shards.push({ group, id: "api", scenarios: sortIds(api.map((s) => s.id)), browser: false, phase: "parallel" });
    if (browser.length) {
        const room = Math.max(1, opts.maxShards - shards.length);
        const n = opts.cloneMode ? Math.max(1, Math.min(opts.maxBrowser, room)) : 1;
        const buckets = pack(browser, n);
        for (const b of buckets) {
            const ids = sortIds(b.map((s) => s.id));
            shards.push({ group, id: buckets.length === 1 && !opts.cloneMode ? "browser" : ids.join("+"), scenarios: ids, browser: true, phase: "parallel" });
        }
    }
    if (solo.length) shards.push({ group, id: "solo", scenarios: sortIds(solo.map((s) => s.id)), browser: solo.some((s) => (s.kind ?? "browser") === "browser"), phase: "solo" });
    return shards;
};

// The per-shard files under <taskDir>/qa/: output, partial results, questions.
export const shardFiles = (pass: "before" | "after", shard: QaShard | undefined): { output: string; partial: string; questions: string } =>
    shard
        ? { output: `qa/${pass}.${shard.id}.json`, partial: `qa/${pass}.${shard.id}.partial.json`, questions: `qa/questions.${pass}.${shard.id}.json` }
        : { output: `qa/${pass}.json`, partial: `qa/${pass}.partial.json`, questions: "questions.json" };

// Merges scenario results by id (later wins), sorted by id.
export const mergeScenarios = <T extends { id: string }>(...lists: T[][]): T[] => {
    const m = new Map<string, T>();
    for (const list of lists) for (const s of list) m.set(s.id, s);
    return [...m.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
};

// Questions from several shards as one round: ids that collide get the shard id in front.
export const mergeQuestions = <Q extends { id: string }>(rounds: Array<{ shard: string; questions: Q[] }>): Q[] => {
    const seen = new Set<string>();
    const out: Q[] = [];
    for (const r of rounds) {
        for (const q of r.questions) {
            const id = seen.has(q.id) ? `${r.shard}-${q.id}` : q.id;
            seen.add(id);
            out.push({ ...q, id });
        }
    }
    return out;
};
