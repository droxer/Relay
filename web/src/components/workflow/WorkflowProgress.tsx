"use client";

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowAttemptResult, WorkflowRun } from "relay-core";
import {
  currentWorkflowAssignment,
  WORKFLOW_RESULT_REASONS,
  workflowBlock,
  workflowQuestion,
  workflowStepName,
  workflowStepStates,
  type WorkflowBlock,
  type WorkflowStepState,
} from "../../lib/workflowRuns";
import { Button } from "../ui/button";
import {
  Dialog, DialogBackdrop, DialogClose, DialogContent, DialogPortal,
  DialogTitle, DialogTrigger, DialogViewport,
} from "../ui/dialog";

const RUN_STATUS_KEY: Record<WorkflowRun["status"], string> = {
  awaiting_approval: "workflow.status_awaiting_approval",
  awaiting_input: "workflow.status_awaiting_input",
  ready: "workflow.status_running",
  blocked: "workflow.status_blocked",
  completed: "workflow.status_completed",
  cancelled: "workflow.status_cancelled",
};

const STEP_STATE_KEY: Record<WorkflowStepState, string> = {
  done: "workflow.step_done",
  current: "workflow.step_running",
  waiting: "workflow.step_waiting",
  blocked: "workflow.step_blocked",
  cancelled: "workflow.step_cancelled",
  pending: "workflow.step_pending",
};

function blockKey(block: WorkflowBlock): [string, Record<string, string>?] {
  switch (block.kind) {
    case "admission": return ["workflow.block_admission", { detail: block.detail }];
    case "interrupted": return ["workflow.block_interrupted"];
    case "rejected": return ["workflow.block_rejected"];
    default: return [`workflow.reason.${block.reason}`];
  }
}

function RecordedTime({ timestamp, lead = "" }: { timestamp?: string; lead?: string }) {
  const { i18n } = useTranslation();
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  return <>{lead}<time dateTime={timestamp}>{new Date(timestamp).toLocaleString(i18n.language || undefined)}</time></>;
}

