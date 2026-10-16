import { anchorOf, type Message, type MessageAnchor } from "../api";
import { Markdown } from "../Markdown";

// A chat message with its anchor unpacked, for placement.
export interface ThreadMessage extends MessageAnchor {
    msg: Message;
}
export const threadMessages = (messages: Message[]): ThreadMessage[] =>
    messages.flatMap((msg) => {
        const a = anchorOf(msg);
        return a ? [{ ...a, msg }] : [];
    });

export const LineThread = ({ items, asking, canAsk, onReply, open, onOpen }: { items: ThreadMessage[]; asking: boolean; canAsk: boolean; onReply: () => void; open: boolean; onOpen: (open: boolean) => void }) => {
    const first = items.find((t) => t.msg.role === "user")?.msg.text ?? "";
    if (!open && !asking) {
        return (
            <div className="line-thread folded" onClick={() => onOpen(true)} title="Show the discussion">
                ▸ Q&amp;A · {items.length} message{items.length === 1 ? "" : "s"}{first ? ` — ${first.replace(/\s+/g, " ").slice(0, 90)}` : ""}
            </div>
        );
    }
    return (
    <div className="line-thread">
        <button className="tiny thread-fold" onClick={() => onOpen(false)} title="Collapse this discussion">▾ Collapse</button>
        {items.map(({ msg }) => (
            <div key={msg.id} className={`thread-msg ${msg.role}`}>
                <div className="chat-msg-head">
                    <b>{msg.role === "user" ? "You" : "Agent"}</b>
                    <span className="field-hint">{new Date(msg.created_at).toLocaleString()}</span>
                </div>
                {msg.role === "agent" ? <Markdown source={msg.text} /> : <div>{msg.text}</div>}
            </div>
        ))}
        {asking && <div className="thread-msg agent pending">Agent is answering…</div>}
        {canAsk && !asking && <button className="tiny" onClick={onReply}>Reply</button>}
    </div>
    );
};
