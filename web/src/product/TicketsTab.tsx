import { useEffect, useMemo, useState } from "react";
import { errText } from "../format";
import { api, poEnvIds, trackerName, type Env, type PoDetail, type PoIssue, type PoTicket } from "../api";
import { Markdown } from "../Markdown";
import { DataTable, type DataColumn } from "../components/DataTable";
import { EntityForm, Field, ReadField, useDraft } from "../components/EntityView";
import { Section } from "../components/Panel";
import { navigate } from "../routes";
import { Button, Chip, Icon, Input, Notice, Select, Tabs, Textarea } from "@vortex/ds";
import { Nothing, since } from "./parts";
import { when } from "../format";

type Props = { d: PoDetail; sel: string | null; ticketTab: string | undefined; onError: (m: string) => void; reload: () => void; send: (t: string) => void };

const TicketEditor = ({ t, onSave }: { t: PoTicket; onSave: (t: PoTicket) => Promise<void> }) => {
    const draft = useDraft(() => t, [t]);
    const [saving, setSaving] = useState(false);
    const x = draft.value;
    return (
        <EntityForm dirty={draft.dirty} saving={saving} onDiscard={draft.reset} onSave={async () => { setSaving(true); try { await onSave(x); } finally { setSaving(false); } }}>
            <Field label="Title"><Input value={x.title} onChange={(e) => draft.patch({ title: e.target.value })} /></Field>
            <Field label="Type"><Select value={x.type} onChange={(e) => draft.patch({ type: e.target.value as PoTicket["type"] })}>{["epic", "story", "task", "bug"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
            <Field label="Estimate" hint="Story points; empty for none."><Input inputMode="numeric" value={x.estimate ?? ""} onChange={(e) => { const n = Number(e.target.value); draft.patch({ estimate: e.target.value.trim() === "" || !Number.isFinite(n) ? null : n }); }} /></Field>
            <Field label="Summary"><Input value={x.summary} onChange={(e) => draft.patch({ summary: e.target.value })} /></Field>
            <Field label="Description"><Textarea rows={8} value={x.description} onChange={(e) => draft.patch({ description: e.target.value })} /></Field>
            <Field label="Acceptance criteria" hint="One per line."><Textarea rows={5} value={x.acceptanceCriteria.join("\n")} onChange={(e) => draft.patch({ acceptanceCriteria: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })} /></Field>
        </EntityForm>
    );
};

// The issue behind a ticket as the task manager has it now: status, labels, assignee and its comments.
const LiveIssue = ({ issue }: { issue: PoIssue }) => (
    <div className="po-stack">
        <div className="po-chips">
            <Chip tone="accent">{issue.status ?? "Unknown status"}</Chip>
            {issue.assignee && <Chip>{issue.assignee}</Chip>}
            {issue.priority && <Chip>Priority {issue.priority}</Chip>}
            {issue.labels.map((l) => <Chip key={l}>{l}</Chip>)}
        </div>
        <Section title={`Comments (${issue.comments.length})`}>
            {issue.comments.length === 0 ? <p className="po-muted">No comments.</p> : (
                <div className="po-comments">
                    {issue.comments.map((c) => (
                        <div key={c.id} className="po-comment">
                            <div className="po-comment-head"><b>{c.author}</b> <span className="po-muted">{when(c.at)}</span></div>
                            <Markdown source={c.body} />
                        </div>
                    ))}
                </div>
            )}
        </Section>
    </div>
);

// When the issues were last read from the task manager, and a button to read them now.
const IssuesRefresh = ({ d, onError, reload }: { d: PoDetail; onError: (m: string) => void; reload: () => void }) => {
    const [busy, setBusy] = useState(false);
    const refresh = async () => {
        setBusy(true);
        try { await api.poRefreshIssues(d.po.id); reload(); } catch (e) { onError(errText(e)); } finally { setBusy(false); }
    };
    const read = d.po.issues_refreshed_at ? `read ${since(d.po.issues_refreshed_at)}` : "never read";
    return (
        <>
            {d.po.issues_error && <Chip tone="bad" title={d.po.issues_error}>Last refresh failed</Chip>}
            <Button disabled={busy || d.refreshingIssues || d.running} title={`${d.issues.length} issue(s) tracked · ${read} · read every hour, and the Product owner gets what changed${d.running ? " · wait for the Product owner's turn" : ""}`} onClick={() => void refresh()}>{busy || d.refreshingIssues ? "Refreshing…" : "Refresh issues"}</Button>
        </>
    );
};

// The Product owner's tickets: one list (components/DataTable) — a row opens the ticket. A ticket becomes a tracker
// issue with Create in Linear/ClickUp, and an issue becomes a Vortex task with Create task; both work on one ticket or
// on the checked ones.
export const TicketsTab = ({ d, sel, ticketTab, onError, reload, send }: Props) => {
    const tickets = d.tickets?.tickets ?? [];
    // The opened ticket and its tab are routed (#/product/<po>/tickets/<key>/<tab>).
    const setSel = (key: string | null, tab?: string): void => navigate({ page: "product", po: d.po.id, tab: "tickets", ...(key ? { ticket: key } : {}), ...(key && tab ? { ticketTab: tab } : {}) });
    const [busy, setBusy] = useState(false);
    // Tasks are created in one of the PO's environments: its primary one unless another is picked.
    const [allEnvs, setAllEnvs] = useState<Env[]>([]);
    useEffect(() => { void api.envs().then(setAllEnvs).catch(() => undefined); }, []);
    const poEnvs = poEnvIds(d.po);
    const [target, setTarget] = useState(d.po.env_id);
    const targetEnv = poEnvs.includes(target) ? target : d.po.env_id;
    const envName = allEnvs.find((e) => e.id === targetEnv)?.name ?? null;
    const tracker = trackerName(d.po.source);
    const byKey = useMemo(() => new Map(tickets.map((t) => [t.key, t])), [tickets]);
    const link = (k: string) => d.links.find((l) => l.key === k);
    const identOf = (t: PoTicket): string | null => link(t.key)?.identifier ?? t.existing ?? null;
    const issueOf = (t: PoTicket): PoIssue | undefined => { const id = identOf(t)?.toUpperCase(); return id ? d.issues.find((i) => i.identifier.toUpperCase() === id) : undefined; };
    const taskOf = (t: PoTicket) => { const id = identOf(t)?.toUpperCase(); return id ? d.tasks.find((x) => x.ticket_id.toUpperCase() === id) : undefined; };
    const act = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try { await fn(); reload(); } catch (e) { onError(errText(e)); } finally { setBusy(false); }
    };
    const createIssues = (keys?: string[]) => act(() => api.poApproveTickets(d.po.id, keys));
    const createTasks = (ids: string[]) => act(() => api.createTasks({ envId: targetEnv, tickets: ids, mode: "each", productOwnerId: d.po.id }));
    const targetPicker = poEnvs.length > 1 && (
        <Select value={targetEnv} aria-label="Environment for new tasks" title="The environment new tasks are created in" onChange={(e) => setTarget(e.target.value)}>
            {poEnvs.map((id) => <option key={id} value={id}>{allEnvs.find((e) => e.id === id)?.name ?? id}</option>)}
        </Select>
    );
    if (!d.tickets) {
        return (
            <div className="po-stack">
                {d.ticketsError && <Notice tone="bad">tickets.json: {d.ticketsError}</Notice>}
                <Nothing
                    title="No ticket proposal yet"
                    action={d.po.phase === "tickets" ? <Button disabled={d.running} onClick={() => send("Write tickets.json now from the approved design.")}>Ask for the tickets</Button> : undefined}
                >
                    {d.po.phase === "tickets" ? "The Product owner is writing it." : "It comes after you approve the design."}
                </Nothing>
            </div>
        );
    }
    const current = sel ? byKey.get(sel) : undefined;
    if (current) {
        const ident = identOf(current);
        const issue = issueOf(current);
        const task = taskOf(current);
        const url = link(current.key)?.url ?? issue?.url ?? null;
        const save = (next: PoTicket) => act(() => api.poSetTickets(d.po.id, tickets.map((t) => (t.key === next.key ? next : t))));
        const items = [
            { key: "details", label: "Details" },
            ...(issue ? [{ key: "tracker", label: tracker }] : []),
            ...(!link(current.key) ? [{ key: "edit", label: "Edit" }] : []),
        ];
        const tab = items.find((i) => i.key === ticketTab)?.key ?? "details";
        return (
            <div className="po-stack">
                <div className="po-ticket-head">
                    <Button size="sm" variant="ghost" onClick={() => setSel(null)}><Icon name="arrowLeft" />Tickets</Button>
                    <h2><span className="po-muted">{current.key}{ident ? ` · ${ident}` : ""}</span> {current.title}</h2>
                    <div className="po-ticket-actions">
                        {!ident && <Button variant="primary" disabled={busy || d.running} onClick={() => void createIssues([current.key])}>Create in {tracker}</Button>}
                        {ident && !task && <>{targetPicker}<Button variant="primary" disabled={busy || !d.po.env_id} title={d.po.env_id ? undefined : "This Product owner has no environment"} onClick={() => void createTasks([ident])}>Create task{envName ? ` in ${envName}` : ""}</Button></>}
                        {task && <a className="btn" href={`#/tasks/${encodeURIComponent(task.id)}`}>Open task · {task.stage.replace(/_/g, " ")}</a>}
                        {url && <a className="btn" href={url} target="_blank" rel="noreferrer">{ident ?? tracker} ↗</a>}
                    </div>
                </div>
                {items.length > 1 && <Tabs variant="pill" items={items} active={tab} onChange={(k) => setSel(current.key, k)} />}
                {tab === "details" && (
                    <div className="ev-fields">
                        <ReadField label="Type"><Chip>{current.type}</Chip>{current.estimate != null && <Chip>{current.estimate} pt</Chip>}{current.labels.map((l) => <Chip key={l}>{l}</Chip>)}</ReadField>
                        {current.parent && byKey.get(current.parent) && <ReadField label="Parent"><Button size="sm" onClick={() => setSel(current.parent)}>{current.parent} · {byKey.get(current.parent)!.title}</Button></ReadField>}
                        {current.summary && <ReadField label="Summary">{current.summary}</ReadField>}
                        <Field label="Description"><Markdown source={current.description} /></Field>
                        {current.acceptanceCriteria.length > 0 && <Field label="Acceptance criteria"><ul className="po-ac">{current.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul></Field>}
                        {current.dependsOn.length > 0 && <ReadField label="Depends on">{current.dependsOn.map((k) => <Button size="sm" key={k} onClick={() => setSel(k)}>{k} {byKey.get(k)?.title ?? ""}</Button>)}</ReadField>}
                    </div>
                )}
                {tab === "tracker" && issue && <LiveIssue issue={issue} />}
                {tab === "edit" && <TicketEditor key={current.key} t={current} onSave={save} />}
            </div>
        );
    }
    const pendingAll = tickets.filter((t) => !identOf(t));
    const columns: DataColumn<PoTicket>[] = [
        { key: "key", label: "Key", value: (t) => t.key, filter: false },
        { key: "title", label: "Title", kind: "label", value: (t) => t.title, filter: false },
        { key: "type", label: "Type", value: (t) => t.type, filter: "auto", render: (t) => <Chip tone={t.type === "epic" ? "accent" : t.type === "bug" ? "bad" : "neutral"}>{t.type}</Chip> },
        { key: "points", label: "Points", kind: "num", value: (t) => t.estimate ?? null, filter: false, render: (t) => (t.estimate == null ? <span className="po-muted">—</span> : t.estimate) },
        { key: "issue", label: tracker, value: (t) => identOf(t) ?? "Not created", filter: false, render: (t) => (identOf(t) ? <Chip tone="ok">{identOf(t)}</Chip> : <Chip>Not created</Chip>) },
        { key: "status", label: "Status", value: (t) => issueOf(t)?.status ?? "", filter: "auto" },
        { key: "task", label: "Task", value: (t) => taskOf(t)?.stage.replace(/_/g, " ") ?? "None", filter: "auto" },
        { key: "comments", label: "Comments", kind: "num", value: (t) => issueOf(t)?.comments.length ?? 0, filter: false, defaultHidden: true },
        { key: "parent", label: "Parent", value: (t) => t.parent ?? "", filter: false, defaultHidden: true },
    ];
    return (
        <div className="po-stack">
            {d.ticketsError && <Notice tone="bad">tickets.json: {d.ticketsError}</Notice>}
            <DataTable
                embedded
                title="Tickets"
                columns={columns}
                rows={tickets}
                rowKey={(t) => t.key}
                onRowClick={(t) => setSel(t.key)}
                storageKey="po-tickets"
                actions={
                    <>
                        <IssuesRefresh d={d} onError={onError} reload={reload} />
                        {pendingAll.length > 0 && <Button variant="primary" disabled={busy || d.running} title={`Creates the ${pendingAll.length} ticket(s) not in ${tracker} yet`} onClick={() => void createIssues()}>{busy ? "Creating…" : `Create ${pendingAll.length} in ${tracker}`}</Button>}
                    </>
                }
                bulkActions={(rows, clear) => {
                    const toCreate = rows.filter((t) => !identOf(t));
                    const toStart = rows.filter((t) => identOf(t) && !taskOf(t));
                    return (
                        <>
                            {toCreate.length > 0 && <Button size="sm" disabled={busy || d.running} onClick={() => void createIssues(toCreate.map((t) => t.key)).then(clear)}>Create {toCreate.length} in {tracker}</Button>}
                            {toStart.length > 0 && targetPicker}
                            {toStart.length > 0 && <Button size="sm" variant="primary" disabled={busy || !d.po.env_id} onClick={() => void createTasks(toStart.map((t) => identOf(t)!)).then(clear)}>Create {toStart.length} task{toStart.length === 1 ? "" : "s"}{envName ? ` in ${envName}` : ""}</Button>}
                        </>
                    );
                }}
            />
        </div>
    );
};
