import { useEffect, useState } from "react";
import { Button, Checkbox, Chip, EmptyState, Icon, Input, Notice, Select, Tab, TabList, Textarea, type Tone } from "@vortex/ds";
import { api, checkOutcome, isApprovalGateCheck, parseBaseBranch, parseChecks, prRepos, prStateOf, repoColorClass, repoName, type CiAutopilot, type MergeMethod, type PrCheck, type PrComments, type PrDraftEntry, type PrFixReplies as PrFixRepliesData, type PrState, type TaskDbInfo, type TaskDetail } from "../api";
import { AgentInput, usePendingFiles } from "../AgentInput";
import { BranchPicker } from "../BranchPicker";
import { BaseCheckChip } from "../components/BaseCheckChip";
import { KeyValue } from "../components/KeyValue";
import { Markdown } from "../Markdown";
import { Panel } from "../components/Panel";
import { storage } from "../storage";
import { elapsed, RepoChip } from "./common";
import { ReviewHistory } from "./PrComments";
import "./workspace.css";

type Act = (fn: () => Promise<unknown>) => Promise<void>;

// The Pull request tab: one panel per repository (state, checks, merge), the branch against its base, the batch jobs
// for the agent, the CI autopilot, and the drafts while they are being reviewed.



// One repository's drafted PR: read view, or an editor with the markdown source beside the rendered preview. Saving
// rewrites that repository's entry in pr.json; approving pushes/opens that repository's PR right away.
const PrDraftEntryView = ({ detail, entry, repos, onAction }: { detail: TaskDetail; entry: PrDraftEntry; repos: string[]; onAction: Act }) => {
    const { task, pr } = detail;
    const row = prStateOf(detail, entry.repo);
    const created = !!row?.number;
    const approved = !!row?.approved_at;
    // Drafts are reviewed during PR Creation Review — and a draft whose PR never opened stays reviewable from the later PR stages.
    const reviewing = (task.stage === "pr_creation_review" && task.status === "waiting_user") || (!created && task.status !== "running" && (task.stage === "pr_waiting" || task.stage === "pr_fix" || task.stage === "pr_green"));
    const editable = task.status !== "running" && !created;
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(entry.title);
    const [body, setBody] = useState(entry.body);
    // This repository's PR base: the entry's own (a per-repo stack) or the draft's shared one.
    const [base, setBase] = useState(entry.base ?? pr?.base ?? "");
    const [saving, setSaving] = useState(false);
    const [notes, setNotes] = useState("");
    const [changes, setChanges] = useState(false);
    const attach = usePendingFiles();
    useEffect(() => {
        if (!editing) {
            setTitle(entry.title);
            setBody(entry.body);
            setBase(entry.base ?? pr?.base ?? "");
        }
    }, [entry.title, entry.body, entry.base, pr?.base, editing]);
    const dirty = title !== entry.title || body !== entry.body || base !== (pr?.base ?? "");
    const o = prOutcome(row);
    return (
        <Panel
            title={<><RepoChip repo={entry.repo} repos={repos} /> PR draft</>}
            badge={
                <>
                    {created && <Chip tone={o.tone}>{row?.url ? <a href={row.url} target="_blank" rel="noreferrer">#{row.number} {o.text}</a> : o.text}</Chip>}
                    {!created && approved && <Chip tone="warn" title="Approved; Vortex could not push or open it itself. See the status line.">approved · {o.text}</Chip>}
                    {!created && !approved && reviewing && <Chip tone="wait">awaiting your approval</Chip>}
                    {editable && !editing && <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>}
                </>
            }
        >
            {!editing && (
                <>
                    <KeyValue items={[{ label: "Title", value: entry.title }, { label: "Base", value: <code>{pr?.base}</code> }]} />
                    {entry.stackedOn && (
                        <Notice tone="info">
                            <b>Stacked PR.</b> Base <code>{pr?.base}</code> is open as <a href={entry.stackedOn.url} target="_blank" rel="noreferrer">#{entry.stackedOn.number} {entry.stackedOn.title}</a>. That one merges first; GitHub retargets this PR to the trunk afterwards and the task follows.
                        </Notice>
                    )}
                    {!entry.stackedOn && entry.stackNote && (
                        <Notice tone="warn">
                            <b>Base has no PR.</b> {entry.stackNote}
                        </Notice>
                    )}
                    <Markdown source={entry.body} />
                </>
            )}
            {editing && (
                <div className="pr-editor">
                    <label>Title <Input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                    <label>Base branch{repos.length > 1 ? ` for ${repoName(entry.repo)}` : ""} <BranchPicker envId={task.env_id} repo={entry.repo} value={base} onChange={setBase} /></label>
                    <div className="pr-editor-panes">
                        <div className="pr-editor-pane">
                            <div className="pr-editor-head">Markdown</div>
                            <Textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
                        </div>
                        <div className="pr-editor-pane preview">
                            <div className="pr-editor-head">Preview</div>
                            <div className="pr-editor-preview"><Markdown source={body || "*(empty)*"} /></div>
                        </div>
                    </div>
                    <div className="actions tight">
                        <Button variant="primary" disabled={saving || !title.trim() || !dirty} onClick={() => { setSaving(true); void onAction(() => api.patchPrDraft(task.id, { repo: entry.repo, title: title.trim(), body, base })).then(() => setEditing(false)).finally(() => setSaving(false)); }}>{saving ? "Saving…" : "Save draft"}</Button>
                        <Button disabled={saving} onClick={() => setEditing(false)}>Cancel</Button>
                        {dirty && <span className="field-hint">unsaved edits{approved ? " — saving withdraws the approval until you approve again" : ""}</span>}
                    </div>
                </div>
            )}
            {reviewing && !created && !editing && (
                <div className="draft-verdict">
                    <b>{repoName(entry.repo)}: your call</b>
                    {!approved && (
                        <div className="actions">
                            <Button variant="primary" onClick={() => onAction(() => api.review(task.id, { verdict: "approve", repo: entry.repo }))}>Approve and create the {repoName(entry.repo)} PR</Button>
                            <Button onClick={() => setChanges((v) => !v)}>{changes ? "Cancel" : "Request changes"}</Button>
                        </div>
                    )}
                    {approved && <p className="quiet">Approved. {task.status_line}</p>}
                    {changes && (
                        <>
                            <AgentInput placeholder={`What should change in the ${repoName(entry.repo)} description (required)`} value={notes} onChange={setNotes} pending={attach} />
                            <div className="actions tight">
                                <Button variant="primary" disabled={!notes.trim()} onClick={() => onAction(async () => { const files = await api.uploadFiles(task.id, attach.files); await api.review(task.id, { verdict: "changes", repo: entry.repo, notes, ...(files.length ? { files } : {}) }); setNotes(""); attach.clear(); setChanges(false); })}>Send back to the drafting agent</Button>
                                <span className="field-hint">The agent redrafts this repository's PR (others are copied through unchanged); drafts not yet approved go back to pending.</span>
                            </div>
                        </>
                    )}
                </div>
            )}
        </Panel>
    );
};

// PR Creation Review: one tab per repository; each draft is edited and approved on its own.
export const PrDraftTabs = ({ detail, onAction, focusRepo, onFocusRepo }: { detail: TaskDetail; onAction: Act; focusRepo?: string | null; onFocusRepo?: (repo: string) => void }) => {
    const { task, pr } = detail;
    const drafts = pr?.drafts ?? [];
    const repos = drafts.map((d) => d.repo);
    // The open repository is routed (focusRepo); without a router, the first one.
    const [localActive, setLocalActive] = useState(0);
    const active = onFocusRepo ? Math.max(0, repos.indexOf(focusRepo ?? "")) : localActive;
    const setActive = (i: number) => (onFocusRepo ? onFocusRepo(repos[i] ?? "") : setLocalActive(i));
    if (drafts.length === 0) return <EmptyState icon="inbox" title="No draft yet" />;
    const approvedCount = drafts.filter((d) => prStateOf(detail, d.repo)?.approved_at).length;
    const cur = drafts[Math.min(active, drafts.length - 1)]!;
    return (
        <>
            {pr?.legacy && drafts.length > 1 && (
                <Notice tone="warn">
                    <b>This draft predates per-repository PRs.</b> One description was written (on the first repository's template) and is shown under every repository. Redraft so each repository gets its own description on its own template.
                    {task.status !== "running" && (
                        <div className="actions tight">
                            <Button variant="primary" onClick={() => { if (confirm("Redraft the pull requests per repository? The current draft is archived.")) void onAction(() => api.rerun(task.id, "pr_creation_review")); }}>Redraft per repository</Button>
                        </div>
                    )}
                </Notice>
            )}
            {drafts.length > 1 && (
                <TabList variant="pill" className="pr-repo-tabs">
                    {drafts.map((d, i) => {
                        const row = prStateOf(detail, d.repo);
                        const o = prOutcome(row);
                        return (
                            <Tab key={d.repo} active={i === active} className={`repo-${repoColorClass(d.repo, repos)}`} onClick={() => setActive(i)}>
                                {repoName(d.repo)} <Chip tone={row?.approved_at ? (o.tone === "neutral" ? "ok" : o.tone) : "wait"}>{row?.number ? `#${row.number}` : row?.approved_at ? "approved" : "pending"}</Chip>
                            </Tab>
                        );
                    })}
                    <span className="field-hint pr-tabs-note">{approvedCount}/{drafts.length} approved. The task moves on once every repository is approved.</span>
                </TabList>
            )}
            {task.stage === "pr_creation_review" && <ReviewHistory reviews={detail.reviews} stage="pr_creation_review" />}
            <PrDraftEntryView key={cur.repo} detail={detail} entry={cur} repos={repos} onAction={onAction} />
        </>
    );
};

// The PR comments picked for the agent (`<repo>:<comment id>`): one set per task, shared by the PR comments tab and the
// PR tab's batch jobs (picking in one picks in the other), kept by the server so a reload keeps it.
const prPickStore: { taskId: string | null; keys: Set<string>; subs: Set<() => void> } = { taskId: null, keys: new Set(), subs: new Set() };
export const usePrPicks = (taskId: string): [Set<string>, (next: Set<string>) => void] => {
    const [, rerender] = useState(0);
    useEffect(() => {
        const sub = () => rerender((n) => n + 1);
        prPickStore.subs.add(sub);
        if (prPickStore.taskId !== taskId) {
            prPickStore.taskId = taskId;
            prPickStore.keys = new Set();
            void api.prPicks(taskId).then((r) => {
                if (prPickStore.taskId !== taskId) return;
                prPickStore.keys = new Set(r.keys);
                prPickStore.subs.forEach((f) => f());
            }).catch(() => undefined);
        }
        return () => { prPickStore.subs.delete(sub); };
    }, [taskId]);
    const set = (next: Set<string>): void => {
        prPickStore.keys = next;
        prPickStore.subs.forEach((f) => f());
        void api.putPrPicks(taskId, [...next]).catch(() => undefined);
    };
    return [prPickStore.taskId === taskId ? prPickStore.keys : new Set(), set];
};
export const pickKey = (repo: string, id: number): string => `${repo}:${id}`;

// Batched PR jobs: tick what the agent should do in ONE run — rebase onto the latest base (mechanical first), fix the
// failing checks, address picked PR comments, follow free-text instructions — then review the diff once and push once.
export const PrJobsCard = ({ detail, repos, onAction }: { detail: TaskDetail; repos: string[]; onAction: Act }) => {
    const { task } = detail;
    const [rebase, setRebase] = useState(false);
    const [rebaseRepos, setRebaseRepos] = useState<string[]>(repos);
    const [fixCi, setFixCi] = useState(false);
    const [instructions, setInstructions] = useState("");
    const attach = usePendingFiles();
    const [comments, setComments] = useState<Record<string, PrComments | null>>({});
    const [picked, setPickedSet] = usePrPicks(task.id);
    const setPicked = (next: Set<string> | ((p: Set<string>) => Set<string>)): void => setPickedSet(typeof next === "function" ? next(picked) : next);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const failing = repos.map((r) => ({ repo: r, n: parseChecks(prStateOf(detail, r)?.checks_json).filter((c) => !isApprovalGateCheck(c) && checkOutcome(c) === "fail").length })).filter((x) => x.n > 0);
    const withPr = repos.filter((r) => prStateOf(detail, r)?.number);
    useEffect(() => {
        let alive = true;
        for (const r of withPr) void api.prComments(task.id, r).then((c) => alive && setComments((m) => ({ ...m, [r]: c }))).catch(() => undefined);
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task.id, withPr.join(",")]);
    const commentKey = pickKey;
    const allComments = withPr.flatMap((r) => [...(comments[r]?.human ?? []), ...(comments[r]?.automation ?? [])].filter((c) => !(c.kind === "line" && c.resolved)).map((c) => ({ repo: r, c })));
    // Picks of comments still open here (a pick of a comment resolved since stays stored but is not sent).
    const openPicks = allComments.map((x) => commentKey(x.repo, x.c.id)).filter((k) => picked.has(k));
    const jobs = (rebase ? 1 : 0) + (fixCi && failing.length ? 1 : 0) + (openPicks.length ? 1 : 0) + (instructions.trim() || attach.files.length ? 1 : 0);
    const run = async () => {
        setBusy(true);
        setNote(null);
        const byRepo = new Map<string, number[]>();
        for (const key of openPicks) {
            const [repo = "", id = ""] = key.split(":");
            byRepo.set(repo, [...(byRepo.get(repo) ?? []), Number(id)]);
        }
        try {
            await onAction(async () => {
                const files = await api.uploadFiles(task.id, attach.files);
                const r = await api.prJobs(task.id, {
                    rebase: rebase ? { repos: rebaseRepos.length === repos.length ? undefined : rebaseRepos } : null,
                    fixCi: fixCi ? {} : null,
                    comments: [...byRepo].map(([repo, ids]) => ({ repo, ids })),
                    ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
                    ...(files.length ? { files } : {}),
                });
                setNote(r.started ? `started: ${r.note}` : r.note);
                if (r.started) {
                    setPicked(new Set([...picked].filter((k) => !openPicks.includes(k))));
                    setInstructions("");
                    attach.clear();
                }
            });
        } finally {
            setBusy(false);
        }
    };
    const idle = task.status !== "running";
    return (
        <Panel title="Ask the agent" hint="Tick what to do in one agent session. It commits as it goes, you review the diff once, then one push. The rebase runs mechanically first; only conflicts reach the agent." badge={jobs ? <Chip tone="accent">{jobs} job{jobs === 1 ? "" : "s"}</Chip> : undefined}>
            <div className="pr-jobs">
                <Checkbox checked={rebase} onChange={(e) => setRebase(e.target.checked)} label="Rebase onto the latest base" />
                {rebase && repos.length > 1 && (
                    <span className="pr-jobs-sub">
                        {repos.map((r) => (
                            <Checkbox key={r} checked={rebaseRepos.includes(r)} onChange={(e) => setRebaseRepos((p) => (e.target.checked ? [...p, r] : p.filter((x) => x !== r)))} label={repoName(r)} />
                        ))}
                    </span>
                )}
                <span className="pr-jobs-row" title={failing.length ? failing.map((f) => `${repoName(f.repo)}: ${f.n} failing`).join(" · ") : "No failing checks right now"}>
                    <Checkbox checked={fixCi} disabled={!failing.length} onChange={(e) => setFixCi(e.target.checked)} label="Fix failing CI" />
                    {failing.length > 0 && <Chip tone="bad">{failing.map((f) => `${repos.length > 1 ? `${repoName(f.repo)} ` : ""}${f.n}`).join(" · ")}</Chip>}
                </span>
                <div className="pr-jobs-comments">
                    <span>Address PR comments{allComments.length ? ` (${openPicks.length}/${allComments.length} picked)` : withPr.length ? ": none open" : ": no PR yet"}</span>
                    {allComments.length > 0 && (
                        <>
                            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(allComments.map((x) => commentKey(x.repo, x.c.id))))}>Pick all</Button>
                            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Pick none</Button>
                        </>
                    )}
                    {allComments.map(({ repo, c }) => {
                        const key = commentKey(repo, c.id);
                        const text = c.kind === "line" ? `${c.path}:${c.line ?? "?"} — ${c.body}` : c.kind === "review" ? `review (${c.state.toLowerCase()}): ${c.body || "(no text)"}` : c.body;
                        return (
                            <Checkbox
                                key={key}
                                className="pr-jobs-comment"
                                title={text}
                                checked={picked.has(key)}
                                onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(key); else n.delete(key); return n; })}
                                label={<>{repos.length > 1 && <RepoChip repo={repo} repos={repos} />} <b>{c.author}</b> <span className="pr-jobs-comment-text">{text.slice(0, 140)}{text.length > 140 ? "…" : ""}</span></>}
                            />
                        );
                    })}
                </div>
                <label className="stacked-field">Custom instructions (optional)
                    <AgentInput value={instructions} onChange={setInstructions} pending={attach} placeholder="Anything else the agent should do in the same run…" rows={3} />
                </label>
                <div className="pr-jobs-actions">
                    <Button variant="primary" disabled={!idle || busy || jobs === 0} onClick={() => void run()}>{busy ? "Starting…" : `Run ${jobs || ""} job${jobs === 1 ? "" : "s"} in one session`}</Button>
                    {!idle && <span className="field-hint">A run is in progress.</span>}
                    {note && <span className="field-hint">{note}</span>}
                </div>
            </div>
        </Panel>
    );
};


