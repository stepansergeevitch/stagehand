import { forwardRef, type CSSProperties, type KeyboardEvent } from "react";
import { ChatInput } from "./components/ChatInput";
import type { PendingFiles } from "./FilePicker";

export { FileChips, usePendingFiles, type PendingFiles } from "./FilePicker";

interface Props {
    value: string;
    onChange: (value: string) => void;
    // Files the human can paste, drop or attach; the caller uploads `pending.files` when it sends. Without it the box
    // is text only (a task that does not exist yet, a settings field).
    pending?: PendingFiles | undefined;
    // "none" when the caller renders one FileChips (with its Attach button) for several boxes.
    chips?: "above" | "below" | "none";
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
    rows?: number | undefined;
    autoFocus?: boolean | undefined;
    spellCheck?: boolean | undefined;
    style?: CSSProperties | undefined;
    className?: string | undefined;
    onKeyDown?: ((e: KeyboardEvent<HTMLTextAreaElement>) => void) | undefined;
}

// The Field shape of ChatInput: a note, an answer or a review comment inside a form (the form's own button submits). Same box,
// same attachments (paste, drop, the paperclip) as every chat; see components/ChatInput.tsx.
export const AgentInput = forwardRef<HTMLTextAreaElement, Props>(({ value, onChange, pending, chips = "above", placeholder, disabled, rows, autoFocus, spellCheck, className, onKeyDown }, ref) => (
    <ChatInput ref={ref} value={value} onChange={onChange} pending={pending} chips={chips === "none" ? "none" : "inside"} placeholder={placeholder} disabled={disabled} rows={rows} autoFocus={autoFocus} spellCheck={spellCheck} className={className} onKeyDown={onKeyDown} />
));
AgentInput.displayName = "AgentInput";
