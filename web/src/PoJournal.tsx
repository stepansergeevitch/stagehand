import { useMemo, useState } from "react";
import { api, trackerName, type PoCorrection, type PoDetail, type PoJournalEvent, type PoQuestion } from "./api";
import { AgentInput, usePendingFiles } from "./AgentInput";
import { PoMessageFiles } from "./FilePicker";
import { Markdown } from "./Markdown";
import { Section } from "./components/Panel";
import { Nothing } from "./product/parts";
import { errText, when } from "./format";
import { Badge, Button, Checkbox, Chip, Select, type Tone } from "@vortex/ds";

// A Product owner's journal on its page: the outstanding questions it keeps, the events that reached it (and what
// each changed), and the corrections it suggests for existing tickets and task designs. The cards use the product
// styles (product/product.css).

type Props = { d: PoDetail; onError: (m: string) => void; reload: () => void };

// Lines of a diff: "+ " added, "- " removed, "  " unchanged, "…" a gap.
export const DiffLines = ({ lines, max = 400 }: { lines: string[]; max?: number }) => (
    <pre className="po-diff">
        {lines.slice(0, max).map((l, i) => (
            <div key={i} className={l === "…" ? "gap" : l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : "ctx"}>{l === "…" ? "⋯" : l}</div>
        ))}
        {lines.length > max && <div className="gap">… {lines.length - max} more line(s)</div>}
    </pre>
);

const Thread = ({ poId, thread, asking }: { poId: string; thread: PoQuestion["thread"]; asking: boolean }) => (
    <div className="po-thread">
        {thread.map((m, i) => (
            <div key={i} className={`po-thread-msg ${m.role === "po" ? "agent" : "user"}`}>
                <div className="po-thread-head"><b>{m.role === "user" ? "You" : "Product owner"}</b> <span className="po-muted">{when(m.at)}</span></div>
                {m.role === "po" ? <Markdown source={m.text} /> : <div>{m.text}</div>}
                <PoMessageFiles poId={poId} files={m.files ?? []} />
            </div>
        ))}
        {asking && <div className="po-thread-msg agent pending">The Product owner is answering…</div>}
    </div>
);

// ---------- outstanding questions ----------

const STATUS_CHIP: Record<PoQuestion["status"], [string, Tone]> = { open: ["Open", "warn"], proposed: ["Resolution to confirm", "warn"], resolved: ["Resolved", "ok"], dropped: ["Dropped", "neutral"] };

