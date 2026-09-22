import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PrompterMessage, type PrompterSession, type Settings } from "./api";
import { Markdown } from "./Markdown";
import { storage } from "./storage";
import { prompterBus } from "./prompterBus";
import { formatRoute, type Route } from "./routes";

// Prompter — the assistant in the bottom-right corner. One chat window = one claude session on the server (fresh
// each time the window is opened; the palace is its memory between chats). It sees the current location (the route)
// with every message. Collapse keeps the session (it keeps pinging); the × ends it (a farewell turn files notes).
// A server restart does not end it: the session id is kept here, and the widget re-attaches when the socket is back.

const OPEN_KEY = "stagehand.prompter.open";
const SESSION_KEY = "stagehand.prompter.session";
const WIDE_KEY = "stagehand.prompter.wide";

export const Prompter = ({ route, settings }: { route: Route; settings: Settings | null }) => {
    const [open, setOpen] = useState(() => storage.get(OPEN_KEY) === "1");
    const [wide, setWide] = useState(() => storage.get(WIDE_KEY) === "1");
    const [session, setSession] = useState<PrompterSession | null>(null);
    const [messages, setMessages] = useState<PrompterMessage[]>([]);
    const [live, setLive] = useState("");
    const [activity, setActivity] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [model, setModel] = useState("");
    const [where, setWhere] = useState("");
    const [status, setStatus] = useState<{ ready: boolean; reason: string | null; account: string | null } | null>(null);
    const path = formatRoute(route);
    const bottom = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);

    // Re-attach to the session this browser had (a reload, a server restart), else start a new one.
    const attach = useCallback(async () => {
        const saved = storage.get(SESSION_KEY);
        if (saved) {
            try {
                const r = await api.prompterMessages(saved);
                if (!r.session.closed_at) {
                    setSession(r.session);
                    setMessages(r.messages);
                    setBusy(r.busy);
                    setModel(r.session.model ?? "");
                    return;
                }
            } catch {
                /* gone — start fresh */
            }
        }
        const s = await api.prompterCreate(model || settings?.prompter.model || null);
        storage.set(SESSION_KEY, s.id);
        setSession(s);
        setMessages([]);
        setBusy(false);
        setModel(s.model ?? "");
    }, [model, settings]);

    useEffect(() => {
        if (!open) return;
        void api.prompterStatus().then((s) => setStatus({ ready: s.ready, reason: s.reason, account: s.account })).catch(() => undefined);
        if (!session) void attach().catch((e: Error) => setError(e.message));
    }, [open, session, attach]);
    useEffect(() => {
        if (!open || !session) return;
        const t = setInterval(() => void api.prompterPing(session.id).catch(() => undefined), 60_000);
        return () => clearInterval(t);
    }, [open, session]);
    useEffect(() => storage.set(OPEN_KEY, open ? "1" : "0"), [open]);
    useEffect(() => storage.set(WIDE_KEY, wide ? "1" : "0"), [wide]);
    useEffect(
        () =>
            prompterBus.subscribe((ev) => {
                if (!session || ev.sessionId !== session.id) return;
                if (ev.kind === "text") setLive(ev.text);
                else if (ev.kind === "activity") setActivity(ev.text);
                else if (ev.kind === "done") {
                    setLive("");
                    setActivity(null);
                    setBusy(false);
                    if (ev.message) setMessages((m) => [...m, ev.message!]);
                    if (ev.error) setError(ev.error);
                } else if (ev.kind === "closed") {
                    if (storage.get(SESSION_KEY) === session.id) storage.set(SESSION_KEY, "");
                    setSession(null);
                    setMessages([]);
                }
            }),
        [session],
    );
    // After the socket came back (server restart): the answer that was under way is lost; re-read what is stored.
    useEffect(
        () =>
            prompterBus.onReconnect(() => {
                if (!session) return;
                void api
                    .prompterMessages(session.id)
                    .then((r) => {
                        setMessages(r.messages);
                        setBusy(r.busy);
                        if (!r.busy) {
                            setLive("");
                            setActivity(null);
                        }
                    })
                    .catch(() => undefined);
            }),
        [session],
    );
    useEffect(() => {
        if (!open) return;
        const h = setTimeout(() => void api.prompterDescribe(path).then((d) => setWhere(d.summary)).catch(() => undefined), 300);
        return () => clearTimeout(h);
    }, [open, path]);
    useEffect(() => {
        bottom.current?.scrollIntoView({ block: "end" });
    }, [messages.length, live, activity, open]);

    const send = async () => {
        const t = text.trim();
        if (!t || !session || busy) return;
        setText("");
        setError(null);
        setBusy(true);
        setMessages((m) => [...m, { id: `local-${Date.now()}`, session_id: session.id, role: "user", text: t, path, created_at: new Date().toISOString() }]);
        try {
            await api.prompterSend(session.id, t, path);
        } catch (e) {
            setBusy(false);
            setError(String((e as Error).message ?? e));
        }
    };
    const end = (thenNew: boolean) => {
        if (session) void api.prompterClose(session.id).catch(() => undefined);
        storage.set(SESSION_KEY, "");
        setSession(null);
        setMessages([]);
        setLive("");
        setActivity(null);
        setBusy(false);
        setError(null);
        if (!thenNew) setOpen(false);
    };

    if (!open) {
        return (
            <button className="prompter-fab" title="Prompter — the assistant that knows this app and sees what you see" onClick={() => setOpen(true)}>
                <span className="prompter-fab-mark">P</span> Prompter
            </button>
        );
    }
    return (
        <aside className={`prompter ${wide ? "wide" : ""}`} aria-label="Prompter">
            <header className="prompter-head">
                <b>Prompter</b>
                {status?.account && <span className="chip" title="the AI account that runs the assistant">{status.account}</span>}
                <select className="prompter-model" value={model} title="Model for the next new session" onChange={(e) => setModel(e.target.value)}>
                    {(settings?.models ?? []).filter((m) => m.value).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <span className="spacer" />
                <button className="tiny" title="End this chat and start a new one (the assistant files its notes first)" onClick={() => end(true)}>New</button>
                <button className="tiny" title={wide ? "Smaller" : "Larger"} onClick={() => setWide((v) => !v)}>{wide ? "⇲" : "⇱"}</button>
                <button className="tiny" title="Hide the window; the chat stays open" onClick={() => setOpen(false)}>–</button>
                <button className="tiny" title="End this chat" onClick={() => end(false)}>×</button>
            </header>
            <div className="prompter-where" title="What the assistant is told you are looking at">{where || path}</div>
            {status && !status.ready && <div className="blocked-box" style={{ margin: "0 10px 6px" }}>{status.reason}</div>}
            <div className="prompter-log">
                {messages.length === 0 && !live && <div className="empty">Ask about what you see, how Stagehand works, or tell me what to do here. I remember through the palace, not through this window.</div>}
                {messages.map((m) => (
                    <div key={m.id} className={`chat-msg ${m.role === "user" ? "user" : "agent"}`}>
                        {m.role === "user" ? <div className="prompter-user-text">{m.text}</div> : <Markdown source={m.text} />}
                    </div>
                ))}
                {live && <div className="chat-msg agent live"><Markdown source={live} /></div>}
                {busy && <div className="prompter-activity">{activity ?? "thinking…"}</div>}
                <div ref={bottom} />
            </div>
            {error && <div className="blocked-box" style={{ margin: "0 10px 6px" }}>{error}</div>}
            <div className="prompter-input">
                <textarea
                    ref={input}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                        }
                    }}
                    placeholder={busy ? "Answering…" : "Message Prompter… (Enter to send, Shift+Enter for a new line)"}
                    disabled={!session || (status !== null && !status.ready)}
                    rows={2}
                />
                <button className="primary" disabled={!session || busy || !text.trim()} onClick={() => void send()}>{busy ? "…" : "Send"}</button>
            </div>
        </aside>
    );
};
