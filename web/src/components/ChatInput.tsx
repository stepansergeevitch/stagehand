import { forwardRef, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, IconButton, Kbd, Tabs, Textarea } from "@vortex/ds";
import { FileChips, type PendingFiles } from "../FilePicker";
import "./chatinput.css";

// The one box for anything the human writes to an agent (docs/ux-redesign.md, the approved "Chat input" design): the
// task Chat, the Prompter, the Product owner chat, and every note, answer and review comment in a form.
//
// A rounded box: the attached files as chips above the text, the text (it grows from `rows` to 8, then scrolls), and a
// toolbar inside it: Attach and the mode on the left, the action on the right. Two shapes of the same component:
//   Composer (`action`)  a chat: the action sends. While the agent works (`working`) it is Stack (the message goes out after
//                        the turn) and Stop appears beside it; with an empty box only Stop is left.
//   Field (no `action`)  a note in a form: the same box and attachments, no action; the form's own button submits.
// A queued message waits above the box with Edit and Remove; a failed send shows above it with Retry and keeps the text.
//
// Keys (Emacs; RET sends on a desktop, a phone's Return is a new line and the button sends): RET sends, Shift+RET or C-j is a
// new line, C-c C-c sends from anywhere in the box, C-g (or Esc) stops the running turn or leaves the box, M-p (or ArrowUp in
// an empty box) takes the last queued message back.
export interface ChatInputProps {
    value: string;
    onChange: (value: string) => void;
    // Files to paste, drop or attach (usePendingFiles); the caller uploads them when it sends. None: text only.
    pending?: PendingFiles | undefined;
    // "none": the caller draws the chips and the Attach button itself (a form that keeps one list for several boxes).
    chips?: "inside" | "none";
    placeholder?: string | undefined;
    ariaLabel?: string | undefined;
    disabled?: boolean | undefined;
    // A line inside the box saying what is going on ("Agent is working", why it is disabled).
    status?: ReactNode;
    rows?: number | undefined;
    autoFocus?: boolean | undefined;
    spellCheck?: boolean | undefined;
    className?: string | undefined;
    // The composer's action: its label (Send, Run, Stack), "sending" while the send is in flight, and what it does.
    action?: { label: string; sendingLabel?: string; sending?: boolean; onSend: () => void } | undefined;
    // The agent is working: Stop shows (C-g), the action says Stack.
    working?: boolean | undefined;
    onStop?: (() => void) | undefined;
    // Ask | Do and the like, in the toolbar.
    mode?: { value: string; items: Array<{ key: string; label: string }>; onChange: (key: string) => void } | undefined;
    queued?: Array<{ id: string; text: string }> | undefined;
    onEditQueued?: ((id: string) => void) | undefined;
    onRemoveQueued?: ((id: string) => void) | undefined;
    // M-p / ArrowUp in an empty box.
    onRecall?: (() => void) | undefined;
    error?: ReactNode;
    onRetry?: (() => void) | undefined;
    onKeyDown?: ((e: KeyboardEvent<HTMLTextAreaElement>) => void) | undefined;
}