// ---- merging ----
const MERGE_KEY = "vortex.mergeMethod";
export const storedMergeMethod = (): MergeMethod => (storage.get(MERGE_KEY) as MergeMethod | null) ?? "squash";

// Why merging this PR now is questionable, or null when it is ready.
export const mergeWarning = (row: PrState): string | null => {
    const checks = parseChecks(row.checks_json).filter((c) => !isApprovalGateCheck(c));
    const failing = checks.filter((c) => checkOutcome(c) === "fail").length;
    const pending = checks.filter((c) => checkOutcome(c) === "pending").length;
    return failing ? `${failing} check(s) are failing` : pending ? `${pending} check(s) still running` : row.review_decision === "CHANGES_REQUESTED" ? "a reviewer requested changes" : row.review_decision !== "APPROVED" ? "not approved yet" : null;
};

// Asks, then merges the PR as the human.
export const mergePr = (task: TaskDetail["task"], row: PrState, method: MergeMethod, deleteBranch: boolean, onAction: Act): void => {
    const warn = mergeWarning(row);
    if (!confirm(`Merge ${repoName(row.repo)} #${row.number} (${method})${deleteBranch ? " and delete the remote branch" : ""}?${warn ? `\n\nNote: ${warn}.` : ""}`)) return;
    void onAction(() => api.mergePr(task.id, { repo: row.repo, method, deleteBranch }));
};