function AttemptResult({ result }: { result: WorkflowAttemptResult }) {
  const { t } = useTranslation();
  const reason = (WORKFLOW_RESULT_REASONS as readonly string[]).includes(result.reason ?? "")
    ? result.reason : "unknown";
  const outputs = Object.entries(result.outputs);
  return (
    <div className="workflow-timeline-attempt" data-testid="workflow-attempt"
      data-attempt={result.workflowAttempt} data-state={result.status}>
      <p className="workflow-timeline-meta">
        {t("workflow.attempt", { attempt: result.workflowAttempt })}
        {` · ${t(result.status === "succeeded" ? "workflow.step_done"
          : result.status === "question" ? "workflow.step_asked" : "workflow.step_blocked")}`}
        <RecordedTime timestamp={result.timestamp} lead=" · " />
      </p>
      {result.status === "question" && result.question ? <p className="workflow-timeline-reason">{result.question}</p> : null}
      {result.status === "blocked" ? <p className="workflow-timeline-reason">{t(`workflow.reason.${reason}`)}</p> : null}
      {result.note ? <p className="workflow-timeline-reason">{result.note}</p> : null}
      {result.evidence?.length ? <ul className="workflow-timeline-evidence">{result.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
      {outputs.length ? (
        <dl className="workflow-timeline-outputs">
          {outputs.map(([name, value]) => (
            <div key={name} className="workflow-timeline-output">
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

type RunViewProps = {
  run: WorkflowRun;
  agentName: (agentId: string) => string;
};

export function WorkflowRunSummary({ run, agentName }: RunViewProps) {
  const { t } = useTranslation();
  const current = currentWorkflowAssignment(run);
  const done = run.status === "completed" ? run.assignments.length : run.currentIndex;
  const name = typeof run.workflowSnapshot?.name === "string" ? run.workflowSnapshot.name : run.teamSnapshot.name;

  return (
    <div className="workflow-run-summary" data-state={run.status}>
      <div className="workflow-run-overview">
        <strong className="workflow-run-name">{name || t("workflow.section_title")}</strong>
        <span className="workflow-progress-status">{t(RUN_STATUS_KEY[run.status])}</span>
        <span className="workflow-run-count tnum">{t("workflow.progress_position", { done, total: run.assignments.length })}</span>
      </div>
      {current && run.status !== "completed" ? (
        <div className="workflow-run-step">
          <span>{workflowStepName(run, current)}</span>
          <span className="workflow-run-agent">{agentName(current.workOwnerAgentId)}</span>
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowProgress({ run, agentName }: RunViewProps) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const block = workflowBlock(run);
  const reason = block && blockKey(block);
  const question = workflowQuestion(run);

  return (
    <section className="workflow-progress" aria-label={t("workflow.timeline_title")}>
      <WorkflowRunSummary run={run} agentName={agentName} />
      <Dialog>
        <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
          {t("workflow.view_run_details")}
        </DialogTrigger>
        <DialogPortal>
          <DialogBackdrop className="dialog-backdrop" />
          <DialogViewport className="dialog-viewport workflow-run-viewport">
            <DialogContent className="dialog-modal workflow-run-dialog" initialFocus={headingRef}>
              <header className="workflow-run-dialog-header">
                <DialogTitle ref={headingRef} tabIndex={-1} className="dialog-title">
                  {t("workflow.timeline_title")}
                </DialogTitle>
                <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>
                  {t("sheet.close")}
                </DialogClose>
              </header>
              <div className="workflow-run-scroll" tabIndex={0} role="region" aria-label={t("workflow.run_steps")}>
                <div className="workflow-run-dialog-summary">
                  <WorkflowRunSummary run={run} agentName={agentName} />
                  {reason ? <p className="workflow-timeline-reason">{t(reason[0], reason[1])}</p> : null}
                  {block?.kind === "result" && block.note ? <p className="workflow-timeline-meta">{block.note}</p> : null}
                  {question?.question ? <p className="workflow-timeline-meta">{question.question}</p> : null}
                </div>
                <WorkflowRunLedger run={run} agentName={agentName} />
              </div>
            </DialogContent>
          </DialogViewport>
        </DialogPortal>
      </Dialog>
    </section>
  );
}

/** The run's frozen steps, attempts and decisions in their recorded order. */
export function WorkflowRunLedger({ run, agentName }: RunViewProps) {
  const { t } = useTranslation();
  const states = workflowStepStates(run);
  const block = workflowBlock(run);

  return (
    <ol className="workflow-timeline">
      {run.assignments.map((assignment, position) => {
        const state = states[position];
        const results = (run.attemptResults ?? []).filter(result => result.workflowStepId === assignment.workflowStepId);
        const currentResult = results.find(result => result.assignmentId === assignment.assignmentId);
        const reason = state === "blocked" && block && !currentResult ? blockKey(block) : null;
        return (
          <li key={assignment.workItemId} className="workflow-timeline-step" data-state={state}>
            <div className="workflow-timeline-head">
              <span className="workflow-step-index tnum" aria-hidden="true">{position + 1}</span>
              <span className="workflow-timeline-name">{workflowStepName(run, assignment)}</span>
              <span className="workflow-timeline-state">{t(STEP_STATE_KEY[state])}</span>
            </div>
            <p className="workflow-timeline-meta">
              {agentName(assignment.workOwnerAgentId)}
              {assignment.workflowAttempt > 1 ? ` · ${t("workflow.attempt", { attempt: assignment.workflowAttempt })}` : ""}
              {assignment.awaitApproval ? ` · ${t("workflow.gate_badge")}` : ""}
            </p>
            {reason ? <p className="workflow-timeline-reason">{t(reason[0], reason[1])}</p> : null}
            {results.map(result => <AttemptResult key={result.assignmentId} result={result} />)}
            {[...run.gateDecisions, ...(run.recoveryDecisions ?? [])]
              .filter(decision => decision.workflowStepId === assignment.workflowStepId)
              .map((decision, index) => <div className="workflow-timeline-decision" key={decision.id ?? `${decision.kind}-${index}`}>
                <span>{t(`workflow.decision_${decision.kind}`)}</span>
                {` · ${t("workflow.attempt", { attempt: decision.workflowAttempt })}`}
                <RecordedTime timestamp={decision.timestamp} lead=" · " />
                {decision.kind === "answer" && decision.answer ? <p className="workflow-timeline-reason">{decision.answer}</p> : null}
              </div>)}
            {(run.interruptions ?? []).filter(item => item.workflowStepId === assignment.workflowStepId)
              .map((item, index) => <p className="workflow-timeline-reason" key={`interruption-${index}`}>
                {t("workflow.block_interrupted")}<RecordedTime timestamp={item.timestamp} lead=" · " />
              </p>)}
          </li>
        );
      })}
    </ol>
  );
}
