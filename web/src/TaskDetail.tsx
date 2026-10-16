import { useEffect, useState } from "react";
import { Badge, Button, Chip, EmptyState, Icon, MenuItem, Notice, Select, Tab, TabList, Tabs } from "@vortex/ds";
import { api, baseLabel, checkOutcome, envRepos, isApprovalGateCheck, labelsOf, parseChecks, pendingQuestions, poEnvIds, prRepos, prStateOf, repoColorClass, repoName, STAGE_LABEL, STAGE_ORDER, stageOf, taskLabel, type Account, type Env, type PrComment, type PrComments, type ProductOwner, type Stage, type TaskDetail } from "./api";
import { anchorOf } from "./api";
import { LabelChips, LabelEditor } from "./Labels";
import { LazyTerminal } from "./LazyTerminal";
import type { ConversationSub, DetailsPart, DesignSection, TaskTab, TaskView } from "./routes";
import { Chat } from "./Chat";
import { DiffView, type PriorComment } from "./DiffView";
import { ServicesPanel } from "./Services";
import { TaskCost } from "./TaskCost";
import { AgentInput } from "./AgentInput";
import { DataTable, type DataColumn } from "./components/DataTable";
import { Field, ReadField } from "./components/EntityView";
import { MoreMenu } from "./components/MoreMenu";
import { PageHeader } from "./components/PageHeader";
import { Panel } from "./components/Panel";
import { StageProgress, TaskStatusChip, taskState } from "./components/status";
import { CiAutopilotCard, BaseChecks, mergePr, PrDraftTabs, PrFixReplies, PrJobsCard, PrPanel, PrSummaryChips, storedMergeMethod, TaskDbPanel, usePrPicks, pickKey } from "./tasks/Pr";
import { parseComments, PrCommentList, ReviewHistory } from "./tasks/PrComments";
import { DraftList, QuestionsPanel, ReturnDialog, ReviewPanel, useReview } from "./tasks/Review";
import { NotesCard, PoBriefCard, TicketView } from "./tasks/Ticket";
import { PR_STAGES, StepPanel } from "./tasks/WorkTab";
import { Linkified, RunStatusChip, useArtifactText } from "./tasks/common";
import { Markdown } from "./Markdown";
import "./tasks/workspace.css";

export type Tab = TaskTab;

interface Props {
    detail: TaskDetail;
    accounts: Account[];
    env: Env | undefined;
    onError: (m: string) => void;
    feed: string[];
    terminal: string | null;
    onAction: (fn: () => Promise<unknown>) => Promise<void>;
    // What the task view shows (tab, step, section, repository, diff scope) is routed — part of the URL hash — so a
    // reload lands on the same view and a link names it; every view change goes through onView.
    view: TaskView;
    onView: (v: TaskView) => void;
    onOpenTerminal: () => Promise<void>;
    onCloseTerminal: () => void;
    // Back to the list the task was opened from, and that list's name for the breadcrumb.
    onClose: () => void;
    listLabel: string;
}

const CONVERSATION_SUBS: Array<{ key: "chat" | ConversationSub; label: string }> = [
    { key: "chat", label: "Agent chat" },
    { key: "user", label: "Your comments" },
    { key: "pr", label: "PR comments" },
    { key: "automation", label: "Automation" },
];

type Run = TaskDetail["runs"][number];

