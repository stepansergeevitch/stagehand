import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type PrompterMessage, type PrompterSession, type Settings, type Task } from "./api";
import { storage } from "./storage";
import { prompterBus } from "./prompterBus";
import { formatRoute, navigate, type Route } from "./routes";
import { usePendingFiles } from "./AgentInput";
import { ChatInput } from "./components/ChatInput";
import { Modal } from "./components/Modal";
import { Badge, Button, Chip, Icon, IconButton, Kbd, Menu, MenuItem, Notice, StatusDot, Switch } from "@vortex/ds";
import { useDismiss } from "./components/useDismiss";
import { Answer, AnswerActions, StepsLine, clock, useMedia, type Step } from "./PrompterParts";
import "./prompter.css";

// Prompter — the assistant. Every chat is a claude session on the server; several can be open at once and the chat
// switcher in the header moves between them (the list is the server's, so a reload or a server restart shows the same
// chats; a turn that died with the server is sent again by the server). The palace is its memory between chats. It
// sees the current location (the route) with every message unless the chat's "Share view" switch is off. Hide keeps
// the chats; "End this chat" ends the current one (a farewell turn files notes); chats idle for a day end on their own.
// On a wide screen the open panel is docked to the right edge and the page narrows beside it; "Float the window"
// (and any small screen) makes it a window over the page. Messages sent while it answers stack up (dashed) and go
// out together as the next turn; ArrowUp in an empty input takes the last stacked message back for editing.
// Keys: C-c p opens and focuses it (hides it when focus is already inside), C-c p n starts a new chat, C-g / Esc
// inside it hides it while no turn runs.

const OPEN_KEY = "vortex.prompter.open";
const SESSION_KEY = "vortex.prompter.session";
const FLOAT_KEY = "vortex.prompter.float";

interface ChatState {
    messages: PrompterMessage[];
    live: string;
    activity: string | null;
    busy: boolean;
    unread: boolean;
    loaded: boolean;
    // The steps of the running turn, and those of finished answers (by message id): kept in memory only.
    steps: Step[];
    stepsByMsg: Record<string, Step[]>;
    // "Share view" off: the page context is not sent.
    noShare: boolean;
}
const EMPTY: ChatState = { messages: [], live: "", activity: null, busy: false, unread: false, loaded: false, steps: [], stepsByMsg: {}, noShare: false };

const ago = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};

type Status = { ready: boolean; reason: string | null; account: string | null };
// `turn`: the assistant's turn failed (Retry sends the message again); otherwise the message did not go out.
interface Problem { text: string; turn: boolean }

const TITLE = "New chat";

