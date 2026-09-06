import { useEffect, useState } from "react";
import { api, STAGE_LABEL, STAGE_ORDER, type Account, type QaPass, type Stage, type TaskDetail } from "./api";
import { Terminal } from "./Terminal";
import { Markdown } from "./Markdown";

interface Props {
    detail: TaskDetail;
    accounts: Account[];
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

const statusChip = (s: string) => {
    const cls = s === "waiting_user" || s === "blocked" ? "wait" : s === "running" ? "accent" : s === "failed" ? "bad" : s === "done" ? "ok" : s === "rate_limited" ? "warn" : "";
    return <span className={`chip ${cls}`}>{s.replace("_", " ")}</span>;
};

export const TaskDetailView = ({ detail, accounts, feed, terminal, onAction, onOpenTerminal, onCloseTerminal }: Props) => {
    const { task, runs, design, impl, qaBefore, qaAfter, pr, research } = detail;
    const has = (p: string) => detail.artifacts.some((a) => a.path === p);
    const researchMd = useArtifactText(task.id, "research.md", has("research.md"));
    const designMd = useArtifactText(task.id, "design.md", has("design.md"));
    const [notes, setNotes] = useState("");
    const [routeTo, setRouteTo] = useState<"implementation" | "design_proposal">("implementation");
    const currentIdx = STAGE_ORDER.indexOf(task.stage);
    const skipped = new Set<Stage>(design && design.qa.length === 0 ? ["qa_baseline", "manual_qa"] : []);
    const waiting = task.status === "waiting_user";

    return (
        <>
            <h1>{task.ticket_id} {task.title ?? ""}</h1>
            <div className="sub">
                {statusChip(task.status)}
                <span>{STAGE_LABEL[task.stage]}</span>
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
                    <button className="primary" onClick={() => onAction(() => api.retry(task.id))}>Retry stage</button>
                )}
                <button onClick={() => onAction(() => api.pin(task.id))}>{task.pinned ? "Unpin" : "Pin"}</button>
                {terminal ? <button onClick={onCloseTerminal}>Close terminal</button> : <button disabled={task.status === "running"} onClick={onOpenTerminal}>Open terminal</button>}
            </div>
            <div className="timeline">
                {STAGE_ORDER.map((s, i) => (
                    <span key={s} className={`stage ${i < currentIdx ? "past" : i === currentIdx ? "current" : ""} ${skipped.has(s) ? "skipped" : ""}`}>{STAGE_LABEL[s]}</span>
                ))}
            </div>

            {task.status === "blocked" && <div className="blocked-box"><b>Blocked.</b> {task.status_line}</div>}
            {task.status === "rate_limited" && <div className="blocked-box"><b>Rate limited.</b> {task.status_line}</div>}

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
                    <textarea placeholder="Notes for Claude (required for 'Request changes')" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    <div className="actions">
                        <button className="primary" onClick={() => onAction(() => api.review(task.id, { verdict: "approve", ...(notes ? { notes } : {}) }))}>
                            {task.stage === "pr_creation_review" ? "Approve & create PR" : "Approve"}
                        </button>
                        <button disabled={!notes.trim()} onClick={() => onAction(() => api.review(task.id, { verdict: "changes", notes, ...(task.stage === "user_review" ? { routeTo } : {}) }))}>
                            Request changes
                        </button>
                    </div>
                </div>
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

            {research && (
                <Section title="Research" open={task.stage === "research" || (task.stage === "design_proposal" && !design)} badge={<span className={`chip ${research.classification === "bug" ? "bad" : "accent"}`}>{research.classification}</span>}>
                    <div className="kv"><b>Summary</b><span>{research.summary}</span><b>Branch</b><code>{research.branchName}</code><b>Areas</b><span>{research.affectedAreas.join(", ")}</span></div>
                    {researchMd && <details><summary>research.md</summary><Markdown source={researchMd} /></details>}
                </Section>
            )}

            {design && (
                <Section title="Design proposal" open={task.stage === "design_proposal"} badge={<span className={`chip ${design.classification === "bug" ? "bad" : "accent"}`}>{design.classification}</span>}>
                    {designMd && <details open={task.stage === "design_proposal"}><summary>design.md</summary><Markdown source={designMd} /></details>}
                    <h3>Plan by layer</h3>
                    <table><tbody>{design.plan.map((p) => <tr key={p.layer}><td><code>{p.layer}</code></td><td><ul className="plain">{p.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></td></tr>)}</tbody></table>
                    <h3>Test plan</h3>
                    <table><tbody>{design.testPlan.map((t) => <tr key={t.file}><td><code>{t.file}</code></td><td><ul className="plain">{t.cases.map((c, i) => <li key={i}><code>{c}</code></li>)}</ul></td></tr>)}</tbody></table>
                    <h3>QA scenarios {design.qa.length === 0 && <span className="chip">none — {design.qaSkippedReason ?? "no reason given"}</span>}</h3>
                    {design.qa.map((s) => (
                        <div className="scenario" key={s.id}>
                            <h3><span className="chip accent">{s.id}</span>{s.title} <code>{s.url}</code> <span className="chip">{s.persona}</span></h3>
                            <ol style={{ margin: 0, paddingLeft: 20 }}>{s.steps.map((st, i) => <li key={i}>{st.action} → <i>{st.assert}</i> {st.shot && <span className="chip warn">shot</span>}</li>)}</ol>
                        </div>
                    ))}
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
                <div className="scenario" key={s.id}>
                    <h3><span className="chip accent">{s.id}</span>{s.title} <span>before {chip(b?.outcome)}</span> <span>after {chip(a?.outcome)}</span></h3>
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
                </div>
            );
        })}
    </>
);
