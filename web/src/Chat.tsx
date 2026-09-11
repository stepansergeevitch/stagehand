import { useEffect, useRef, useState } from "react";
import { anchorOf, api, type Message, type TaskStatus } from "./api";
import { Markdown } from "./Markdown";

// Notes the agent leaves on its own (implementation notes, a CI fix summary) and the human's own questions/answers,
// in one timeline. Asking a question resumes the task's own session headlessly — same constraint as the terminal:
// only one thing can drive that session at a time, so it's disabled while a stage run is in progress.
export const Chat = ({ taskId, messages, status, onSent, onOpenCode }: { taskId: string; messages: Message[]; status: TaskStatus; onSent: () => Promise<void>; onOpenCode?: () => void }) => {
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const canAsk = status !== "running";

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: "end" });
    }, [messages.length]);

    const send = async () => {
        const t = text.trim();
        if (!t || sending) return;
        setSending(true);
        setError(null);
        setText("");
        try {
            await api.sendMessage(taskId, t);
            await onSent();
        } catch (e) {
            setError(String((e as Error).message ?? e));
            setText(t);
        } finally {
            setSending(false);
        }
    };

    return (
        <section className="card chat">
            <h2>Chat</h2>
            <p className="field-hint">Notes the agent leaves on its own (implementation notes, CI fixes) appear here, and you can ask it a question about this task — it answers with full context of everything it has done so far. This does not make code changes; those happen through the normal stage flow.</p>
            <div className="chat-log">
                {messages.length === 0 && <div className="empty">No messages yet.</div>}
                {messages.map((m) => {
                    const a = anchorOf(m);
                    return (
                        <div key={m.id} className={`chat-msg ${m.role}`}>
                            <div className="chat-msg-head">
                                <b>{m.role === "user" ? "You" : "Agent"}</b>
                                <span className="field-hint">{new Date(m.created_at).toLocaleString()}</span>
                                {a && (
                                    <button className="chip accent anchor-chip" title={`About this line of the diff — ${a.snippet.trim().slice(0, 120)}`} onClick={onOpenCode}>
                                        {a.path}:{a.line}{a.side === "old" ? " (removed)" : ""}
                                    </button>
                                )}
                            </div>
                            <Markdown source={m.text} />
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>
            {error && <div className="blocked-box" style={{ marginBottom: 0 }}>{error}</div>}
            <div className="chat-input">
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                    }}
                    placeholder={canAsk ? "Ask about this task… (⌘/Ctrl+Enter to send)" : "A stage is running — ask once it's idle"}
                    disabled={!canAsk || sending}
                />
                <button className="primary" disabled={!canAsk || sending || !text.trim()} onClick={() => void send()}>
                    {sending ? "Asking…" : "Send"}
                </button>
            </div>
        </section>
    );
};
