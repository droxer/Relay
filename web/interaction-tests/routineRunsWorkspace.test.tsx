import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { RecordRuns } from "../src/components/task-record/RecordRuns";

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

function renderRuns(onOpenRun = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
