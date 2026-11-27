import type { WorkflowAssignment, WorkflowAttemptBinding, WorkflowRun } from "relay-core";
import type { RelaySession } from "../types.ts";

export function taskWorkflowSessionQueryKey(sessionId: string) {
  return ["task-workflow-session", sessionId] as const;
}

type RelayEvent = RelaySession["events"][number];
type WorkflowEvent = Extract<RelayEvent, { type: `workflow.${string}` }>;

/**
 * Client mirror of `backend/relay/collaboration/workflow_events.py`.
 *
 * Most workflow events project exactly as the backend does. Two cannot be
 * recomputed here without duplicating backend policy: a finished step's result
 * (report validation) and a retry's next attempt identity (uuid5). For those —
 * and for any event whose revision does not match this cache — the session is
 * marked as owing a snapshot, and `useSessionDetail` refetches the
 * authoritative materialization instead of guessing. The marker is client-only:
 * a fetched snapshot never carries it.
 */
type WorkflowTrailingSession = RelaySession & { workflowSnapshotDue?: number };

export function workflowSnapshotDue(session: RelaySession | undefined): number | undefined {
  return (session as WorkflowTrailingSession | undefined)?.workflowSnapshotDue;
}

function owesSnapshot(session: RelaySession): RelaySession {
  return { ...session, workflowSnapshotDue: session.events.length } as WorkflowTrailingSession;
}

function replaceRun(session: RelaySession, run: WorkflowRun): RelaySession {
  return {
    ...session,
    workflowRuns: (session.workflowRuns ?? []).map(item => item.workflowRunId === run.workflowRunId ? run : item),
  };
}

/** The open run's current attempt, when the event names exactly it. */
function currentAttempt(session: RelaySession, event: WorkflowAttemptBinding): WorkflowRun | undefined {
  if (session.activeWorkflowRunId !== event.workflowRunId) return undefined;
  const run = session.workflowRuns?.find(item => item.workflowRunId === event.workflowRunId);
  const assignment = run?.assignments[run.currentIndex];
  if (!run || !assignment || run.revision !== event.expectedRevision) return undefined;
  return assignment.workflowStepId === event.workflowStepId
    && assignment.workflowAttempt === event.workflowAttempt
    && assignment.assignmentId === event.assignmentId ? run : undefined;
}

function startRun(session: RelaySession, event: Extract<WorkflowEvent, { type: "workflow.started" }>): RelaySession {
  const first = event.assignments[0];
  if (!first?.teamSnapshot) return owesSnapshot(session);
  const runs = session.workflowRuns ?? [];
  if (runs.some(run => run.workflowRunId === first.workflowRunId)) return session;
  const run: WorkflowRun = {
    workflowRunId: first.workflowRunId,
    teamSnapshot: first.teamSnapshot,
    ...(first.workflowSnapshot ? { workflowSnapshot: first.workflowSnapshot } : {}),
    assignments: event.assignments,
    currentIndex: 0,
    revision: 0,
    status: first.awaitApproval ? "awaiting_approval" : "ready",
    gateDecisions: [],
    startedAt: event.timestamp,
  };
  return { ...session, workflowRuns: [...runs, run], activeWorkflowRunId: run.workflowRunId };
}

export function applyWorkflowEvent(session: RelaySession, event: WorkflowEvent): RelaySession {
  if (event.type === "workflow.started") return startRun(session, event);
  const run = currentAttempt(session, event);
  if (!run) return owesSnapshot(session);
  const revision = run.revision + 1;
  switch (event.type) {
    case "workflow.gate_decided":
      if (run.status !== "awaiting_approval") return owesSnapshot(session);
      return replaceRun(session, {
        ...run,
        revision,
        status: event.kind === "approve" ? "ready" : "blocked",
        gateDecisions: [...run.gateDecisions, event],
      });
    case "workflow.recovery_decided":
      if (event.kind !== "cancel" || run.status === "completed" || run.status === "cancelled") {
        return owesSnapshot(session);
      }
      return replaceRun(session, {
        ...run,
        revision,
        status: "cancelled",
        recoveryDecisions: [...(run.recoveryDecisions ?? []), event],
      });
    case "workflow.interrupted":
      if (run.status !== "ready") return owesSnapshot(session);
      return replaceRun(session, {
        ...run, revision, status: "blocked", interruptions: [...(run.interruptions ?? []), event],
      });
    case "workflow.admission_blocked":
      if (run.status !== "ready") return owesSnapshot(session);
      return replaceRun(session, {
        ...run, revision, status: "blocked", admissionError: String(event.reason).slice(0, 2000),
      });
    default:
      // workflow.step_finished: only the backend can judge the attempt's report.
      return owesSnapshot(session);
  }
}

/** `session.status` cancelled closes every open run (reducer.py `_apply_session_status`). */
export function cancelOpenWorkflowRuns(session: RelaySession): RelaySession {
  if (!session.workflowRuns?.length) return session;
  return {
    ...session,
    workflowRuns: session.workflowRuns.map(run => run.status === "completed" || run.status === "cancelled"
      ? run
      : { ...run, status: "cancelled" as const, revision: run.revision + 1 }),
  };
}