const touch = (): boolean => window.matchMedia("(hover: none)").matches;

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(({ value, onChange, pending, chips = "inside", placeholder, ariaLabel, disabled, status, rows = 2, autoFocus, spellCheck, className, action, working, onStop, mode, queued, onEditQueued, onRemoveQueued, onRecall, error, onRetry, onKeyDown }, ref) => {
    const own = useRef<HTMLTextAreaElement | null>(null);
    const picker = useRef<HTMLInputElement>(null);
    const chord = useRef(0);
    const [dragging, setDragging] = useState(false);
    const hasContent = value.trim().length > 0 || (pending?.files.length ?? 0) > 0;
    const sending = !!action?.sending;
    const canSend = !!action && !disabled && !sending && hasContent;
    const inside = chips !== "none";

    // Grows with the text from `rows` lines to eight, then scrolls.
    useEffect(() => {
        const el = own.current;
        if (!el) return;
        el.style.height = "auto";
        const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
        const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
        el.style.height = `${Math.min(el.scrollHeight, line * 8 + pad)}px`;
    }, [value, rows]);

    const send = (): void => { if (canSend) action!.onSend(); };
    const keys = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" && !e.shiftKey && !e.altKey && action && (e.metaKey || e.ctrlKey || !touch())) {
            e.preventDefault();
            send();
        } else if (e.ctrlKey && e.code === "KeyJ") {
            e.preventDefault();
            const el = e.currentTarget;
            el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
            onChange(el.value);
        } else if (e.ctrlKey && e.code === "KeyC" && !e.currentTarget.value.slice(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)) {
            e.preventDefault();
            if (Date.now() - chord.current < 1500) { chord.current = 0; send(); } else chord.current = Date.now();
        } else if ((e.ctrlKey && e.code === "KeyG") || (e.key === "Escape" && working && onStop)) {
            e.preventDefault();
            if (working && onStop) onStop();
            else e.currentTarget.blur();
        } else if (onRecall && ((e.altKey && e.code === "KeyP") || (e.key === "ArrowUp" && !value))) {
            e.preventDefault();
            onRecall();
        }
    };

    const showAction = !!action && (!working || hasContent);
    const showBar = !!action || !!mode || !!onStop || (!!pending && inside);
    return (
        <div className={`chat-input-wrap${className ? ` ${className}` : ""}`}>
            {error && (
                <div className="chat-input-error" role="alert">
                    <span>{error}</span>
                    {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
                </div>
            )}
            {queued?.map((q) => (
                <div key={q.id} className="chat-input-queued">
                    <b>Queued</b>
                    <span className="text">{q.text}</span>
                    {onEditQueued && <Button size="sm" variant="ghost" onClick={() => onEditQueued(q.id)}>Edit <Kbd>M-p</Kbd></Button>}
                    {onRemoveQueued && <Button size="sm" variant="ghost" onClick={() => onRemoveQueued(q.id)}>Remove</Button>}
                </div>
            ))}
            <div
                className={`chat-input${dragging ? " drag" : ""}${disabled ? " dis" : ""}${error ? " err" : ""}`}
                onDragEnter={(e) => { if (pending && e.dataTransfer.types.includes("Files")) setDragging(true); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
                onDragOver={pending?.onDragOver}
                onDrop={(e) => { setDragging(false); pending?.onDrop(e); }}
            >
                {dragging && <div className="chat-input-drop" role="status">Drop to attach</div>}
                {pending && inside && pending.files.length > 0 && <FileChips pending={pending} disabled={disabled} attach={false} uploading={sending} />}
                <Textarea
                    ref={(el: HTMLTextAreaElement | null) => { own.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    aria-label={ariaLabel ?? placeholder ?? "Message"}
                    disabled={disabled || sending}
                    rows={rows}
                    autoFocus={autoFocus}
                    spellCheck={spellCheck}
                    onKeyDown={keys}
                    onPaste={pending?.onPaste}
                />
                {status && <div className="chat-input-status" role="status">{status}</div>}
                {showBar && (
                    <div className="chat-input-bar">
                        {pending && inside && (
                            <>
                                <IconButton icon="paperclip" label="Attach files" variant="ghost" disabled={disabled || sending} onClick={() => picker.current?.click()} />
                                <input ref={picker} type="file" multiple hidden disabled={disabled} onChange={(e) => { if (e.target.files) pending.add(e.target.files); e.target.value = ""; }} />
                            </>
                        )}
                        {mode && <Tabs variant="pill" className="chat-input-mode" active={mode.value} onChange={mode.onChange} items={mode.items} />}
                        <span className="sp" />
                        {working && onStop && <Button variant="danger" onClick={onStop}>Stop <Kbd>C-g</Kbd></Button>}
                        {showAction && <Button variant="primary" disabled={!canSend} onClick={send}>{sending ? action!.sendingLabel ?? "Sending" : action!.label} <Kbd>RET</Kbd></Button>}
                    </div>
                )}
            </div>
        </div>
    );
});
ChatInput.displayName = "ChatInput";
