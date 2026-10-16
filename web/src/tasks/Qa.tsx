import { useEffect, useState } from "react";
import { Badge, Button, Chip, Notice } from "@vortex/ds";
import { api, stageOf, STAGE_ORDER, type QaChange, type QaPass, type TaskDetail } from "../api";
import { KeyValue } from "../components/KeyValue";
import { Panel } from "../components/Panel";
import { Lightbox, outcomeTone, Sub } from "./common";
import "./workspace.css";

type Act = (fn: () => Promise<unknown>) => Promise<void>;

// One QA scenario as the reviewer reads it: the steps, the baseline's outcome with its evidence, and the seed and
// teardown folded away (rarely read).
export const QaTests = ({ taskId, design, before }: { taskId: string; design: NonNullable<TaskDetail["design"]>; before: QaPass | null }) => {
    const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
    const chip = (o?: string) =>
        o ? <Chip tone={outcomeTone(o) === "neutral" ? "warn" : outcomeTone(o)}>baseline {o === "needs_human" ? "check yourself" : o}</Chip> : <Chip>no baseline yet</Chip>;
    if (design.qa.length === 0) return <p className="quiet"><b>No QA scenarios.</b> {design.qaSkippedReason ?? "No reason given."}</p>;
    return (
        <>
            {zoom && <Lightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
            {before?.blockers.length ? (
                <div className="qa-blockers"><span className="qa-obs-label"><b>Baseline blockers</b></span><ul className="qa-obs-text">{before.blockers.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
            ) : null}
            {design.qa.map((s) => {
                const b = before?.scenarios.find((x) => x.id === s.id);
                const setup = [...(s.teardown ?? []).map((x) => ({ kind: "Teardown", x })), ...(s.seed ?? []).map((x) => ({ kind: "Seed", x }))];
                return (
                    <details className="scenario" key={s.id} open>
                        <summary>
                            <h3>
                                <Chip tone="accent">{s.id}</Chip>{s.kind === "api" && <Chip>API</Chip>}<b className="scenario-title">{s.title}</b> <code>{s.url}</code> <Chip className="persona">{s.persona}</Chip>{" "}
                                {s.baseline === false ? <Chip title="The journey does not exist before the change: the baseline records it as a failure by construction">new surface — no baseline</Chip> : chip(b?.outcome)}
                            </h3>
                        </summary>
                        <ol className="qa-steps">
                            {s.steps.map((st, i) => (
                                <li key={i}>
                                    <b>Do:</b> {s.kind === "api" ? <code>{st.action}</code> : st.action}
                                    <br />
                                    <b>Expect:</b> {st.assert} {st.shot && <Chip tone="warn">shot</Chip>}
                                </li>
                            ))}
                        </ol>
                        {b?.observation && (
                            <div className="qa-obs">
                                <div className="qa-obs-row">
                                    <span className="qa-obs-label"><b>Baseline saw</b></span>
                                    <ul className="qa-obs-text">{b.observation.split(/;\s+/).map((frag, i) => <li key={i}>{frag}</li>)}</ul>
                                </div>
                            </div>
                        )}
                        {b?.log && <pre className="qa-log">{b.log}</pre>}
                        {b && b.shots.length > 0 && (
                            <div className="gallery">
                                {b.shots.map((sh) => (
                                    <figure key={sh.step}>
                                        <img src={api.artifactUrl(taskId, sh.file)} alt="" onClick={() => setZoom({ src: api.artifactUrl(taskId, sh.file), caption: `${s.id} · baseline · step ${sh.step} · ${s.steps[sh.step - 1]?.assert ?? ""}` })} title="Click to inspect" />
                                        <figcaption><b>step {sh.step}</b> · {s.steps[sh.step - 1]?.assert}</figcaption>
                                    </figure>
                                ))}
                            </div>
                        )}
                        {setup.length > 0 ? (
                            <details className="seed">
                                <summary><b>Seed</b> — {s.seed?.length ?? 0} step(s){s.teardown?.length ? `, ${s.teardown.length} teardown` : ""}</summary>
                                <ul className="plain">{setup.map((x, i) => <li key={i}><b>{x.kind}:</b> <code>{x.x}</code></li>)}</ul>
                            </details>
                        ) : (
                            <div className="seed quiet">Seed: nothing beyond a logged-in user</div>
                        )}
                    </details>
                );
            })}
        </>
    );
};

// The corrections applied to design.json during QA (a seed, step, assert or whole scenario), by the human's answer or by
// Jev, each revertible: the next pass then runs the original again.
const QaChanges = ({ taskId, running, onAction }: { taskId: string; running: boolean; onAction: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const [changes, setChanges] = useState<QaChange[]>([]);
    const load = () => void api.qaChanges(taskId).then((r) => setChanges(r.changes)).catch(() => setChanges([]));
    useEffect(load, [taskId, running]);
    if (!changes.length) return null;
    const what = (c: QaChange): string => (c.kind === "scenario" ? "scenario rewritten" : `${c.kind} ${c.index + 1}`);
    return (
        <Sub title={<>Scenario changes during QA <Badge>{changes.length}</Badge></>} open={false}>
            <div className="qa-changes">
                {changes.map((c) => (
                    <div className="qa-change" key={c.id}>
                        <Chip tone="accent">{c.scenario}</Chip> <b>{what(c)}</b>{" "}
                        <Chip tone={c.by === "jev" ? "ok" : "neutral"} title={c.jev ? `legit ${Math.round(c.jev.legit * 100)} %, weakens ${Math.round(c.jev.weakens * 100)} %, read as ${c.jev.kind}` : "approved by you"}>{c.by === "jev" ? "Jev-approved" : "your answer"}</Chip>{" "}
                        <span className="field-hint">{new Date(c.at).toLocaleString()}</span>
                        {c.revertedAt && <Chip tone="warn">reverted</Chip>}
                        {c.reason && <div className="field-hint">{c.reason}</div>}
                        <details>
                            <summary>before / after</summary>
                            <pre className="qa-change-diff">{JSON.stringify(c.before, null, 2)}</pre>
                            <pre className="qa-change-diff">{JSON.stringify(c.after, null, 2)}</pre>
                        </details>
                        {!c.revertedAt && <Button size="sm" disabled={running} onClick={() => void onAction(async () => { await api.revertQaChange(taskId, c.id); load(); })}>Revert</Button>}
                    </div>
                ))}
            </div>
        </Sub>
    );
};

const QaGallery = ({ taskId, design, before, after }: { taskId: string; design: NonNullable<TaskDetail["design"]>; before: QaPass | null; after: QaPass | null }) => {
    const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
    const shot = (file: string | undefined, caption: string, missing: string) =>
        file ? <img src={api.artifactUrl(taskId, file)} alt="" onClick={() => setZoom({ src: api.artifactUrl(taskId, file), caption })} title="Click to inspect" /> : <div className="empty">{missing}</div>;
    return (
    <>
        {zoom && <Lightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
        {[before, after].map((p) => p?.blockers.length ? (
            <div key={p.pass} className="qa-blockers"><span className="qa-obs-label">{p.pass} blockers</span><ul className="qa-obs-text">{p.blockers.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
        ) : null)}
        {design.qa.map((s) => {
            const b = before?.scenarios.find((x) => x.id === s.id);
            const a = after?.scenarios.find((x) => x.id === s.id);
            const shots = s.steps.map((st, i) => (st.shot ? i + 1 : null)).filter((x): x is number => x !== null);
            const chip = (o?: string) =>
                o ? <Chip tone={outcomeTone(o) === "neutral" ? "warn" : outcomeTone(o)}>{o === "needs_human" ? "check yourself" : o}</Chip> : <Chip>none</Chip>;
            // A "pass" whose own observation talks about errors deserves a second look (the runner may have rationalised an env problem away).
            const suspicious = (p?: { outcome: string; observation: string }) =>
                p?.outcome === "pass" && /\berror|exception|unauthori[sz]ed|forbidden|denied|could not|couldn't|failed|4\d\d\b|5\d\d\b/i.test(p.observation);
            return (
                <details className="scenario" key={s.id} open>
                    <summary>
                        <h3>
                            <Chip tone="accent">{s.id}</Chip>{s.kind === "api" && <Chip>API</Chip>}<span className="scenario-title">{s.title}</span> <span>before {chip(b?.outcome)}{b?.superseded && <Chip tone="warn" title={`The scenario changed after the baseline pass (change ${b.superseded}); this before result no longer pairs with the after pass (the baseline runs only in the design stage)`}>baseline superseded</Chip>}</span> <span>after {chip(a?.outcome)}</span>
                            {a?.jev && <Chip tone={a.jev.verdict === "pass" ? "ok" : "warn"} title={`Jev's grade of the runner's observation against the asserts (pass needs 85); the runner said ${a.jev.runner}`}>Jev {a.jev.grade}/100</Chip>}
                            {(suspicious(b) || suspicious(a)) && <Chip tone="warn" title="The runner marked this pass but its observation mentions an error — check the screenshots">Observation mentions an error</Chip>}
                        </h3>
                    </summary>
                    {a?.outcome === "needs_human" && (
                        <Notice tone="wait"><b>Please verify this one yourself.</b> {a.observation}</Notice>
                    )}
                    {(b?.observation || a?.observation) && (
                        <div className="qa-obs">
                            {[b, a].map((p) => p?.observation ? (
                                <div key={p === b ? "before" : "after"} className="qa-obs-row">
                                    <span className="qa-obs-label">{p === b ? "Before" : "After"} {chip(p.outcome)}</span>
                                    <ul className="qa-obs-text">{p.observation.split(/;\s+/).map((frag, i) => <li key={i}>{frag}</li>)}</ul>
                                </div>
                            ) : null)}
                        </div>
                    )}
                    {(b?.log || a?.log) && (
                        <div className="gallery">
                            {[b, a].map((p) => (
                                <figure key={p === b ? "before" : "after"}>
                                    {p?.log ? <pre className="qa-log">{p.log}</pre> : <div className="empty">no {p === b ? "before" : "after"} output</div>}
                                    <figcaption>{p === b ? "before" : "after"} · commands and output</figcaption>
                                </figure>
                            ))}
                        </div>
                    )}
                    {shots.map((step) => {
                        const bf = b?.shots?.find((x) => x.step === step)?.file;
                        const af = a?.shots?.find((x) => x.step === step)?.file;
                        return (
                            <div className="gallery" key={step}>
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

// The QA evidence of a task: re-run buttons, earlier automatic fix attempts, scenario changes, and the before / after gallery.
export const QaEvidence = ({ task, design, before, after, history, currentIdx, onAction }: { task: TaskDetail["task"]; design: NonNullable<TaskDetail["design"]>; before: QaPass | null; after: QaPass | null; history: NonNullable<TaskDetail["qaHistory"]>; currentIdx: number; onAction: Act }) => (
    <Panel
        title="QA evidence"
        actions={
            task.status !== "running" ? (
                <>
                    {stageOf(task.stage) === "design_proposal" && <Button size="sm" onClick={() => onAction(() => api.rerun(task.id, "qa_baseline"))}>Re-run baseline</Button>}
                    {currentIdx >= STAGE_ORDER.indexOf("manual_qa") && <Button size="sm" onClick={() => onAction(() => api.rerun(task.id, "manual_qa"))}>Re-run manual QA</Button>}
                </>
            ) : undefined
        }
    >
        {history.length > 0 && (
            <Sub title={`Earlier automatic fix attempts (${history.length})`} open={false}>
                <p className="quiet">Manual QA failed and was sent straight back to Implementation these times before the current result; the agent saw this same trail.</p>
                <KeyValue
                    items={history.map(({ attempt, data }) => ({
                        label: `Attempt ${attempt}`,
                        value: !data ? "Could not read." : data.scenarios.filter((s) => s.outcome === "fail").length ? data.scenarios.filter((s) => s.outcome === "fail").map((s) => `${s.id}: ${s.observation}`).join("; ") : "No scenario failures recorded.",
                    }))}
                />
            </Sub>
        )}
        <QaChanges taskId={task.id} running={task.status === "running"} onAction={onAction} />
        <QaGallery taskId={task.id} design={design} before={before} after={after} />
    </Panel>
);