const MergeControls = ({ task, row, onAction }: { task: TaskDetail["task"]; row: PrState; onAction: Act }) => {
    const [method, setMethod] = useState<MergeMethod>(storedMergeMethod);
    const [deleteBranch, setDeleteBranch] = useState(true);
    const warn = mergeWarning(row);
    return (
        <span className="merge-controls">
            <Select value={method} aria-label="Merge method" onChange={(e) => { setMethod(e.target.value as MergeMethod); storage.set(MERGE_KEY, e.target.value); }}>
                <option value="squash">Squash</option>
                <option value="merge">Merge commit</option>
                <option value="rebase">Rebase</option>
            </Select>
            <Checkbox checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} label="Delete branch" title="Delete the remote branch after merging" />
            <Button variant="primary" disabled={task.status === "running"} title={warn ? `Merge anyway: ${warn}` : "Merge the pull request as you"} onClick={() => mergePr(task, row, method, deleteBranch, onAction)}>
                Merge{warn ? " anyway" : ""}
            </Button>
        </span>
    );
};

export const prOutcome = (row: PrState | undefined): { kind: "none" | "manual" | "failed" | "pending" | "approved" | "green" | "merged" | "closed"; text: string; tone: Tone } => {
    if (!row?.number) return row?.approved_at ? { kind: "manual", text: "approved, not on GitHub yet", tone: "warn" } : { kind: "none", text: "not created yet", tone: "neutral" };
    if (row.merged_at) return { kind: "merged", text: "merged", tone: "ok" };
    if (row.state === "CLOSED") return { kind: "closed", text: "closed", tone: "bad" };
    const gated = parseChecks(row.checks_json).filter((c) => !isApprovalGateCheck(c));
    const failed = gated.filter((c) => checkOutcome(c) === "fail").length;
    const pending = gated.filter((c) => checkOutcome(c) === "pending").length;
    if (failed) return { kind: "failed", text: `${failed} check(s) failing`, tone: "bad" };
    if (pending) return { kind: "pending", text: `${pending} check(s) running`, tone: "wait" };
    if (gated.length === 0 && row.pushed_at && Date.now() - new Date(row.pushed_at).getTime() < 10 * 60_000) return { kind: "pending", text: "waiting for checks to start", tone: "wait" };
    if (row.review_decision === "APPROVED") return { kind: "approved", text: "approved", tone: "ok" };
    return { kind: "green", text: gated.length ? "checks green" : "no checks", tone: "accent" };
};