export const Prompter = ({ route, settings, tasks = [] }: { route: Route; settings: Settings | null; tasks?: Task[] }) => {
    const [open, setOpen] = useState(() => storage.get(OPEN_KEY) === "1");
    const [floating, setFloating] = useState(() => storage.get(FLOAT_KEY) === "1");
    const [sessions, setSessions] = useState<PrompterSession[]>([]);
    const [activeId, setActiveId] = useState<string | null>(() => storage.get(SESSION_KEY) || null);
    const [chats, setChats] = useState<Record<string, ChatState>>({});
    const [text, setText] = useState("");
    const attach = usePendingFiles();
    const [error, setError] = useState<Problem | null>(null);
    const [switcher, setSwitcher] = useState(false);
    const [sheet, setSheet] = useState(false);
    const closeSwitcher = useCallback(() => setSwitcher(false), []);
    const switcherRef = useDismiss(switcher, closeSwitcher);
    const [where, setWhere] = useState("");
    const [status, setStatus] = useState<Status | null>(null);
    const wide = useMedia("(min-width: 901px)");
    const phone = useMedia("(max-width: 760px)");
    const docked = wide && !floating;
    const path = formatRoute(route);
    const bottom = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const panel = useRef<HTMLElement>(null);
    const focusSoon = useRef(false);
    const wantNew = useRef(false);
    const session = sessions.find((s) => s.id === activeId) ?? null;
    const chat = (activeId && chats[activeId]) || EMPTY;
    const queued = chat.messages.filter((m) => m.role === "user" && m.state === "queued");
    const share = !chat.noShare;
    const ticketTasks = useMemo(() => Object.fromEntries(tasks.map((t) => [t.ticket_id, t.id])), [tasks]);
    const otherUnread = Object.entries(chats).some(([id, c]) => id !== activeId && c.unread);

    const patchChat = useCallback((id: string, fn: (c: ChatState) => ChatState) => setChats((all) => ({ ...all, [id]: fn(all[id] ?? EMPTY) })), []);
    const fail = useCallback((e: unknown, turn = false) => setError({ text: String((e as Error)?.message ?? e), turn }), []);

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
        const s = await api.prompterCreate(settings?.prompter?.model || null);
        setSessions((list) => [s, ...list.filter((x) => x.id !== s.id)]);
        patchChat(s.id, (c) => ({ ...c, loaded: true }));
        setActiveId(s.id);
        setError(null);
        input.current?.focus();
    }, [settings, patchChat]);

    // Opening the window: the status, the chat list, and a chat to show (the remembered one, the newest, or a new one).
    useEffect(() => {
        if (!open) return;
        void api.prompterStatus().then((s) => setStatus({ ready: s.ready, reason: s.reason, account: s.account })).catch(() => undefined);
        void loadSessions()
            .then(async (list) => {
                const remembered = storage.get(SESSION_KEY);
                const pick = list.find((s) => s.id === remembered) ?? list[0];
                if (wantNew.current) {
                    wantNew.current = false;
                    await create();
                } else if (pick) setActiveId(pick.id);
                else await create();
            })
            .catch((e: Error) => fail(e));
        // create/loadSessions are stable enough for the open toggle; re-running on every model change would open chats.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    useEffect(() => {
        if (activeId) storage.set(SESSION_KEY, activeId);
    }, [activeId]);
    useEffect(() => {
        if (!open || !activeId) return;
        if (!chats[activeId]?.loaded) void loadChat(activeId).catch((e: Error) => fail(e));
        else patchChat(activeId, (c) => ({ ...c, unread: false }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, activeId]);
    // The open window keeps the active chat alive (the server ends chats idle for a day).
    useEffect(() => {
        if (!open || !activeId) return;
        const t = setInterval(() => void api.prompterPing(activeId).catch(() => undefined), 60_000);
        return () => clearInterval(t);
    }, [open, activeId]);
    useEffect(() => storage.set(OPEN_KEY, open ? "1" : "0"), [open]);
    useEffect(() => storage.set(FLOAT_KEY, floating ? "1" : "0"), [floating]);
    // A docked panel narrows the page beside it (the shell reads this class).
    useEffect(() => {
        document.body.classList.toggle("prompter-docked", open && docked);
        return () => document.body.classList.remove("prompter-docked");
    }, [open, docked]);
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
                else if (ev.kind === "activity")
                    patchChat(id, (c) => ({ ...c, activity: ev.text, busy: true, steps: c.steps[c.steps.length - 1]?.text === ev.text ? c.steps : [...c.steps, { time: clock(), text: ev.text }] }));
                else if (ev.kind === "done") {
                    patchChat(id, (c) => ({
                        ...c,
                        live: "",
                        activity: null,
                        busy: false,
                        unread: id !== activeId,
                        steps: [],
                        stepsByMsg: ev.message && c.steps.length ? { ...c.stepsByMsg, [ev.message.id]: c.steps } : c.stepsByMsg,
                        messages: ev.message && !c.messages.some((x) => x.id === ev.message!.id) ? [...c.messages, ev.message] : c.messages,
                    }));
                    if (ev.error && id === activeId) fail(ev.error, true);
                } else if (ev.kind === "queued") patchChat(id, (c) => ({ ...c, messages: c.messages.some((x) => x.id === ev.message.id) ? c.messages : [...c.messages, ev.message] }));
                else if (ev.kind === "removed") patchChat(id, (c) => ({ ...c, messages: c.messages.filter((x) => x.id !== ev.messageId) }));
                else if (ev.kind === "turn") patchChat(id, (c) => ({ ...c, busy: true, activity: null, steps: [], messages: c.messages.map((x) => (ev.messageIds.includes(x.id) ? { ...x, state: "sent" } : x)) }));
            }),
        [activeId, loadSessions, patchChat, fail],
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
    }, [chat.messages.length, chat.live, chat.activity, chat.steps.length, error, open, activeId]);
    // After C-c p opened the panel: the input takes the focus as soon as it can.
    useEffect(() => {
        if (open && focusSoon.current && input.current && !input.current.disabled) {
            input.current.focus();
            focusSoon.current = false;
        }
    });

    // Sends one message (the draft with its files, or an earlier one again) now, or stacks it behind the running turn
    // (the server decides; the dashed bubble says which). With "Share view" off no location goes along.
    const deliver = async (t: string, withDraftFiles: boolean): Promise<boolean> => {
        if (!session) return false;
        setError(null);
        try {
            const files = withDraftFiles ? await api.prompterUploadFiles(session.id, attach.files) : [];
            const r = await api.prompterSend(session.id, t, share ? path : "", files);
            if (withDraftFiles) attach.clear();
            patchChat(session.id, (c) => ({ ...c, busy: c.busy || !r.queued, messages: c.messages.some((x) => x.id === r.message.id) ? c.messages : [...c.messages, r.message] }));
            return true;
        } catch (e) {
            fail(e);
            return false;
        }
    };
    const send = async () => {
        const t = text.trim() || (attach.files.length ? "See the attached file(s)." : "");
        if (!t || !session) return;
        setText("");
        if (!(await deliver(t, true))) setText(t);
    };
    // Retry: the last message the person wrote before this answer (or the last of the chat) goes out again as a new one.
    const lastUserBefore = (index: number): string | null => {
        for (let i = index - 1; i >= 0; i--) {
            const m = chat.messages[i]!;
            if (m.role === "user" && m.state !== "queued") return m.text;
        }
        return null;
    };
    const retryTurn = () => {
        const t = lastUserBefore(chat.messages.length);
        if (t) void deliver(t, false);
        else setError(null);
    };
    // Ctrl-C: the running turn is killed; what it said so far stays; stacked messages go out as the next turn.
    const stop = async () => {
        if (!session) return;
        try {
            await api.prompterStop(session.id);
        } catch (e) {
            fail(e);
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
            fail(e);
        }
    };
    // Remove: a stacked message is dropped without coming back into the box.
    const removeQueued = async (id: string) => {
        if (!session) return;
        try {
            await api.prompterUnqueue(session.id, id);
            patchChat(session.id, (c) => ({ ...c, messages: c.messages.filter((x) => x.id !== id) }));
        } catch (e) {
            fail(e);
        }
    };
    // Ends one chat (the assistant files its notes first); the next one is shown, or the window closes.
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
    const newChat = () => {
        setSwitcher(false);
        setSheet(false);
        void create().catch((e: Error) => fail(e));
    };
    const openSettings = () => {
        setSwitcher(false);
        setSheet(false);
        navigate({ page: "prompter" });
    };
    const choose = (id: string) => {
        setSwitcher(false);
        setSheet(false);
        setActiveId(id);
        setError(null);
    };
    const setShare = (on: boolean) => {
        if (activeId) patchChat(activeId, (c) => ({ ...c, noShare: !on }));
    };


    // C-c p: open and focus / focus / hide; C-c p n: a new chat. Matched on e.code, in the capture phase so a page
    // chord or a text box does not see the second key of this one.
    const keys = useRef({ toggle: () => {}, newChat: () => {} });
    keys.current = {
        toggle: () => {
            if (!open) {
                focusSoon.current = true;
                setOpen(true);
            } else if (panel.current?.contains(document.activeElement)) setOpen(false);
            else input.current?.focus();
        },
        newChat: () => {
            if (open) void create().catch((e: Error) => fail(e));
            else {
                wantNew.current = true;
                focusSoon.current = true;
                setOpen(true);
            }
        },
    };
    useEffect(() => {
        let c = 0;
        let p = 0;
        const onKey = (e: KeyboardEvent): void => {
            if (/^(Control|Shift|Alt|Meta)/.test(e.code)) return;
            const now = Date.now();
            const bare = !e.ctrlKey && !e.altKey && !e.metaKey;
            if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === "KeyC") {
                c = now;
                p = 0;
                return;
            }
            if (bare && c && now - c < 1500 && e.code === "KeyP") {
                c = 0;
                p = now;
                e.preventDefault();
                e.stopImmediatePropagation();
                keys.current.toggle();
                return;
            }
            if (bare && p && now - p < 1500 && e.code === "KeyN") {
                p = 0;
                e.preventDefault();
                e.stopImmediatePropagation();
                keys.current.newChat();
                return;
            }
            c = 0;
            p = 0;
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, []);
    // C-g or Esc inside the panel hides it, unless a turn runs (then the input stops it) or a menu is open (it closes).
    const onPanelKey = (e: ReactKeyboardEvent<HTMLElement>): void => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (((e.ctrlKey && e.code === "KeyG") || e.key === "Escape") && !chat.busy && !switcher) {
            e.preventDefault();
            setOpen(false);
        }
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

    const dot = (c: ChatState) => <StatusDot tone={c.busy ? "info" : c.unread ? "accent" : "neutral"} pulse={c.busy} title={c.busy ? "Answering" : c.unread ? "Unread answer" : undefined} />;
    const label = (s: PrompterSession) => ((chats[s.id] ?? EMPTY).busy ? "answering" : ago(s.last_at));
    const title = session?.title ?? TITLE;
    const shared = where || path;
    // One chat per row: the row opens it, the × beside it closes it (the menu stays open to close several; the last one closes the window).
    const chatRows = (menu: boolean) => sessions.map((s) => {
        const c = chats[s.id] ?? EMPTY;
        return (
            <div key={s.id} className={`pr-chat-row${s.id === activeId ? " on" : ""}`}>
                <MenuItem className="pr-chat-pick" role={menu ? "menuitem" : undefined} aria-current={s.id === activeId ? "true" : undefined} onClick={() => choose(s.id)}>
                    {dot(c)}
                    <span className={`pr-row-title${c.unread ? " unread" : ""}`}>{s.title ?? TITLE}</span>
                    <small className="pr-row-meta">{label(s)}</small>
                </MenuItem>
                <IconButton icon="close" size="sm" variant="ghost" className="pr-chat-close" label={`Close chat ${s.title ?? TITLE}`} onClick={() => end(s.id, sessions.length <= 1)} />
            </div>
        );
    });
    const shareSwitch = <Switch checked={share} aria-label="Share what you are looking at" label="Share view" disabled={!session} onChange={(e) => setShare(e.target.checked)} />;
    const turnProblem = error?.turn ? error.text.replace(/\.+$/, "") : null;

    return (
        <aside ref={panel} className={`prompter${docked ? " docked" : ""}`} aria-label="Prompter" onKeyDown={onPanelKey}>
            <header className="pr-head">
                <div className="pr-menu-wrap pr-switcher" ref={switcherRef}>
                    <Button size="sm" className="pr-sw" aria-haspopup={phone ? "dialog" : "menu"} aria-expanded={phone ? sheet : switcher} aria-label={`Chats: ${title}`} onClick={() => (phone ? setSheet(true) : setSwitcher((v) => !v))}>
                        {dot(chat)}
                        <span className="pr-sw-title">{title}</span>
                        <Icon name="chevronDown" />
                    </Button>
                    {switcher && !phone && (
                        <Menu className="pr-menu pr-chats" aria-label="Chats">
                            {chatRows(true)}
                            {sessions.length > 0 && <hr />}
                            <MenuItem onClick={newChat}>New chat <Kbd>C-c p n</Kbd></MenuItem>
                            {wide && <MenuItem onClick={() => { setFloating((v) => !v); setSwitcher(false); }}>{docked ? "Float the window" : "Dock the window"}</MenuItem>}
                            <MenuItem onClick={openSettings}>Prompter settings</MenuItem>
                        </Menu>
                    )}
                </div>
                {otherUnread && <StatusDot tone="accent" role="img" aria-label="Another chat has an unread answer" title="Another chat has an unread answer" />}
                <span className="pr-spacer" />
                <IconButton className="pr-new" icon="plus" label="New chat" variant="ghost" size="sm" onClick={newChat} />
                <IconButton icon="close" label="Hide Prompter" variant="ghost" size="sm" onClick={() => setOpen(false)} />
            </header>
            {status?.ready !== false && (
                <div className="pr-ctx">
                    <span className="pr-ctx-label">Looking at</span>
                    <Chip tone="accent" className={`pr-chip${share ? "" : " off"}`} title={share ? "What the assistant is told you are looking at" : "Not shared"}>{shared}</Chip>
                    <span className="pr-spacer" />
                    {shareSwitch}
                </div>
            )}
            {status && !status.ready && (
                <Notice tone="warn" className="pr-notice">
                    <span className="pr-notice-text">{status.reason}</span>
                    <Button size="sm" onClick={() => navigate({ page: "accounts" })}>Open AI accounts</Button>
                </Notice>
            )}
            <div className="pr-log" role="log" aria-label="Conversation">
                {chat.messages.map((m, i) => {
                    if (m.state === "queued") return null;
                    if (m.role === "user") return <div key={m.id} className="pr-msg user"><div className="pr-user-text">{m.text}</div></div>;
                    const steps = chat.stepsByMsg[m.id];
                    return (
                        <div key={m.id} className="pr-turn">
                            {steps && <StepsLine steps={steps} />}
                            <div className="pr-msg agent">
                                <Answer source={m.text} tasks={ticketTasks} route={route} />
                                {m.role === "assistant" && <AnswerActions text={m.text} canRetry={!chat.busy && lastUserBefore(i) !== null} onRetry={() => { const t = lastUserBefore(i); if (t) void deliver(t, false); }} />}
                            </div>
                        </div>
                    );
                })}
                {chat.live && <div className="pr-msg agent live"><Answer source={chat.live} tasks={ticketTasks} route={route} /></div>}
                {chat.busy && <StepsLine steps={chat.steps} live={chat.activity ?? "Thinking…"} />}
                {error && (
                    <Notice tone="bad" className="pr-notice-log">
                        <span className="pr-notice-text">{turnProblem !== null ? `Prompter stopped: ${turnProblem}. Your message is kept.` : error.text}</span>
                        {error.turn && <Button size="sm" onClick={retryTurn}>Retry</Button>}
                    </Notice>
                )}
                <div ref={bottom} />
            </div>
            <div className="pr-input">
                <ChatInput
                    ref={input}
                    value={text}
                    onChange={setText}
                    pending={attach}
                    action={{ label: chat.busy ? "Stack" : "Send", onSend: () => void send() }}
                    working={chat.busy}
                    onStop={() => void stop()}
                    queued={queued.map((m) => ({ id: m.id, text: m.text }))}
                    onEditQueued={(id) => { const m = queued.find((x) => x.id === id); if (m) void takeBack(m); }}
                    onRemoveQueued={(id) => void removeQueued(id)}
                    onRecall={() => { const m = queued[queued.length - 1]; if (m) void takeBack(m); }}
                    placeholder="Message Prompter"
                    disabled={!session || (status !== null && !status.ready)}
                />
            </div>
            {sheet && phone && (
                <Modal title="Chats" className="pr-sheet" onClose={() => setSheet(false)}>
                    <div className="pr-sheet-list" role="group" aria-label="Chats">
                        {chatRows(false)}
                        <MenuItem className="pr-sheet-new" onClick={newChat}>New chat</MenuItem>
                        <MenuItem onClick={openSettings}>Prompter settings</MenuItem>
                    </div>
                </Modal>
            )}
        </aside>
    );
};
