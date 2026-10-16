import { forwardRef, type CSSProperties, type KeyboardEvent } from "react";
import { FileChips, type PendingFiles } from "./FilePicker";
import { Textarea } from "./components/ui";

export { FileChips, usePendingFiles, type PendingFiles } from "./FilePicker";

interface Props {
    value: string;
    onChange: (value: string) => void;
    // Files the human can paste, drop or attach; the caller uploads `pending.files` when it sends. Without it the box
    // is text only (a task that does not exist yet, a settings field).
    pending?: PendingFiles | undefined;
    // Where the chips (and the Attach button) sit; "none" when the caller renders one FileChips for several boxes.
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

// The one text box for anything the human writes to an agent: Chat and Do, answers to its questions, review notes,
// Return notes, the task's standing instructions, PR jobs, a commit-removal note, Prompter. A screenshot pasted or
// files dropped onto it, or attached with the button, go to the agent with the text (see usePendingFiles).
export const AgentInput = forwardRef<HTMLTextAreaElement, Props>(({ value, onChange, pending, chips = "above", placeholder, disabled, rows, autoFocus, spellCheck, style, className, onKeyDown }, ref) => (
    <div className={`agent-input${className ? ` ${className}` : ""}`}>
        {pending && chips === "above" && <FileChips pending={pending} disabled={disabled} />}
        <Textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            rows={rows}
            autoFocus={autoFocus}
            spellCheck={spellCheck}
            style={style}
            onKeyDown={onKeyDown}
            onPaste={pending?.onPaste}
            onDrop={pending?.onDrop}
            onDragOver={pending?.onDragOver}
        />
        {pending && chips === "below" && <FileChips pending={pending} disabled={disabled} />}
    </div>
));
AgentInput.displayName = "AgentInput";