// Every check GitHub reported for the PR head, with its outcome, a link to its log, and how long a running one has been going.
const CHECKS_SHOWN = 12;
export const ChecksList = ({ checks }: { checks: PrCheck[] }) => {
    const [, tick] = useState(0);
    const [all, setAll] = useState(false);
    const running = checks.some((c) => checkOutcome(c) === "pending" && c.startedAt);
    useEffect(() => {
        if (!running) return;
        const t = setInterval(() => tick((n) => n + 1), 10_000);
        return () => clearInterval(t);
    }, [running]);
    if (checks.length === 0) return <span className="quiet">No checks reported yet.</span>;
    const order = { fail: 0, pending: 1, cancelled: 2, pass: 3 };
    const sorted = [...checks].sort((a, b) => order[checkOutcome(a)] - order[checkOutcome(b)] || (a.name ?? a.context ?? "").localeCompare(b.name ?? b.context ?? ""));
    const count = (o: keyof typeof order): number => checks.filter((c) => checkOutcome(c) === o).length;
    const shown = all ? sorted : sorted.slice(0, CHECKS_SHOWN);
    return (
        <>
        <div className="checks-summary">
            {count("fail") > 0 && <Chip tone="bad">{count("fail")} failing</Chip>}
            {count("pending") > 0 && <Chip tone="wait">{count("pending")} running</Chip>}
            {count("pass") > 0 && <Chip tone="ok">{count("pass")} passed</Chip>}
            {count("cancelled") > 0 && <Chip>{count("cancelled")} cancelled</Chip>}
        </div>
        <ul className="checks">
            {shown.map((c, i) => {
                const o = checkOutcome(c);
                const gate = isApprovalGateCheck(c);
                const url = c.detailsUrl ?? c.targetUrl;
                const label = c.name ?? c.context ?? "check";
                const st = (c.conclusion ?? c.state ?? c.status ?? "pending").toLowerCase().replace(/_/g, " ");
                return (
                    <li key={i} className={`check ${o} ${gate ? "gate" : ""}`}>
                        <Chip tone={gate ? "neutral" : o === "pass" ? "ok" : o === "fail" ? "bad" : o === "cancelled" ? "neutral" : "wait"}>{gate ? "manual gate" : o === "pending" ? (c.status === "IN_PROGRESS" || c.startedAt ? "running" : "queued") : st}</Chip>
                        {url ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>}
                        {o === "pending" && c.startedAt && <span className="field-hint">{elapsed(c.startedAt)}</span>}
                        {o !== "pending" && c.startedAt && c.completedAt && <span className="field-hint">{elapsed(c.startedAt, c.completedAt)}</span>}
                        {c.workflowName && c.workflowName !== label && <span className="field-hint">{c.workflowName}</span>}
                    </li>
                );
            })}
        </ul>
        {sorted.length > CHECKS_SHOWN && <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>{all ? "Show fewer checks" : `Show all ${sorted.length} checks`}</Button>}
        </>
    );
};

