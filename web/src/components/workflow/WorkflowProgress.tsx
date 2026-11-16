"use client";

import { useTranslation } from "react-i18next";
import type { WorkflowAttemptResult, WorkflowRun } from "relay-core";
import {
  WORKFLOW_RESULT_REASONS,
  workflowBlock,
  workflowStepName,
  workflowStepStates,
  type WorkflowBlock,
  type WorkflowStepState,
} from "../../lib/workflowRuns";
import { ChevronDownIcon, ICON } from "../icons";

const RUN_STATUS_KEY: Record<WorkflowRun["status"], string> = {
  awaiting_approval: "workflow.status_awaiting_approval",
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
        {` · ${t(result.status === "succeeded" ? "workflow.step_done" : "workflow.step_blocked")}`}
        <RecordedTime timestamp={result.timestamp} lead=" · " />
      </p>
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

/**
 * A workflow run at the top of its thread: one compact line — position,
 * current step, status in words — that opens to the frozen timeline with
 * each step's owner, attempt, recorded outputs and why a step stopped.
 * It reads the run's frozen definition, never the Team's latest.
 */
export function WorkflowProgress({ run, agentName, expanded = false }: {
  run: WorkflowRun;
  expanded?: boolean;
  agentName: (agentId: string) => string;
}) {
  const { t } = useTranslation();
  const states = workflowStepStates(run);
  const current = run.assignments[Math.min(run.currentIndex, run.assignments.length - 1)];
  const done = run.status === "completed" ? run.assignments.length : run.currentIndex;
  const block = workflowBlock(run);
  const currentName = current && run.status !== "completed" ? workflowStepName(run, current) : null;

  return (
    <details className="workflow-progress" data-state={run.status} open={expanded || undefined}>
      <summary className="workflow-progress-summary">
        <span className="workflow-progress-label">{run.teamSnapshot.name ?? t("workflow.section_title")}</span>
        <span className="workflow-progress-meter" aria-hidden="true">
          {states.map((state, position) => (
            <span key={run.assignments[position].workItemId} className="workflow-progress-pip" data-state={state} />
          ))}
        </span>
        <span className="workflow-progress-position tnum">
          {t("workflow.progress_position", { done, total: run.assignments.length })}
        </span>
        {currentName ? <span className="workflow-progress-step" title={currentName}>{currentName}</span> : null}
        <span className="workflow-progress-status">{t(RUN_STATUS_KEY[run.status])}</span>
        <ChevronDownIcon className="workflow-progress-chevron" size={ICON.sm} aria-hidden="true" />
      </summary>
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
                .map((decision, index) => <p className="workflow-timeline-decision" key={decision.id ?? `${decision.kind}-${index}`}>
                  <span>{t(`workflow.decision_${decision.kind}`)}</span>
                  {` · ${t("workflow.attempt", { attempt: decision.workflowAttempt })}`}
                  <RecordedTime timestamp={decision.timestamp} lead=" · " />
                </p>)}
              {(run.interruptions ?? []).filter(item => item.workflowStepId === assignment.workflowStepId)
                .map((item, index) => <p className="workflow-timeline-reason" key={`interruption-${index}`}>
                  {t("workflow.block_interrupted")}<RecordedTime timestamp={item.timestamp} lead=" · " />
                </p>)}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
