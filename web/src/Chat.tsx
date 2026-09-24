import { useEffect, useRef, useState } from "react";
import { anchorOf, api, filesOf, type Message, type TaskStatus } from "./api";
import { MessageFiles } from "./FilePicker";
import { AgentInput, usePendingFiles } from "./AgentInput";
import { Markdown } from "./Markdown";

type Mode = "ask" | "do";

// Notes the agent leaves on its own (implementation notes, a CI fix summary) and the human's own questions/answers,
// in one timeline. Both modes resume the task's own session headlessly — same constraint as the terminal: only one
// thing can drive that session at a time, so the input is disabled while a run is in progress.
//   Ask — a question; the agent answers and changes nothing.
//   Do  — an instruction; the agent carries it out in the worktree (under the env's rules) and reports back here.
export const Chat = ({ taskId, messages, status, onSent, onOpenCode }: { taskId: string; messages: Message[]; status: TaskStatus; onSent: () => Promise<void>; onOpenCode?: () => void }) => {
    const [mode, setMode] = useState<Mode>("ask");
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const pending = usePendingFiles();
    const idle = status !== "running";

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: "end" });
    }, [messages.length]);

    const send = async () => {
        // A screenshot alone is a message too: the text then just points at the files.
        const t = text.trim() || (pending.files.length ? "See the attached file(s)." : "");
        if (!t || sending) return;
        setSending(true);
        setError(null);
        setText("");
        try {
            const files = await api.uploadFiles(taskId, pending.files);
            if (mode === "do") await api.instruct(taskId, t, files);
            else await api.sendMessage(taskId, t, undefined, files);
            pending.clear();
            await onSent();
        } catch (e) {
            setError(String((e as Error).message ?? e));
            setText(t);
        } finally {
            setSending(false);
        }
    };

    const placeholder = !idle
        ? "A run is in progress — send once it's idle"
        : mode === "do"
          ? "Tell the agent what to do in this task's worktree… (⌘/Ctrl+Enter to run)"
          : "Ask about this task… (⌘/Ctrl+Enter to send)";

    return (
        <section className="card chat">
            <h2>Chat</h2>
            <p className="field-hint">
                Notes the agent leaves on its own (implementation notes, CI fixes) appear here. <b>Ask</b> a question and it answers with the full context of this task without touching code.
                Switch to <b>Do</b> to give it instructions to carry out now — it works in the worktree under this environment's rules (commits/pushes only where allowed), then reports back here; the task returns to its current stage afterwards. Stop halts it like any run.
            </p>
            <div className="chat-log">
                {messages.length === 0 && <div className="empty">No messages yet.</div>}
                {messages.map((m) => {
                    const a = anchorOf(m);
                    return (
                        <div key={m.id} className={`chat-msg ${m.role}${m.kind ? ` ${m.kind}` : ""}`}>
                            <div className="chat-msg-head">
                                <b>{m.role === "user" ? "You" : "Agent"}</b>
                                {m.kind === "instruction" && <span className="chip accent">instruction</span>}
                                {m.kind === "instruction_result" && <span className="chip ok">report</span>}
                                <span className="field-hint">{new Date(m.created_at).toLocaleString()}</span>
                                {a && (
                                    <button className="chip accent anchor-chip" title={`About this line of the diff — ${a.snippet.trim().slice(0, 120)}`} onClick={onOpenCode}>
                                        {a.path}:{a.line}{a.side === "old" ? " (removed)" : ""}
                                    </button>
                                )}
                            </div>
                            <Markdown source={m.text} />
                            <MessageFiles taskId={taskId} files={filesOf(m)} />
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>
            {error && <div className="blocked-box" style={{ marginBottom: 0 }}>{error}</div>}
            <div className="chat-mode" role="tablist" aria-label="Message mode">
                <button type="button" role="tab" aria-selected={mode === "ask"} className={mode === "ask" ? "active" : ""} onClick={() => setMode("ask")} title="A question — the agent answers, changes nothing">Ask</button>
                <button type="button" role="tab" aria-selected={mode === "do"} className={mode === "do" ? "active" : ""} onClick={() => setMode("do")} title="An instruction — the agent carries it out in the worktree and reports back">Do</button>
            </div>
            <div className="chat-input">
                <AgentInput
                    value={text}
                    onChange={setText}
                    pending={pending}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                    }}
                    placeholder={placeholder}
                    disabled={!idle || sending}
                    rows={mode === "do" ? 4 : 2}
                />
                <button className="primary" disabled={!idle || sending || (!text.trim() && pending.files.length === 0)} onClick={() => void send()}>
                    {sending ? (mode === "do" ? "Starting…" : "Asking…") : mode === "do" ? "Run" : "Send"}
                </button>
            </div>
        </section>
    );
};
