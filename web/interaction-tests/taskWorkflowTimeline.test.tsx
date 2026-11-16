import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { TaskWorkflowTimeline } from "../src/components/task-record/TaskWorkflowTimeline";
import { getSession } from "../src/api";

vi.mock("../src/api", () => ({ getSession: vi.fn() }));
vi.mock("../src/components/workflow/WorkflowProgress", () => ({
  WorkflowProgress: ({ run, expanded }: any) => <p>{run.teamSnapshot.name} {expanded ? "expanded" : "collapsed"}</p>,
}));

function show(ids: string[]) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TaskWorkflowTimeline taskId="task" sessionIds={ids} agentName={id => id} onOpenThread={vi.fn()} />
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
