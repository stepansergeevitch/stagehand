import { useCallback, useEffect, useRef, useState } from "react";
import { Loading } from "../components/Loading";
import { errText } from "../format";
import { api, poFilesOf, type PoDetail, type PoPhase } from "../api";
import { usePendingFiles } from "../AgentInput";
import { PoMessageFiles } from "../FilePicker";
import { Markdown } from "../Markdown";
import { CorrectionsTab, EventsTab, QuestionsTab } from "../PoJournal";
import { EntityView } from "../components/EntityView";
import { Panel } from "../components/Panel";
import { poBus } from "../poBus";
import type { PoTab } from "../routes";
import { Badge, Button, Chip, Icon, MenuItem, MoreMenu } from "@vortex/ds";
import { ChatInput } from "../components/ChatInput";
import { ContextTab } from "./ContextTab";
import { DesignTab } from "./DesignTab";
import { TicketsTab } from "./TicketsTab";
import { PHASE_LABEL } from "./parts";

const PHASES: PoPhase[] = ["context", "design", "tickets", "approved", "live"];

// Where the Product owner is in its work: a place, so plain words, the finished ones ticked, the current one bold.
const PhaseTrack = ({ phase }: { phase: PoPhase }) => {
    const at = PHASES.indexOf(phase);
    return (
        <ol className="po-phases" aria-label="Phase">
            {PHASES.map((p, i) => (
                <li key={p} className={i < at ? "done" : i === at ? "now" : undefined} {...(i === at ? { "aria-current": "step" as const } : {})}>
                    {i < at && <Icon name="check" />}{PHASE_LABEL[p]}
                </li>
            ))}
        </ol>
    );
};

const PoChat = ({ d, onError, reload }: { d: PoDetail; onError: (m: string) => void; reload: () => void }) => {
    const [text, setText] = useState("");
    const pending = usePendingFiles();
    const [live, setLive] = useState<string>("");
    const [activity, setActivity] = useState<string>("");
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => poBus.subscribe((ev) => {
        if (ev.poId !== d.po.id) return;
        if (ev.kind === "text") setLive(ev.text);
        if (ev.kind === "activity") setActivity(ev.text);
        if (ev.kind === "message" || ev.kind === "updated") { if (ev.kind === "message" && ev.message.role === "agent") { setLive(""); setActivity(""); } reload(); }
    }), [d.po.id, reload]);
    // Scroll the message list, not the page.
    useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [d.messages.length, live]);
    const send = async () => {
        const t = text.trim();
        if (!t && pending.files.length === 0) return;
        try { await api.poSend(d.po.id, t || "See the attached file(s).", pending.files.length ? await api.uploadPoFiles(d.po.id, pending.files) : undefined); setText(""); pending.clear(); reload(); } catch (e) { onError(errText(e)); }
    };
    return (
        <div className="po-chat">
            <div className="po-messages" ref={list} role="log" aria-label="Conversation">
                {d.messages.length === 0 && !d.running && <p className="po-muted">No messages yet.</p>}
                {d.messages.map((m) => (
                    <div key={m.id} className={`po-msg ${m.role}`}>
                        <span className="po-msg-who">{m.role === "agent" ? "Product owner" : m.role === "user" ? "You" : "Vortex"}</span>
                        <Markdown source={m.text} />
                        <PoMessageFiles poId={d.po.id} files={poFilesOf(m)} />
                    </div>
                ))}
                {d.running && (
                    <div className="po-msg agent live">
                        <span className="po-msg-who">Product owner{activity && <span className="po-muted"> · {activity}</span>}</span>
                        {live ? <Markdown source={live} /> : <p className="po-muted">Thinking…</p>}
                    </div>
                )}
            </div>
            <div className="po-input">
                <ChatInput
                    value={text}
                    onChange={setText}
                    pending={pending}
                    action={{ label: "Send", onSend: () => void send() }}
                    working={d.running}
                    onStop={() => void api.poStop(d.po.id).then(reload)}
                    disabled={d.running}
                    status={d.running ? "The Product owner is answering" : undefined}
                    placeholder="Message the Product owner"
                    rows={3}
                />
            </div>
        </div>
    );
};

const TAB_LABEL: Record<PoTab, string> = { context: "Context", design: "Design", questions: "Questions", corrections: "Corrections", tickets: "Tickets", events: "Events" };