// The repository's branch and the base it diffs against / its PR targets, editable in place: one repository's base
// can be moved (e.g. onto the trunk once the parent's PR for that repository merged) at any stage, PR draft or not.
// The stored value is a plain branch (every repository) or a per-repo map; editing one repository keeps the others.
const BaseLine = ({ task, repo, repos, onAction }: { task: TaskDetail["task"]; repo: string; repos: string[]; onAction: Act }) => {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState("");
    const bases = parseBaseBranch(task.base_branch);
    const base = typeof bases === "string" ? bases : bases?.[repo];
    const save = () => {
        const next: Record<string, string> = typeof bases === "string" ? Object.fromEntries(repos.map((r) => [r, bases])) : { ...(bases ?? {}) };
        if (value.trim()) next[repo] = value.trim();
        else delete next[repo];
        void onAction(() => api.patchTask(task.id, { baseBranch: Object.keys(next).length ? next : null })).then(() => setEditing(false));
    };
    if (editing)
        return (
            <span className="branch-line">
                <BranchPicker envId={task.env_id} repo={repo} value={value} onChange={setValue} placeholder="Environment default" />
                <Button size="sm" variant="primary" onClick={save}>Save</Button>
                <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </span>
        );
    return (
        <span className="branch-line">
            <code title="The branch this repository diffs against and its PR targets (the environment default when none is set)">{base ?? "environment default"}</code>
            {task.status !== "running" && (
                <Button size="sm" variant="ghost" title="Change this repository's base branch (then use Rebase onto the latest base in the task menu)" onClick={() => { setValue(base ?? ""); setEditing(true); }}>Change</Button>
            )}
        </span>
    );
};

// Whether each repository's branch still goes onto its latest base: merged in memory, then the environment's base check on
// the result (server base-check.ts), every 10 minutes and on "check now". The detail (conflicted files, the check's
// output) opens under the line.
export const BaseChecks = ({ detail, onAction }: { detail: TaskDetail; onAction: Act }) => {
    const { task } = detail;
    const rows = detail.baseChecks ?? [];
    const [checking, setChecking] = useState(false);
    if (!task.branch || !task.worktree_path) return null;
    const repos = rows.map((r) => r.repo);
    const now = () => {
        setChecking(true);
        void onAction(() => api.baseCheck(task.id)).finally(() => setChecking(false));
    };
    return (
        <Panel
            title="Branch against its base"
            hint="Merges each repository's branch with its latest base in memory and runs the environment's base check on the result, every 10 minutes and on request."
            actions={task.status !== "running" ? <Button size="sm" disabled={checking} onClick={now}><Icon name="refresh" />{checking ? "Checking…" : rows.length ? "Check now" : "Check against the latest base"}</Button> : undefined}
        >
            {rows.length === 0 && <p className="quiet">Not checked yet.</p>}
            {rows.map((r) => {
                const [head, ...rest] = r.detail.split("\n");
                return (
                    <div key={r.repo} className="base-row">
                        <RepoChip repo={r.repo} repos={repos} />
                        <BaseCheckChip state={r.state} detail={r.detail} />
                        {rest.length > 0 ? (
                            <details>
                                <summary>{head}</summary>
                                <pre>{rest.join("\n")}</pre>
                            </details>
                        ) : (
                            <span>{head}</span>
                        )}
                        <span className="field-hint" title={`branch ${r.head_sha.slice(0, 10)}, ${r.base} ${r.base_sha.slice(0, 10)}`}>{new Date(r.checked_at).toLocaleTimeString()}</span>
                    </div>
                );
            })}
        </Panel>
    );
};

