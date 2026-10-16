import { useMemo } from "react";
import { Button, Chip, EmptyState } from "@vortex/ds";
import { api, STAGE_LABEL, STAGE_ORDER, stageOf, type MessageAnchor, type ProductOwner, type Stage, type TaskDetail } from "../api";
import { KeyValue } from "../components/KeyValue";
import { Panel } from "../components/Panel";
import { threadMessages } from "../components/LineThread";
import { Markdown } from "../Markdown";
import type { DesignSection } from "../routes";
import { DesignTabs } from "./Design";
import { QaEvidence } from "./Qa";
import type { ReviewState } from "./Review";
import { Sub } from "./common";
import { ReviewHistory } from "./PrComments";
import "./workspace.css";

type Act = (fn: () => Promise<unknown>) => Promise<void>;

// A stage the agent can run again (its previous output is archived).
export const RERUNNABLE: ReadonlySet<Stage> = new Set(["research", "design_proposal", "qa_baseline", "implementation", "code_review", "manual_qa", "pr_creation_review", "pr_fix"]);
export const PR_STAGES: ReadonlySet<Stage> = new Set(["pr_waiting", "pr_fix", "pr_green", "pr_approved", "done"]);

const classTone = (c: string) => (c === "bug" ? "bad" : "accent");

// The one panel of the stage being looked at: what the agent produced there and, when it is waiting for you, what is asked.
export const StepPanel = ({ detail, step, researchMd, designMd, owners, rv, section, onSection, onTab, onAction, onError }: {
    detail: TaskDetail;
    step: Stage;
    researchMd: string | null;
    designMd: string | null;
    owners: ProductOwner[];
    rv: ReviewState;
    section: DesignSection | undefined;
    onSection: (s: DesignSection) => void;
    onTab: (tab: "code" | "pr" | "conversation") => void;
    onAction: Act;
    onError: (m: string) => void;
}) => {
    const { task, research, design, impl, review, qaBefore, qaAfter } = detail;
    const rerun = RERUNNABLE.has(step) && task.status !== "running" ? (
        <Button size="sm" variant="ghost" title={`Run ${STAGE_LABEL[step]} again; its previous output is archived and the later stages run after it`} onClick={() => { if (confirm(`Re-run ${STAGE_LABEL[step]}? Later stages will run again after it.`)) void onAction(() => api.rerun(task.id, step)); }}>Re-run</Button>
    ) : undefined;

    switch (step) {
        case "research":
            return research ? (
                <Panel title="Research" badge={<Chip tone={classTone(research.classification)}>{research.classification}</Chip>} actions={rerun}>
                    <KeyValue items={[{ label: "Summary", value: research.summary }, { label: "Branch", value: research.branchName, mono: true }, { label: "Areas", value: (research.affectedAreas ?? []).join(", ") || "None named" }]} />
                    {researchMd && <Sub title="research.md" open={false}><Markdown source={researchMd} /></Sub>}
                </Panel>
            ) : <EmptyState icon="inbox" title="No research yet" />;
        case "design_proposal":
            return design ? (
                <>
                    <Panel title="Design proposal" badge={<><Chip tone={classTone(design.classification)}>{design.classification}</Chip>{(design.affectedRepos ?? []).map((r) => <Chip key={r}>{r}</Chip>)}</>} actions={rerun}>
                        <DesignTabs
                            annot={{ comments: rv.comments, threads: threadMessages(detail.messages ?? []), canComment: rv.canCommentDesign, canAsk: task.status !== "running", onChange: rv.changeComment, onAsk: (anchor: MessageAnchor, text: string, files: File[]) => onAction(async () => { await api.sendMessage(task.id, text, anchor, await api.uploadFiles(task.id, files)); }) }}
                            onPicked={rv.setPoPicked}
                            task={task}
                            owner={owners.find((o) => o.id === task.product_owner_id) ?? null}
                            design={design}
                            md={designMd}
                            before={qaBefore}
                            section={section}
                            onSection={onSection}
                            onAction={onAction}
                            onError={onError}
                        />
                    </Panel>
                </>
            ) : <EmptyState icon="inbox" title="No design yet" />;
        case "qa_baseline":
        case "manual_qa":
            return design && (qaBefore || qaAfter) ? (
                <QaEvidence task={task} design={design} before={qaBefore} after={qaAfter} history={detail.qaHistory ?? []} currentIdx={STAGE_ORDER.indexOf(stageOf(task.stage))} onAction={onAction} />
            ) : <EmptyState icon="inbox" title="No QA evidence yet" />;
        case "code_review":
            return review ? (
                <Panel
                    title="Code review"
                    hint="The pre-landing checklist applied by a fresh session. Fixed findings are committed on the branch, open ones are yours to judge, suppressed ones are low-confidence and kept for calibration."
                    badge={<><Chip tone={review.findings.some((f) => f.status === "open" && (f.severity === "P0" || f.severity === "P1")) ? "bad" : "ok"}>{review.findings.filter((f) => f.status === "open").length} open</Chip><Chip>{review.findings.filter((f) => f.status === "fixed").length} fixed</Chip></>}
                    actions={rerun}
                >
                    <p>{review.summary}</p>
                    {(["open", "fixed", "suppressed"] as const).map((st) => {
                        const rows = review.findings.filter((f) => f.status === st);
                        if (!rows.length) return null;
                        return (
                            <Sub key={st} title={`${st === "open" ? "Open" : st === "fixed" ? "Fixed" : "Suppressed (low confidence)"} (${rows.length})`} open={st !== "suppressed"}>
                                {rows.map((f) => (
                                    <div key={f.id} className="finding">
                                        <div className="finding-head">
                                            <Chip tone={f.severity === "P0" || f.severity === "P1" ? "bad" : f.severity === "P2" ? "warn" : "neutral"}>{f.severity}</Chip>
                                            <span className="field-hint">{f.confidence}/10</span>
                                            <b>{f.title}</b>
                                            <code>{f.file}{f.line ? `:${f.line}` : ""}</code>
                                            {f.category && <Chip>{f.category}</Chip>}
                                            {f.commit && <code>{f.commit.slice(0, 7)}</code>}
                                        </div>
                                        {f.detail && <p>{f.detail}</p>}
                                        {f.quote && <pre className="finding-quote">{f.quote}</pre>}
                                    </div>
                                ))}
                            </Sub>
                        );
                    })}
                </Panel>
            ) : <EmptyState icon="inbox" title="No review yet" />;
        case "implementation":
            // impl.json can be partial while Implementation is still running (the agent writes notes first): never assume a field.
            return impl ? (
                <Panel
                    title="Implementation"
                    badge={impl.gates ? <Chip tone={impl.gates.tests && impl.gates.typecheck ? "ok" : "bad"}>tests {impl.gates.tests ? "pass" : "fail"}, typecheck {impl.gates.typecheck ? "pass" : "fail"}</Chip> : <Chip tone="wait">in progress</Chip>}
                    actions={<>{rerun}<Button size="sm" onClick={() => onTab("code")}>Open the code changes</Button></>}
                >
                    <KeyValue
                        columns={2}
                        items={[
                            { label: "New-line coverage", value: `${impl.coverageNewLines ?? "—"}%` },
                            { label: "Backend tests", value: impl.tests?.backend ?? "—" },
                            { label: "Frontend tests", value: impl.tests?.frontend ?? "—" },
                        ]}
                    />
                    <Sub title={`Commits (${impl.commits?.length ?? 0})`} open={!!impl.commits?.length}>
                        {impl.commits?.length ? <ul className="plain mono-list">{impl.commits.map((c) => <li key={c}><code>{c}</code></li>)}</ul> : <p className="quiet">None, the changes are uncommitted.</p>}
                    </Sub>
                    {(impl.files ?? []).length > 0 && (
                        <Sub title={`Files (${impl.files!.length})`} open={false}>
                            <ul className="plain mono-list">{impl.files!.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
                        </Sub>
                    )}
                    {impl.notes && <Sub title="Notes from the implementer" open={false}><Markdown source={impl.notes} /></Sub>}
                </Panel>
            ) : <EmptyState icon="inbox" title="No implementation yet" />;
        case "user_review":
            if (task.stage === "user_review" && task.status === "waiting_user") return null;
            return (
                <Panel title="Your review" actions={<Button size="sm" onClick={() => onTab("conversation")}>Open conversation</Button>}>
                    {detail.reviews.some((r) => r.stage === "user_review") ? <ReviewHistory reviews={detail.reviews} stage="user_review" /> : <p className="quiet">No review rounds yet.</p>}
                </Panel>
            );
        default:
            return (
                <Panel title="Pull request" actions={<Button size="sm" onClick={() => onTab("pr")}>Open the pull request</Button>}>
                    <p>{STAGE_LABEL[task.stage]}. The pull request is tracked on its own tab.</p>
                </Panel>
            );
    }
};
