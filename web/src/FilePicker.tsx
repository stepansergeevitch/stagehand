import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { api, type SharedFile } from "./api";
import { bytes as fmtBytes } from "./format";
import { Button, Chip, Icon, IconButton, Input } from "@vortex/ds";
import "./agent-input.css";

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");

// A pasted screenshot arrives as a File called "image.png": give it a name that says when it was pasted, so several
// pastes stay apart in the task dir and in the agent's prompt.
const named = (f: File): File => (/^image\.\w+$/i.test(f.name) ? new File([f], `pasted-${stamp()}${f.name.slice(f.name.lastIndexOf("."))}`, { type: f.type }) : f);

// Files the human is about to send with a message (Chat, Do, an answer). They stay in memory until Send: the caller
// uploads them then and names them on the message — nothing lands in the task dir for a message that is never sent.
// Paste, drop and the Attach button all feed the same list; an attached file is in, no confirm step (remove is one tap).
export const usePendingFiles = () => {
    const [files, setFiles] = useState<File[]>([]);
    const add = useCallback((list: Iterable<File>) => setFiles((prev) => [...prev, ...[...list].filter((f) => f.size > 0).map(named)]), []);
    const remove = useCallback((i: number) => setFiles((prev) => prev.filter((_, j) => j !== i)), []);
    const clear = useCallback(() => setFiles([]), []);
    const onPaste = (e: ClipboardEvent) => {
        const got = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter((f): f is File => f !== null);
        if (got.length === 0) return;
        e.preventDefault();
        add(got);
    };
    const onDrop = (e: DragEvent) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        add(e.dataTransfer.files);
    };
    const onDragOver = (e: DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
    };
    return { files, add, remove, clear, onPaste, onDrop, onDragOver };
};

export type PendingFiles = ReturnType<typeof usePendingFiles>;


// A thumbnail for an image still in memory; the object URL is released when the chip goes.
const Thumb = ({ file }: { file: File }) => {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        const u = URL.createObjectURL(file);
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [file]);
    return url ? <img src={url} alt="" /> : null;
};

// The pending files as chips (thumbnail, name, size, remove) plus the Attach button. Sits above the text input.
export const FileChips = ({ pending, disabled, attach = true, uploading }: { pending: PendingFiles; disabled?: boolean; attach?: boolean; uploading?: boolean }) => {
    const picker = useRef<HTMLInputElement>(null);
    return (
        <div className="file-chips">
            {pending.files.map((f, i) => (
                <Chip key={`${f.name}-${i}`} className="file-chip" title={`${f.name} · ${fmtBytes(f.size)}`}>
                    {f.type.startsWith("image/") && <Thumb file={f} />}
                    <span className="name">{f.name}</span>
                    <span className="file-size">{uploading ? "Uploading" : fmtBytes(f.size)}</span>
                    <IconButton icon="close" size="sm" variant="ghost" label={`Remove ${f.name}`} disabled={disabled || uploading} onClick={() => pending.remove(i)} />
                </Chip>
            ))}
            {attach && (
                <Button size="sm" className="file-attach" disabled={disabled} title="Attach files for the agent. You can also paste a screenshot or drop files onto the text box." onClick={() => picker.current?.click()}>
                    <Icon name="plus" />Attach
                </Button>
            )}
            <Input
                ref={picker}
                type="file"
                multiple
                hidden
                disabled={disabled}
                onChange={(e) => {
                    if (e.target.files) pending.add(e.target.files);
                    e.target.value = "";
                }}
            />
        </div>
    );
};

// Files that went with a sent message: images inline (open full size in a new tab), anything else a link. The agent
// got the same files by path.
const FileTiles = ({ files, urlOf }: { files: SharedFile[]; urlOf: (file: string) => string }) => {
    if (files.length === 0) return null;
    return (
        <div className="msg-files">
            {files.map((f) => {
                const src = urlOf(f.file);
                const meta = [f.mime, fmtBytes(f.size)].filter(Boolean).join(" · ");
                return f.mime?.startsWith("image/") ? (
                    <a key={f.file} href={src} target="_blank" rel="noreferrer" title={`${f.name} · ${meta}`}>
                        <img src={src} alt={f.name} />
                    </a>
                ) : (
                    <a key={f.file} className="file-tile" href={src} target="_blank" rel="noreferrer" title={meta}>
                        {f.name}
                    </a>
                );
            })}
        </div>
    );
};

export const MessageFiles = ({ taskId, files }: { taskId: string; files: SharedFile[] }) => <FileTiles files={files} urlOf={(file) => api.artifactUrl(taskId, file)} />;

// The same for a Product owner's messages and threads: the files live under the PO dir.
export const PoMessageFiles = ({ poId, files }: { poId: string; files: SharedFile[] }) => <FileTiles files={files} urlOf={(file) => api.poFileUrl(poId, file)} />;
