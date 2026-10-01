import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { RecordRuns } from "../src/components/task-record/RecordRuns";

vi.mock("../src/api", () => ({
  listTaskRuns: vi.fn(async () => ({
    runs: [
      { taskId: "run-new", status: "done", createdAt: "2026-10-01T09:00:00Z", startedAt: "2026-10-01T09:00:00Z", finishedAt: "2026-10-01T09:02:00Z", artifactCount: 2 },
      { taskId: "run-old", status: "failed", createdAt: "2026-09-24T09:00:00Z", startedAt: "2026-09-24T09:00:00Z", finishedAt: "2026-09-24T09:01:00Z", artifactCount: 0, failureMessage: "Timed out" },
    ],
  })),
}));
vi.mock("../src/components/task-record/RecordWorkspace", () => ({
  RecordWorkspace: ({ taskId, rootLabel }: { taskId: string; rootLabel?: string }) => (
    <div data-testid="run-workspace" data-task-id={taskId}>{rootLabel}</div>
  ),
}));

function renderRuns(onOpenRun = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecordRuns taskId="routine-1" hrefForRun={(id) => `/routines/routine-1/runs/${id}`} onOpenRun={onOpenRun} />
    </QueryClientProvider>,
  );
  return onOpenRun;
}

it("opens on the newest run's folder and follows the selected run", async () => {
  renderRuns();
  const workspace = await screen.findByTestId("run-workspace");
  expect(workspace.getAttribute("data-task-id")).toBe("run-new");

  const rows = screen.getAllByRole("button", { pressed: false });
  fireEvent.click(rows[0]!);
  expect(screen.getByTestId("run-workspace").getAttribute("data-task-id")).toBe("run-old");
  expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
});

it("still opens a run's own record from its row", async () => {
  const onOpenRun = renderRuns();
  await screen.findByTestId("run-workspace");
  const open = screen.getAllByRole("link");
  expect(open[1]!.getAttribute("href")).toBe("/routines/routine-1/runs/run-old");
  fireEvent.click(open[1]!);
  expect(onOpenRun).toHaveBeenCalledWith("run-old");
  // Selecting is not navigating.
  fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button"));
  expect(onOpenRun).toHaveBeenCalledTimes(1);
});
