import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const cls = (invalid: boolean | undefined, className: string | undefined): string | undefined => [invalid && "invalid", className].filter(Boolean).join(" ") || undefined;

// Text-like controls share one look (styles.css); pass-through wrappers so every control in the app is one of these three.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(({ invalid, className, ...rest }, ref) => (
    <input ref={ref} className={cls(invalid, className)} aria-invalid={invalid || undefined} {...rest} />
));
Input.displayName = "Input";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(({ invalid, className, ...rest }, ref) => (
    <select ref={ref} className={cls(invalid, className)} aria-invalid={invalid || undefined} {...rest} />
));
Select.displayName = "Select";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(({ invalid, className, ...rest }, ref) => (
    <textarea ref={ref} className={cls(invalid, className)} aria-invalid={invalid || undefined} {...rest} />
));
Textarea.displayName = "Textarea";

const CODE_ROWS = { sm: 3, md: 6, lg: 12 } as const;

// A text area for commands and other code or machine text: monospace, no wrapping, no autocorrect. `size` is how many
// lines it shows before it scrolls; `prose` wraps long lines (markdown, rules written in sentences).
export const CodeArea = forwardRef<HTMLTextAreaElement, { size?: keyof typeof CODE_ROWS; prose?: boolean } & TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(({ size = "sm", prose, className, ...rest }, ref) => (
    <Textarea
        ref={ref}
        className={["code-area", prose && "prose", className].filter(Boolean).join(" ")}
        rows={CODE_ROWS[size]}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...(prose ? {} : { wrap: "off" })}
        {...rest}
    />
));
CodeArea.displayName = "CodeArea";
