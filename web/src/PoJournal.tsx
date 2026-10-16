import { useMemo, useState } from "react";
import { api, type PoCorrection, type PoDetail, type PoJournalEvent, type PoQuestion } from "./api";
import { AgentInput } from "./AgentInput";
import { Markdown } from "./Markdown";
import { Button, Card, Chip, Input, Select } from "@vortex/ds";

// A Product Owner's journal on its page: the outstanding questions it keeps, the events that reached it (and what
// each changed), and the corrections it suggests for existing tickets and task designs.

type Props = { d: PoDetail; onError: (m: string) => void; reload: () => void };

const when = (iso: string): string => new Date(iso).toLocaleString();

// Lines of a diff: "+ " added, "- " removed, "  " unchanged, "…" a gap.
export const DiffLines = ({ lines, max = 400 }: { lines: string[]; max?: number }) => (
    <pre className="po-diff">
        {lines.slice(0, max).map((l, i) => (
            <div key={i} className={l === "…" ? "gap" : l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : "ctx"}>{l === "…" ? "⋯" : l}</div>
        ))}
        {lines.length > max && <div className="gap">… {lines.length - max} more line(s)</div>}
    </pre>
);

const Thread = ({ thread, asking }: { thread: PoQuestion["thread"]; asking: boolean }) => (
    <>
        {thread.map((m, i) => (
            <div key={i} className={`thread-msg ${m.role === "po" ? "agent" : "user"}`}>
                <div className="chat-msg-head"><b>{m.role === "user" ? "You" : "Product Owner"}</b> <span className="field-hint">{when(m.at)}</span></div>
                {m.role === "po" ? <Markdown source={m.text} /> : <div>{m.text}</div>}
            </div>
        ))}
        {asking && <div className="thread-msg agent pending">The Product Owner is answering…</div>}
    </>
);

// ---------- outstanding questions ----------

const STATUS_CHIP: Record<PoQuestion["status"], [string, string]> = { open: ["open", "warn"], proposed: ["resolution suggested", "accent"], resolved: ["resolved", "ok"], dropped: ["dropped", ""] };

