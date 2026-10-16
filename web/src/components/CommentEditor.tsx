import { useState } from "react";
import { AgentInput, usePendingFiles } from "../AgentInput";
import { Button } from "./ui";

// One editor for both things a line takes: a review comment (Save — kept as a draft until the review is sent) and a
// question for the agent (Ask — sent right away, answered in place). Either button is offered only when allowed.
// Files go with a question (the agent gets them with the anchored message); a saved draft comment is text only.
export const CommentEditor = ({ initial, placeholder, onSave, onAsk, onCancel, onDelete }: { initial: string; placeholder: string; onSave?: (t: string) => void; onAsk?: (t: string, files: File[]) => void; onCancel: () => void; onDelete?: () => void }) => {
    const [text, setText] = useState(initial);
    const attach = usePendingFiles();
    const ask = () => onAsk?.(text.trim() || "See the attached file(s).", attach.files);
    return (
        <div className="line-comment editing">
            <AgentInput
                autoFocus
                value={text}
                onChange={setText}
                placeholder={placeholder}
                pending={onAsk ? attach : undefined}
                chips="below"
                onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) onSave ? onSave(text.trim()) : ask();
                }}
            />
            <div className="actions">
                {onSave && <Button variant="primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>Save comment</Button>}
                {onAsk && <Button className={onSave ? "" : "primary"} disabled={!text.trim() && attach.files.length === 0} title="Ask the task's agent about this; the answer appears here and in Chat" onClick={ask}>Ask agent</Button>}
                <Button onClick={onCancel}>Cancel</Button>
                {onDelete && <Button variant="danger" onClick={onDelete}>Delete</Button>}
            </div>
        </div>
    );
};
