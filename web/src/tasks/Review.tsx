import { useEffect, useState } from "react";
import { Button, Checkbox, Chip, IconButton, Select } from "@vortex/ds";
import { api, STAGE_LABEL, STAGE_ORDER, stageOf, type LineComment, type QuestionRound, type Review, type Stage, type TaskDetail } from "../api";
import { AgentInput, FileChips, usePendingFiles } from "../AgentInput";
import { useDraftComments } from "../DiffView";
import { Modal } from "../components/Modal";
import { Panel } from "../components/Panel";
import { ReviewHistory } from "./PrComments";
import { DESIGN_DOC, pickedOf } from "./Design";
import "./workspace.css";

type Act = (fn: () => Promise<unknown>) => Promise<void>;

// The human's side of a review stage: the notes, the line comments drafted in the diff, the proposal comments and the
// Product owner's picked comments that go along, and the two verdicts. One instance per task view, so the header's
// primary button and the review panel on the Work tab approve the very same thing.
export const useReview = (detail: TaskDetail, onAction: Act) => {
    const { task } = detail;
    const [notes, setNotes] = useState("");
    const [routeTo, setRouteTo] = useState<"implementation" | "design_proposal">("implementation");
    // User Review only: skip the browser QA stages on the way back this once (the human QA's by hand).
    const [skipQa, setSkipQa] = useState(false);
    const attach = usePendingFiles();
    const [comments, changeComment, clearComments] = useDraftComments(task.id);
    const pending = Object.entries(comments);
    const canComment = task.status === "waiting_user" && task.stage === "user_review";
    // Design Proposal: comments on (and questions about) passages of design.md, plus the Product Owner's picked review comments, go
    // into ONE Request changes round. The comments are drafts of the same store the diff uses, told apart by their path.
    const canCommentDesign = task.status === "waiting_user" && task.stage === "design_proposal";
    const designPending = pending.filter(([, c]) => c.path === DESIGN_DOC);
    const [poPicked, setPoPicked] = useState(0);
    // Request changes pressed while nothing says what should change: the notes box shows the error until the human types.
    const [triedChanges, setTriedChanges] = useState(false);
    useEffect(() => {
        if (task.stage !== "design_proposal" || !task.product_owner_id) return setPoPicked(0);
        void api.poReview(task.id).then((r) => setPoPicked(pickedOf(r))).catch(() => undefined);
    }, [task.id, task.stage, task.product_owner_id, task.updated_at]);
    // At a PR stage, Code-changes line comments go to a PR-fix round of their own (the box above the diff).
    const canCommentPr = task.status !== "running" && ["pr_waiting", "pr_fix", "pr_green", "pr_approved"].includes(task.stage);
    const changesCount = canComment ? pending.length : canCommentDesign ? designPending.length + poPicked : 0;
    const canRequestChanges = !!notes.trim() || attach.files.length > 0 || (canComment && pending.length > 0) || (canCommentDesign && (designPending.length > 0 || poPicked > 0));

    const approve = (): Promise<void> =>
        onAction(async () => {
            const files = await api.uploadFiles(task.id, attach.files);
            await api.review(task.id, { verdict: "approve", ...(notes ? { notes } : {}), ...(files.length ? { files } : {}) });
            clearComments();
            setNotes("");
            attach.clear();
        });
    const requestChanges = (): Promise<void> => {
        if (!canRequestChanges) { setTriedChanges(true); return Promise.resolve(); }
        return onAction(async () => {
            const files = await api.uploadFiles(task.id, attach.files);
            await api.review(task.id, {
                verdict: "changes",
                ...(notes.trim() ? { notes } : {}),
                ...(files.length ? { files } : {}),
                ...(task.stage === "user_review" ? { routeTo, comments: pending.map(([, c]) => c), ...(skipQa ? { skipQa: true } : {}) } : {}),
                ...(task.stage === "design_proposal" ? { comments: designPending.map(([, c]) => c), ...(poPicked > 0 ? { includePoReview: true } : {}) } : {}),
            });
            clearComments();
            setPoPicked(0);
            setNotes("");
            attach.clear();
        });
    };
    return { notes, setNotes: (v: string) => { setNotes(v); setTriedChanges(false); }, notesError: triedChanges && !canRequestChanges, routeTo, setRouteTo, skipQa, setSkipQa, attach, comments, changeComment, clearComments, pending, canComment, canCommentDesign, canCommentPr, designPending, poPicked, setPoPicked, changesCount, canRequestChanges, approve, requestChanges };
};
export type ReviewState = ReturnType<typeof useReview>;