export function isWorkflowEvent(event: RelayEvent): event is WorkflowEvent {
  return event.type.startsWith("workflow.");
}

/** The run a thread shows: the active one, else the newest. */
export function activeWorkflowRun(session: Pick<RelaySession, "workflowRuns" | "activeWorkflowRunId"> | undefined): WorkflowRun | undefined {
  const runs = session?.workflowRuns;
  if (!session || !runs?.length) return undefined;
  return runs.find(run => run.workflowRunId === session.activeWorkflowRunId) ?? runs.at(-1);
}

export function currentWorkflowAssignment(run: WorkflowRun): WorkflowAssignment | undefined {
  return run.assignments[run.currentIndex];
}

/** The binding an owner decision on the current attempt must send. */
export function workflowDecisionBinding(run: WorkflowRun): WorkflowAttemptBinding | undefined {
  const assignment = currentWorkflowAssignment(run);
  if (!assignment) return undefined;
  return {
    workflowRunId: run.workflowRunId,
    workflowStepId: assignment.workflowStepId,
    workflowAttempt: assignment.workflowAttempt,
    assignmentId: assignment.assignmentId,
    expectedRevision: run.revision,
  };
}

/** The step name for an assignment, from the frozen definition. */
export function workflowStepName(run: WorkflowRun, assignment: WorkflowAssignment): string {
  return run.teamSnapshot.workflowSteps?.find(step => step.id === assignment.workflowStepId)?.name
    ?? assignment.workflowStepId;
}

/** The newest recorded result of a step, if any. */
export function latestStepResult(run: WorkflowRun, stepId: string) {
  return run.attemptResults?.filter(result => result.workflowStepId === stepId).at(-1);
}

export type WorkflowStepState = "done" | "current" | "waiting" | "blocked" | "cancelled" | "pending";

/** Each frozen step's state, in saved order. */
export function workflowStepStates(run: WorkflowRun): WorkflowStepState[] {
  return run.assignments.map((_, index) => {
    if (run.status === "completed" || index < run.currentIndex) return "done";
    if (index > run.currentIndex) return run.status === "cancelled" ? "cancelled" : "pending";
    if (run.status === "awaiting_approval" || run.status === "awaiting_input") return "waiting";
    if (run.status === "blocked") return "blocked";
    if (run.status === "cancelled") return "cancelled";
    return "current";
  });
}

export interface WorkflowQuestion {
  question: string;
  options: string[];
}

/** What the current step asked its owner, while the run waits on the answer. */
export function workflowQuestion(run: WorkflowRun): WorkflowQuestion | undefined {
  if (run.status !== "awaiting_input") return undefined;
  const current = currentWorkflowAssignment(run);
  const result = run.attemptResults?.filter(item => item.assignmentId === current?.assignmentId).at(-1);
  if (result?.status !== "question") return undefined;
  return { question: result.question ?? "", options: result.options ?? [] };
}

/** Result reasons the backend records (`collaboration/workflow_results.py`). */
export const WORKFLOW_RESULT_REASONS = [
  "workflow_execution_failed",
  "workflow_result_incomplete",
  "workflow_result_required",
  "workflow_result_missing",
  "workflow_result_invalid",
  "workflow_result_wrong_run",
  "workflow_result_not_done",
  "workflow_evidence_required",
  "workflow_outputs_required",
  "workflow_outputs_too_large",
] as const;

export type WorkflowBlock =
  | { kind: "result"; reason: (typeof WORKFLOW_RESULT_REASONS)[number] | "unknown"; note?: string }
  | { kind: "admission"; detail: string }
  | { kind: "interrupted" }
  | { kind: "rejected" };

/** Why the current step is blocked, from the newest fact recorded on it. */
export function workflowBlock(run: WorkflowRun): WorkflowBlock | undefined {
  if (run.status !== "blocked") return undefined;
  const current = currentWorkflowAssignment(run);
  if (!current) return undefined;
  if (run.admissionError) return { kind: "admission", detail: run.admissionError };
  const sameAttempt = (item: { assignmentId: string }) => item.assignmentId === current.assignmentId;
  if (run.interruptions?.some(sameAttempt)) return { kind: "interrupted" };
  const result = run.attemptResults?.filter(sameAttempt).at(-1);
  if (result?.status === "blocked") {
    const reason = (WORKFLOW_RESULT_REASONS as readonly string[]).includes(result.reason ?? "")
      ? result.reason as (typeof WORKFLOW_RESULT_REASONS)[number]
      : "unknown";
    return { kind: "result", reason, ...(result.note ? { note: result.note } : {}) };
  }
  if (run.gateDecisions.some((decision) => sameAttempt(decision) && decision.kind === "reject")) return { kind: "rejected" };
  return { kind: "result", reason: "unknown" };
}
