// Emacs selection in every text box: C-SPC (or C-@) sets the mark, then the movement keys grow the selection from it in the
// direction you move; C-g drops the mark, C-w cuts the region, M-w copies it. Any other key ends the mark (typing replaces
// the region as usual). Without a mark nothing here runs, so the browser's own keys (C-a, C-e, C-k, C-f, C-b…) are untouched.
// Keys are matched on the physical key (`e.code`): on macOS Option changes the typed character.

export type Motion = "left" | "right" | "up" | "down" | "home" | "end" | "wordLeft" | "wordRight" | "start" | "finish";

export const lineStart = (v: string, p: number): number => v.lastIndexOf("\n", p - 1) + 1;
export const lineEnd = (v: string, p: number): number => {
    const i = v.indexOf("\n", p);
    return i < 0 ? v.length : i;
};

// One line up or down, keeping the column (clamped to the shorter line).
export const moveVertical = (v: string, p: number, dir: 1 | -1): number => {
    const col = p - lineStart(v, p);
    if (dir < 0) {
        const s = lineStart(v, p);
        if (s === 0) return 0;
        const prevStart = lineStart(v, s - 1);
        return Math.min(prevStart + col, s - 1);
    }
    const e = lineEnd(v, p);
    if (e >= v.length) return v.length;
    const nextStart = e + 1;
    return Math.min(nextStart + col, lineEnd(v, nextStart));
};

const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);
export const wordForward = (v: string, p: number): number => {
    let i = p;
    while (i < v.length && !isWord(v[i])) i++;
    while (i < v.length && isWord(v[i])) i++;
    return i;
};
export const wordBackward = (v: string, p: number): number => {
    let i = p;
    while (i > 0 && !isWord(v[i - 1])) i--;
    while (i > 0 && isWord(v[i - 1])) i--;
    return i;
};

export const applyMotion = (v: string, p: number, m: Motion): number => {
    switch (m) {
        case "left": return Math.max(0, p - 1);
        case "right": return Math.min(v.length, p + 1);
        case "up": return moveVertical(v, p, -1);
        case "down": return moveVertical(v, p, 1);
        case "home": return lineStart(v, p);
        case "end": return lineEnd(v, p);
        case "wordLeft": return wordBackward(v, p);
        case "wordRight": return wordForward(v, p);
        case "start": return 0;
        case "finish": return v.length;
    }
};

type Keys = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

// The motion a key makes, in Emacs terms (C-f C-b C-n C-p C-a C-e, M-f M-b, M-< M->) or with the plain arrows and Home / End.
export const motionOf = (e: Keys): Motion | null => {
    if (e.metaKey) return null;
    if (e.ctrlKey && !e.altKey && !e.shiftKey) {
        switch (e.code) {
            case "KeyF": return "right";
            case "KeyB": return "left";
            case "KeyN": return "down";
            case "KeyP": return "up";
            case "KeyA": return "home";
            case "KeyE": return "end";
        }
    }
    if (e.altKey && !e.ctrlKey) {
        if (e.code === "KeyF") return "wordRight";
        if (e.code === "KeyB") return "wordLeft";
        if (e.shiftKey && e.code === "Comma") return "start";
        if (e.shiftKey && e.code === "Period") return "finish";
    }
    if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
        switch (e.code) {
            case "ArrowLeft": return "left";
            case "ArrowRight": return "right";
            case "ArrowUp": return "up";
            case "ArrowDown": return "down";
            case "Home": return "home";
            case "End": return "end";
        }
    }
    return null;
};

type Box = HTMLTextAreaElement | HTMLInputElement;
const isBox = (el: EventTarget | null): el is Box =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ["text", "search", "url", "email", "tel", ""].includes(el.type));

const marks = new WeakMap<Box, { mark: number; cursor: number }>();

const select = (el: Box, mark: number, cursor: number): void => {
    el.setSelectionRange(Math.min(mark, cursor), Math.max(mark, cursor), cursor < mark ? "backward" : "forward");
};

const onKey = (e: KeyboardEvent): void => {
    const el = e.target;
    if (!isBox(el)) return;
    const st = marks.get(el);
    const handled = (): void => { e.preventDefault(); e.stopPropagation(); };
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Space" || (e.shiftKey && e.code === "Digit2"))) {
        handled();
        const pos = el.selectionStart ?? 0;
        // C-SPC again on the same spot ends the mark.
        if (st && st.mark === pos && st.cursor === pos) marks.delete(el);
        else marks.set(el, { mark: pos, cursor: pos });
        el.setSelectionRange(pos, pos);
        return;
    }
    if (!st) return;
    if (e.ctrlKey && !e.altKey && e.code === "KeyG") {
        handled();
        marks.delete(el);
        el.setSelectionRange(st.cursor, st.cursor);
        return;
    }
    if ((e.ctrlKey && !e.altKey && e.code === "KeyW") || (e.altKey && !e.ctrlKey && e.code === "KeyW")) {
        handled();
        const a = Math.min(st.mark, st.cursor);
        const b = Math.max(st.mark, st.cursor);
        const region = el.value.slice(a, b);
        marks.delete(el);
        if (region) void navigator.clipboard?.writeText(region).catch(() => undefined);
        if (e.ctrlKey) {
            // Cut through the editing command so undo and the framework's input event both work.
            el.setSelectionRange(a, b);
            document.execCommand("delete");
        } else {
            el.setSelectionRange(st.cursor, st.cursor);
        }
        return;
    }
    const m = motionOf(e);
    if (m) {
        handled();
        const next = applyMotion(el.value, st.cursor, m);
        st.cursor = next;
        select(el, st.mark, next);
        return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    marks.delete(el);
};

// Installed once for the whole app: a capture listener, so a handled key never reaches the box's own handlers.
export const installEmacsMark = (): (() => void) => {
    const drop = (e: Event): void => { if (isBox(e.target)) marks.delete(e.target); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", drop, true);
    document.addEventListener("focusout", drop, true);
    return () => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("mousedown", drop, true);
        document.removeEventListener("focusout", drop, true);
    };
};
