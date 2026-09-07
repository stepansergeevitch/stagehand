import { useEffect, useMemo, useRef, useState } from "react";
import { api, STAGE_LABEL, STAGE_ORDER, type Account, type QaPass, type Stage, type TaskDetail } from "./api";
import { Terminal } from "./Terminal";
import { Markdown } from "./Markdown";
import { ServicesPanel } from "./Services";
import { DiffView, useDraftComments, type PriorComment } from "./DiffView";
import type { Env, LineComment, PrComment, PrComments, Review } from "./api";

// GitHub PR comments of one kind (human or automation): review verdicts, line comments (path:line), general comments.
const PrCommentList = ({ title, items, loading, error, hasPr, url, fetchedAt, onRefresh }: { title: string; items: PrComment[] | null; loading: boolean; error: string | null; hasPr: boolean; url: string | null; fetchedAt: string | null; onRefresh: () => void }) => (
    <Card title={title} badge={items ? <span className="chip">{items.length}</span> : undefined}>
        {!hasPr && <div className="empty">No pull request yet — comments appear here once it exists.</div>}
        {hasPr && (
            <div className="actions" style={{ marginTop: 0 }}>
                <button onClick={onRefresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
                {url && <a href={url} target="_blank" rel="noreferrer">open PR ↗</a>}
                {fetchedAt && <span className="field-hint">fetched {new Date(fetchedAt).toLocaleTimeString()}</span>}
            </div>
        )}
        {error && <div className="blocked-box">{error}</div>}
        {items && items.length === 0 && <div className="empty">nothing here</div>}
        {items && items.length > 0 && (
            <div className="gh-comments">
                {[...items].sort((a, b) => a.at.localeCompare(b.at)).map((c) => (
                    <div key={`${c.kind}-${c.id}`} className={`gh-comment ${c.kind}`}>
                        <div className="gh-head">
                            <b>{c.author}</b>
                            {c.kind === "review" && <span className={`chip ${c.state === "APPROVED" ? "ok" : c.state === "CHANGES_REQUESTED" ? "bad" : ""}`}>{c.state.toLowerCase().replace("_", " ")}</span>}
                            {c.kind === "line" && <code>{c.path}{c.line !== null ? `:${c.line}` : ""}{c.outdated ? " (outdated)" : ""}</code>}
                            {c.kind === "general" && <span className="chip">comment</span>}
                            <span className="field-hint">{new Date(c.at).toLocaleString()}</span>
                            <a href={c.url} target="_blank" rel="noreferrer">↗</a>
                        </div>
                        {c.body && <Markdown source={c.body} />}
                    </div>
                ))}
            </div>
        )}
    </Card>
);

const parseComments = (r: Review): LineComment[] => {
    try {
        return r.comments ? (JSON.parse(r.comments) as LineComment[]) : [];
    } catch {
        return [];
    }
};

// Earlier rounds of this stage's review, so the reviewer can check what was asked before.
const ReviewHistory = ({ reviews, stage }: { reviews: Review[]; stage: Stage }) => {
    const rounds = reviews.filter((r) => r.stage === stage && r.verdict === "changes");
    if (rounds.length === 0) return null;
    return (
        <div className="review-history">
            {rounds.map((r, i) => {
                const cs = parseComments(r);
                return (
                    <details key={r.id}>
                        <summary>Round {i + 1} · {new Date(r.created_at).toLocaleString()} · {cs.length} line comment{cs.length === 1 ? "" : "s"}{r.notes ? " · notes" : ""}</summary>
                        {r.notes && <div className="md">{r.notes}</div>}
                        {cs.length > 0 && (
                            <ul className="plain">
                                {cs.map((c, j) => <li key={j}><code>{c.path}:{c.line}</code> {c.text}</li>)}
                            </ul>
                        )}
                    </details>
                );
            })}
        </div>
    );
};

interface Props {
    detail: TaskDetail;
    accounts: Account[];
    env: Env | undefined;
    onError: (m: string) => void;
    feed: string[];
    terminal: string | null;
    onAction: (fn: () => Promise<unknown>) => Promise<void>;
    // The open tab is routed (part of the URL hash) so a reload lands on the same view.
    tab: Tab;
    setTab: (t: Tab) => void;
    onOpenTerminal: () => Promise<void>;
    onCloseTerminal: () => void;
}

const useArtifactText = (taskId: string, rel: string, exists: boolean): string | null => {
    const [text, setText] = useState<string | null>(null);
    useEffect(() => {
        if (!exists) return;
        void fetch(api.artifactUrl(taskId, rel)).then((r) => (r.ok ? r.text() : null)).then(setText);
    }, [taskId, rel, exists]);
    return text;
};

const Card = ({ title, badge, children }: { title: React.ReactNode; badge?: React.ReactNode; children: React.ReactNode }) => (
    <section className="card">
        <h2>{title} {badge}</h2>
        {children}
    </section>
);

// A collapsible sub-heading inside a card (open by default).
const Sub = ({ title, open = true, children }: { title: React.ReactNode; open?: boolean; children: React.ReactNode }) => (
    <details className="sub" open={open}>
        <summary><h3>{title}</h3></summary>
        <div className="sub-body">{children}</div>
    </details>
);

// The ticket as it was fetched from ClickUp/Linear: everything Claude was given, unabridged. Without a stored copy the tab
// tries one server-side fetch (REST token only, never an agent run) and otherwise shows a plain message with the link.
const TicketView = ({ detail, onFetch }: { detail: TaskDetail; onFetch: () => Promise<void> }) => {
    const { task, ticket } = detail;
    const [state, setState] = useState<"idle" | "fetching" | "failed">("idle");
    const [reason, setReason] = useState<string | null>(null);
    const tried = useRef(false);
    const fetchNow = async () => {
        setState("fetching");
        try {
            await onFetch();
            setState("idle");
        } catch (e) {
            setReason(String((e as Error).message ?? e));
            setState("failed");
        }
    };
    useEffect(() => {
        if (ticket || tried.current) return;
        tried.current = true;
        void fetchNow();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ticket]);
    if (!ticket) {
        const link = task.ticket_url ? <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.ticket_id} ↗</a> : <code>{task.ticket_id}</code>;
        return (
            <section className="card">
                <h2>Ticket</h2>
                {state === "fetching" && <p className="quiet">Fetching {task.ticket_id} from {task.source}…</p>}
                {state !== "fetching" && (
                    <div className="blocked-box">
                        Ticket {link} could not be fetched{reason ? `: ${reason}` : ""}.
                        <div className="actions"><button onClick={() => void fetchNow()}>Fetch again</button></div>
                    </div>
                )}
            </section>
        );
    }
    return (
        <section className="card ticket-view">
            <h2>{ticket.id} {ticket.title}</h2>
            <div className="sub">
                {ticket.status && <span className="chip">{ticket.status}</span>}
                <span className="chip">{ticket.source} · {ticket.fetchedVia}</span>
                {(ticket.url ?? task.ticket_url) && <a href={ticket.url ?? task.ticket_url ?? ""} target="_blank" rel="noreferrer">open in {task.source} ↗</a>}
            </div>
            {ticket.acceptanceCriteria.length > 0 && (
                <Sub title="Acceptance criteria">
                    <ul className="plain">{ticket.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </Sub>
            )}
            <Sub title="Description">
                {ticket.description.trim() ? <Markdown source={ticket.description} /> : <div className="empty">no description</div>}
            </Sub>
            {ticket.parent && (
                <Sub title={<>Parent · {ticket.parent.id} {ticket.parent.title}</>} open={false}>
                    {ticket.parent.description.trim() ? <Markdown source={ticket.parent.description} /> : <div className="empty">no description</div>}
                </Sub>
            )}
        </section>
    );
};

// Status lines that ask for a login carry the app URL; make it clickable so a closed automation window is not a dead end.
const Linkified = ({ text }: { text: string }) => {
    const parts = text.split(/(https?:\/\/[^\s)]+)/g);
    return <>{parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : <span key={i}>{p}</span>))}</>;
};