// The draft line comments waiting to be sent, each removable.
export const DraftList = ({ pending, onRemove }: { pending: Array<[string, LineComment]>; onRemove: (key: string) => void }) => (
    <ul className="draft-list">
        {pending.map(([k, c]) => (
            <li key={k}>
                <code>{c.path}:{c.line}</code>
                <span>{c.text}</span>
                <IconButton icon="close" label="Remove this comment" variant="ghost" onClick={() => onRemove(k)} />
            </li>
        ))}
    </ul>
);

// "Your call": notes, what goes along, Approve / Request changes. The header carries the same Approve.
export const ReviewPanel = ({ task, reviews, rv, onOpenCode }: { task: TaskDetail["task"]; reviews: Review[]; rv: ReviewState; onOpenCode: () => void }) => (
    <Panel title={`${STAGE_LABEL[task.stage]}: your call`} tone="wait" className="review-panel">
        {task.stage === "user_review" && (
            <div className="review-options">
                <label className="inline-field">On changes, send back to
                    <Select value={rv.routeTo} onChange={(e) => rv.setRouteTo(e.target.value as typeof rv.routeTo)}>
                        <option value="implementation">Implementation</option>
                        <option value="design_proposal">Design proposal</option>
                    </Select>
                </label>
                <Checkbox checked={rv.skipQa} onChange={(e) => rv.setSkipQa(e.target.checked)} label="Skip manual QA on the way back (you QA by hand)" />
            </div>
        )}
        {rv.canCommentDesign && (
            <p className="quiet">
                One round for everything: {rv.designPending.length} comment{rv.designPending.length === 1 ? "" : "s"} on the proposal (select text in Proposal), {rv.poPicked} picked Product owner comment{rv.poPicked === 1 ? "" : "s"}, and the note below.
            </p>
        )}
        <AgentInput placeholder={rv.canComment ? "General comments (optional if you left line comments in Code)" : "Notes for the agent (required for Request changes)"} value={rv.notes} onChange={rv.setNotes} pending={rv.attach} fieldError={rv.notesError ? "Required to request changes" : undefined} />
        {rv.canComment && rv.pending.length > 0 && (
            <div className="pending-comments">
                <b>{rv.pending.length} line comment{rv.pending.length === 1 ? "" : "s"} to send</b>
                <DraftList pending={rv.pending} onRemove={(k) => rv.changeComment(k, null)} />
            </div>
        )}
        <div className="actions">
            <Button variant="primary" onClick={() => void rv.approve()}>{task.stage === "pr_fix" ? "Approve and push" : "Approve"}</Button>
            <Button onClick={() => void rv.requestChanges()}>Request changes{rv.changesCount > 0 ? ` (${rv.changesCount})` : ""}</Button>
            {task.stage === "user_review" && <Button variant="ghost" onClick={onOpenCode}>Comment on lines in Code</Button>}
        </div>
        <ReviewHistory reviews={reviews} stage={task.stage} />
    </Panel>
);

// Stages a task can be sent back to with notes (from any non-running state, e.g. after an accidental Approve).
const RETURNABLE: Stage[] = ["design_proposal", "implementation", "user_review", "pr_creation_review"];