const QuestionCard = ({ q, poId, asking, onAsk, onConfirm }: { q: PoQuestion; poId: string; asking: boolean; onAsk: (t: string, files: File[]) => Promise<void>; onConfirm: (resolution: string | undefined, files: File[]) => Promise<void> }) => {
    const askFiles = usePendingFiles();
    const ownFiles = usePendingFiles();
    const editFiles = usePendingFiles();
    const live = q.status === "open" || q.status === "proposed";
    const [open, setOpen] = useState(live && (q.thread.length > 0 || q.status === "proposed"));
    const [text, setText] = useState("");
    const [edit, setEdit] = useState<string | null>(null);
    const [own, setOwn] = useState<string | null>(null);
    const send = async () => {
        const t = text.trim();
        if (!t && askFiles.files.length === 0) return;
        setOpen(true);
        try { await onAsk(t || "See the attached file(s).", askFiles.files); } catch { return; }
        setText("");
        askFiles.clear();
    };
    const [label, tone] = STATUS_CHIP[q.status];
    return (
        <article className={`po-card ${q.status}`}>
            <div className="po-card-head">
                <Chip mono>{q.key}</Chip>
                <b className="po-card-title">{q.question}</b>
                <Chip tone={tone}>{label}</Chip>
                <time className="po-muted">{when(q.created_at)}</time>
            </div>
            {q.detail && <div className="po-card-body"><Markdown source={q.detail} /></div>}
            {q.status === "proposed" && q.resolution && (
                <div className="po-quote">
                    <b>Suggested resolution</b>
                    {edit === null ? <Markdown source={q.resolution} /> : <AgentInput value={edit} onChange={setEdit} pending={editFiles} rows={4} />}
                    <div className="po-actions">
                        {edit === null ? (
                            <>
                                <Button variant="primary" disabled={asking} onClick={() => void onConfirm(undefined, []).catch(() => undefined)} title="The Product owner records it in its context and design">Confirm</Button>
                                <Button disabled={asking} onClick={() => setEdit(q.resolution ?? "")}>Edit, then confirm</Button>
                            </>
                        ) : (
                            <>
                                <Button variant="primary" disabled={!edit.trim() && editFiles.files.length === 0} onClick={() => void onConfirm(edit.trim() || undefined, editFiles.files).then(() => { setEdit(null); editFiles.clear(); }, () => undefined)}>Confirm this resolution</Button>
                                <Button onClick={() => { setEdit(null); editFiles.clear(); }}>Cancel</Button>
                            </>
                        )}
                    </div>
                </div>
            )}
            {q.status === "resolved" && q.resolution && (
                <div className="po-quote done">
                    <b>Resolution</b> <span className="po-muted">confirmed {q.resolved_at ? when(q.resolved_at) : ""}</span>
                    <Markdown source={q.resolution} />
                </div>
            )}
            {q.status === "dropped" && <p className="po-muted">Dropped by the Product owner{q.resolution ? `: ${q.resolution}` : ""}. Write to it to open the question again.</p>}
            {q.status === "open" && own !== null && (
                <div className="po-quote">
                    <AgentInput placeholder="The answer, as a decision — the Product owner records it" value={own} onChange={setOwn} pending={ownFiles} rows={3} />
                    <div className="po-actions">
                        <Button variant="primary" disabled={!own.trim() && ownFiles.files.length === 0} onClick={() => void onConfirm(own.trim() || undefined, ownFiles.files).then(() => { setOwn(null); ownFiles.clear(); }, () => undefined)}>Resolve</Button>
                        <Button onClick={() => { setOwn(null); ownFiles.clear(); }}>Cancel</Button>
                    </div>
                </div>
            )}
            <div className="po-actions">
                {(q.status !== "resolved" || q.thread.length > 0) && <Button size="sm" on={open} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{q.status === "resolved" ? "Discussion" : "Discuss"}{q.thread.length ? ` (${q.thread.length})` : ""}</Button>}
                {q.status === "open" && own === null && <Button size="sm" onClick={() => setOwn("")}>I know the answer</Button>}
            </div>
            {open && (
                <div className="po-discussion">
                    <Thread poId={poId} thread={q.thread} asking={asking} />
                    {!asking && q.status !== "resolved" && (
                        <>
                            <AgentInput
                                placeholder="Answer it, give a fact, or ask what the Product owner needs (⌘/Ctrl+Enter sends)"
                                value={text}
                                onChange={setText}
                                pending={askFiles}
                                rows={2}
                                onKeyDown={(e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                        e.preventDefault();
                                        void send();
                                    }
                                }}
                            />
                            <div className="po-actions"><Button variant="primary" disabled={!text.trim() && askFiles.files.length === 0} onClick={() => void send()}>Send</Button></div>
                        </>
                    )}
                </div>
            )}
        </article>
    );
};

