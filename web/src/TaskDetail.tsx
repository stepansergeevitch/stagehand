import { useEffect, useState } from "react";
import { api, STAGE_LABEL, STAGE_ORDER, type Account, type QaPass, type Stage, type TaskDetail } from "./api";
import { Terminal } from "./Terminal";
import { Markdown } from "./Markdown";
import { ServicesPanel } from "./Services";
import { DiffView, useDraftComments } from "./DiffView";
import type { Env, LineComment, Review } from "./api";

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

const Section = ({ title, badge, open, children }: { title: string; badge?: React.ReactNode; open: boolean; children: React.ReactNode }) => (
    <details className="card" open={open}>
        <summary>
            <h2>
                {title} {badge}
            </h2>
        </summary>
        <div className="card-body">{children}</div>
    </details>
);

// A collapsible sub-heading inside a card (open by default).
const Sub = ({ title, open = true, children }: { title: React.ReactNode; open?: boolean; children: React.ReactNode }) => (
    <details className="sub" open={open}>
        <summary><h3>{title}</h3></summary>
        <div className="sub-body">{children}</div>
    </details>
);

const RERUNNABLE: ReadonlySet<Stage> = new Set(["research", "design_proposal", "qa_baseline", "implementation", "manual_qa", "pr_creation_review", "pr_red"]);

const statusChip = (s: string) => {
    const cls = s === "waiting_user" || s === "blocked" ? "wait" : s === "running" ? "accent" : s === "failed" ? "bad" : s === "done" ? "ok" : s === "rate_limited" ? "warn" : "";
    return <span className={`chip ${cls}`}>{s.replace("_", " ")}</span>;
};

