import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PrompterMessage, type PrompterSession, type Settings } from "./api";
import { Markdown } from "./Markdown";
import { storage } from "./storage";
import { prompterBus } from "./prompterBus";
import { formatRoute, type Route } from "./routes";
import { AgentInput, usePendingFiles } from "./AgentInput";

// Prompter — the assistant in the bottom-right corner. Every chat is a claude session on the server; several can be
// open at once and the strip under the header switches between them (the list is the server's, so a reload or a
// server restart shows the same chats; a turn that died with the server is sent again by the server). The palace is
// its memory between chats. It sees the current location (the route) with every message. Collapse keeps the chats;
// the × ends the current one (a farewell turn files notes); chats idle for a day end on their own.
// Messages sent while it answers stack up (dashed) and go out together as the next turn; ArrowUp in an empty input
// takes the last stacked message back for editing.

const OPEN_KEY = "stagehand.prompter.open";
const SESSION_KEY = "stagehand.prompter.session";
const WIDE_KEY = "stagehand.prompter.wide";

interface ChatState {
    messages: PrompterMessage[];
    live: string;
    activity: string | null;
    busy: boolean;
    unread: boolean;
    loaded: boolean;
}
const EMPTY: ChatState = { messages: [], live: "", activity: null, busy: false, unread: false, loaded: false };

const ago = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};

