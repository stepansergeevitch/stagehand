import { useEffect, useRef, useState } from "react";
import { anchorOf, api, filesOf, type Message, type TaskStatus } from "./api";
import { MessageFiles } from "./FilePicker";
import { AgentInput, usePendingFiles } from "./AgentInput";
import { Markdown } from "./Markdown";
import { Panel } from "./components/Panel";
import { Button, Chip, EmptyState, Notice, Tabs } from "@vortex/ds";
import "./tasks/chat.css";

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
        ? "A run is in progress. Send once it is idle."
        : mode === "do"
          ? "Tell the agent what to do in this task's worktree… (⌘/Ctrl+Enter to run)"
          : "Ask about this task… (⌘/Ctrl+Enter to send)";

    return (
        <Panel
            title="Agent chat"
            hint="Notes the agent leaves on its own (implementation notes, CI fixes) appear here. Ask puts a question to it with the full context of this task and changes nothing. Do gives it an instruction to carry out now in the worktree, under this environment's rules; it reports back here and the task returns to its current stage. Do can also try something in the running app (manual QA): its screenshots come back attached to the reply. Stop halts it like any run."
            className="chat"
        >
            <div className="chat-log">
                {messages.length === 0 && <EmptyState icon="inbox" title="No messages yet">Notes the agent leaves and your questions appear here.</EmptyState>}
                {messages.map((m) => {
                    const a = anchorOf(m);
                    return (
                        <div key={m.id} className={`chat-msg ${m.role}${m.kind ? ` ${m.kind}` : ""}`}>
                            <div className="chat-msg-head">
                                <b>{m.role === "user" ? "You" : "Agent"}</b>
                                {m.kind === "instruction" && <Chip tone="accent">instruction</Chip>}
                                {m.kind === "instruction_result" && <Chip tone="ok">report</Chip>}
                                <span className="field-hint">{new Date(m.created_at).toLocaleString()}</span>
                                {a && a.prComment && (
                                    <a className="chip accent anchor-chip" href={a.prComment.url} target="_blank" rel="noreferrer" title={`About a PR comment: ${a.snippet.trim().slice(0, 120)}`}>
                                        PR #{a.prComment.number} · {a.prComment.author}{a.path ? ` · ${a.path}${a.line ? `:${a.line}` : ""}` : ""}
                                    </a>
                                )}
                                {a && !a.prComment && (
                                    <Button size="sm" variant="ghost" className="anchor-chip" title={`About this line of the diff: ${a.snippet.trim().slice(0, 120)}`} onClick={onOpenCode}>
                                        {a.path}:{a.line}{a.side === "old" ? " (removed)" : ""}
                                    </Button>
                                )}
                            </div>
                            <Markdown source={m.text} />
                            <MessageFiles taskId={taskId} files={filesOf(m)} />
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>
            {error && <Notice tone="bad">{error}</Notice>}
            <div className="chat-composer">
                <Tabs variant="pill" active={mode} onChange={(k) => setMode(k as Mode)} items={[{ key: "ask", label: "Ask" }, { key: "do", label: "Do" }]} />
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
                    <Button variant="primary" disabled={!idle || sending || (!text.trim() && pending.files.length === 0)} onClick={() => void send()}>
                        {sending ? (mode === "do" ? "Starting…" : "Asking…") : mode === "do" ? "Run" : "Send"}
                    </Button>
                </div>
            </div>
        </Panel>
    );
};