const RERUNNABLE: ReadonlySet<Stage> = new Set(["research", "design_proposal", "qa_baseline", "implementation", "manual_qa", "pr_creation_review", "pr_red"]);
const PR_STAGES: ReadonlySet<Stage> = new Set(["pr_waiting", "pr_red", "pr_green", "pr_approved", "done"]);

const statusChip = (s: string) => {
    const cls = s === "waiting_user" || s === "blocked" ? "wait" : s === "running" ? "accent" : s === "failed" ? "bad" : s === "done" ? "ok" : s === "rate_limited" ? "warn" : "";
    return <span className={`chip ${cls}`}>{s.replace("_", " ")}</span>;
};

export type Tab = "work" | "runs" | "design" | "code" | "comments" | "ticket";
export const TASK_TABS: readonly Tab[] = ["work", "runs", "design", "code", "comments", "ticket"];

// PR status for the header widget, derived from the stage, the stored PR state and the status line.
const PrWidget = ({ detail }: { detail: TaskDetail }) => {
    const { task, prState, pr } = detail;
    const checks = ((): Array<{ name?: string; context?: string; conclusion?: string; state?: string }> => {
        try {
            return prState?.checks_json ? (JSON.parse(prState.checks_json) as Array<{ name?: string; context?: string; conclusion?: string; state?: string }>) : [];
        } catch {
            return [];
        }
    })();
    const failed = checks.filter((c) => /FAILURE|ERROR|CANCELLED|TIMED_OUT/i.test(c.conclusion ?? c.state ?? ""));
    const passed = checks.filter((c) => /SUCCESS|NEUTRAL|SKIPPED/i.test(c.conclusion ?? c.state ?? ""));
    const pending = checks.length - failed.length - passed.length;
    let status: React.ReactNode;
    if (prState?.merged_at) status = <span className="chip ok">merged</span>;
    else if (prState?.url) {
        const cls = failed.length ? "bad" : pending > 0 ? "warn" : prState.review_decision === "APPROVED" ? "ok" : "accent";
        const text = failed.length ? `${failed.length} check(s) failing` : pending > 0 ? `${pending} check(s) running` : prState.review_decision === "APPROVED" ? "approved" : checks.length ? "checks green" : STAGE_LABEL[task.stage];
        status = <span className={`chip ${cls}`}>{text}</span>;
    } else if (task.stage === "pr_creation_review") status = <span className="chip wait">{task.status === "waiting_user" ? "draft ready — approve to create" : "drafting"}</span>;
    else if (PR_STAGES.has(task.stage)) status = <span className="chip warn">not created yet</span>;
    else if (pr) status = <span className="chip">draft</span>;
    else status = <span className="chip">none yet</span>;
    return (
        <section className="card widget">
            <h2>Pull request</h2>
            <div className="widget-body">
                {status}
                {prState?.url && <a href={prState.url} target="_blank" rel="noreferrer">#{prState.number} ↗</a>}
                {prState?.review_decision && <span className="chip">{prState.review_decision.toLowerCase().replace("_", " ")}</span>}
                {checks.length > 0 && <span className="mono small">{passed.length}/{checks.length} checks passed{failed.length ? ` · failing: ${failed.map((c) => c.name ?? c.context).join(", ")}` : ""}</span>}
                {!prState?.url && PR_STAGES.has(task.stage) && task.status_line && <span className="small">{task.status_line}</span>}
                {task.branch && <code className="small">⎇ {task.branch}</code>}
            </div>
        </section>
    );
};

export const TaskDetailView = ({ detail, accounts, env, onError, feed, terminal, onAction, tab, setTab, onOpenTerminal, onCloseTerminal }: Props) => {
    const { task, runs, design, impl, qaBefore, qaAfter, pr, research } = detail;
    const has = (p: string) => detail.artifacts.some((a) => a.path === p);
    const researchMd = useArtifactText(task.id, "research.md", has("research.md"));
    const designMd = useArtifactText(task.id, "design.md", has("design.md"));
    const [notes, setNotes] = useState("");
    const [routeTo, setRouteTo] = useState<"implementation" | "design_proposal">("implementation");
    const [comments, changeComment, clearComments] = useDraftComments(task.id);
    const pending = Object.entries(comments);
    const canComment = task.status === "waiting_user" && task.stage === "user_review";
    const currentIdx = STAGE_ORDER.indexOf(task.stage);
    const skipped = new Set<Stage>(design && design.qa.length === 0 ? ["qa_baseline", "manual_qa"] : []);
    const waiting = task.status === "waiting_user";
    const [step, setStep] = useState<Stage>(task.stage);
    useEffect(() => {
        setStep(task.stage);
    }, [task.id]);
    useEffect(() => setStep(task.stage), [task.stage]);
    // GitHub PR comments (humans + automation), loaded when a tab needs them; line comments are also shown inline in the diff.
    const [commentsTab, setCommentsTab] = useState<"user" | "pr" | "automation">("user");
    const [gh, setGh] = useState<PrComments | null>(null);
    const [ghLoading, setGhLoading] = useState(false);
    const [ghError, setGhError] = useState<string | null>(null);
    const loadGh = async () => {
        if (!detail.prState?.number) return;
        setGhLoading(true);
        setGhError(null);
        try {
            setGh(await api.prComments(task.id));
        } catch (e) {
            setGhError(String((e as Error).message ?? e));
        } finally {
            setGhLoading(false);
        }
    };
    useEffect(() => {
        setGh(null);
        if ((tab === "comments" || tab === "code") && detail.prState?.number) void loadGh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task.id, tab, detail.prState?.number]);
    const prior: PriorComment[] = [
        ...detail.reviews
            .filter((r) => r.stage === "user_review" && r.verdict === "changes")
            .flatMap((r, i) => parseComments(r).map((c) => ({ ...c, round: i + 1 }))),
        ...(gh ? [...gh.human, ...gh.automation] : [])
            .filter((c): c is Extract<PrComment, { kind: "line" }> => c.kind === "line" && c.line !== null)
            .map((c) => ({ path: c.path, line: c.line ?? 0, side: c.side, snippet: c.snippet, text: c.body, round: 0, by: c.author })),
    ];

    // Which workflow steps have something to show (or are the current one).
    const stepHasContent = (s: Stage): boolean => {
        switch (s) {
            case "research": return !!research;
            case "design_proposal": return !!design;
            case "qa_baseline": return !!qaBefore;
            case "implementation": return !!impl;
            case "manual_qa": return !!qaAfter;
            case "user_review": return detail.reviews.some((r) => r.stage === "user_review") || task.stage === "user_review";
            case "pr_creation_review": return !!pr;
            default: return PR_STAGES.has(s) && (!!detail.prState || s === task.stage);
        }
    };
    const steps = STAGE_ORDER.filter((s, i) => i <= currentIdx && !skipped.has(s) && (stepHasContent(s) || s === task.stage));
    // PR stages share one panel.
    const stepKey = (s: Stage): Stage => (PR_STAGES.has(s) ? "pr_waiting" : s);

    const reviewBox = waiting && (
        <div className="review-box">
            <b>{STAGE_LABEL[task.stage]} — your call.</b>
            {task.stage === "user_review" && (
                <label style={{ display: "block", margin: "6px 0" }}>
                    On changes, send back to{" "}
                    <select value={routeTo} onChange={(e) => setRouteTo(e.target.value as typeof routeTo)}>
                        <option value="implementation">Implementation</option>
                        <option value="design_proposal">Design Proposal</option>
                    </select>
                </label>
            )}
            <textarea placeholder={canComment ? "General comments (optional if you left line comments in Code changes)" : "Notes for Claude (required for 'Request changes')"} value={notes} onChange={(e) => setNotes(e.target.value)} />
            {canComment && pending.length > 0 && (
                <div className="pending-comments">
                    {pending.length} line comment{pending.length === 1 ? "" : "s"} to send:
                    <ul className="plain">
                        {pending.map(([k, c]) => (
                            <li key={k}><code>{c.path}:{c.line}</code>{c.text} <button className="danger" onClick={() => changeComment(k, null)} title="remove">×</button></li>
                        ))}
                    </ul>
                </div>
            )}
            <div className="actions">
                <button
                    className="primary"
                    onClick={() => onAction(async () => { await api.review(task.id, { verdict: "approve", ...(notes ? { notes } : {}) }); clearComments(); setNotes(""); })}
                >
                    {task.stage === "pr_creation_review" ? "Approve & create PR" : "Approve"}
                </button>
                <button
                    disabled={!notes.trim() && !(canComment && pending.length > 0)}
                    onClick={() =>
                        onAction(async () => {
                            await api.review(task.id, {
                                verdict: "changes",
                                ...(notes.trim() ? { notes } : {}),
                                ...(task.stage === "user_review" ? { routeTo, comments: pending.map(([, c]) => c) } : {}),
                            });
                            clearComments();
                            setNotes("");
                        })
                    }
                >
                    Request changes{canComment && pending.length > 0 ? ` (${pending.length})` : ""}
                </button>
                {task.stage === "user_review" && <button onClick={() => setTab("code")}>Open Code changes to comment on lines</button>}
            </div>
            <ReviewHistory reviews={detail.reviews} stage={task.stage} />
        </div>
    );

    const qaPanel = design && (qaBefore || qaAfter) && (
        <Card title="QA evidence">
            {task.status !== "running" && (
                <div className="actions" style={{ marginTop: 0 }}>
                    <button onClick={() => onAction(() => api.rerun(task.id, "qa_baseline"))}>Re-run QA baseline</button>
                    {currentIdx >= STAGE_ORDER.indexOf("manual_qa") && <button onClick={() => onAction(() => api.rerun(task.id, "manual_qa"))}>Re-run Manual QA</button>}
                </div>
            )}
            <QaGallery taskId={task.id} design={design} before={qaBefore} after={qaAfter} />
        </Card>
    );

    const stepPanel = (s: Stage): React.ReactNode => {
        switch (stepKey(s)) {
            case "research":
                return research ? (
                    <Card title="Research" badge={<span className={`chip ${research.classification === "bug" ? "bad" : "accent"}`}>{research.classification}</span>}>
                        <div className="kv"><b>Summary</b><span>{research.summary}</span><b>Branch</b><code>{research.branchName}</code><b>Areas</b><span>{research.affectedAreas.join(", ")}</span></div>
                        {researchMd && <Sub title="research.md" open={false}><Markdown source={researchMd} /></Sub>}
                    </Card>
                ) : <div className="empty">no research yet</div>;
            case "design_proposal":
                return design ? (
                    <Card title="Design proposal" badge={<span className={`chip ${design.classification === "bug" ? "bad" : "accent"}`}>{design.classification}</span>}>
                        <div className="kv">
                            <b>Plan</b><span>{design.plan.length} layer(s): {design.plan.map((p) => p.layer).join(", ")}</span>
                            <b>Tests</b><span>{design.testPlan.reduce((n, t) => n + t.cases.length, 0)} case(s) in {design.testPlan.length} file(s)</span>
                            <b>QA</b><span>{design.qa.length ? `${design.qa.length} scenario(s)` : `none — ${design.qaSkippedReason ?? "no reason given"}`}</span>
                        </div>
                        <div className="actions"><button onClick={() => setTab("design")}>Open the full proposal</button></div>
                    </Card>
                ) : <div className="empty">no design yet</div>;
            case "qa_baseline":
            case "manual_qa":
                return qaPanel ?? <div className="empty">no QA evidence yet</div>;
            case "implementation":
                return impl ? (
                    <Card title="Implementation" badge={<span className={`chip ${impl.gates.tests && impl.gates.typecheck ? "ok" : "bad"}`}>tests {impl.gates.tests ? "✓" : "✗"} · typecheck {impl.gates.typecheck ? "✓" : "✗"}</span>}>
                        <div className="kv">
                            <b>Coverage (new lines)</b><span>{impl.coverageNewLines ?? "—"}%</span>
                            <b>Backend</b><span>{impl.tests.backend ?? "—"}</span>
                            <b>Frontend</b><span>{impl.tests.frontend ?? "—"}</span>
                            <b>Files</b><span>{impl.files.map((f) => <code key={f} style={{ marginRight: 8 }}>{f}</code>)}</span>
                            <b>Commits</b><span>{impl.commits.length ? impl.commits.map((c) => <div key={c}><code>{c}</code></div>) : "none (uncommitted changes)"}</span>
                        </div>
                        {impl.notes && <Sub title="Notes from the implementer" open={false}><Markdown source={impl.notes} /></Sub>}
                        <div className="actions"><button onClick={() => setTab("code")}>Open Code changes</button></div>
                    </Card>
                ) : <div className="empty">no implementation yet</div>;
            case "user_review":
                return (
                    <>
                        {task.stage === "user_review" ? reviewBox : <Card title="User Review"><ReviewHistory reviews={detail.reviews} stage="user_review" /><div className="actions"><button onClick={() => setTab("comments")}>PR comments</button></div></Card>}
                    </>
                );
            case "pr_creation_review":
                return (
                    <>
                        {task.stage === "pr_creation_review" && reviewBox}
                        {pr ? (
                            <Card title="PR draft">
                                <div className="kv"><b>Title</b><span>{pr.title}</span><b>Base</b><code>{pr.base}</code></div>
                                <Markdown source={pr.body} />
                            </Card>
                        ) : <div className="empty">no draft yet</div>}
                    </>
                );
            case "pr_waiting":
                return <PrPanel detail={detail} />;
            default:
                return null;
        }
    };

    return (
        <>
            <h1>{task.ticket_id} {task.title ?? ""}</h1>
            <div className="sub">
                {statusChip(task.status)}
                <span>{STAGE_LABEL[task.stage]}</span>
                {task.ticket_url ? <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.source} ↗</a> : <span>{task.source}</span>}
                {task.model && <span className="chip">{task.model}</span>}
                <span>session {task.session_id.slice(0, 8)}</span>
                <label>
                    account{" "}
                    <select value={task.account_id ?? ""} onChange={(e) => onAction(() => api.setAccount(task.id, e.target.value))}>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                </label>
            </div>
            <div className="actions">
                {task.status === "running" && <button className="danger" onClick={() => onAction(() => api.stop(task.id))}>Stop</button>}
                {(task.status === "failed" || task.status === "stopped" || task.status === "blocked") && (
                    <button className="primary" onClick={() => onAction(() => api.retry(task.id))}>{task.status === "blocked" ? "Re-run stage" : "Retry stage"}</button>
                )}
                <button onClick={() => onAction(() => api.pin(task.id))}>{task.pinned ? "Unpin" : "Pin"}</button>
                {terminal ? <button onClick={onCloseTerminal}>Close terminal</button> : <button disabled={task.status === "running"} onClick={onOpenTerminal}>Open terminal</button>}
            </div>

            <div className="widgets">
                {task.worktree_path ? (
                    <section className="card widget">
                        <h2>App</h2>
                        <ServicesPanel taskId={task.id} env={env} onError={onError} />
                    </section>
                ) : (
                    <section className="card widget"><h2>App</h2><div className="empty">no worktree yet</div></section>
                )}
                <PrWidget detail={detail} />
            </div>

            <div className="timeline">
                {STAGE_ORDER.map((s, i) => {
                    const runnable = RERUNNABLE.has(s) && i <= currentIdx && task.status !== "running" && !skipped.has(s);
                    return (
                        <span key={s} className={`stage ${i < currentIdx ? "past" : i === currentIdx ? "current" : ""} ${skipped.has(s) ? "skipped" : ""}`}>
                            {STAGE_LABEL[s]}
                            {runnable && (
                                <button
                                    className="rerun"
                                    title={`Re-run ${STAGE_LABEL[s]} (archives its previous output)`}
                                    onClick={() => { if (confirm(`Re-run ${STAGE_LABEL[s]}? Later stages will run again after it.`)) void onAction(() => api.rerun(task.id, s)); }}
                                >
                                    ↻
                                </button>
                            )}
                        </span>
                    );
                })}
            </div>

            {task.status === "blocked" && (
                <div className="blocked-box">
                    <b>Blocked.</b> <Linkified text={task.status_line ?? ""} />
                    {/log ?in/i.test(task.status_line ?? "") && (
                        <div className="actions" style={{ marginBottom: 0 }}>
                            <button className="primary" onClick={async () => { try { const r = await api.openApp(task.id); onError(`Opened ${r.opened} in Chrome profile "${r.profile}" — log in there, then Retry.`); } catch (e) { onError(String((e as Error).message ?? e)); } }}>
                                Open app in Chrome{env?.chrome_browser_name ? ` (${env.chrome_browser_name})` : ""}
                            </button>
                            {!/waiting for you/.test(task.status_line ?? "") && <button onClick={() => onAction(() => api.qaLogin(task.id))}>Log in for QA (agent waits and re-runs)</button>}
                            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Open app: the exact URL in the Chrome profile QA uses, no agent — log in, then Retry. Log in for QA: an agent opens it, waits for the login and re-runs the stage by itself.</span>
                        </div>
                    )}
                </div>
            )}
            {task.status === "rate_limited" && (
                <div className="blocked-box">
                    <b>Rate limited.</b> {task.status_line}
                    {(() => {
                        const at = [...runs].reverse().find((r) => r.resume_at)?.resume_at;
                        if (!at) return null;
                        const ms = new Date(at).getTime() - Date.now();
                        const local = new Date(at).toLocaleString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
                        return <span className="chip warn" style={{ marginLeft: 8 }}>{ms > 0 ? `auto-resume at ${local} (in ${Math.ceil(ms / 60000)} min)` : "resuming…"}</span>;
                    })()}
                </div>
            )}

            <div className="tabs" role="tablist">
                {([
                    ["work", "Work"],
                    ["runs", `Runs (${runs.length})`],
                    ["design", "Design proposal"],
                    ["code", `Code changes${pending.length ? ` (${pending.length} 💬)` : ""}`],
                    ["comments", `PR comments${prior.length || pending.length ? ` (${prior.length + pending.length})` : ""}`],
                    ["ticket", "Ticket"],
                ] as Array<[Tab, string]>).map(([t, label]) => (
                    <button key={t} role="tab" className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{label}</button>
                ))}
            </div>

            {tab === "work" && (
                <>
                    <div className="subtabs">
                        {steps.map((s) => (
                            <button key={s} className={stepKey(step) === stepKey(s) ? "active" : ""} onClick={() => setStep(s)}>
                                {PR_STAGES.has(s) ? "Pull request" : STAGE_LABEL[s]}{s === task.stage ? " ·" : ""}
                            </button>
                        ))}
                    </div>
                    {task.status === "running" && stepKey(step) === stepKey(task.stage) && (
                        <Card title="Live">
                            <div className="feed">{feed.length === 0 ? <div className="k">waiting for events…</div> : feed.slice(-40).map((l, i) => <div key={i}>{l}</div>)}</div>
                        </Card>
                    )}
                    {waiting && stepKey(step) !== stepKey(task.stage) && task.stage !== "pr_creation_review" && task.stage !== "user_review" && reviewBox}
                    {stepPanel(step)}
                    {terminal && (
                        <Card title={<>Terminal <code>{terminal}</code></>}>
                            <Terminal session={terminal} />
                        </Card>
                    )}
                </>
            )}

            {tab === "runs" && (
                <Card title="Runs">
                    <div className="runs">
                        {runs.length === 0 && <div className="empty">none yet</div>}
                        {[...runs].reverse().map((r) => (
                            <div className="run" key={r.id}>
                                <span>{STAGE_LABEL[r.stage]} <small style={{ color: "var(--ink-3)" }}>#{r.attempt}</small></span>
                                {statusChip(r.status)}
                                <span className={r.error ? "err" : ""}>{r.error ?? r.last_event ?? ""}</span>
                                <span className="mono" style={{ color: "var(--ink-3)" }}>{r.num_turns ? `${r.num_turns} turns` : ""}{r.cost_usd ? ` · $${r.cost_usd.toFixed(2)}` : ""}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            )}

            {tab === "design" && (
                design ? (
                    <Card title="Design proposal" badge={<span className={`chip ${design.classification === "bug" ? "bad" : "accent"}`}>{design.classification}</span>}>
                        {task.stage === "design_proposal" && reviewBox}
                        <DesignSections design={design} md={designMd} />
                    </Card>
                ) : <div className="empty">No design proposal yet.</div>
            )}

            {tab === "code" && (
                task.branch && task.worktree_path ? (
                    <Card title="Code changes" badge={pending.length > 0 ? <span className="chip wait">{pending.length} 💬</span> : undefined}>
                        {canComment && <p className="field-hint">Tap a line to leave a comment; send them from the PR comments tab or the review box.</p>}
                        <DiffView taskId={task.id} refreshKey={task.updated_at} comments={comments} prior={prior} canComment={canComment} onChange={changeComment} />
                    </Card>
                ) : <div className="empty">No branch yet.</div>
            )}

            {tab === "comments" && (
                <>
                    <div className="subtabs">
                        <button className={commentsTab === "user" ? "active" : ""} onClick={() => setCommentsTab("user")}>Human · User comments</button>
                        <button className={commentsTab === "pr" ? "active" : ""} onClick={() => setCommentsTab("pr")}>Human · PR comments{gh ? ` (${gh.human.length})` : ""}</button>
                        <button className={commentsTab === "automation" ? "active" : ""} onClick={() => setCommentsTab("automation")}>Automation comments{gh ? ` (${gh.automation.length})` : ""}</button>
                    </div>
                    {commentsTab === "user" && (
                        task.stage === "user_review" && waiting ? reviewBox : (
                            <Card title="Your comments before the PR">
                                {pending.length > 0 && (
                                    <div className="pending-comments">
                                        Draft line comments (sent with the next "Request changes" in User Review):
                                        <ul className="plain">{pending.map(([k, c]) => <li key={k}><code>{c.path}:{c.line}</code>{c.text} <button className="danger" onClick={() => changeComment(k, null)} title="remove">×</button></li>)}</ul>
                                    </div>
                                )}
                                <ReviewHistory reviews={detail.reviews} stage="user_review" />
                                {!detail.reviews.some((r) => r.stage === "user_review") && pending.length === 0 && <div className="empty">No review comments yet.</div>}
                            </Card>
                        )
                    )}
                    {commentsTab !== "user" && (
                        <PrCommentList
                            title={commentsTab === "pr" ? "Comments on the pull request" : "Automation comments on the pull request"}
                            items={gh ? (commentsTab === "pr" ? gh.human : gh.automation) : null}
                            loading={ghLoading}
                            error={ghError}
                            hasPr={!!detail.prState?.url}
                            url={detail.prState?.url ?? null}
                            fetchedAt={gh?.fetchedAt ?? null}
                            onRefresh={() => void loadGh()}
                        />
                    )}
                </>
            )}

            {tab === "ticket" && <TicketView detail={detail} onFetch={async () => { await api.fetchTicket(task.id); await onAction(async () => undefined); }} />}
        </>
    );
};

// Details for the PR stages: checks, review, merge — everything the poller stored.
const PrPanel = ({ detail }: { detail: TaskDetail }) => {
    const { task, prState } = detail;
    const checks = ((): Array<{ name?: string; context?: string; conclusion?: string; state?: string; detailsUrl?: string }> => {
        try {
            return prState?.checks_json ? (JSON.parse(prState.checks_json) as Array<{ name?: string; context?: string; conclusion?: string; state?: string; detailsUrl?: string }>) : [];
        } catch {
            return [];
        }
    })();
    return (
        <Card title="Pull request">
            {!prState?.url && <p>{task.status_line ?? "No pull request yet."}</p>}
            {prState?.url && (
                <div className="kv">
                    <b>PR</b><a href={prState.url} target="_blank" rel="noreferrer">#{prState.number} ↗</a>
                    <b>Review</b><span>{prState.review_decision ? prState.review_decision.toLowerCase().replace("_", " ") : "no decision yet"}</span>
                    <b>Merged</b><span>{prState.merged_at ? new Date(prState.merged_at).toLocaleString() : "not yet"}</span>
                    <b>Checks</b>
                    <span>
                        {checks.length === 0 ? "none reported yet" : (
                            <ul className="plain">
                                {checks.map((c, i) => {
                                    const st = c.conclusion ?? c.state ?? "pending";
                                    const cls = /SUCCESS|NEUTRAL|SKIPPED/i.test(st) ? "ok" : /FAILURE|ERROR|CANCELLED|TIMED_OUT/i.test(st) ? "bad" : "warn";
                                    return <li key={i}><span className={`chip ${cls}`}>{st.toLowerCase()}</span> {c.name ?? c.context}</li>;
                                })}
                            </ul>
                        )}
                    </span>
                    <b>Last poll</b><span>{new Date(prState.updated_at).toLocaleString()}</span>
                </div>
            )}
        </Card>
    );
};

// design.md is split on its `## ` headings into subtabs; the structured plan / test plan / QA scenarios from design.json
// are merged into the subtab whose heading they belong to, so each section is read in one place.
interface MdSection { title: string; body: string }
const splitSections = (md: string): { intro: string; sections: MdSection[] } => {
    const lines = md.split("\n");
    const sections: MdSection[] = [];
    let intro: string[] = [];
    let cur: MdSection | null = null;
    let fence = false;
    for (const line of lines) {
        if (/^```/.test(line)) fence = !fence;
        const h = !fence ? /^##\s+(.+?)\s*$/.exec(line) : null;
        if (h) {
            if (cur) sections.push(cur);
            cur = { title: h[1]!.replace(/^\d+[.)]\s*/, ""), body: "" };
            continue;
        }
        if (cur) cur.body += `${line}\n`;
        else intro.push(line);
    }
    if (cur) sections.push(cur);
    // Drop the H1 title line from the intro; what remains (if anything) is shown above the tabs.
    intro = intro.filter((l) => !/^#\s/.test(l));
    return { intro: intro.join("\n").trim(), sections };
};

const QaScenarios = ({ design }: { design: NonNullable<TaskDetail["design"]> }) => (
    <>
        {design.qa.length === 0 && <div className="quiet">none — {design.qaSkippedReason ?? "no reason given"}</div>}
        {design.qa.map((s) => (
            <details className="scenario" key={s.id} open>
                <summary>
                    <h3><span className="chip accent">{s.id}</span><span className="scenario-title">{s.title}</span> <code>{s.url}</code> <span className="chip persona">{s.persona}</span></h3>
                </summary>
                {s.seed && s.seed.length > 0 ? (
                    <div className="seed"><b>Seed</b><ul className="plain">{s.seed.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
                ) : (
                    <div className="seed quiet">Seed: nothing beyond a logged-in user</div>
                )}
                <ol style={{ margin: 0, paddingLeft: 20 }}>{s.steps.map((st, i) => <li key={i}>{st.action} → <i>{st.assert}</i> {st.shot && <span className="chip warn">shot</span>}</li>)}</ol>
            </details>
        ))}
    </>
);

const DesignSections = ({ design, md }: { design: NonNullable<TaskDetail["design"]>; md: string | null }) => {
    const parsed = useMemo(() => (md ? splitSections(md) : { intro: "", sections: [] }), [md]);
    // Structured data attaches to the matching markdown section; sections without a markdown twin still get a tab.
    type Part = { key: string; title: string; md?: string; extra?: React.ReactNode };
    const parts: Part[] = parsed.sections.map((s) => ({ key: s.title, title: s.title, md: s.body }));
    const attach = (test: RegExp, title: string, extra: React.ReactNode) => {
        const hit = parts.find((p) => test.test(p.title));
        if (hit) hit.extra = extra;
        else parts.push({ key: title, title, extra });
    };
    attach(/^change|implementation|plan by layer/i, "Plan by layer", (
        <table><tbody>{design.plan.map((p) => <tr key={p.layer}><td><code>{p.layer}</code></td><td><ul className="plain">{p.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></td></tr>)}</tbody></table>
    ));
    attach(/^tests?\b|test plan/i, "Test plan", (
        <table><tbody>{design.testPlan.map((t) => <tr key={t.file}><td><code>{t.file}</code></td><td><ul className="plain">{t.cases.map((c, i) => <li key={i}><code>{c}</code></li>)}</ul></td></tr>)}</tbody></table>
    ));
    attach(/qa/i, "QA scenarios", <QaScenarios design={design} />);
    const [active, setActive] = useState(0);
    const cur = parts[Math.min(active, parts.length - 1)];
    return (
        <>
            {parsed.intro && <Markdown source={parsed.intro} />}
            <div className="subtabs">
                {parts.map((p, i) => <button key={p.key} className={i === active ? "active" : ""} onClick={() => setActive(i)}>{p.title}</button>)}
            </div>
            {cur && (
                <div className="design-section">
                    {cur.md && <Markdown source={cur.md} />}
                    {cur.extra && <div className="design-structured">{cur.extra}</div>}
                </div>
            )}
        </>
    );
};

// Full-size view of one screenshot: first click fits it to the viewport width, a second click shows it 1:1 (scrollable).
const Lightbox = ({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) => {
    const [natural, setNatural] = useState(false);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="lightbox" onClick={onClose}>
            <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
                <span>{caption}</span>
                <span className="lightbox-actions">
                    <button onClick={() => setNatural((v) => !v)}>{natural ? "Fit to width" : "Actual size"}</button>
                    <a href={src} target="_blank" rel="noreferrer">Open in a tab ↗</a>
                    <button onClick={onClose} aria-label="Close">×</button>
                </span>
            </div>
            <img src={src} alt="" className={natural ? "natural" : ""} onClick={(e) => { e.stopPropagation(); setNatural((v) => !v); }} />
        </div>
    );
};

const QaGallery = ({ taskId, design, before, after }: { taskId: string; design: NonNullable<TaskDetail["design"]>; before: QaPass | null; after: QaPass | null }) => {
    const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
    const shot = (file: string | undefined, caption: string, missing: string) =>
        file ? <img src={api.artifactUrl(taskId, file)} alt="" onClick={() => setZoom({ src: api.artifactUrl(taskId, file), caption })} title="Click to inspect" /> : <div className="empty">{missing}</div>;
    return (
    <>
        {zoom && <Lightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
        {[before, after].map((p) => p?.blockers.length ? <div key={p.pass} className="blocked-box">{p.pass}: {p.blockers.join(" · ")}</div> : null)}
        {design.qa.map((s) => {
            const b = before?.scenarios.find((x) => x.id === s.id);
            const a = after?.scenarios.find((x) => x.id === s.id);
            const shots = s.steps.map((st, i) => (st.shot ? i + 1 : null)).filter((x): x is number => x !== null);
            const chip = (o?: string) =>
                o ? <span className={`chip ${o === "pass" ? "ok" : o === "fail" ? "bad" : o === "needs_human" ? "wait" : "warn"}`}>{o === "needs_human" ? "check yourself" : o}</span> : <span className="chip">—</span>;
            // A "pass" whose own observation talks about errors deserves a second look (the runner may have rationalised an env problem away).
            const suspicious = (p?: { outcome: string; observation: string }) =>
                p?.outcome === "pass" && /\berror|exception|unauthori[sz]ed|forbidden|denied|could not|couldn't|failed|4\d\d\b|5\d\d\b/i.test(p.observation);
            return (
                <details className="scenario" key={s.id} open>
                    <summary>
                        <h3>
                            <span className="chip accent">{s.id}</span><span className="scenario-title">{s.title}</span> <span>before {chip(b?.outcome)}</span> <span>after {chip(a?.outcome)}</span>
                            {(suspicious(b) || suspicious(a)) && <span className="chip warn" title="The runner marked this pass but its observation mentions an error — check the screenshots">⚠ observation mentions an error</span>}
                        </h3>
                    </summary>
                    {a?.outcome === "needs_human" && (
                        <div className="review-box" style={{ marginTop: 8 }}>
                            <b>Please verify this one yourself.</b> {a.observation}
                        </div>
                    )}
                    {b?.observation && <div style={{ fontSize: 13, color: "var(--ink-2)" }}>before: {b.observation}</div>}
                    {a?.observation && <div style={{ fontSize: 13, color: "var(--ink-2)" }}>after: {a.observation}</div>}
                    {shots.map((step) => {
                        const bf = b?.shots.find((x) => x.step === step)?.file;
                        const af = a?.shots.find((x) => x.step === step)?.file;
                        return (
                            <div className="gallery" key={step} style={{ marginTop: 8 }}>
                                <figure>{shot(bf, `${s.id} · before · step ${step} · ${s.steps[step - 1]?.assert ?? ""}`, "no before shot")}<figcaption>before · step {step} · {s.steps[step - 1]?.assert}</figcaption></figure>
                                <figure>{shot(af, `${s.id} · after · step ${step} · ${s.steps[step - 1]?.assert ?? ""}`, "no after shot")}<figcaption>after · step {step}</figcaption></figure>
                            </div>
                        );
                    })}
                </details>
            );
        })}
    </>
    );
};