export const QuestionsTab = ({ d, onError, reload }: Props) => {
    // Rethrows: the box that sent keeps its draft when the call failed.
    const call = async (fn: () => Promise<unknown>) => { try { await fn(); reload(); } catch (e) { onError(errText(e)); throw e; } };
    const live = d.questions.filter((q) => q.status === "open" || q.status === "proposed");
    const resolved = d.questions.filter((q) => q.status === "resolved").reverse();
    const dropped = d.questions.filter((q) => q.status === "dropped").reverse();
    const card = (q: PoQuestion) => (
        <QuestionCard key={q.id} q={q} poId={d.po.id} asking={d.askingQuestions.includes(q.id)} onAsk={(t, f) => call(async () => api.poAskQuestion(d.po.id, q.id, t, f.length ? await api.uploadPoFiles(d.po.id, f) : undefined))} onConfirm={(r, f) => call(async () => api.poConfirmQuestion(d.po.id, q.id, r, f.length ? await api.uploadPoFiles(d.po.id, f) : undefined))} />
    );
    return (
        <div className="po-stack">
            <Section title={<>Outstanding questions <Badge>{live.length}</Badge></>} hint="The Product owner keeps this list. Discuss a question with it; when it suggests a resolution, confirm it — the Product owner then records it in its context and design.">
                {live.length === 0 ? <Nothing title="No outstanding questions" /> : <div className="po-cards">{live.map(card)}</div>}
            </Section>
            {resolved.length > 0 && <details className="po-fold po-history"><summary>Resolved ({resolved.length})</summary><div className="po-cards">{resolved.map(card)}</div></details>}
            {dropped.length > 0 && <details className="po-fold po-history"><summary>Dropped ({dropped.length})</summary><div className="po-cards">{dropped.map(card)}</div></details>}
        </div>
    );
};

// ---------- events ----------

const KIND_LABEL: Record<string, string> = { created: "Created", artifact: "Source", tracker: "Task manager", chat: "Chat", system: "System", design: "Design", tickets: "Tickets", question: "Question", edit: "Your edit", context: "Product context" };
const EVENT_STATUS: Record<PoJournalEvent["status"], [string, Tone] | null> = {
    pending: ["Queued for the Product owner", "wait"],
    waiting: ["Waiting for the description", "wait"],
    processing: ["Product owner reading…", "info"],
    done: null,
    unread: ["Not read by the Product owner", "warn"],
    failed: ["Failed", "bad"],
};
const FILE_OF = { context: "context.md", design: "design.md", tickets: "tickets.json" } as const;

const EventCard = ({ e, d, onRead }: { e: PoJournalEvent; d: PoDetail; onRead: () => void }) => {
    const status = EVENT_STATUS[e.status];
    const files = (["context", "design", "tickets"] as const).filter((f) => e.changes?.[f]?.length);
    const arts = (e.refs.artifacts ?? []).map((id) => d.artifacts.find((a) => a.id === id)).filter((a) => !!a);
    return (
        <article className={`po-card ${e.kind}`}>
            <div className="po-card-head">
                <Chip>{KIND_LABEL[e.kind] ?? e.kind}</Chip>
                <b className="po-card-title">{e.title}</b>
                {status && <Chip tone={status[1]} title={e.error ?? undefined}>{status[0]}</Chip>}
                <time className="po-muted">{when(e.created_at)}</time>
            </div>
            {e.brief ? <div className="po-quote"><Markdown source={e.brief} /></div> : e.status === "done" && <p className="po-muted">No brief.</p>}
            {e.error && e.status !== "done" && <p className="po-error">{e.error}</p>}
            {(e.status === "unread" || e.status === "failed") && e.retryable && <div className="po-actions"><Button size="sm" variant="primary" disabled={d.running} onClick={onRead}>Have the Product owner read it</Button></div>}
            <div className="po-chips">
                {files.map((f) => <Chip key={f} tone="accent">{FILE_OF[f]} changed</Chip>)}
                {e.memory.length > 0 && <Chip>{e.memory.length} memory write(s)</Chip>}
                {e.linked.questions.length > 0 && <Chip tone="warn">Questions: {e.linked.questions.join(", ")}</Chip>}
                {e.linked.corrections > 0 && <Chip tone="warn">{e.linked.corrections} correction(s)</Chip>}
                {arts.map((a) => <Chip key={a!.id}>{a!.title}</Chip>)}
            </div>
            {e.body && <details className="po-fold"><summary>What reached the Product owner</summary><div className="po-scroll"><Markdown source={e.body} /></div></details>}
            {files.map((f) => (
                <details key={f} className="po-fold">
                    <summary>{FILE_OF[f]} — {e.changes![f]!.filter((l) => l.startsWith("+ ")).length} added, {e.changes![f]!.filter((l) => l.startsWith("- ")).length} removed line(s){e.changes?.revisions?.[FILE_OF[f]] ? <span className="po-muted"> · revision {e.changes.revisions[FILE_OF[f]]}</span> : null}</summary>
                    <DiffLines lines={e.changes![f]!} />
                </details>
            ))}
            {e.memory.length > 0 && (
                <details className="po-fold">
                    <summary>Memory writes ({e.memory.length})</summary>
                    <ul className="po-memory">{e.memory.map((m, i) => <li key={i}><code>{m.tool}</code> <span className="po-muted">{m.input.slice(0, 400)}</span></li>)}</ul>
                </details>
            )}
        </article>
    );
};