// One Product owner: the entity view (its documents and journals as tabs) beside the chat that changes them.
export const PoPage = ({ id, tab: tabArg, ticket, ticketTab, onTab, onBack, onError }: { id: string; tab: PoTab | undefined; ticket: string | undefined; ticketTab: string | undefined; onTab: (t: PoTab) => void; onBack: () => void; onError: (m: string) => void }) => {
    const [d, setD] = useState<PoDetail | null>(null);
    const reload = useCallback(() => void api.productOwner(id).then(setD).catch((e: Error) => onError(e.message)), [id, onError]);
    useEffect(reload, [reload]);
    const send = (t: string) => void api.poSend(id, t).then(reload).catch((e: Error) => onError(e.message));
    if (!d) return <Loading />;
    const envPo = d.po.scope_kind === "env";
    const tabs: PoTab[] = envPo ? ["questions", "corrections", "context", "events"] : ["design", "questions", "corrections", "context", "tickets", "events"];
    // No tab in the URL: the first one.
    const tab = tabArg ?? tabs[0]!;
    const count = (t: PoTab): { n: number; tone: "warn" | "neutral" } | null => {
        if (t === "questions") return { n: d.questions.filter((q) => q.status === "open" || q.status === "proposed").length, tone: "warn" };
        if (t === "events") return { n: d.events.filter((e) => e.status === "unread" || e.status === "failed").length, tone: "warn" };
        if (t === "corrections") return { n: d.corrections.filter((c) => c.status === "open").length, tone: "warn" };
        if (t === "tickets") return { n: d.tickets?.tickets.length ?? 0, tone: "neutral" };
        return null;
    };
    const canApprove = !envPo && !!d.design && (d.po.phase === "context" || d.po.phase === "design");
    const failed = d.po.status === "failed";
    const remove = async () => {
        if (!confirm(`Delete the Product owner "${d.po.title}"? Its chat, sources and proposals go; its memory and the created tickets stay.`)) return;
        try { await api.deleteProductOwner(id); onBack(); } catch (e) { onError(errText(e)); }
    };
    return (
        <div className="po-workspace">
            <EntityView
                type="Product owners"
                onType={onBack}
                id={d.po.title}
                meta={
                    <>
                        <PhaseTrack phase={d.po.phase} />
                        {d.running && <Chip tone="info">Answering</Chip>}
                        {failed && <Chip tone="bad">Failed</Chip>}
                        {d.proposal && <Chip tone="warn">Context proposal</Chip>}
                        {d.po.scope_url && (/^https?:/.test(d.po.scope_url) ? <a className="po-ext" href={d.po.scope_url} target="_blank" rel="noreferrer">{d.po.source === "linear" ? "Linear project" : "ClickUp epic"} ↗</a> : <Chip mono>{d.po.scope_url}</Chip>)}
                        {d.tasks.length > 0 && <span className="po-muted">{d.tasks.length} task{d.tasks.length === 1 ? "" : "s"}</span>}
                    </>
                }
                notice={failed && d.po.status_line ? { ok: false, text: d.po.status_line } : null}
                actions={
                    <>
                        <Button className="po-chat-jump" onClick={() => document.getElementById("po-chat")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Chat</Button>
                        {canApprove && <Button variant="primary" disabled={d.running} onClick={async () => { try { await api.poApproveDesign(id); reload(); } catch (e) { onError(errText(e)); } }}>Approve design</Button>}
                        <MoreMenu>
                            <MenuItem danger onClick={() => void remove()}>Delete Product owner</MenuItem>
                        </MoreMenu>
                    </>
                }
                tab={tab}
                onTab={(t) => onTab(t as PoTab)}
                tabs={tabs.map((t) => {
                    const c = count(t);
                    return {
                        key: t,
                        label: <>{TAB_LABEL[t]}{t === "context" && d.proposal ? <Badge tone="warn">1</Badge> : c && c.n > 0 ? <Badge tone={c.tone}>{c.n}</Badge> : null}</>,
                        content:
                            t === "context" ? <ContextTab d={d} onError={onError} reload={reload} />
                            : t === "design" ? <DesignTab d={d} onError={onError} send={send} />
                            : t === "questions" ? <QuestionsTab d={d} onError={onError} reload={reload} />
                            : t === "tickets" ? <TicketsTab d={d} sel={ticket ?? null} ticketTab={ticketTab} onError={onError} reload={reload} send={send} />
                            : t === "events" ? <EventsTab d={d} onError={onError} reload={reload} />
                            : <CorrectionsTab d={d} onError={onError} reload={reload} />,
                    };
                })}
            />
            <aside id="po-chat" className="po-chat-aside" aria-label="Chat with the Product owner">
                <Panel title="Chat with the Product owner" flush><PoChat d={d} onError={onError} reload={reload} /></Panel>
            </aside>
        </div>
    );
};
