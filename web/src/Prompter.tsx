import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PrompterMessage, type PrompterSession, type Settings } from "./api";
import { Markdown } from "./Markdown";
import { storage } from "./storage";
import { prompterBus } from "./prompterBus";
import { formatRoute, type Route } from "./routes";
import { AgentInput, usePendingFiles } from "./AgentInput";
import { Badge, Button, Chip, Icon, IconButton, Menu, MenuItem, Notice, Select, StatusDot, Tab, TabList } from "@vortex/ds";
import { useDismiss } from "./components/useDismiss";
import "./prompter.css";

// Prompter — the assistant in the bottom-right corner. Every chat is a claude session on the server; several can be
// open at once and the strip under the header switches between them (the list is the server's, so a reload or a
// server restart shows the same chats; a turn that died with the server is sent again by the server). The palace is
// its memory between chats. It sees the current location (the route) with every message. Collapse keeps the chats;
// the × ends the current one (a farewell turn files notes); chats idle for a day end on their own.
// Messages sent while it answers stack up (dashed) and go out together as the next turn; ArrowUp in an empty input
// takes the last stacked message back for editing.

const OPEN_KEY = "vortex.prompter.open";
const SESSION_KEY = "vortex.prompter.session";
const WIDE_KEY = "vortex.prompter.wide";

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
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useDismiss(menuOpen, () => setMenuOpen(false));
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
            <Button className="prompter-fab" variant="primary" title="Prompter: the assistant that knows this app and sees what you see" onClick={() => setOpen(true)}>
                <Icon name="spark" /><span className="pr-fab-text">Prompter</span>
                {unread > 0 && <Badge tone="accent" title="Chats with an answer you have not seen">{unread}</Badge>}
            </Button>
        );
    }
    const placeholder = chat.busy
        ? `Answering. Esc stops it; a message sent now waits for the next turn${queued.length ? ` (${queued.length} stacked; ArrowUp edits the last one)` : ""}`
        : "Message Prompter. Enter sends, Shift+Enter adds a line.";
    return (
        <aside className={`prompter${wide ? " wide" : ""}`} aria-label="Prompter">
            <header className="pr-head">
                <h2 className="pr-title">Prompter</h2>
                {status?.account && <Chip className="pr-account" title="The AI account that runs the assistant">{status.account}</Chip>}
                <Select className="pr-model" value={model} aria-label="Model for the next new chat" title="Model for the next new chat" onChange={(e) => setModel(e.target.value)}>
                    {(settings?.models ?? []).filter((m) => m.value).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
                <span className="pr-spacer" />
                <IconButton icon="plus" label="New chat (this one stays open in the strip)" variant="ghost" size="sm" onClick={() => void create().catch((e: Error) => setError(e.message))} />
                <div className="pr-menu-wrap" ref={menuRef}>
                    <IconButton icon="more" label="Chat options" variant="ghost" size="sm" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((o) => !o)} />
                    {menuOpen && (
                        <Menu className="pr-menu">
                            <MenuItem onClick={() => { setWide((v) => !v); setMenuOpen(false); }}>{wide ? "Smaller window" : "Larger window"}</MenuItem>
                            <hr />
                            <MenuItem danger disabled={!session} onClick={() => { setMenuOpen(false); if (session) end(session.id, sessions.length <= 1); }}>End this chat</MenuItem>
                        </Menu>
                    )}
                </div>
                <IconButton icon="chevronDown" label="Hide (the chats stay open)" variant="ghost" size="sm" onClick={() => setOpen(false)} />
            </header>
            {sessions.length > 1 && (
                <TabList variant="pill" className="pr-strip" aria-label="Chats">
                    {sessions.map((s) => {
                        const c = chats[s.id] ?? EMPTY;
                        return (
                            <Tab key={s.id} active={s.id === activeId} title={`${s.title ?? "New chat"} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · last ${ago(s.last_at)} ago${s.model ? ` · ${s.model}` : ""}`} onClick={() => setActiveId(s.id)}>
                                {c.busy && <StatusDot tone="info" pulse title="Answering" />}
                                {!c.busy && c.unread && <StatusDot tone="accent" title="Unread answer" />}
                                <span className={`pr-tab-title${c.unread ? " unread" : ""}`}>{s.title ?? "New chat"}</span>
                            </Tab>
                        );
                    })}
                </TabList>
            )}
            <div className="pr-where" title="What the assistant is told you are looking at">{where || path}</div>
            {status && !status.ready && <Notice tone="warn" className="pr-notice">{status.reason}</Notice>}
            <div className="pr-log">
                {chat.messages.length === 0 && !chat.live && <p className="pr-empty">Ask about what you see, how Vortex works, or tell me what to do here. I remember through the palace, not through this window.</p>}
                {chat.messages.map((m) => (
                    <div key={m.id} className={`pr-msg ${m.role === "user" ? "user" : "agent"}${m.state === "queued" ? " queued" : ""}`}>
                        {m.role === "user" ? <div className="pr-user-text">{m.text}</div> : <Markdown source={m.text} />}
                        {m.state === "queued" && (
                            <div className="pr-queued">
                                <span>Waits for the next turn</span>
                                <Button size="sm" variant="ghost" title="Take it back into the input to edit (ArrowUp does the same for the last one)" onClick={() => void takeBack(m)}>Edit</Button>
                            </div>
                        )}
                    </div>
                ))}
                {chat.live && <div className="pr-msg agent live"><Markdown source={chat.live} /></div>}
                {chat.busy && <div className="pr-activity" role="status">{chat.activity ?? "Thinking…"}</div>}
                <div ref={bottom} />
            </div>
            {error && <Notice tone="bad" className="pr-notice">{error}</Notice>}
            <div className="pr-input">
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
                <div className="pr-send">
                    {chat.busy && <Button variant="danger" title={`Stop this turn (Esc)${queued.length ? `; the ${queued.length} stacked message${queued.length === 1 ? "" : "s"} go out next` : ""}`} onClick={() => void stop()}>Stop</Button>}
                    <Button variant="primary" disabled={!session || (!text.trim() && attach.files.length === 0)} title={chat.busy ? "Stacks behind the running turn" : "Send"} onClick={() => void send()}>{chat.busy ? "Stack" : "Send"}</Button>
                </div>
            </div>
        </aside>
    );
};
