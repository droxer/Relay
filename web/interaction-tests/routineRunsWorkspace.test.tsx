import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { RecordRuns } from "../src/components/task-record/RecordRuns";
import { listTaskRuns } from "../src/api";
import type { TaskRun } from "../src/domain-types/tasks";

vi.mock("../src/api", () => ({
  listTaskRuns: vi.fn(async () => ({
    runs: [
      { taskId: "run-new", status: "done", createdAt: "2026-10-01T09:00:00Z", startedAt: "2026-10-01T09:00:00Z", finishedAt: "2026-10-01T09:02:00Z", artifactCount: 2, latestSessionId: "ses-new" },
      { taskId: "run-old", status: "failed", createdAt: "2026-09-24T09:00:00Z", startedAt: "2026-09-24T09:00:00Z", finishedAt: "2026-09-24T09:01:00Z", artifactCount: 0, failureMessage: "Timed out", latestSessionId: "ses-old" },
    ],
  })),
}));
vi.mock("../src/components/task-record/RecordWorkspace", () => ({
  RecordWorkspace: ({ taskId, threadId, rootLabel }: { taskId: string; threadId?: string | null; rootLabel?: string }) => (
    <div data-testid="run-workspace" data-task-id={taskId} data-thread-id={threadId ?? ""}>{rootLabel}</div>
  ),
}));

function renderRuns(onOpenRun = vi.fn(), client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <RecordRuns taskId="routine-1" hrefForRun={(id) => `/automations/routine-1/runs/${id}`} onOpenRun={onOpenRun} />
    </QueryClientProvider>,
  );
  return onOpenRun;
}

it("opens on the newest run's folder and follows the selected run", async () => {
  renderRuns();
  const workspace = await screen.findByTestId("run-workspace");
  expect(workspace.getAttribute("data-task-id")).toBe("run-new");
  // Each run's activity shows only its own thread's handoff.
  expect(workspace.getAttribute("data-thread-id")).toBe("ses-new");

  const rows = screen.getAllByRole("button", { pressed: false });
  fireEvent.click(rows[0]!);
  expect(screen.getByTestId("run-workspace").getAttribute("data-task-id")).toBe("run-old");
  expect(screen.getByTestId("run-workspace").getAttribute("data-thread-id")).toBe("ses-old");
  expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
});

it("opens the selected run's own record from its detail, never from selecting", async () => {
  const onOpenRun = renderRuns();
  await screen.findByTestId("run-workspace");
  // Selecting is not navigating.
  fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button"));
  expect(onOpenRun).not.toHaveBeenCalled();

  // The detail follows the selection, and its link is a real href.
  const open = screen.getByRole("link", { name: "record.open_run" });
  expect(open.getAttribute("href")).toBe("/automations/routine-1/runs/run-old");
  fireEvent.click(open);
  expect(onOpenRun).toHaveBeenCalledWith("run-old");
});

it("says the selected run's failure in full beside the ledger", async () => {
  renderRuns();
  await screen.findByTestId("run-workspace");
  fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button"));
  const detail = screen.getByRole("banner", { name: "backlog.runs.detail_label" });
  expect(within(detail).getByText("Timed out")).toBeTruthy();
});

it("walks the ledger with the arrow keys, one tab stop for the list", async () => {
  renderRuns();
  await screen.findByTestId("run-workspace");
  const rows = within(screen.getByRole("list")).getAllByRole("button");
  expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);

  fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
  expect(screen.getByTestId("run-workspace").getAttribute("data-task-id")).toBe("run-old");
  expect(document.activeElement).toBe(rows[1]);

  fireEvent.keyDown(rows[1]!, { key: "Home" });
  expect(screen.getByTestId("run-workspace").getAttribute("data-task-id")).toBe("run-new");
});

it("requests only the next page and keeps the selected run's folder", async () => {
  const first: TaskRun = {
    taskId: "run-first", status: "done", createdAt: "2026-11-03T09:00:00Z",
    startedAt: null, endedAt: null, failureMessage: null,
    artifactCount: 0, sessionIds: [], latestSessionId: null,
  };
  const boundary: TaskRun = { ...first, taskId: "run-boundary", createdAt: "2026-11-02T09:00:00Z" };
  const earlier: TaskRun = { ...first, taskId: "run-earlier", createdAt: "2026-11-01T09:00:00Z" };
  const newest: TaskRun = { ...first, taskId: "run-newest", createdAt: "2026-11-04T09:00:00Z" };
  const api = vi.mocked(listTaskRuns);
  api.mockClear()
    .mockResolvedValueOnce({ taskId: "routine-1", nextCursor: "older-cursor", runs: [first, boundary] })
    .mockResolvedValueOnce({ taskId: "routine-1", nextCursor: null, runs: [earlier] })
    .mockResolvedValueOnce({ taskId: "routine-1", nextCursor: "shifted-cursor", runs: [newest, first] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderRuns(vi.fn(), client);
  await screen.findByTestId("run-workspace");
  fireEvent.click(await screen.findByRole("button", { name: "record.runs_show_earlier" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
  fireEvent.click(within(screen.getAllByRole("listitem")[2]!).getByRole("button"));

  await act(() => client.refetchQueries({ queryKey: ["task-runs", "routine-1", 25], exact: true }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
  expect(screen.getByTestId("run-workspace").getAttribute("data-task-id")).toBe("run-earlier");
  expect(api.mock.calls.map(([, options]) => options)).toEqual([
    { limit: 25 }, { limit: 25, before: "older-cursor" }, { limit: 25 },
  ]);
});