export const EventsTab = ({ d, onError, reload }: Props) => {
    const [kind, setKind] = useState("");
    const kinds = useMemo(() => [...new Set(d.events.map((e) => e.kind))], [d.events]);
    const list = kind ? d.events.filter((e) => e.kind === kind) : d.events;
    return (
        <Section
            title="Events"
            hint="Everything that reached the Product owner, newest first, with its brief and what it changed in its context, design and memory."
            actions={(
                <Select value={kind} aria-label="Filter by kind" onChange={(e) => setKind(e.target.value)}>
                    <option value="">All events ({d.events.length})</option>
                    {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
                </Select>
            )}
        >
            {list.length === 0 ? <Nothing title="No events yet" /> : <div className="po-cards">{list.map((e) => <EventCard key={e.id} e={e} d={d} onRead={() => void api.poReadEvent(d.po.id, e.id).then(reload).catch((err: Error) => onError(err.message))} />)}</div>}
        </Section>
    );
};

// ---------- corrections ----------

const TicketCorrection = ({ c, d, busy, onApply, onDiscard }: { c: PoCorrection; d: PoDetail; busy: boolean; onApply: () => void; onDiscard: () => void }) => {
    const issue = d.issues.find((i) => i.identifier.toUpperCase() === c.target.toUpperCase());
    const ev = d.events.find((e) => e.id === c.event_id);
    const manager = trackerName(d.po.source);
    return (
        <article className="po-card">
            <div className="po-card-head">
                {issue && /^https?:/.test(issue.url) ? <a className="po-ext" href={issue.url} target="_blank" rel="noreferrer">{c.target} ↗</a> : <Chip tone="accent">{c.target}</Chip>}
                <b className="po-card-title">{c.title}</b>
                <time className="po-muted">{when(c.created_at)}</time>
            </div>
            {c.body && <Markdown source={c.body} />}
            {ev && <p className="po-muted">After: {ev.title}</p>}
            {issue && issue.description !== c.before && <p className="po-error">The description changed in {manager} since this suggestion.</p>}
            <details className="po-fold" open>
                <summary>New description, as a diff</summary>
                <DiffLines lines={c.diff ?? []} />
            </details>
            <div className="po-actions">
                <Button variant="primary" disabled={busy} title={`Write the new description to ${c.target} in ${manager}`} onClick={() => { if (confirm(`Replace the description of ${c.target} in ${manager} with the new one?`)) onApply(); }}>Apply</Button>
                <Button variant="danger" disabled={busy} onClick={onDiscard}>Discard</Button>
            </div>
        </article>
    );
};

const TaskGroup = ({ taskId, items, d, busy, onSend, onDiscard }: { taskId: string; items: PoCorrection[]; d: PoDetail; busy: boolean; onSend: (ids: string[]) => void; onDiscard: (ids: string[]) => void }) => {
    const task = d.tasks.find((t) => t.id === taskId);
    const [picked, setPicked] = useState<Set<string>>(() => new Set(items.map((c) => c.id)));
    const ids = items.filter((c) => picked.has(c.id)).map((c) => c.id);
    const pastDesign = task && task.stage !== "design_proposal";
    const waiting = task?.stage === "design_proposal" && task.status === "waiting_user";
    return (
        <article className="po-card group">
            <div className="po-card-head">
                <b>Task</b>
                {task ? <a href={`#/tasks/${encodeURIComponent(task.id)}`}>{task.ticket_id}{task.title ? ` — ${task.title}` : ""}</a> : <span className="po-muted">(task gone)</span>}
                {task && <span className="po-muted">{task.stage.replace(/_/g, " ")} · {task.status.replace(/_/g, " ")}</span>}
            </div>
            {items.map((c) => {
                const ev = d.events.find((e) => e.id === c.event_id);
                return (
                    <div key={c.id} className={`po-subcard${picked.has(c.id) ? " picked" : ""}`}>
                        <div className="po-card-head">
                            <Checkbox aria-label={`Include ${c.title}`} checked={picked.has(c.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                            <b className="po-card-title">{c.title}</b>
                            <time className="po-muted">{when(c.created_at)}</time>
                        </div>
                        <Markdown source={c.body} />
                        {ev && <p className="po-muted">After: {ev.title}</p>}
                    </div>
                );
            })}
            <div className="po-actions">
                <Button
                    variant="primary"
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
                {pastDesign && <span className="po-muted">The task goes back to Design proposal; later stages run again.</span>}
            </div>
        </article>
    );
};

const STATUS_LABEL: Record<PoCorrection["status"], string> = { open: "Open", sent: "Sent to agent", discarded: "Discarded", applied: "Applied", withdrawn: "Withdrawn by the Product owner" };

export const CorrectionsTab = ({ d, onError, reload }: Props) => {
    const [busy, setBusy] = useState(false);
    const call = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); reload(); } catch (e) { onError(errText(e)); } finally { setBusy(false); } };
    const open = d.corrections.filter((c) => c.status === "open");
    const tickets = open.filter((c) => c.kind === "ticket");
    const byTask = new Map<string, PoCorrection[]>();
    for (const c of open.filter((x) => x.kind === "task")) byTask.set(c.target, [...(byTask.get(c.target) ?? []), c]);
    const done = d.corrections.filter((c) => c.status !== "open");
    const label = (c: PoCorrection) => (c.kind === "task" ? d.tasks.find((t) => t.id === c.target)?.ticket_id ?? "task" : c.target);
    return (
        <div className="po-stack">
            {open.length === 0 && <Nothing title="No open corrections">After an event, the Product owner suggests what to change in existing tickets and in the designs of existing tasks.</Nothing>}
            {byTask.size > 0 && (
                <Section title="Tasks" hint="Changes the Product owner suggests to the designs of existing tasks. Pick the ones to send to the task's agent.">
                    <div className="po-cards">
                        {[...byTask.entries()].map(([taskId, items]) => (
                            <TaskGroup key={`${taskId}:${items.map((c) => c.id).join(",")}`} taskId={taskId} items={items} d={d} busy={busy} onSend={(ids) => void call(() => api.poSendCorrections(d.po.id, ids))} onDiscard={(ids) => void call(() => api.poCorrectionsStatus(d.po.id, ids, "discarded"))} />
                        ))}
                    </div>
                </Section>
            )}
            {tickets.length > 0 && (
                <Section title="Tickets" hint="New descriptions the Product owner suggests for existing tickets. Applying writes the description to the task manager.">
                    <div className="po-cards">
                        {tickets.map((c) => <TicketCorrection key={c.id} c={c} d={d} busy={busy} onApply={() => void call(() => api.poApplyCorrection(d.po.id, c.id))} onDiscard={() => void call(() => api.poCorrectionsStatus(d.po.id, [c.id], "discarded"))} />)}
                    </div>
                </Section>
            )}
            {done.length > 0 && (
                <details className="po-fold po-history">
                    <summary>Done ({done.length})</summary>
                    <div className="po-cards">
                        {done.map((c) => (
                            <details key={c.id} className="po-card closed">
                                <summary><Chip>{c.kind}</Chip><Chip>{label(c)}</Chip><b className="po-card-title">{c.title}</b><Chip tone={c.status === "applied" ? "ok" : "neutral"}>{STATUS_LABEL[c.status]}</Chip><time className="po-muted">{when(c.updated_at)}</time></summary>
                                {c.body && <Markdown source={c.body} />}
                                {c.kind === "ticket" && c.diff && <DiffLines lines={c.diff} />}
                            </details>
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
};