export const TaskDetailView = ({ detail, accounts, env, onError, feed, terminal, onAction, onOpenTerminal, onCloseTerminal }: Props) => {
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

    return (
        <>
            <h1>{task.ticket_id} {task.title ?? ""}</h1>
            <div className="sub">
                {statusChip(task.status)}
                <span>{STAGE_LABEL[task.stage]}</span>
                {task.ticket_url ? <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.source} ↗</a> : <span>{task.source}</span>}
                {task.model && <span className="chip">{task.model}</span>}
                {task.branch && <span>⎇ {task.branch}</span>}
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

            {task.worktree_path && (
                <Section title="App" open={true}>
                    <ServicesPanel taskId={task.id} env={env} onError={onError} />
                </Section>
            )}

            {task.status === "blocked" && (
                <div className="blocked-box">
                    <b>Blocked.</b> {task.status_line}
                    {/log ?in/i.test(task.status_line ?? "") && !/waiting for you/.test(task.status_line ?? "") && (
                        <div className="actions" style={{ marginBottom: 0 }}>
                            <button className="primary" onClick={() => onAction(() => api.qaLogin(task.id))}>Log in for QA</button>
                            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Opens the app in the automation Chrome window; log in there once (the profile persists), and the stage re-runs by itself.</span>
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

            {waiting && (
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
                    <textarea placeholder={canComment ? "General comments (optional if you left line comments in the diff below)" : "Notes for Claude (required for 'Request changes')"} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
                    </div>
                    <ReviewHistory reviews={detail.reviews} stage={task.stage} />
                </div>
            )}

            {task.branch && task.worktree_path && (
                <Section title="Code changes" open={task.stage === "user_review"} badge={pending.length > 0 ? <span className="chip wait">{pending.length} 💬</span> : undefined}>
                    <DiffView taskId={task.id} refreshKey={task.updated_at} comments={comments} canComment={canComment} onChange={changeComment} />
                </Section>
            )}

            {terminal && (
                <section className="card">
                    <h2>Terminal <code>{terminal}</code></h2>
                    <Terminal session={terminal} />
                </section>
            )}

            {task.status === "running" && (
                <section className="card">
                    <h2>Live</h2>
                    <div className="feed">{feed.length === 0 ? <div className="k">waiting for events…</div> : feed.slice(-40).map((l, i) => <div key={i}>{l}</div>)}</div>
                </section>
            )}

            {detail.ticket && (
                <Section title="Ticket" open={task.stage === "research"} badge={<span className="chip">{detail.ticket.fetchedVia}</span>}>
                    <div className="kv">
                        <b>Title</b><span>{detail.ticket.title}</span>
                        <b>Status</b><span>{detail.ticket.status ?? "—"}</span>
                        {detail.ticket.parent && <><b>Parent</b><span>{detail.ticket.parent.id} — {detail.ticket.parent.title}</span></>}
                    </div>
                    {detail.ticket.acceptanceCriteria.length > 0 && (
                        <Sub title="Acceptance criteria">
                            <ul className="plain">{detail.ticket.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                        </Sub>
                    )}
                    <details><summary>Description</summary><Markdown source={detail.ticket.description} /></details>
                </Section>
            )}

            {research && (
                <Section title="Research" open={task.stage === "research" || (task.stage === "design_proposal" && !design)} badge={<span className={`chip ${research.classification === "bug" ? "bad" : "accent"}`}>{research.classification}</span>}>
                    <div className="kv"><b>Summary</b><span>{research.summary}</span><b>Branch</b><code>{research.branchName}</code><b>Areas</b><span>{research.affectedAreas.join(", ")}</span></div>
                    {researchMd && <details><summary>research.md</summary><Markdown source={researchMd} /></details>}
                </Section>
            )}

            {design && (
                <Section title="Design proposal" open={task.stage === "design_proposal"} badge={<span className={`chip ${design.classification === "bug" ? "bad" : "accent"}`}>{design.classification}</span>}>
                    {designMd && <details open={task.stage === "design_proposal"}><summary>design.md</summary><Markdown source={designMd} /></details>}
                    <Sub title="Plan by layer">
                        <table><tbody>{design.plan.map((p) => <tr key={p.layer}><td><code>{p.layer}</code></td><td><ul className="plain">{p.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></td></tr>)}</tbody></table>
                    </Sub>
                    <Sub title="Test plan">
                        <table><tbody>{design.testPlan.map((t) => <tr key={t.file}><td><code>{t.file}</code></td><td><ul className="plain">{t.cases.map((c, i) => <li key={i}><code>{c}</code></li>)}</ul></td></tr>)}</tbody></table>
                    </Sub>
                    <Sub title={<>QA scenarios {design.qa.length === 0 && <span className="chip">none — {design.qaSkippedReason ?? "no reason given"}</span>}</>}>
                        {design.qa.map((s) => (
                            <details className="scenario" key={s.id} open>
                                <summary>
                                    <h3><span className="chip accent">{s.id}</span><span className="scenario-title">{s.title}</span> <code>{s.url}</code> <span className="chip persona">{s.persona}</span></h3>
                                </summary>
                                <ol style={{ margin: 0, paddingLeft: 20 }}>{s.steps.map((st, i) => <li key={i}>{st.action} → <i>{st.assert}</i> {st.shot && <span className="chip warn">shot</span>}</li>)}</ol>
                            </details>
                        ))}
                    </Sub>
                </Section>
            )}

            {impl && (
                <Section title="Implementation" open={task.stage === "implementation" || task.stage === "user_review"} badge={<span className={`chip ${impl.gates.tests && impl.gates.typecheck ? "ok" : "bad"}`}>tests {impl.gates.tests ? "✓" : "✗"} · typecheck {impl.gates.typecheck ? "✓" : "✗"}</span>}>
                    <div className="kv">
                        <b>Coverage (new lines)</b><span>{impl.coverageNewLines ?? "—"}%</span>
                        <b>Backend</b><span>{impl.tests.backend ?? "—"}</span>
                        <b>Frontend</b><span>{impl.tests.frontend ?? "—"}</span>
                        <b>Files</b><span>{impl.files.map((f) => <code key={f} style={{ marginRight: 8 }}>{f}</code>)}</span>
                        <b>Commits</b><span>{impl.commits.map((c) => <div key={c}><code>{c}</code></div>)}</span>
                    </div>
                    {impl.notes && <Markdown source={impl.notes} />}
                </Section>
            )}

            {(qaBefore || qaAfter) && design && (
                <Section title="QA evidence" open={task.stage === "manual_qa" || task.stage === "user_review"}>
                    {task.status !== "running" && (
                        <div className="actions" style={{ marginTop: 0 }}>
                            <button onClick={() => onAction(() => api.rerun(task.id, "qa_baseline"))}>Re-run QA baseline</button>
                            {currentIdx >= STAGE_ORDER.indexOf("manual_qa") && <button onClick={() => onAction(() => api.rerun(task.id, "manual_qa"))}>Re-run Manual QA</button>}
                        </div>
                    )}
                    <QaGallery taskId={task.id} design={design} before={qaBefore} after={qaAfter} />
                </Section>
            )}

            {pr && (
                <Section title="PR draft" open={task.stage === "pr_creation_review"}>
                    <div className="kv"><b>Title</b><span>{pr.title}</span><b>Base</b><code>{pr.base}</code></div>
                    <Markdown source={pr.body} />
                </Section>
            )}

            <Section title="Runs" open={false} badge={<span className="chip">{runs.length}</span>}>
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
            </Section>
        </>
    );
};

const QaGallery = ({ taskId, design, before, after }: { taskId: string; design: NonNullable<TaskDetail["design"]>; before: QaPass | null; after: QaPass | null }) => (
    <>
        {[before, after].map((p) => p?.blockers.length ? <div key={p.pass} className="blocked-box">{p.pass}: {p.blockers.join(" · ")}</div> : null)}
        {design.qa.map((s) => {
            const b = before?.scenarios.find((x) => x.id === s.id);
            const a = after?.scenarios.find((x) => x.id === s.id);
            const shots = s.steps.map((st, i) => (st.shot ? i + 1 : null)).filter((x): x is number => x !== null);
            const chip = (o?: string) => (o ? <span className={`chip ${o === "pass" ? "ok" : o === "fail" ? "bad" : "warn"}`}>{o}</span> : <span className="chip">—</span>);
            return (
                <details className="scenario" key={s.id} open>
                    <summary>
                        <h3><span className="chip accent">{s.id}</span><span className="scenario-title">{s.title}</span> <span>before {chip(b?.outcome)}</span> <span>after {chip(a?.outcome)}</span></h3>
                    </summary>
                    {b?.observation && <div style={{ fontSize: 13, color: "var(--ink-2)" }}>before: {b.observation}</div>}
                    {a?.observation && <div style={{ fontSize: 13, color: "var(--ink-2)" }}>after: {a.observation}</div>}
                    {shots.map((step) => {
                        const bf = b?.shots.find((x) => x.step === step)?.file;
                        const af = a?.shots.find((x) => x.step === step)?.file;
                        return (
                            <div className="gallery" key={step} style={{ marginTop: 8 }}>
                                <figure>{bf ? <img src={api.artifactUrl(taskId, bf)} alt="" /> : <div className="empty">no before shot</div>}<figcaption>before · step {step} · {s.steps[step - 1]?.assert}</figcaption></figure>
                                <figure>{af ? <img src={api.artifactUrl(taskId, af)} alt="" /> : <div className="empty">no after shot</div>}<figcaption>after · step {step}</figcaption></figure>
                            </div>
                        );
                    })}
                </details>
            );
        })}
    </>
);