export const ReturnDialog = ({ task, pending, onSend, onClose }: { task: TaskDetail["task"]; pending: LineComment[]; onSend: (stage: Stage, notes: string, withComments: boolean, skipQa: boolean, files: File[]) => Promise<void>; onClose: () => void }) => {
    const idx = STAGE_ORDER.indexOf(stageOf(task.stage));
    const options = RETURNABLE.filter((s) => STAGE_ORDER.indexOf(s) <= idx);
    const [stage, setStage] = useState<Stage>(options[options.length - 1] ?? "design_proposal");
    const [notes, setNotes] = useState("");
    const [skipQa, setSkipQa] = useState(false);
    const attach = usePendingFiles();
    const [tried, setTried] = useState(false);
    if (options.length === 0) return null;
    const runs = stage !== "user_review";
    // Returning to a stage before User Review means the QA stages would run again on the way back; offer to skip them once.
    const qaAhead = runs && STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf("user_review");
    const withComments = stage === "implementation" && pending.length > 0;
    const blocked = runs && !notes.trim() && attach.files.length === 0 && !withComments;
    const send = (): void => { if (blocked) { setTried(true); return; } void onSend(stage, notes, stage === "implementation", qaAhead && skipQa, attach.files); };
    return (
        <Modal
            title="Return to a stage"
            onClose={onClose}
            footer={
                <>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="primary" onClick={send}>Send back to {STAGE_LABEL[stage]}</Button>
                </>
            }
        >
            <div className="dialog-form">
                <label className="inline-field">Return to
                    <Select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
                        {options.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}{s === task.stage ? " (current)" : ""}</option>)}
                    </Select>
                </label>
                <p className="quiet">{runs ? `${STAGE_LABEL[stage]} runs again with your notes as reviewer notes, then the later stages run again.` : "User review waits for you again; no agent runs."}</p>
                <AgentInput placeholder={runs ? "What should change (required)" : "Notes for yourself (optional)"} value={notes} onChange={(v) => { setNotes(v); setTried(false); }} pending={attach} fieldError={tried && blocked ? "Required to request changes" : undefined} />
                {withComments && <p className="quiet">{pending.length} draft line comment{pending.length === 1 ? "" : "s"} from Code go along.</p>}
                {qaAhead && <Checkbox checked={skipQa} onChange={(e) => setSkipQa(e.target.checked)} label={`Skip manual QA this pass: go straight to user review after ${STAGE_LABEL[stage === "design_proposal" ? "implementation" : stage]}`} />}
            </div>
        </Modal>
    );
};

// The agent stopped mid-stage to ask: one answer per question (an option click fills it, free text overrides), then the
// stage resumes in the same session with the answers. Sending with blanks lets the agent decide those itself.
// Files (a screenshot, an export) can go with the answers: pasted or dropped on any answer box, or attached.
export const QuestionsPanel = ({ round, onSend }: { round: QuestionRound; onSend: (answers: Record<string, string>, files: File[]) => Promise<void> }) => {
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [sending, setSending] = useState(false);
    const pending = usePendingFiles();
    useEffect(() => setAnswers({}), [round.id]);
    const set = (id: string, text: string) => setAnswers((a) => ({ ...a, [id]: text }));
    const answered = round.questions.filter((q) => answers[q.id]?.trim()).length;
    const send = () => { setSending(true); void onSend(answers, pending.files).then(() => pending.clear()).finally(() => setSending(false)); };
    return (
        <Panel
            title={`${STAGE_LABEL[round.stage]}: the agent has ${round.questions.length === 1 ? "a question" : `${round.questions.length} questions`}`}
            hint="It stopped at this point. Your answers go back into the same session and the stage continues. A blank answer means you decide."
            tone="warn"
            className="questions-panel"
        >
            {round.questions.map((q, i) => (
                <div key={q.id} className="question">
                    <div className="question-text"><Chip tone="accent">{i + 1}</Chip> {q.text}</div>
                    {q.context && <div className="question-context">{q.context}</div>}
                    {q.options.length > 0 && (
                        <div className="question-options">
                            {q.options.map((o) => <Button key={o} size="sm" on={answers[q.id] === o} aria-pressed={answers[q.id] === o} onClick={() => set(q.id, answers[q.id] === o ? "" : o)}>{o}</Button>)}
                        </div>
                    )}
                    <AgentInput value={answers[q.id] ?? ""} onChange={(v) => set(q.id, v)} pending={pending} chips="none" placeholder={q.options.length ? "Pick an option above or write your own answer" : "Your answer"} className="answer-input" />
                </div>
            ))}
            <FileChips pending={pending} disabled={sending} />
            <div className="actions">
                <Button variant="primary" disabled={sending || (answered === 0 && pending.files.length === 0)} onClick={send}>{sending ? "Sending…" : `Send answers${answered < round.questions.length ? ` (${answered}/${round.questions.length})` : ""}`}</Button>
                <Button disabled={sending} onClick={() => { if (confirm("Let the agent decide every unanswered question itself and continue?")) send(); }}>Let the agent decide</Button>
            </div>
        </Panel>
    );
};
