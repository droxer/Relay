import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { RecordRuns } from "../src/components/task-record/RecordRuns";

const { openArtifact } = vi.hoisted(() => ({ openArtifact: vi.fn() }));

vi.mock("../src/api", () => ({
  listTaskArtifacts: vi.fn(async (taskId: string) => ({
    artifacts: taskId === "run-new" ? [{
      id: "artifact-new", title: "report.md", sessionId: "ses-new",
      kind: "workspace_file", createdAt: "2026-10-01T09:02:00Z",
    }] : [],
  })),
  listTaskRuns: vi.fn(async () => ({
    runs: [
      { taskId: "run-new", status: "done", createdAt: "2026-10-01T09:00:00Z", startedAt: "2026-10-01T09:00:00Z", finishedAt: "2026-10-01T09:02:00Z", artifactCount: 2, latestSessionId: "ses-new" },
      { taskId: "run-old", status: "failed", createdAt: "2026-09-24T09:00:00Z", startedAt: "2026-09-24T09:00:00Z", finishedAt: "2026-09-24T09:01:00Z", artifactCount: 0, failureMessage: "Timed out", latestSessionId: "ses-old" },
    ],
  })),
}));
vi.mock("../src/components/ArtifactViewerProvider", () => ({
  useArtifactViewer: () => ({ open: openArtifact }),
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

it("shows only the selected run's artifacts and no workspace browser", async () => {
  renderRuns();
  await screen.findByText("report.md");
  expect(screen.queryByRole("button", { name: "workspace.tab_activity" })).toBeNull();
  expect(screen.queryByRole("button", { name: "workspace.parent_directory" })).toBeNull();
  expect(document.querySelector(".workspace-panes")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /report\.md/ }));
  expect(openArtifact).toHaveBeenCalledWith(
    expect.objectContaining({ id: "artifact-new" }), "ses-new",
    [expect.objectContaining({ id: "artifact-new" })], 1,
  );
  expect(screen.getByRole("link", { name: "artifact.action_download" }).getAttribute("href"))
    .toBe("/api/v1/threads/ses-new/artifacts/artifact-new");

  fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button"));
  await screen.findByText("backlog.artifacts_empty");
  expect(screen.queryByText("report.md")).toBeNull();
  expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
});

it("opens the selected run's own record from its detail, never from selecting", async () => {
  const onOpenRun = renderRuns();
  await screen.findByText("report.md");
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
  await screen.findByText("report.md");
  fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button"));
  const detail = screen.getByRole("banner", { name: "backlog.runs.detail_label" });
  expect(within(detail).getByText("Timed out")).toBeTruthy();
});

it("walks the ledger with the arrow keys, one tab stop for the list", async () => {
  renderRuns();
  await screen.findByText("report.md");
  const rows = within(screen.getByRole("region", { name: "record.tab_runs" })).getAllByRole("button");
  expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);

  fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
  expect(rows[1]!.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(rows[1]);

  fireEvent.keyDown(rows[1]!, { key: "Home" });
  expect(rows[0]!.getAttribute("aria-pressed")).toBe("true");
});
