import { useMemo, useState } from "react";
import { api, type PoDetail } from "../api";
import { Markdown } from "../Markdown";
import { Button, Notice, Select } from "@vortex/ds";
import { Nothing, errText } from "./parts";

type Props = { d: PoDetail; onError: (m: string) => void; send: (t: string) => void };

// design.md split on its `## ` headings: a table of contents on the side, each section addressable.
const sectionsOf = (md: string): Array<{ title: string; body: string }> => {
    const out: Array<{ title: string; body: string }> = [];
    let cur: { title: string; body: string } | null = null;
    let fence = false;
    for (const line of md.split("\n")) {
        if (/^```/.test(line)) fence = !fence;
        const h = !fence ? /^##\s+(.+?)\s*$/.exec(line) : null;
        if (h) {
            if (cur) out.push(cur);
            cur = { title: h[1]!, body: "" };
        } else if (cur) cur.body += `${line}\n`;
    }
    if (cur) out.push(cur);
    return out;
};

export const DesignTab = ({ d, onError, send }: Props) => {
    const [rev, setRev] = useState<{ name: string; text: string } | null>(null);
    const revs = d.revisions.filter((r) => r.file === "design.md");
    const text = rev?.text ?? d.design ?? "";
    const sections = useMemo(() => sectionsOf(text), [text]);
    if (!d.design) {
        return (
            <Nothing
                title="No design yet"
                action={<Button variant="primary" disabled={d.running} onClick={() => send("Write design.md now, from what we know. Mark what is still open in Open questions.")}>Ask for the design</Button>}
            >
                The Product owner writes the design once the context is complete.
            </Nothing>
        );
    }
    const canApprove = d.po.phase === "context" || d.po.phase === "design";
    return (
        <div className="po-doc">
            <nav className="po-toc" aria-label="Design sections">
                {sections.map((s, i) => <a key={i} href="#" onClick={(e) => { e.preventDefault(); document.getElementById(`po-sec-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{s.title}</a>)}
                {revs.length > 1 && (
                    <label className="po-env-pick"><span>Version</span>
                        <Select value={rev?.name ?? ""} onChange={async (e) => { const n = e.target.value; if (!n) return setRev(null); try { setRev({ name: n, text: (await api.poRevision(d.po.id, n)).text }); } catch (err) { onError(errText(err)); } }}>
                            <option value="">Current</option>
                            {revs.slice(0, -1).reverse().map((r) => <option key={r.name} value={r.name}>{new Date(r.at).toLocaleString()}</option>)}
                        </Select>
                    </label>
                )}
            </nav>
            <div className="po-doc-body">
                {rev && <Notice tone="info">You are reading an earlier version. <Button size="sm" onClick={() => setRev(null)}>Back to current</Button></Notice>}
                {canApprove && !rev && <Notice tone="warn">Your call: refine the design in the chat, or approve it. The Product owner then splits it into tickets.</Notice>}
                {sections.length === 0 ? <Markdown source={text} /> : sections.map((s, i) => (
                    <section key={i} id={`po-sec-${i}`} className="po-section">
                        <h2>{s.title}</h2>
                        <Markdown source={s.body} />
                    </section>
                ))}
            </div>
        </div>
    );
};