export const Prompter = ({ route, settings }: { route: Route; settings: Settings | null }) => {
    const [open, setOpen] = useState(() => storage.get(OPEN_KEY) === "1");
    const [wide, setWide] = useState(() => storage.get(WIDE_KEY) === "1");
    const [sessions, setSessions] = useState<PrompterSession[]>([]);
    const [activeId, setActiveId] = useState<string | null>(() => storage.get(SESSION_KEY) || null);
    const [chats, setChats] = useState<Record<string, ChatState>>({});
    const [text, setText] = useState("");
    const attach = usePendingFiles();
    const [error, setError] = useState<string | null>(null);
    const [model, setModel] = useState("");
    const [where, setWhere] = useState("");
    const [status, setStatus] = useState<{ ready: boolean; reason: string | null; account: string | null } | null>(null);
    const path = formatRoute(route);
    const bottom = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const session = sessions.find((s) => s.id === activeId) ?? null;
    const chat = (activeId && chats[activeId]) || EMPTY;
    const queued = chat.messages.filter((m) => m.role === "user" && m.state === "queued");

    const patchChat = useCallback((id: string, fn: (c: ChatState) => ChatState) => setChats((all) => ({ ...all, [id]: fn(all[id] ?? EMPTY) })), []);

    // The server's list of open chats; the active one is the remembered one when it is still open, else the newest.
    const loadSessions = useCallback(async (): Promise<PrompterSession[]> => {
        const list = await api.prompterSessions();
        setSessions(list);
        setChats((all) => {
            const next: Record<string, ChatState> = {};
            for (const s of list) next[s.id] = { ...(all[s.id] ?? EMPTY), busy: s.busy ?? all[s.id]?.busy ?? false };
            return next;
        });
        return list;
    }, []);

    // The messages of one chat (on first view, and again after the socket came back).
    const loadChat = useCallback(
        async (id: string) => {
            const r = await api.prompterMessages(id);
            patchChat(id, (c) => ({ ...c, messages: r.messages, busy: r.busy, loaded: true, unread: false, ...(r.busy ? {} : { live: "", activity: null }) }));
        },
        [patchChat],
    );

    const create = useCallback(async () => {
        const s = await api.prompterCreate(model || settings?.prompter?.model || null);
        setSessions((list) => [s, ...list.filter((x) => x.id !== s.id)]);
        patchChat(s.id, (c) => ({ ...c, loaded: true }));
        setActiveId(s.id);
        setModel(s.model ?? "");
        input.current?.focus();
    }, [model, settings, patchChat]);

    // Opening the window: the status, the chat list, and a chat to show (the remembered one, the newest, or a new one).
    useEffect(() => {
        if (!open) return;
        void api.prompterStatus().then((s) => setStatus({ ready: s.ready, reason: s.reason, account: s.account })).catch(() => undefined);
        void loadSessions()
            .then(async (list) => {
                const remembered = storage.get(SESSION_KEY);
                const pick = list.find((s) => s.id === remembered) ?? list[0];
                if (pick) setActiveId(pick.id);
                else await create();
            })
            .catch((e: Error) => setError(e.message));
        // create/loadSessions are stable enough for the open toggle; re-running on every model change would open chats.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    useEffect(() => {
        if (activeId) storage.set(SESSION_KEY, activeId);
    }, [activeId]);
    useEffect(() => {
        if (!open || !activeId) return;
        if (!chats[activeId]?.loaded) void loadChat(activeId).catch((e: Error) => setError(e.message));
        else patchChat(activeId, (c) => ({ ...c, unread: false }));
        const s = sessions.find((x) => x.id === activeId);
        if (s) setModel(s.model ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, activeId]);
    // The open window keeps the active chat alive (the server ends chats idle for a day).
    useEffect(() => {
        if (!open || !activeId) return;
        const t = setInterval(() => void api.prompterPing(activeId).catch(() => undefined), 60_000);
        return () => clearInterval(t);
    }, [open, activeId]);
    useEffect(() => storage.set(OPEN_KEY, open ? "1" : "0"), [open]);
    useEffect(() => storage.set(WIDE_KEY, wide ? "1" : "0"), [wide]);
    useEffect(
        () =>
            prompterBus.subscribe((ev) => {
                const id = ev.sessionId;
                if (ev.kind === "updated") {
                    void loadSessions().catch(() => undefined);
                    return;
                }
                if (ev.kind === "closed") {
                    setSessions((list) => list.filter((s) => s.id !== id));
                    setChats((all) => {
                        const { [id]: _gone, ...rest } = all;
                        return rest;
                    });
                    setActiveId((cur) => (cur === id ? null : cur));
                    return;
                }
                if (ev.kind === "text") patchChat(id, (c) => ({ ...c, live: ev.text, busy: true }));
                else if (ev.kind === "activity") patchChat(id, (c) => ({ ...c, activity: ev.text, busy: true }));
                else if (ev.kind === "done") {
                    patchChat(id, (c) => ({
                        ...c,
                        live: "",
                        activity: null,
                        busy: false,
                        unread: id !== activeId,
                        messages: ev.message && !c.messages.some((x) => x.id === ev.message!.id) ? [...c.messages, ev.message] : c.messages,
                    }));
                    if (ev.error && id === activeId) setError(ev.error);
                } else if (ev.kind === "queued") patchChat(id, (c) => ({ ...c, messages: c.messages.some((x) => x.id === ev.message.id) ? c.messages : [...c.messages, ev.message] }));
                else if (ev.kind === "removed") patchChat(id, (c) => ({ ...c, messages: c.messages.filter((x) => x.id !== ev.messageId) }));
                else if (ev.kind === "turn") patchChat(id, (c) => ({ ...c, busy: true, activity: null, messages: c.messages.map((x) => (ev.messageIds.includes(x.id) ? { ...x, state: "sent" } : x)) }));
            }),
        [activeId, loadSessions, patchChat],
    );
    // After the socket came back (server restart): the list and the active chat are re-read; a turn that was under
    // way is either lost or sent again by the server (it shows up as busy).
    useEffect(
        () =>
            prompterBus.onReconnect(() => {
                void loadSessions().catch(() => undefined);
                if (activeId) void loadChat(activeId).catch(() => undefined);
            }),
        [activeId, loadSessions, loadChat],
    );
    // A chat the active one was switched away from and later closed by the server: pick another.
    useEffect(() => {
        if (!open || activeId || sessions.length === 0) return;
        setActiveId(sessions[0]!.id);
    }, [open, activeId, sessions]);
    useEffect(() => {
        if (!open) return;
        const h = setTimeout(() => void api.prompterDescribe(path).then((d) => setWhere(d.summary)).catch(() => undefined), 300);
        return () => clearTimeout(h);
    }, [open, path]);
    useEffect(() => {
        bottom.current?.scrollIntoView({ block: "end" });
    }, [chat.messages.length, chat.live, chat.activity, open, activeId]);

    // Sends now, or stacks the message behind the running turn (the server decides; the dashed bubble says which).
    const send = async () => {
        const t = text.trim() || (attach.files.length ? "See the attached file(s)." : "");
        if (!t || !session) return;
        setText("");
        setError(null);
        try {
            const files = await api.prompterUploadFiles(session.id, attach.files);
            const r = await api.prompterSend(session.id, t, path, files);
            attach.clear();
            patchChat(session.id, (c) => ({ ...c, busy: c.busy || !r.queued, messages: c.messages.some((x) => x.id === r.message.id) ? c.messages : [...c.messages, r.message] }));
        } catch (e) {
            setText(t);
            setError(String((e as Error).message ?? e));
        }
    };
    // Ctrl-C: the running turn is killed; what it said so far stays; stacked messages go out as the next turn.
    const stop = async () => {
        if (!session) return;
        try {
            await api.prompterStop(session.id);
        } catch (e) {
            setError(String((e as Error).message ?? e));
        }
    };
    // ArrowUp in an empty input: the last stacked message comes back for editing (it leaves the stack).
    const takeBack = async (m: PrompterMessage) => {
        if (!session) return;
        try {
            await api.prompterUnqueue(session.id, m.id);
            patchChat(session.id, (c) => ({ ...c, messages: c.messages.filter((x) => x.id !== m.id) }));
            setText((cur) => (cur.trim() ? `${cur}\n${m.text}` : m.text));
            input.current?.focus();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        }
    };
    // Ends one chat (the assistant files its notes first); the strip moves to the next one, or the window closes.
    const end = (id: string, thenClose: boolean) => {
        void api.prompterClose(id).catch(() => undefined);
        const rest = sessions.filter((s) => s.id !== id);
        setSessions(rest);
        setChats((all) => {
            const { [id]: _gone, ...others } = all;
            return others;
        });
        setError(null);
        if (activeId === id) setActiveId(rest[0]?.id ?? null);
        if (thenClose) setOpen(false);
    };

    if (!open) {
        const unread = Object.values(chats).filter((c) => c.unread).length;
        return (
            <button className="prompter-fab" title="Prompter — the assistant that knows this app and sees what you see" onClick={() => setOpen(true)}>
                <span className="prompter-fab-mark">P</span> Prompter{unread > 0 && <span className="chip accent" title="chats with an answer you have not seen">{unread}</span>}
            </button>
        );
    }
    const placeholder = chat.busy
        ? `Answering… Esc stops it; a message sent now waits for the next turn${queued.length ? ` (${queued.length} stacked; ArrowUp edits the last one)` : ""}`
        : "Message Prompter… (Enter to send, Shift+Enter for a new line)";
    return (
        <aside className={`prompter ${wide ? "wide" : ""}`} aria-label="Prompter">
            <header className="prompter-head">
                <b>Prompter</b>
                {status?.account && <span className="chip" title="the AI account that runs the assistant">{status.account}</span>}
                <select className="prompter-model" value={model} title="Model for the next new chat" onChange={(e) => setModel(e.target.value)}>
                    {(settings?.models ?? []).filter((m) => m.value).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <span className="spacer" />
                <button className="tiny" title="Start another chat (this one stays open in the strip)" onClick={() => void create().catch((e: Error) => setError(e.message))}>+ New</button>
                <button className="tiny" title={wide ? "Smaller" : "Larger"} onClick={() => setWide((v) => !v)}>{wide ? "⇲" : "⇱"}</button>
                <button className="tiny" title="Hide the window; the chats stay open" onClick={() => setOpen(false)}>–</button>
                <button className="tiny" title="End this chat" disabled={!session} onClick={() => session && end(session.id, sessions.length <= 1)}>×</button>
            </header>
            {sessions.length > 1 && (
                <div className="prompter-strip" role="tablist">
                    {sessions.map((s) => {
                        const c = chats[s.id] ?? EMPTY;
                        return (
                            <button
                                key={s.id}
                                role="tab"
                                className={`prompter-tab ${s.id === activeId ? "active" : ""} ${c.unread ? "unread" : ""}`}
                                title={`${s.title ?? "new chat"} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · last ${ago(s.last_at)} ago${s.model ? ` · ${s.model}` : ""}`}
                                onClick={() => setActiveId(s.id)}
                            >
                                {c.busy && <span className="prompter-tab-busy" aria-label="answering" />}
                                <span className="prompter-tab-title">{s.title ?? "new chat"}</span>
                                <span className="prompter-tab-close" title="End this chat" onClick={(e) => { e.stopPropagation(); end(s.id, false); }}>×</span>
                            </button>
                        );
                    })}
                </div>
            )}
            <div className="prompter-where" title="What the assistant is told you are looking at">{where || path}</div>
            {status && !status.ready && <div className="blocked-box" style={{ margin: "0 10px 6px" }}>{status.reason}</div>}
            <div className="prompter-log">
                {chat.messages.length === 0 && !chat.live && <div className="empty">Ask about what you see, how Stagehand works, or tell me what to do here. I remember through the palace, not through this window.</div>}
                {chat.messages.map((m) => (
                    <div key={m.id} className={`chat-msg ${m.role === "user" ? "user" : "agent"} ${m.state === "queued" ? "queued" : ""}`}>
                        {m.role === "user" ? <div className="prompter-user-text">{m.text}</div> : <Markdown source={m.text} />}
                        {m.state === "queued" && (
                            <div className="prompter-queued-row">
                                <span>waits for the next turn</span>
                                <button title="Take it back into the input to edit (ArrowUp does the same for the last one)" onClick={() => void takeBack(m)}>edit</button>
                            </div>
                        )}
                    </div>
                ))}
                {chat.live && <div className="chat-msg agent live"><Markdown source={chat.live} /></div>}
                {chat.busy && <div className="prompter-activity">{chat.activity ?? "thinking…"}</div>}
                <div ref={bottom} />
            </div>
            {error && <div className="blocked-box" style={{ margin: "0 10px 6px" }}>{error}</div>}
            <div className="prompter-input">
                <AgentInput
                    ref={input}
                    value={text}
                    onChange={setText}
                    pending={attach}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                        } else if (e.key === "Escape" && chat.busy) {
                            e.preventDefault();
                            void stop();
                        } else if (e.key === "ArrowUp" && !text && queued.length) {
                            e.preventDefault();
                            void takeBack(queued[queued.length - 1]!);
                        }
                    }}
                    placeholder={placeholder}
                    disabled={!session || (status !== null && !status.ready)}
                    rows={2}
                />
                {chat.busy && <button className="prompter-stop" title={`Stop this turn (Esc)${queued.length ? `; the ${queued.length} stacked message${queued.length === 1 ? "" : "s"} go out next` : ""}`} onClick={() => void stop()}>■ Stop</button>}
                <button className="primary" disabled={!session || (!text.trim() && attach.files.length === 0)} title={chat.busy ? "Stacks behind the running turn" : "Send"} onClick={() => void send()}>{chat.busy ? "Stack" : "Send"}</button>
            </div>
        </aside>
    );
};
