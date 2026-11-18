import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { WorkflowRun } from "relay-core";
import { TaskWorkflowTimeline } from "../src/components/task-record/TaskWorkflowTimeline";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { decideWorkflow, getSession, RelayApiError } from "../src/api";

vi.mock("../src/api", async importOriginal => ({
  ...await importOriginal<typeof import("../src/api")>(),
  getSession: vi.fn(),
  decideWorkflow: vi.fn(),
}));

function show(ids: string[], currentUserId = "owner", onOpenThread = vi.fn()) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DialogProvider>
      <TaskWorkflowTimeline currentUserId={currentUserId} sessionIds={ids} agentName={id => id} onOpenThread={onOpenThread} />
    </DialogProvider>
  </QueryClientProvider>);
}

function session(id: string, status: "completed" | "ready" | "cancelled", startedAt: string) {
  return {
    id, status: status === "ready" ? "running" : "completed",
    workflowRuns: id === "ordinary" ? [] : [{
      workflowRunId: id, teamSnapshot: { name: `Frozen ${id}` },
      startedAt, status, currentIndex: 0, gateDecisions: [], assignments: [],
    }],
  } as Awaited<ReturnType<typeof getSession>>;
}

it("puts the open run before newer finished runs and keeps history folded by run", async () => {
  const records = [
    session("recent", "completed", "2026-11-18T03:00:00Z"),
    session("active", "ready", "2026-11-18T01:00:00Z"),
    session("ordinary", "completed", "2026-11-18T04:00:00Z"),
    session("older", "cancelled", "2026-11-18T02:00:00Z"),
  ];
  vi.mocked(getSession).mockImplementation(async id => records.find(record => record.id === id)!);
  const onOpenThread = vi.fn();
  show(records.map(record => record.id), "owner", onOpenThread);
  await screen.findByRole("heading", { name: "workflow.current_run" });
  const cards = screen.getAllByRole("article");
  expect(cards.map(card => card.querySelector("strong")?.textContent)).toEqual(["Frozen active", "Frozen recent", "Frozen older"]);
  expect(cards.every(card => !card.querySelector("details")?.open)).toBe(true);
  const threadLink = within(cards[0]).getByRole("link", { name: "backlog.open_thread" });
  expect(threadLink.getAttribute("href")).toBe("/threads/active");
  fireEvent.click(threadLink);
  expect(onOpenThread).toHaveBeenCalledWith("active");
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
    ...session("release-thread", "completed", run.startedAt),
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

it("selects the latest run by start time when all runs are finished", async () => {
  const records = [
    session("latest", "cancelled", "2026-11-18T02:00:00Z"),
    session("earliest", "completed", "2026-11-18T01:00:00Z"),
  ];
  vi.mocked(getSession).mockImplementation(async id => records.find(record => record.id === id)!);
  show(records.map(record => record.id));
  await screen.findByRole("heading", { name: "workflow.latest_run" });
  expect(within(screen.getAllByRole("article")[0]).getByText("Frozen latest")).toBeTruthy();
});

it("makes a failed timeline read visible and retryable", async () => {
  vi.mocked(getSession).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ workflowRuns: [] } as any);
  show(["retry"]);
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "workspace.retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