// A compact PR summary for the task header: one chip per repository.
export const PrSummaryChips = ({ detail, onOpen }: { detail: TaskDetail; onOpen: (repo: string) => void }) => {
    const repos = prRepos(detail);
    return (
        <>
            {repos.map((repo) => {
                const row = prStateOf(detail, repo);
                const o = prOutcome(row);
                if (o.kind === "none") return null;
                return (
                    <Button key={repo} variant="ghost" size="sm" className="pr-summary" onClick={() => onOpen(repo)} title={`Open the ${repoName(repo)} pull request`}>
                        <Chip tone={o.tone}>{repos.length > 1 ? `${repoName(repo)} ` : "PR "}{row?.number ? `#${row.number} ` : ""}{o.text}</Chip>
                    </Button>
                );
            })}
        </>
    );
};

// Details for the PR stages: one tab per repository, each with its own state, checks and merge.
export const PrPanel = ({ detail, onAction, focusRepo, onFocusRepo }: { detail: TaskDetail; onAction: Act; focusRepo?: string | null; onFocusRepo?: (repo: string) => void }) => {
    const { task } = detail;
    const repos = prRepos(detail);
    const [localActive, setLocalActive] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const active = onFocusRepo ? Math.max(0, repos.indexOf(focusRepo ?? "")) : localActive;
    const setActive = (i: number) => (onFocusRepo ? onFocusRepo(repos[i] ?? "") : setLocalActive(i));
    if (repos.length === 0) return <EmptyState icon="inbox" title="No pull request yet">{task.status_line ?? "It is opened once the draft is approved."}</EmptyState>;
    const repo = repos[Math.min(active, repos.length - 1)]!;
    const row = prStateOf(detail, repo);
    const o = prOutcome(row);
    const checks = parseChecks(row?.checks_json);
    const gated = checks.filter((c) => !isApprovalGateCheck(c));
    const cancelled = gated.filter((c) => checkOutcome(c) === "cancelled").length;
    const countable = gated.length - cancelled;
    const passed = gated.filter((c) => checkOutcome(c) === "pass").length;
    const open = !!row?.url && !row.merged_at && row.state !== "CLOSED";
    return (
        <>
            {repos.length > 1 && (
                <TabList variant="pill" className="pr-repo-tabs">
                    {repos.map((r, i) => {
                        const rRow = prStateOf(detail, r);
                        const rO = prOutcome(rRow);
                        return (
                            <Tab key={r} active={i === active} className={`repo-${repoColorClass(r, repos)}`} onClick={() => setActive(i)}>
                                {repoName(r)} <Chip tone={rO.tone}>{rRow?.number ? `#${rRow.number}` : rO.text}</Chip>
                            </Tab>
                        );
                    })}
                </TabList>
            )}
            <Panel
                title={<><RepoChip repo={repo} repos={repos} /> Pull request{row?.number ? ` #${row.number}` : ""}</>}
                badge={<Chip tone={o.tone}>{o.text}</Chip>}
                actions={
                    <>
                        {open && <Button size="sm" disabled={refreshing} title="Re-read checks, review decisions and comments from GitHub now" onClick={() => { setRefreshing(true); void onAction(() => api.refreshPr(task.id)).finally(() => setRefreshing(false)); }}><Icon name="refresh" />{refreshing ? "Refreshing…" : "Refresh"}</Button>}
                        {row?.url && <a className="button-link" href={row.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
                    </>
                }
            >
                <KeyValue
                    columns={2}
                    items={[
                        ...(task.branch ? [{ label: "Branch", value: <code>{task.branch}</code> }] : []),
                        ...(task.branch ? [{ label: "Base", value: <BaseLine task={task} repo={repo} repos={repos} onAction={onAction} /> }] : []),
                        ...(row?.url
                            ? [
                                  { label: "Review", value: row.review_decision ? row.review_decision.toLowerCase().replace("_", " ") : "No decision yet" },
                                  { label: "Merged", value: row.merged_at ? new Date(row.merged_at).toLocaleString() : row.state === "CLOSED" ? "Closed without merge" : "Not yet" },
                                  { label: "Checks passed", value: gated.length ? `${passed} of ${countable}${cancelled ? ` (${cancelled} cancelled)` : ""}${checks.length > gated.length ? `, plus ${checks.length - gated.length} gate(s)` : ""}` : "None reported" },
                                  { label: "Last poll", value: `${new Date(row.updated_at).toLocaleString()}${row.pushed_at ? `, last push ${new Date(row.pushed_at).toLocaleString()}` : ""}` },
                              ]
                            : []),
                    ]}
                />
                {!row?.url && <p className="quiet">{row?.approved_at ? "Approved, but not on GitHub yet. The status line says what is left to do by hand." : "Not created yet."}</p>}
                {row?.approved_at && !row.number && task.status !== "running" && (
                    <div className="actions">
                        <Button title="Push this repository's branch and open its PR now (uses the approved draft; needs the environment to allow pushes and PR creation, or a PR opened by hand is picked up by branch)" onClick={() => onAction(() => api.createApprovedPrs(task.id))}>Push and open now</Button>
                    </div>
                )}
                {open && (
                    <>
                        <h3 className="panel-sub">Checks</h3>
                        <ChecksList checks={checks} />
                        {o.kind === "failed" && task.status !== "running" && (
                            <div className="actions">
                                <Button variant="primary" onClick={() => onAction(() => api.fixCi(task.id, repo))}>Fix CI on {repoName(repo)}</Button>
                            </div>
                        )}
                    </>
                )}
                {!open && row?.url && checks.length > 0 && (
                    <>
                        <h3 className="panel-sub">Checks</h3>
                        <ChecksList checks={checks} />
                    </>
                )}
            </Panel>
            {open && row && (
                <Panel title="Merge" hint="Merges the pull request as you, with the method you pick.">
                    <MergeControls task={task} row={row} onAction={onAction} />
                </Panel>
            )}
        </>
    );
};


// The CI autopilot: the per-task switch, and each round from the triage to the push.
const AUTOPILOT_PHASE: Record<string, [string, Tone]> = {
    triage: ["triaging", "wait"], fixing: ["fixing", "wait"], reviewing: ["reviewing the fix", "wait"], addressing: ["addressing the review", "wait"], pushing: ["pushing", "wait"],
    pushed: ["pushed", "ok"], denied: ["left for you", "warn"], failed: ["failed", "bad"], stopped: ["stopped", "neutral"],
};
export const CiAutopilotCard = ({ task, onAction }: { task: TaskDetail["task"]; onAction: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const [d, setD] = useState<CiAutopilot | null>(null);
    useEffect(() => { void api.ciAutopilot(task.id).then(setD).catch(() => undefined); }, [task.id, task.updated_at, task.status_line]);
    if (!d) return null;
    const explicit = task.ci_autopilot === 0 || task.ci_autopilot === 1;
    return (
        <Panel title="CI autopilot" badge={<Chip tone={d.on ? "ok" : "neutral"}>{d.on ? "on" : "off"}</Chip>}>
            <div className="po-comment-top">
                <Checkbox title="When the PR's checks finish red, fix the failures this branch caused (its migrations, its tests, untouched tests it broke that pass on base, lint on its own lines), review the fix, and push" checked={d.on} onChange={(e) => void onAction(() => api.patchTask(task.id, { ciAutopilot: e.target.checked }))} label="Fix this task's own CI failures by itself" />
                {explicit && <Button size="sm" variant="ghost" onClick={() => void onAction(() => api.patchTask(task.id, { ciAutopilot: null }))}>Use the environment's default</Button>}
                {!explicit && <span className="field-hint">The environment's default.</span>}
                {d.on && <span className="field-hint">{d.consecutive} of 5 rounds in a row{d.busy ? ", working…" : ""}</span>}
            </div>
            {d.stopped && <Notice tone="bad">Stopped: {d.stopped}. Any action of yours on the task lets it run again.</Notice>}
            {[...d.rounds].reverse().map((r) => {
                const [label, chip] = AUTOPILOT_PHASE[r.phase] ?? [r.phase, "neutral" as Tone];
                return (
                    <details key={r.id} className="po-comment-card" open={r === d.rounds[d.rounds.length - 1]}>
                        <summary className="po-comment-top">
                            <b>#{r.prNumber}</b>{r.repo && <Chip>{r.repo}</Chip>} <code>{r.headSha.slice(0, 7)}</code>
                            <Chip tone={chip}>{label}</Chip>
                            {r.verified && <span className="field-hint">{r.verified.filter((v) => v.allowed).length} to fix · {r.verified.filter((v) => !v.allowed).length} yours</span>}
                            <span className="field-hint">{new Date(r.at).toLocaleString()}</span>
                        </summary>
                        {r.error && <Notice tone="bad">{r.error}</Notice>}
                        {r.triage?.summary && <p>{r.triage.summary}</p>}
                        {r.verified && r.verified.length > 0 && (
                            <table className="checks-table">
                                <thead><tr><th>Check</th><th>Kind</th><th>Failure</th><th>Verdict</th><th>Why</th></tr></thead>
                                <tbody>
                                    {r.verified.map((v, i) => (
                                        <tr key={i}>
                                            <td>{v.check}</td>
                                            <td>{v.kind.replace(/_/g, " ")}</td>
                                            <td>{v.what}{v.keep.length > 0 && <div className="field-hint">{v.keep.join(", ")}</div>}</td>
                                            <td><Chip tone={v.allowed ? "ok" : "warn"}>{v.allowed ? "fix" : "yours"}</Chip></td>
                                            <td className="field-hint">{v.why}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                        {r.review && (
                            <div className="po-human-note">
                                <b>Review of the fix:</b> {r.review.summary}
                                {r.review.findings.length > 0 && <ul className="plain">{r.review.findings.map((f, i) => <li key={i}><Chip>{f.severity}</Chip> ({f.confidence}/10) <code>{f.file}{f.line ? `:${f.line}` : ""}</code> {f.title}</li>)}</ul>}
                            </div>
                        )}
                        {r.pushed && <div className="field-hint">Pushed: {Object.entries(r.pushed).map(([repo, sha]) => `${repo || "repo"} ${sha.slice(0, 7)}`).join(", ")}</div>}
                    </details>
                );
            })}
            {d.rounds.length === 0 && <p className="quiet">No red CI run yet.</p>}
        </Panel>
    );
};

export const PrFixReplies = ({ taskId, updatedAt }: { taskId: string; updatedAt: string }) => {
    const [d, setD] = useState<PrFixRepliesData | null>(null);
    const [err, setErr] = useState<string | null>(null);
    useEffect(() => { void api.prFixReplies(taskId).then(setD).catch(() => setD(null)); }, [taskId, updatedAt]);
    if (!d) return null;
    const rows = Object.entries(d.repos).flatMap(([repo, r]) => r.comments.map((c) => ({ repo, r, c })));
    if (!rows.length) return null;
    const picked = (repo: string, id: number) => d.replies.find((x) => x.repo === repo && x.commentId === id);
    const save = async (next: Array<{ repo: string; commentId: number; sha: string }>) => {
        try { setD(await api.setPrFixReplies(taskId, next)); setErr(null); } catch (e) { setErr(String((e as Error).message ?? e)); }
    };
    const current = () => d.replies.map(({ repo, commentId, sha }) => ({ repo, commentId, sha }));
    return (
        <Panel title={`Reply to the addressed comments (${d.replies.length}/${d.outcomes ? d.outcomes.filter((o) => o.addressed).length : rows.length})`}>
            <p className="quiet">After <b>Approve and push</b>, each ticked comment gets "Addressed in &lt;commit link&gt;" on GitHub from your account. A line comment gets it in its thread; a review or general comment gets a PR comment quoting it.</p>
            {err && <Notice tone="bad">{err}</Notice>}
            {rows.map(({ repo, r, c }) => {
                const p = picked(repo, c.id);
                const commits = d.commits[repo] ?? [];
                // The fix run said whether this round addressed the comment and in which commit: then the reply links
                // to that commit and a comment it did not address gets no reply at all.
                const o = d.outcomes?.find((x) => x.repo === repo && x.commentId === c.id);
                const sha = p?.sha ?? o?.sha ?? commits[0]?.sha ?? "";
                const commit = commits.find((k) => k.sha === sha);
                const head = (
                    <>
                        <b>{c.author}</b> <Chip>{c.kind === "line" ? `${c.path ?? ""}${c.line ? `:${c.line}` : ""}` : c.kind}</Chip>
                        <span className="fix-reply-body">{c.body.split("\n")[0]?.slice(0, 140)}</span>
                        <a href={c.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub"><Icon name="external" /></a>
                    </>
                );
                return (
                    <div key={`${repo}:${c.id}`} className="fix-reply-row">
                        {o && !o.addressed ? (
                            <>
                                <span className="fix-reply-head">{head}</span>
                                <Chip tone="warn">not addressed</Chip>
                                {o.note && <span className="field-hint">{o.note}</span>}
                            </>
                        ) : (
                            <>
                                <Checkbox checked={!!p} disabled={!sha} onChange={(e) => void save(e.target.checked ? [...current(), { repo, commentId: c.id, sha }] : current().filter((x) => !(x.repo === repo && x.commentId === c.id)))} label={head} />
                                {o ? (
                                    <span className="field-hint">Addressed in <code>{sha.slice(0, 7)}</code> {commit?.subject.slice(0, 70) ?? ""}</span>
                                ) : commits.length > 0 ? (
                                    <Select value={sha} disabled={!p} onChange={(e) => void save(current().map((x) => (x.repo === repo && x.commentId === c.id ? { ...x, sha: e.target.value } : x)))}>
                                        {commits.map((k) => <option key={k.sha} value={k.sha}>{k.sha.slice(0, 7)} {k.subject.slice(0, 60)}</option>)}
                                    </Select>
                                ) : <span className="quiet">No commit in this round.</span>}
                            </>
                        )}
                        {p?.posted && <a className="chip ok" href={p.posted} target="_blank" rel="noreferrer">replied</a>}
                        {p?.error && <Chip tone="bad" title={p.error}>reply failed</Chip>}
                        <span className="field-hint">PR #{r.number}</span>
                    </div>
                );
            })}
        </Panel>
    );
};

export const TaskDbPanel = ({ task, onAction }: { task: TaskDetail["task"]; onAction: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const [d, setD] = useState<TaskDbInfo | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { void api.taskDb(task.id).then(setD).catch(() => undefined); }, [task.id, task.updated_at]);
    if (!d || (!d.active && !d.row)) return null;
    const row = d.row;
    const own = row?.status === "ready";
    const run = async (): Promise<void> => {
        setBusy(true);
        try {
            await onAction(() => api.recreateTaskDb(task.id));
            setD(await api.taskDb(task.id));
        } finally {
            setBusy(false);
        }
    };
    const size = d.sizeMb == null ? null : d.sizeMb >= 1024 ? `${(d.sizeMb / 1024).toFixed(1)} GB` : `${d.sizeMb} MB`;
    return (
        <Panel title="Task database" hint="The task's own database copy, when the environment has task databases. Recreate copies the template again.">
            {own ? (
                <KeyValue items={[{ label: "Database", value: <code>{row!.name}{size ? `, ${size}` : ""}</code> }, { label: "Copied from", value: `${row!.template}, ${new Date(row!.created_at).toLocaleString()}` }]} />
            ) : row ? (
                <Notice tone={row.status === "creating" ? "info" : "bad"}>{row.status === "creating" ? "Being created…" : `Could not be created: ${row.error ?? "unknown error"}`}</Notice>
            ) : (
                <p className="quiet">On the environment's shared database{d.template ? ` (${d.template})` : ""}.</p>
            )}
            {d.active && (
                <div className="actions">
                    <Button size="sm" disabled={busy || task.status === "running" || row?.status === "creating"} title={own ? "Stop the app, migrate the template to the base branch, copy it again (this task's data is lost), point the worktree at the copy" : "Stop the app, migrate the template to the base branch, copy it for this task, point the worktree at the copy"} onClick={() => void run()}>
                        {busy ? "Working…" : own ? "Recreate" : row ? "Retry" : "Adopt"}
                    </Button>
                </div>
            )}
        </Panel>
    );
};


