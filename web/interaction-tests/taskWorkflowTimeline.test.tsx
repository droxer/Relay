import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { WorkflowRun } from "relay-core";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { TaskWorkflowTimeline } from "../src/components/task-record/TaskWorkflowTimeline";
import { decideWorkflow, getSession, RelayApiError } from "../src/api";

vi.mock("../src/api", async importOriginal => ({ ...await importOriginal<typeof import("../src/api")>(), getSession: vi.fn(), decideWorkflow: vi.fn() }));
vi.mock("../src/components/workflow/WorkflowProgress", () => ({
  WorkflowProgress: ({ run, expanded }: any) => <p>{run.teamSnapshot.name} {expanded ? "expanded" : "collapsed"} <span>{run.status ? `workflow.status_${run.status === "ready" ? "running" : run.status}` : ""}</span></p>,
}));

function show(ids: string[], currentUserId = "owner") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DialogProvider><TaskWorkflowTimeline currentUserId={currentUserId} sessionIds={ids} agentName={id => id} onOpenThread={vi.fn()} /></DialogProvider>
  </QueryClientProvider>);
}

it("shows frozen workflow ledgers for every linked execution, skipping ordinary Threads", async () => {
  vi.mocked(getSession).mockImplementation(async id => ({ id, status: "completed", workflowRuns: id === "ordinary" ? [] : [
    { workflowRunId: id, teamSnapshot: { name: `Frozen ${id}` } },
  ] }) as any);
  show(["old", "ordinary", "new"]);
  expect(await screen.findByText("Frozen old expanded")).toBeTruthy();
  expect(await screen.findByText("Frozen new expanded")).toBeTruthy();
  expect(screen.queryByText("Frozen ordinary expanded")).toBeNull();
  expect(screen.getAllByText("backlog.open_thread")).toHaveLength(2);
});

it("makes a failed timeline read visible and retryable", async () => {
  vi.mocked(getSession).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ workflowRuns: [] } as any);
  show(["retry"]);
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "workspace.retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

function approvalSession(status: WorkflowRun["status"] = "awaiting_approval", revision = 4) {
  const run: WorkflowRun = {
    workflowRunId: "release-run", teamSnapshot: { id: "team", name: "Release" },
    startedAt: "2026-11-18T01:00:00Z", status, revision, currentIndex: 0, gateDecisions: [],
    assignments: [{
      workflowRunId: "release-run", workflowStepId: "deploy", workflowAttempt: 2,
      assignmentId: "deploy-a2", workItemId: "deploy-w", workOwnerAgentId: "builder",
      workObjective: "Deploy", awaitApproval: true, expectedOutputs: [], acceptanceCriteria: ["Review the release"],
    }],
  };
  return {
    id: "release-thread", status: "completed",
    ownerUserId: "owner", activeWorkflowRunId: run.workflowRunId, events: [], workflowRuns: [run],
  };
}

const approvalBinding = {
  workflowRunId: "release-run", workflowStepId: "deploy", workflowAttempt: 2,
  assignmentId: "deploy-a2", expectedRevision: 4,
};

it.each([
  { kind: "approve", next: "ready", label: "running" },
  { kind: "reject", next: "blocked", label: "blocked" },
] as const)("lets the owner $kind from Activities and refreshes the gate", async ({ kind, next, label }) => {
  const waiting = approvalSession();
  const refreshed = approvalSession(next, 5);
  vi.mocked(getSession).mockResolvedValueOnce(waiting).mockResolvedValue(refreshed);
  vi.mocked(decideWorkflow).mockResolvedValueOnce(refreshed);
  show([waiting.id]);

  expect(await screen.findByText("workflow.status_awaiting_approval")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^workflow\.approve / })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^workflow\.reject / })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^workflow\\.${kind} `) }));

  await screen.findByText(`workflow.status_${label}`);
  expect(decideWorkflow).toHaveBeenLastCalledWith(waiting.id, kind, approvalBinding, undefined);
  expect(screen.queryByRole("button", { name: /^workflow\.(approve|reject) / })).toBeNull();
});

it("refreshes a stale approval gate after a competing decision", async () => {
  const waiting = approvalSession();
  vi.mocked(getSession).mockResolvedValueOnce(waiting).mockResolvedValue(approvalSession("ready", 5));
  vi.mocked(decideWorkflow).mockRejectedValueOnce(new RelayApiError("Stale workflow revision", 409));
  show([waiting.id]);

  fireEvent.click(await screen.findByRole("button", { name: /^workflow\.approve / }));
  await screen.findByText("workflow.status_running");
  expect(screen.queryByRole("button", { name: /^workflow\.approve / })).toBeNull();
});

it("shows the gate status without decisions to a viewer who does not own the Thread", async () => {
  const waiting = approvalSession();
  vi.mocked(getSession).mockResolvedValue(waiting);
  show([waiting.id], "viewer");

  expect(await screen.findByText("workflow.status_awaiting_approval")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^workflow\.(approve|reject) / })).toBeNull();
});