const QuestionCard = ({ q, asking, onAsk, onConfirm }: { q: PoQuestion; asking: boolean; onAsk: (t: string) => Promise<void>; onConfirm: (resolution?: string) => Promise<void> }) => {
    const live = q.status === "open" || q.status === "proposed";
    const [open, setOpen] = useState(live && (q.thread.length > 0 || q.status === "proposed"));
    const [text, setText] = useState("");
    const [edit, setEdit] = useState<string | null>(null);
    const [own, setOwn] = useState<string | null>(null);
    const send = async () => {
        const t = text.trim();
        if (!t) return;
        setText("");
        setOpen(true);
        await onAsk(t);
    };
    const [label, chip] = STATUS_CHIP[q.status];
    return (
        <div className={`po-comment-card po-question ${q.status}`}>
            <div className="po-comment-top">
                <Chip>{q.key}</Chip>
                <b>{q.question}</b>
                <Chip className={`${chip}`}>{label}</Chip>
                <span className="field-hint">{when(q.created_at)}</span>
            </div>
            {q.detail && <div className="quiet"><Markdown source={q.detail} /></div>}
            {q.status === "proposed" && q.resolution && (
                <div className="po-resolution">
                    <div className="chat-msg-head"><b>Suggested resolution</b></div>
                    {edit === null ? <Markdown source={q.resolution} /> : <AgentInput value={edit} onChange={setEdit} rows={4} />}
                    <div className="actions" style={{ marginBottom: 0 }}>
                        {edit === null ? (
                            <>
                                <Button variant="primary" disabled={asking} onClick={() => void onConfirm()} title="The Product Owner records it in its context and design">Confirm</Button>
                                <Button disabled={asking} onClick={() => setEdit(q.resolution ?? "")}>Edit, then confirm</Button>
                                <span className="field-hint">or keep discussing below</span>
                            </>
                        ) : (
                            <>
                                <Button variant="primary" disabled={!edit.trim()} onClick={() => void onConfirm(edit.trim()).then(() => setEdit(null))}>Confirm this resolution</Button>
                                <Button onClick={() => setEdit(null)}>Cancel</Button>
                            </>
                        )}
                    </div>
                </div>
            )}
            {q.status === "resolved" && q.resolution && (
                <div className="po-resolution done">
                    <div className="chat-msg-head"><b>Resolution</b> <span className="field-hint">confirmed {q.resolved_at ? when(q.resolved_at) : ""}</span></div>
                    <Markdown source={q.resolution} />
                </div>
            )}
            {q.status === "dropped" && <div className="quiet">Dropped by the Product Owner{q.resolution ? `: ${q.resolution}` : ""}. Write to it to open the question again.</div>}
            {q.status === "open" && own !== null && (
                <div className="po-resolution">
                    <AgentInput placeholder="The answer, as a decision — the Product Owner records it" value={own} onChange={setOwn} rows={3} />
                    <div className="actions" style={{ marginBottom: 0 }}>
                        <Button variant="primary" disabled={!own.trim()} onClick={() => void onConfirm(own.trim()).then(() => setOwn(null))}>Resolve</Button>
                        <Button onClick={() => setOwn(null)}>Cancel</Button>
                    </div>
                </div>
            )}
            <div>
                {(q.status !== "resolved" || q.thread.length > 0) && <Button size="sm" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"} {q.status === "resolved" ? "Discussion" : "Discuss with Product owner"}{q.thread.length ? ` (${q.thread.length})` : ""}</Button>}{" "}
                {q.status === "open" && own === null && <Button size="sm" onClick={() => setOwn("")}>I know the answer</Button>}
            </div>
            {open && (
                <div className="line-thread" style={{ marginLeft: 0 }}>
                    <Thread thread={q.thread} asking={asking} />
                    {!asking && q.status !== "resolved" && (
                        <>
                            <AgentInput
                                placeholder="Answer it, give a fact, or ask what the Product Owner needs (⌘/Ctrl+Enter sends)"
                                value={text}
                                onChange={setText}
                                rows={2}
                                onKeyDown={(e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                        e.preventDefault();
                                        void send();
                                    }
                                }}
                            />
                            <div className="actions" style={{ marginBottom: 0 }}><Button variant="primary" disabled={!text.trim()} onClick={() => void send()}>Send</Button></div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export const QuestionsTab = ({ d, onError, reload }: Props) => {
    const call = async (fn: () => Promise<unknown>) => { try { await fn(); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } };
    const live = d.questions.filter((q) => q.status === "open" || q.status === "proposed");
    const resolved = d.questions.filter((q) => q.status === "resolved").reverse();
    const dropped = d.questions.filter((q) => q.status === "dropped").reverse();
    const card = (q: PoQuestion) => (
        <QuestionCard key={q.id} q={q} asking={d.askingQuestions.includes(q.id)} onAsk={(t) => call(() => api.poAskQuestion(d.po.id, q.id, t))} onConfirm={(r) => call(() => api.poConfirmQuestion(d.po.id, q.id, r))} />
    );
    return (
        <>
            <div className="field-hint" style={{ marginBottom: 8 }}>The Product Owner keeps this list. Discuss a question with it; when it suggests a resolution, confirm it — the Product Owner then records it in its context and design.</div>
            {live.length === 0 ? <div className="empty">No outstanding questions.</div> : live.map(card)}
            {resolved.length > 0 && <details className="po-history"><summary>Resolved ({resolved.length})</summary>{resolved.map(card)}</details>}
            {dropped.length > 0 && <details className="po-history"><summary>Dropped ({dropped.length})</summary>{dropped.map(card)}</details>}
        </>
    );
};

// ---------- events ----------

const KIND_LABEL: Record<string, string> = { created: "created", artifact: "source", tracker: "task manager", chat: "chat", system: "system", design: "design", tickets: "tickets", question: "question", edit: "your edit", context: "product context" };
const EVENT_STATUS: Record<PoJournalEvent["status"], [string, string] | null> = {
    pending: ["queued for the Product Owner", "wait"],
    waiting: ["waiting for the description", "wait"],
    processing: ["Product Owner reading…", "wait"],
    done: null,
    unread: ["not read by the Product Owner", "warn"],
    failed: ["failed", "bad"],
};
const FILE_OF = { context: "context.md", design: "design.md", tickets: "tickets.json" } as const;

const EventCard = ({ e, d, onRead }: { e: PoJournalEvent; d: PoDetail; onRead: () => void }) => {
    const status = EVENT_STATUS[e.status];
    const files = (["context", "design", "tickets"] as const).filter((f) => e.changes?.[f]?.length);
    const arts = (e.refs.artifacts ?? []).map((id) => d.artifacts.find((a) => a.id === id)).filter((a) => !!a);
    return (
        <div className={`po-event ${e.kind}`}>
            <div className="po-comment-top">
                <Chip>{KIND_LABEL[e.kind] ?? e.kind}</Chip>
                <b>{e.title}</b>
                {status && <Chip className={`${status[1]}`} title={e.error ?? undefined}>{status[0]}</Chip>}
                <span className="spacer" />
                <span className="field-hint">{when(e.created_at)}</span>
            </div>
            {e.brief ? <div className="po-brief"><Markdown source={e.brief} /></div> : e.status === "done" && <div className="quiet">No brief.</div>}
            {e.error && e.status !== "done" && <div className="field-hint bad">{e.error}</div>}
            {(e.status === "unread" || e.status === "failed") && e.retryable && <div className="actions" style={{ margin: "4px 0" }}><Button size="sm" variant="primary" disabled={d.running} onClick={onRead}>Have the Product Owner read it</Button></div>}
            <div className="po-event-links">
                {files.map((f) => <Chip key={f} tone="accent">{FILE_OF[f]} changed</Chip>)}
                {e.memory.length > 0 && <Chip>{e.memory.length} memory write(s)</Chip>}
                {e.linked.questions.length > 0 && <Chip tone="warn">questions: {e.linked.questions.join(", ")}</Chip>}
                {e.linked.corrections > 0 && <Chip tone="warn">{e.linked.corrections} correction(s)</Chip>}
                {arts.map((a) => <Chip key={a!.id}>{a!.title}</Chip>)}
            </div>
            {e.body && <details><summary>What reached the Product Owner</summary><div className="po-event-body"><Markdown source={e.body} /></div></details>}
            {files.map((f) => (
                <details key={f}>
                    <summary>{FILE_OF[f]} — {e.changes![f]!.filter((l) => l.startsWith("+ ")).length} added, {e.changes![f]!.filter((l) => l.startsWith("- ")).length} removed line(s){e.changes?.revisions?.[FILE_OF[f]] ? <span className="field-hint"> · revision {e.changes.revisions[FILE_OF[f]]}</span> : null}</summary>
                    <DiffLines lines={e.changes![f]!} />
                </details>
            ))}
            {e.memory.length > 0 && (
                <details>
                    <summary>Memory writes ({e.memory.length})</summary>
                    <ul className="po-memory">{e.memory.map((m, i) => <li key={i}><code>{m.tool}</code> <span className="quiet">{m.input.slice(0, 400)}</span></li>)}</ul>
                </details>
            )}
        </div>
    );
};

export const EventsTab = ({ d, onError, reload }: Props) => {
    const [kind, setKind] = useState("");
    const kinds = useMemo(() => [...new Set(d.events.map((e) => e.kind))], [d.events]);
    const list = kind ? d.events.filter((e) => e.kind === kind) : d.events;
    return (
        <>
            <div className="po-issues-bar">
                <span className="field-hint">Everything that reached the Product Owner, newest first, with its brief and what it changed in its context, design and memory.</span>
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="">All events ({d.events.length})</option>
                    {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
                </Select>
            </div>
            {list.length === 0 ? <div className="empty">No events yet.</div> : list.map((e) => <EventCard key={e.id} e={e} d={d} onRead={() => void api.poReadEvent(d.po.id, e.id).then(reload).catch((err: Error) => onError(err.message))} />)}
        </>
    );
};

// ---------- corrections ----------

const TicketCorrection = ({ c, d, busy, onApply, onDiscard }: { c: PoCorrection; d: PoDetail; busy: boolean; onApply: () => void; onDiscard: () => void }) => {
    const issue = d.issues.find((i) => i.identifier.toUpperCase() === c.target.toUpperCase());
    const ev = d.events.find((e) => e.id === c.event_id);
    const manager = d.po.source === "clickup" ? "ClickUp" : "Linear";
    return (
        <div className="po-comment-card">
            <div className="po-comment-top">
                {issue ? <a className="chip accent" href={issue.url} target="_blank" rel="noreferrer">{c.target} ↗</a> : <Chip tone="accent">{c.target}</Chip>}
                <b>{c.title}</b>
                <span className="spacer" />
                <span className="field-hint">{when(c.created_at)}</span>
            </div>
            {c.body && <Markdown source={c.body} />}
            {ev && <div className="field-hint">After: {ev.title}</div>}
            {issue && issue.description !== c.before && <div className="field-hint bad">The description changed in {issue.url.includes("clickup") ? "ClickUp" : "Linear"} since this suggestion.</div>}
            <details open>
                <summary>New description — diff</summary>
                <DiffLines lines={c.diff ?? []} />
            </details>
            <div className="actions" style={{ marginBottom: 0 }}>
                <Button variant="primary" disabled={busy} title={`Write the new description to ${c.target} in ${manager}`} onClick={() => { if (confirm(`Replace the description of ${c.target} in ${manager} with the new one?`)) onApply(); }}>Apply</Button>
                <Button variant="danger" disabled={busy} onClick={onDiscard}>Discard</Button>
            </div>
        </div>
    );
};

const TaskGroup = ({ taskId, items, d, busy, onSend, onDiscard }: { taskId: string; items: PoCorrection[]; d: PoDetail; busy: boolean; onSend: (ids: string[]) => void; onDiscard: (ids: string[]) => void }) => {
    const task = d.tasks.find((t) => t.id === taskId);
    const [picked, setPicked] = useState<Set<string>>(() => new Set(items.map((c) => c.id)));
    const ids = items.filter((c) => picked.has(c.id)).map((c) => c.id);
    const pastDesign = task && task.stage !== "design_proposal";
    const waiting = task?.stage === "design_proposal" && task.status === "waiting_user";
    return (
        <Card className="po-task-group">
            <div className="po-comment-top">
                <b>Task</b>
                {task ? <a href={`#/tasks/${encodeURIComponent(task.id)}`}>{task.ticket_id}{task.title ? ` — ${task.title}` : ""}</a> : <span className="quiet">(task gone)</span>}
                {task && <><Chip>{task.stage.replace(/_/g, " ")}</Chip> <Chip>{task.status.replace(/_/g, " ")}</Chip></>}
            </div>
            {items.map((c) => {
                const ev = d.events.find((e) => e.id === c.event_id);
                return (
                    <div key={c.id} className={`po-comment-card${picked.has(c.id) ? " picked" : ""}`}>
                        <div className="po-comment-top">
                            <label className="inline"><Input type="checkbox" checked={picked.has(c.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} /></label>
                            <b>{c.title}</b>
                            <span className="spacer" />
                            <span className="field-hint">{when(c.created_at)}</span>
                        </div>
                        <Markdown source={c.body} />
                        {ev && <div className="field-hint">After: {ev.title}</div>}
                    </div>
                );
            })}
            <div className="actions" style={{ marginBottom: 0 }}>
                <Button variant="primary"
 
 disabled={busy || !ids.length || !task || task.status === "running"}
 title={task?.status === "running" ? "The task is running — send when its run ends" : waiting ? "Another design round with these as the notes" : "The task goes back to Design proposal with these as the notes"}
 onClick={() => {
 if (pastDesign && !confirm(`${task!.ticket_id} is at ${task!.stage.replace(/_/g, " ")}. It goes back to Design proposal with ${ids.length} correction(s); the later stages run again. Send?`)) return;
 onSend(ids);
 }}
>
                    Send {ids.length} to agent
                </Button>
                <Button variant="danger" disabled={busy || !ids.length} onClick={() => onDiscard(ids)}>Discard {ids.length}</Button>
                {pastDesign && <span className="field-hint">The task goes back to Design proposal; later stages run again.</span>}
            </div>
        </Card>
    );
};

const STATUS_LABEL: Record<PoCorrection["status"], string> = { open: "open", sent: "sent to agent", discarded: "discarded", applied: "applied", withdrawn: "withdrawn by the PO" };

export const CorrectionsTab = ({ d, onError, reload }: Props) => {
    const [busy, setBusy] = useState(false);
    const call = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } finally { setBusy(false); } };
    const open = d.corrections.filter((c) => c.status === "open");
    const tickets = open.filter((c) => c.kind === "ticket");
    const byTask = new Map<string, PoCorrection[]>();
    for (const c of open.filter((x) => x.kind === "task")) byTask.set(c.target, [...(byTask.get(c.target) ?? []), c]);
    const done = d.corrections.filter((c) => c.status !== "open");
    const label = (c: PoCorrection) => (c.kind === "task" ? d.tasks.find((t) => t.id === c.target)?.ticket_id ?? "task" : c.target);
    return (
        <>
            <div className="field-hint" style={{ marginBottom: 8 }}>After an event, the Product Owner suggests what to change in existing tickets and in the designs of existing tasks.</div>
            {open.length === 0 && <div className="empty">No open corrections.</div>}
            {byTask.size > 0 && <h2>Tasks</h2>}
            {[...byTask.entries()].map(([taskId, items]) => (
                <TaskGroup key={`${taskId}:${items.map((c) => c.id).join(",")}`} taskId={taskId} items={items} d={d} busy={busy} onSend={(ids) => void call(() => api.poSendCorrections(d.po.id, ids))} onDiscard={(ids) => void call(() => api.poCorrectionsStatus(d.po.id, ids, "discarded"))} />
            ))}
            {tickets.length > 0 && <h2>Tickets</h2>}
            {tickets.map((c) => <TicketCorrection key={c.id} c={c} d={d} busy={busy} onApply={() => void call(() => api.poApplyCorrection(d.po.id, c.id))} onDiscard={() => void call(() => api.poCorrectionsStatus(d.po.id, [c.id], "discarded"))} />)}
            {done.length > 0 && (
                <details className="po-history">
                    <summary>Done ({done.length})</summary>
                    {done.map((c) => (
                        <details key={c.id} className="po-comment-card closed">
                            <summary><Chip>{c.kind}</Chip> <Chip>{label(c)}</Chip> <b>{c.title}</b> <Chip>{STATUS_LABEL[c.status]}</Chip> <span className="field-hint">{when(c.updated_at)}</span></summary>
                            {c.body && <Markdown source={c.body} />}
                            {c.kind === "ticket" && c.diff && <DiffLines lines={c.diff} />}
                        </details>
                    ))}
                </details>
            )}
        </>
    );
};