// The task workspace (docs/ux-redesign.md §4.3): the header carries the state and the one primary action, rarer actions
// sit behind the ⋯ menu, and five tabs hold the work: Work (the stage in front of you), Code, Pull request,
// Conversation, Details.
export const TaskDetailView = ({ detail, accounts, env, onError, feed, terminal, onAction, view, onView, onOpenTerminal, onCloseTerminal, onClose, listLabel }: Props) => {
    const { task, runs, design, qaBefore, qaAfter, pr, prFix, research } = detail;
    const review = detail.review ?? null;
    const tab = view.tab;
    const setTab = (t: Tab) => onView({ tab: t });
    const has = (p: string) => detail.artifacts.some((a) => a.path === p);
    const researchMd = useArtifactText(task.id, "research.md", has("research.md"));
    const designMd = useArtifactText(task.id, "design.md", has("design.md"));
    const rv = useReview(detail, onAction);
    const { comments, pending } = rv;
    const [returning, setReturning] = useState(false);
    const [localNotes, setLocalNotes] = useState("");
    // Product Owners, for the Setup part and the Product owner review.
    const [owners, setOwners] = useState<ProductOwner[]>([]);
    useEffect(() => { void api.productOwners().then(setOwners).catch(() => setOwners([])); }, [task.id]);
    const currentIdx = STAGE_ORDER.indexOf(stageOf(task.stage));
    // QA stages that will not run: no browser scenarios in the design, or the human asked to skip QA this pass.
    const skipped = new Set<Stage>(design && design.qa.length === 0 ? ["manual_qa"] : task.skip_qa ? ["manual_qa"] : []);
    // Waiting on answers to the agent's questions is not a review: the review panel stays hidden until they are sent.
    const asking = pendingQuestions(detail);
    const waiting = task.status === "waiting_user" && !asking;
    const state = taskState(task);

    // GitHub PR comments (humans + automation), loaded when a tab needs them; line comments are also shown inline in the diff.
    const sub: "chat" | ConversationSub = tab === "conversation" ? view.sub ?? "chat" : "chat";
    const setSub = (s: "chat" | ConversationSub) => onView({ tab: "conversation", ...(s !== "chat" ? { sub: s } : {}), ...(tab === "conversation" && view.repo ? { repo: view.repo } : {}) });
    const [prPicks, setPrPicks] = usePrPicks(task.id);
    // Which repository's PR the comments look at (multi-repo tasks have one PR per repository).
    const prdRepos = (detail.prStates ?? []).filter((r) => r.number).map((r) => r.repo);
    const ghRepoRaw = tab === "conversation" ? view.repo ?? null : null;
    const ghRepo = ghRepoRaw !== null && prdRepos.includes(ghRepoRaw) ? ghRepoRaw : (prdRepos[0] ?? null);
    const setGhRepo = (repo: string) => onView({ tab: "conversation", ...(sub !== "chat" ? { sub } : {}), repo });
    // This repository's picks (ids) out of the task's shared set.
    const selectedComments = new Set([...prPicks].filter((k) => k.startsWith(`${ghRepo ?? ""}:`)).map((k) => Number(k.slice((ghRepo ?? "").length + 1))));
    const toggleComment = (id: number) => {
        const next = new Set(prPicks);
        const k = pickKey(ghRepo ?? "", id);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        setPrPicks(next);
    };
    const clearPicks = (): void => setPrPicks(new Set([...prPicks].filter((k) => !k.startsWith(`${ghRepo ?? ""}:`))));
    const ghRow = ghRepo !== null ? prStateOf(detail, ghRepo) : undefined;
    const [gh, setGh] = useState<PrComments | null>(null);
    const [ghLoading, setGhLoading] = useState(false);
    const [ghError, setGhError] = useState<string | null>(null);
    const loadGh = async () => {
        if (ghRepo === null) return;
        setGhLoading(true);
        setGhError(null);
        try {
            setGh(await api.prComments(task.id, ghRepo));
        } catch (e) {
            setGhError(String((e as Error).message ?? e));
        } finally {
            setGhLoading(false);
        }
    };
    useEffect(() => {
        setGh(null);
        if ((tab === "conversation" || tab === "code") && ghRepo !== null) void loadGh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task.id, tab, ghRepo, ghRow?.number]);
    const prior: PriorComment[] = [
        ...detail.reviews
            .filter((r) => r.stage === "user_review" && r.verdict === "changes")
            .flatMap((r, i) => parseComments(r).map((c) => ({ ...c, round: i + 1 }))),
        ...(gh ? [...gh.human, ...gh.automation] : [])
            .filter((c): c is Extract<PrComment, { kind: "line" }> => c.kind === "line" && c.line !== null)
            .map((c) => ({ path: c.path, line: c.line ?? 0, side: c.side, snippet: c.snippet, text: c.body, round: 0, by: c.author, resolved: c.resolved })),
    ];

    // Which workflow steps have something to show (or are the current one).
    const stepHasContent = (s: Stage): boolean => {
        switch (s) {
            case "research": return !!research;
            case "design_proposal": return !!design;
            case "qa_baseline": return !!qaBefore;
            case "implementation": return !!detail.impl;
            case "code_review": return !!review;
            case "manual_qa": return !!qaAfter;
            case "user_review": return detail.reviews.some((r) => r.stage === "user_review") || task.stage === "user_review";
            default: return false;
        }
    };
    // PR stages (draft review through merge) live on their own tab, not as a Work step. The QA baseline is part of the
    // design proposal (it runs inside that stage, and Manual QA shows it next to the after-state), so it is no step of its own.
    const steps = STAGE_ORDER.filter((s, i) => i <= currentIdx && s !== "qa_baseline" && !skipped.has(s) && s !== "pr_creation_review" && !PR_STAGES.has(s) && (stepHasContent(s) || s === stageOf(task.stage)));
    // The Work step shown: the routed one when it is a step of this task, else the current stage.
    const step: Stage = tab === "work" && view.step && steps.includes(view.step) ? view.step : stageOf(task.stage);
    const stepIsCurrent = stageOf(step) === stageOf(task.stage);
    const setStep = (s: Stage) => onView({ tab: "work", step: s });
    const section: DesignSection | undefined = tab === "work" && view.step === "design_proposal" ? view.section : undefined;

    // "Rebase onto latest base": from the menu and from the Code changes base-drift banner. Every repository by default;
    // `repos` narrows it to the ticked ones (multi-repo envs).
    const startRebase = (repos?: string[]) => {
        const base = baseLabel(task, env) ?? env?.base_branch ?? "the base branch";
        const scope = repos?.length ? ` (${repos.map(repoName).join(", ")} only)` : "";
        if (confirm(`Rebase ${task.branch}${scope} onto the latest base (${base})?\n\nA plain git rebase first; the agent resolves conflicts and re-runs checks only where needed. If the branch is on GitHub and this env allows pushes, Vortex force-pushes it afterwards (with lease).`)) void onAction(() => api.rebase(task.id, repos));
    };
    const envRepoList = envRepos(env);
    const prFocusRepo = tab === "pr" ? view.repo ?? null : null;
    const setPrFocusRepo = (repo: string) => onView({ tab: "pr", repo });
    const openPrTab = (repo?: string) => onView({ tab: "pr", ...(repo ? { repo } : {}) });
    const openPrs = (detail.prStates ?? []).filter((r) => r.number && !r.merged_at && r.state !== "CLOSED" && r.state !== "MERGED");

    // The one primary action of the state, in the header.
    const primary = (() => {
        if (task.status === "running") return <Button variant="danger" onClick={() => onAction(() => api.stop(task.id))}>Stop</Button>;
        if (asking && task.status === "waiting_user") return <Button variant="primary" onClick={() => onView({ tab: "work" })}>Answer the questions</Button>;
        if (waiting && task.stage === "pr_creation_review") return <Button variant="primary" onClick={() => openPrTab()}>Review the PR drafts</Button>;
        if (waiting && task.stage !== "implementation") return <Button variant="primary" onClick={() => void rv.approve()}>{task.stage === "pr_fix" ? "Approve and push" : "Approve"}</Button>;
        if (task.status === "failed" || task.status === "stopped" || task.status === "blocked") return <Button variant="primary" onClick={() => onAction(() => api.retry(task.id))}>{task.status === "blocked" ? "Re-run stage" : "Retry stage"}</Button>;
        if (PR_STAGES.has(stageOf(task.stage)) && openPrs.length === 1 && task.status !== "rate_limited") {
            const row = openPrs[0]!;
            return <Button variant="primary" onClick={() => mergePr(task, row, storedMergeMethod(), true, onAction)}>Merge</Button>;
        }
        if (PR_STAGES.has(stageOf(task.stage)) && openPrs.length > 1) return <Button variant="primary" onClick={() => openPrTab()}>Open the pull requests</Button>;
        return null;
    })();

    const cleanUp = () => {
        if (!confirm(`Clean up ${task.ticket_id}? BE/FE stop, the worktree and local branch ${task.branch ?? ""} are removed. Pushed commits and the PR are untouched.`)) return;
        void onAction(async () => {
            try {
                await api.cleanup(task.id);
            } catch (e) {
                const msg = String((e as Error).message ?? e);
                if (/nowhere else/.test(msg) && confirm(`${msg}\n\nDiscard them and clean up anyway?`)) await api.cleanup(task.id, true);
                else throw e;
            }
        });
    };
    const deleteTask = () => {
        if (!confirm(`Delete task ${task.ticket_id}? This cleans up (BE/FE, Chrome tabs, worktree, local branch) the same way "Clean up" does, then removes the task itself. The PR (if any) stays on GitHub.`)) return;
        void onAction(async () => {
            try {
                await api.deleteTask(task.id);
            } catch (e) {
                const msg = String((e as Error).message ?? e);
                if (/nowhere else/.test(msg) && confirm(`${msg}\n\nDiscard them and delete anyway?`)) await api.deleteTask(task.id, false, true);
                else throw e;
            }
        });
    };
    const idle = task.status !== "running";
    const menu = (
        <MoreMenu label="More task actions">
            {idle && task.stage === "manual_qa" && <MenuItem title="Go on to User Review without this Manual QA pass (no after-state evidence). For a pass stuck on the environment; you QA by hand there." onClick={() => onAction(() => api.skipManualQa(task.id))}>Skip manual QA</MenuItem>}
            {idle && !PR_STAGES.has(stageOf(task.stage)) && openPrs.length > 0 && <MenuItem title="The PRs are already open: go back to following them without the rest of this round's stages. The branch must be pushed first." onClick={() => onAction(() => api.followPrs(task.id))}>Back to following the PRs</MenuItem>}
            {idle && currentIdx > 0 && <MenuItem title="Send the task back to an earlier stage with notes (e.g. after an accidental Approve)" onClick={() => setReturning(true)}>Return to a stage…</MenuItem>}
            {idle && task.branch && task.worktree_path && <MenuItem title="A plain git rebase of this task's own commits onto the latest base first; the agent takes over only where that conflicts. If the branch is on GitHub and this environment allows pushes, Vortex force-pushes it with lease and tasks stacked on it are rebased in turn." onClick={() => startRebase()}>Rebase onto the latest base</MenuItem>}
            {idle && task.branch && task.worktree_path && envRepoList.length > 1 && envRepoList.map((r) => <MenuItem key={r} onClick={() => startRebase([r])}>Rebase {repoName(r)} only</MenuItem>)}
            {terminal ? <MenuItem onClick={onCloseTerminal}>Close the terminal</MenuItem> : <MenuItem disabled={!idle} onClick={() => void onOpenTerminal()}>Open a terminal</MenuItem>}
            <MenuItem onClick={() => onAction(() => api.pin(task.id))}>{task.pinned ? "Unpin" : "Pin to the top"}</MenuItem>
            {idle && (task.worktree_path || true) && <hr />}
            {idle && task.worktree_path && <MenuItem title="Stop BE/FE, close their Chrome tabs, run the environment's cleanup command, remove the worktree and local branch; the task and its history stay" onClick={cleanUp}>Clean up the worktree</MenuItem>}
            {idle && <MenuItem danger title="Clean up, then forget this task" onClick={deleteTask}>Delete the task</MenuItem>}
        </MoreMenu>
    );

    // The strip under the header: where the task is, the latest line, the pull requests.
    const rateResume = (() => {
        const at = [...runs].reverse().find((r) => r.resume_at)?.resume_at;
        if (!at || task.status !== "rate_limited") return null;
        const ms = new Date(at).getTime() - Date.now();
        const local = new Date(at).toLocaleString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
        return ms > 0 ? `Resumes by itself at ${local} (in ${Math.ceil(ms / 60000)} min).` : "Resuming…";
    })();
    const failingPrs = (detail.prStates ?? []).filter((r) => r.number && parseChecks(r.checks_json).some((c) => !isApprovalGateCheck(c) && checkOutcome(c) === "fail"));
    // The status line often opens with the stage the strip already names.
    const statusText = (task.status_line ?? "").replace(new RegExp(`^${STAGE_LABEL[task.stage]}\\s*(·|:|-|—)?\\s*`, "i"), "");

    const header = (
        <PageHeader
            title={task.title ?? taskLabel(task)}
            crumbs={[{ label: listLabel, onClick: onClose }, { label: taskLabel(task) }]}
            meta={
                <>
                    <TaskStatusChip task={task} />
                    <LabelChips labels={labelsOf(task)} />
                </>
            }
            actions={<>{primary}{menu}</>}
        >
            <div className="task-strip">
                <span className="task-strip-stage">
                    <StageProgress task={task} />
                    <span>{STAGE_LABEL[task.stage]}</span>
                    <span className="field-hint">step {currentIdx + 1} of {STAGE_ORDER.length}</span>
                </span>
                <PrSummaryChips detail={detail} onOpen={openPrTab} />
                {task.ticket_url && <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.ticket_id} on {task.source}<Icon name="external" /></a>}
            </div>
            {statusText && statusText.toLowerCase() !== state.label.toLowerCase() && <p className="task-status-line" title={statusText}><Linkified text={statusText} /></p>}
            <Tabs
                className="ev-tabs"
                active={tab}
                onChange={(k) => setTab(k as Tab)}
                items={[
                    { key: "work", label: "Work" },
                    { key: "code", label: <>Code{pending.length > 0 && <Badge tone="wait">{pending.length}</Badge>}</> },
                    { key: "pr", label: prRepos(detail).length > 1 ? "Pull requests" : "Pull request" },
                    { key: "conversation", label: <>Conversation{detail.messages?.length ? <Badge>{detail.messages.length}</Badge> : null}</> },
                    { key: "details", label: "Details" },
                ]}
            />
        </PageHeader>
    );

    // ---- Work ----
    const work = (
        <>
            {steps.length > 1 && (
                <TabList variant="pill" aria-label="Stages">
                    {steps.map((s) => (
                        <Tab key={s} active={stageOf(step) === stageOf(s)} onClick={() => setStep(s)}>
                            {STAGE_LABEL[s]}{s === stageOf(task.stage) ? " (now)" : ""}
                        </Tab>
                    ))}
                </TabList>
            )}
            {rv.canCommentDesign || (waiting && task.stage !== "implementation" && task.stage !== "pr_creation_review" && task.stage !== "pr_fix") ? (
                <ReviewPanel task={task} reviews={detail.reviews} rv={rv} onOpenCode={() => setTab("code")} />
            ) : null}
            {asking && task.status === "waiting_user" && (
                <QuestionsPanel round={asking} onSend={(answers, files) => onAction(async () => api.answerQuestions(task.id, asking.id, answers, await api.uploadFiles(task.id, files)))} />
            )}
            {task.status === "running" && stepIsCurrent && (
                <Panel title="Live" badge={<Chip tone="info">running</Chip>}>
                    <div className="feed">{feed.length === 0 ? <div className="k">Waiting for events…</div> : feed.slice(-40).map((l, i) => <div key={i}>{l}</div>)}</div>
                </Panel>
            )}
            <StepPanel
                detail={detail}
                step={step}
                researchMd={researchMd}
                designMd={designMd}
                owners={owners}
                rv={rv}
                section={section}
                onSection={(s) => onView({ tab: "work", step: "design_proposal", section: s })}
                onTab={(t) => setTab(t)}
                onAction={onAction}
                onError={onError}
            />
            {terminal && (
                <Panel title={<>Terminal <code>{terminal}</code></>} actions={<Button size="sm" onClick={onCloseTerminal}>Close</Button>}>
                    <LazyTerminal session={terminal} />
                </Panel>
            )}
            {task.worktree_path && (
                <Panel title="App" hint="This task's BE and FE, started in its worktree.">
                    <ServicesPanel taskId={task.id} env={env} dependencyBranch={task.dependency_branch ?? null} busy={task.status === "running"} onError={onError} onFixStarted={() => void onAction(async () => undefined)} />
                </Panel>
            )}
        </>
    );

    // ---- Code ----
    const code = task.branch && task.worktree_path ? (
        <Panel
            title="Code changes"
            hint={`${rv.canComment ? "Tap a line to leave a review comment (sent from the review panel), or ask the agent about it" : rv.canCommentPr ? "Tap a line to leave a comment for the agent to address in a PR-fix round (nothing is posted to GitHub), or ask the agent about it" : "Tap a line to ask the agent about it"}${task.status === "running" ? ". Questions wait until the current run is over." : ". The answer appears under the line and in the conversation."}`}
            badge={pending.length > 0 ? <Chip tone="wait">{pending.length} comment{pending.length === 1 ? "" : "s"}</Chip> : undefined}
        >
            {rv.canCommentPr && pending.length > 0 && (
                <Notice tone="wait">
                    <b>{pending.length} line comment{pending.length === 1 ? "" : "s"} for the agent.</b> It addresses them, commits locally, and you review the diff before it is pushed.
                    <DraftList pending={pending} onRemove={(k) => rv.changeComment(k, null)} />
                    <AgentInput placeholder="General notes (optional)" value={localNotes} onChange={setLocalNotes} />
                    <div className="actions tight">
                        <Button variant="primary" onClick={() => void onAction(async () => { await api.fixLocalComments(task.id, { ...(localNotes.trim() ? { notes: localNotes } : {}), comments: pending.map(([, c]) => c) }); rv.clearComments(); setLocalNotes(""); })}>
                            Ask the agent to address {pending.length} comment{pending.length === 1 ? "" : "s"}
                        </Button>
                    </div>
                </Notice>
            )}
            <DiffView
                taskId={task.id}
                refreshKey={task.updated_at}
                view={tab === "code" ? { ...(view.repo ? { repo: view.repo } : {}), ...(view.scope ? { scope: view.scope } : {}), ...(view.tests ? { tests: true } : {}) } : {}}
                onView={(v) => onView({ tab: "code", ...v })}
                comments={comments}
                prior={prior}
                canComment={rv.canComment || rv.canCommentPr}
                onChange={rv.changeComment}
                repos={envRepos(env)}
                taskBusy={task.status === "running"}
                onError={onError}
                threads={(detail.messages ?? []).filter((m) => m.anchor && !anchorOf(m)?.prComment)}
                canAsk={task.status !== "running"}
                onAsk={(anchor, text, files) => onAction(async () => api.sendMessage(task.id, text, anchor, await api.uploadFiles(task.id, files)))}
                onRebase={task.branch ? startRebase : undefined}
            />
        </Panel>
    ) : <EmptyState icon="inbox" title="No branch yet">The code changes appear once the implementation has a branch.</EmptyState>;

    // ---- Pull request ----
    const prTab = task.stage === "pr_creation_review" ? (
        <PrDraftTabs detail={detail} onAction={onAction} focusRepo={prFocusRepo} onFocusRepo={setPrFocusRepo} />
    ) : (
        <>
            {task.stage === "pr_fix" && task.status === "waiting_user" && <PrFixReplies taskId={task.id} updatedAt={task.updated_at} />}
            {task.stage === "pr_fix" && waiting && <ReviewPanel task={task} reviews={detail.reviews} rv={rv} onOpenCode={() => setTab("code")} />}
            {task.stage === "pr_fix" && prFix?.summary && (
                <Panel title="Proposed fix" actions={<Button size="sm" onClick={() => setTab("code")}>Review the diff</Button>}>
                    <Markdown source={prFix.summary} />
                </Panel>
            )}
            <PrPanel detail={detail} onAction={onAction} focusRepo={prFocusRepo} onFocusRepo={setPrFocusRepo} />
            <BaseChecks detail={detail} onAction={onAction} />
            {prRepos(detail).length > 0 && <PrJobsCard detail={detail} repos={prRepos(detail)} onAction={onAction} />}
            <CiAutopilotCard task={task} onAction={onAction} />
            {/* A repository whose draft was never approved (the task moved on when another repository's PR opened): still reviewable here. */}
            {(pr?.drafts ?? []).some((d) => !prStateOf(detail, d.repo)?.number) && (
                <>
                    <Notice tone="warn"><b>A pull request is still to be opened.</b> Review and approve the remaining draft below; the task's other PR{prRepos(detail).length > 2 ? "s are" : " is"} unaffected.</Notice>
                    <PrDraftTabs detail={detail} onAction={onAction} focusRepo={(pr?.drafts ?? []).find((d) => !prStateOf(detail, d.repo)?.number)?.repo ?? null} />
                </>
            )}
        </>
    );

    // ---- Conversation ----
    const subLabel = (s: "chat" | ConversationSub, label: string) =>
        s === "pr" && gh ? <>{label}<Badge>{gh.human.length}</Badge></> : s === "automation" && gh ? <>{label}<Badge>{gh.automation.length}</Badge></> : s === "user" && pending.length > 0 ? <>{label}<Badge tone="wait">{pending.length}</Badge></> : label;
    const conversation = (
        <>
            <Tabs variant="pill" active={sub} onChange={(k) => setSub(k as "chat" | ConversationSub)} items={CONVERSATION_SUBS.map((s) => ({ key: s.key, label: subLabel(s.key, s.label) }))} />
            {sub === "chat" && <Chat taskId={task.id} messages={detail.messages ?? []} status={task.status} onSent={async () => onAction(async () => undefined)} onOpenCode={() => setTab("code")} />}
            {sub !== "chat" && prdRepos.length > 1 && sub !== "user" && (
                <TabList variant="pill" className="pr-repo-tabs" aria-label="Repositories">
                    {prdRepos.map((r) => <Tab key={r} active={ghRepo === r} className={`repo-${repoColorClass(r, prdRepos)}`} onClick={() => setGhRepo(r)}>{repoName(r)} <Chip>#{prStateOf(detail, r)?.number}</Chip></Tab>)}
                </TabList>
            )}
            {sub === "user" && (
                <Panel title="Your comments before the PR">
                    {pending.length > 0 && (
                        <div className="pending-comments">
                            <b>Draft line comments</b> ({rv.canCommentPr ? "sent from the box on the Code tab" : "sent with the next Request changes in user review"})
                            <DraftList pending={pending} onRemove={(k) => rv.changeComment(k, null)} />
                        </div>
                    )}
                    <ReviewHistory reviews={detail.reviews} stage="user_review" />
                    {!detail.reviews.some((r) => r.stage === "user_review") && pending.length === 0 && <EmptyState icon="inbox" title="No review comments yet" />}
                </Panel>
            )}
            {(sub === "pr" || sub === "automation") && (
                <>
                    {selectedComments.size > 0 && (
                        <Notice tone="wait">
                            <b>{selectedComments.size} comment{selectedComments.size === 1 ? "" : "s"} picked.</b> The agent addresses just these, commits locally, and you review the diff before it is pushed, with no re-run of QA or user review. To only ask what it thinks of a comment, use Ask agent under that comment.
                            <div className="actions tight">
                                <Button variant="primary" disabled={task.status === "running"} onClick={() => void onAction(async () => { await api.fixComments(task.id, ghRepo ?? "", [...selectedComments]); clearPicks(); })}>Ask the agent to address {selectedComments.size}</Button>
                                <Button onClick={clearPicks}>Clear selection</Button>
                            </div>
                        </Notice>
                    )}
                    <PrCommentList
                        title={`${sub === "pr" ? "Comments" : "Automation comments"} on the ${ghRepo ? repoName(ghRepo) : ""} pull request`}
                        items={gh ? (sub === "pr" ? gh.human : gh.automation) : null}
                        loading={ghLoading}
                        error={ghError}
                        hasPr={!!ghRow?.url}
                        url={ghRow?.url ?? null}
                        fetchedAt={gh?.fetchedAt ?? null}
                        onRefresh={() => void loadGh()}
                        selected={selectedComments}
                        onToggle={toggleComment}
                        repo={ghRepo ?? ""}
                        prNumber={gh?.number ?? null}
                        threads={(detail.messages ?? []).filter((m) => !!anchorOf(m)?.prComment)}
                        canAsk={task.status !== "running"}
                        onAsk={(anchor, text) => onAction(async () => { await api.sendMessage(task.id, text, anchor); })}
                        onResolve={async (id, resolved) => {
                            try {
                                const next = await api.resolvePrComment(task.id, ghRepo ?? "", id, resolved);
                                if (next) setGh(next);
                            } catch (e) {
                                onError(String((e as Error).message ?? e));
                            }
                        }}
                    />
                </>
            )}
        </>
    );

    // ---- Details ----
    const part: "ticket" | DetailsPart = tab === "details" ? view.part ?? "ticket" : "ticket";
    const setPart = (p: "ticket" | DetailsPart) => onView({ tab: "details", ...(p !== "ticket" ? { part: p } : {}) });
    const runColumns: Array<DataColumn<Run>> = [
        { key: "stage", label: "Stage", value: (r) => STAGE_LABEL[r.stage], filter: "auto" },
        { key: "attempt", label: "Attempt", kind: "num", value: (r) => r.attempt },
        { key: "status", label: "Status", value: (r) => r.status, filter: "auto", render: (r) => <RunStatusChip status={r.status} /> },
        { key: "shard", label: "Shard", value: (r) => r.shard ?? "", filter: false, defaultHidden: true },
        { key: "last", label: "Last event", kind: "label", value: (r) => r.error ?? r.last_event ?? "", filter: false, render: (r) => <span className={r.error ? "run-error" : undefined}>{r.error ?? r.last_event ?? ""}</span> },
        { key: "model", label: "Model", value: (r) => r.model ?? "", filter: "auto", defaultHidden: true },
        { key: "turns", label: "Turns", kind: "num", value: (r) => r.num_turns ?? 0 },
        { key: "cost", label: "Cost", kind: "num", value: (r) => r.cost_usd ?? 0, render: (r) => (r.cost_usd ? `$${r.cost_usd.toFixed(2)}` : "") },
    ];
    const details = (
        <>
            <Tabs
                variant="pill"
                active={part}
                onChange={(k) => setPart(k as "ticket" | DetailsPart)}
                items={[
                    { key: "ticket", label: "Ticket and instructions" },
                    { key: "runs", label: <>Runs<Badge>{runs.length}</Badge></> },
                    { key: "cost", label: "Cost" },
                    { key: "setup", label: "Setup" },
                ]}
            />
            {part === "ticket" && (
                <>
                    <NotesCard detail={detail} onSave={(text, files) => onAction(async () => api.patchTask(task.id, { notes: text.trim() || null, files: await api.uploadFiles(task.id, files) }))} />
                    {task.product_owner_id && <PoBriefCard task={task} onError={(m) => void onAction(async () => { throw new Error(m); })} />}
                    <TicketView detail={detail} onFetch={async () => { await api.fetchTicket(task.id); await onAction(async () => undefined); }} />
                </>
            )}
            {part === "runs" && (
                <DataTable
                    embedded
                    title="Runs"
                    columns={runColumns}
                    rows={[...runs].reverse()}
                    rowKey={(r) => r.id}
                    selectable={false}
                    storageKey="task-runs"
                    empty={<EmptyState icon="inbox" title="No runs yet" />}
                />
            )}
            {part === "cost" && <TaskCost taskId={task.id} refreshKey={task.updated_at} />}
            {part === "setup" && (
                <>
                    <Panel title="Task settings">
                        <div className="setup-fields">
                            <Field label="Labels" hint="Free-text labels with a colour; they show on the task in lists.">
                                <LabelEditor labels={labelsOf(task)} onChange={(next) => onAction(() => api.patchTask(task.id, { labels: next }))} />
                            </Field>
                            <Field label="AI account" hint="The account this task's agents run on.">
                                <Select value={task.account_id ?? ""} onChange={(e) => onAction(() => api.setAccount(task.id, e.target.value))}>
                                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                                </Select>
                            </Field>
                            {owners.length > 0 && (
                                <Field label="Product owner" hint="The Product Owner whose project this ticket belongs to: it can review the design proposal.">
                                    <Select value={task.product_owner_id ?? ""} onChange={(e) => onAction(() => api.setTaskProductOwner(task.id, e.target.value || null))}>
                                        <option value="">None</option>
                                        {owners.filter((o) => poEnvIds(o).includes(task.env_id)).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                                    </Select>
                                </Field>
                            )}
                            <ReadField label="Model">{task.model ?? "Default"}</ReadField>
                            <ReadField label="Session"><code>{task.session_id}</code></ReadField>
                            {task.branch && <ReadField label="Branch"><code>{task.branch}</code></ReadField>}
                            <ReadField label="Ticket">{task.ticket_url ? <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.ticket_id} on {task.source}</a> : `${task.ticket_id} (${task.source})`}</ReadField>
                        </div>
                    </Panel>
                    {task.worktree_path && <TaskDbPanel task={task} onAction={onAction} />}
                </>
            )}
        </>
    );

    return (
        <div className="task-workspace">
            {header}
            {detail.onBase && (
                <Notice tone="info">
                    <b>The worktree is on base code for the QA baseline.</b> The baseline records what the app does without this change, so the branch (with its uncommitted work stashed and its migrations rolled back) is switched out for the pass. Code and the dev servers show the base until it ends; then the branch, its stash and its migrations come back.
                </Notice>
            )}
            {task.status === "blocked" && (
                <Notice tone="warn">
                    <b>Blocked.</b> <Linkified text={task.status_line ?? ""} />
                    {failingPrs.length > 0 && (
                        <div className="actions tight">
                            {failingPrs.map((r) => <Button variant="primary" key={r.repo} onClick={() => onAction(() => api.fixCi(task.id, r.repo))}>Fix CI{failingPrs.length > 1 || r.repo ? ` on ${repoName(r.repo)}` : ""}</Button>)}
                            <span className="quiet">The agent proposes a fix and commits it locally. Nothing is pushed until you review the diff and approve.</span>
                        </div>
                    )}
                    {/log ?in/i.test(task.status_line ?? "") && !/waiting for you/.test(task.status_line ?? "") && (
                        <div className="actions tight">
                            <Button variant="primary" onClick={() => onAction(() => api.qaLogin(task.id))}>Log in for QA</Button>
                            <span className="quiet">Opens the app in the QA Chrome profile. You log in there, Vortex watches the tab, then re-runs the stage. No agent, no cost.</span>
                        </div>
                    )}
                    {/Relaunch Chrome for QA/.test(task.status_line ?? "") && (
                        <div className="actions tight">
                            <Button variant="primary" onClick={() => onAction(() => api.relaunchChrome(task.id))}>Relaunch Chrome for QA</Button>
                            <span className="quiet">Quits Chrome and reopens it with the switches that keep a covered window rendering (your tabs restore), then retries this stage. Needed once per Chrome start.</span>
                        </div>
                    )}
                </Notice>
            )}
            {task.status === "rate_limited" && (
                <Notice tone="wait"><b>Rate limited.</b> {task.status_line} {rateResume}</Notice>
            )}
            {state.group === "attention" && task.status === "failed" && task.status_line && <Notice tone="bad">{task.status_line}</Notice>}
            <div className="task-body" role="tabpanel">
                {tab === "work" && work}
                {tab === "code" && code}
                {tab === "pr" && prTab}
                {tab === "conversation" && conversation}
                {tab === "details" && details}
            </div>
            {returning && (
                <ReturnDialog
                    task={task}
                    pending={pending.map(([, c]) => c)}
                    onClose={() => setReturning(false)}
                    onSend={async (stage, text, withComments, skipQa, fileList) => {
                        await onAction(async () => {
                            const files = await api.uploadFiles(task.id, fileList);
                            await api.returnTo(task.id, { stage, ...(text.trim() ? { notes: text } : {}), ...(files.length ? { files } : {}), ...(withComments ? { comments: pending.map(([, c]) => c) } : {}), ...(skipQa ? { skipQa: true } : {}) });
                            if (withComments) rv.clearComments();
                        });
                        setReturning(false);
                    }}
                />
            )}
        </div>
    );
};
