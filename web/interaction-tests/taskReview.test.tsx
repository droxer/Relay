import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import * as api from "../src/api";
import { TaskReviewPanel } from "../src/components/task-record/TaskReviewPanel";

const mutateAsync = vi.fn();
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({ updateTaskMutation: { mutateAsync, isPending: false } }) }));

const brief = {
  taskId: "task", revision: "a".repeat(64), status: "review", canAccept: true,
  goal: "Fix export", description: "Keep CSV compatible", sessionId: "thread", roundId: "round",
  criteria: ["CSV stays compatible"], verification: "not_recorded", missing: ["verification"],
  reports: [{ runId: "run", agent: "codex", agentId: "agent", role: "implementer", status: "completed", exitCode: 0,
    completedAt: "2026-11-02T00:00:00Z", workStatus: "done", note: "Fixed CSV escaping", evidence: ["All tests passed"], findings: [], outputTruncated: false }],
  artifacts: [{ id: "file-v1", title: "export.csv", kind: "workspace_file", sessionId: "thread", createdAt: "2026-11-02T00:00:00Z" }],
};

function show(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><TaskReviewPanel taskId="task" onRequestChanges={vi.fn()} {...props} /></QueryClientProvider>), client };
}

it("presents claims separately from execution facts and accepts the displayed revision", async () => {
  vi.spyOn(api, "getTaskReview").mockResolvedValue(brief as Awaited<ReturnType<typeof api.getTaskReview>>);
  mutateAsync.mockResolvedValue({ status: "done" });
  const changes = vi.fn();
  show({ onRequestChanges: changes });
  await screen.findByText("Fixed CSV escaping");
  expect(screen.getByText("All tests passed")).toBeTruthy();
  expect(screen.getByText("task_review.claims")).toBeTruthy();
  expect(screen.getByText("task_review.verification_missing")).toBeTruthy();
  expect(screen.getByRole("link", { name: "export.csv" }).getAttribute("href")).toContain("file-v1");
  expect(screen.getByRole("link", { name: "export.csv" }).getAttribute("href")).toContain("snapshot=1");
  fireEvent.click(screen.getByRole("button", { name: "thread.lifecycle.request_changes" }));
  expect(changes).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "thread.lifecycle.accept" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ taskId: "task", input: { status: "done", reviewRevision: brief.revision } }));
});

it("holds stale acceptance until the person explicitly refreshes the brief", async () => {
  const read = vi.spyOn(api, "getTaskReview").mockResolvedValue(brief as Awaited<ReturnType<typeof api.getTaskReview>>);
  mutateAsync.mockRejectedValueOnce(new api.RelayApiError("Changed", 409, "task_review_changed"));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "thread.lifecycle.accept" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "thread.lifecycle.accept" }) as HTMLButtonElement).disabled).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ ...brief, revision: "b".repeat(64) } as Awaited<ReturnType<typeof api.getTaskReview>>);
  fireEvent.click(screen.getByRole("button", { name: "task_review.refresh" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "thread.lifecycle.accept" }) as HTMLButtonElement).disabled).toBe(false));
});

it("shows missing information and gives failed reads a retry without offering acceptance", async () => {
  const read = vi.spyOn(api, "getTaskReview").mockRejectedValueOnce(new Error("Offline"));
  show();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "thread.lifecycle.accept" })).toBeNull();
  read.mockResolvedValue({ ...brief, reports: [], artifacts: [], criteria: [] } as Awaited<ReturnType<typeof api.getTaskReview>>);
  fireEvent.click(screen.getByRole("button", { name: "task_review.refresh" }));
  await screen.findByText("task_review.reports_missing");
  expect(screen.getByText("task_review.artifacts_missing")).toBeTruthy();
  expect(screen.getByText("task_review.criteria_missing")).toBeTruthy();
});

it("keeps a read-only review readable without decision controls", async () => {
  vi.spyOn(api, "getTaskReview").mockResolvedValue(brief as Awaited<ReturnType<typeof api.getTaskReview>>);
  show({ readOnly: true });
  await screen.findByText("Fixed CSV escaping");
  expect(screen.queryByRole("button", { name: "thread.lifecycle.accept" })).toBeNull();
});

it("does not replace a displayed review when another surface refreshes the shared cache", async () => {
  vi.spyOn(api, "getTaskReview").mockResolvedValue(brief as Awaited<ReturnType<typeof api.getTaskReview>>);
  const { client } = show();
  await screen.findByText("Fixed CSV escaping");
  await act(async () => {
    client.setQueryData(["task-review", "task"], { ...brief, reports: [{ ...brief.reports[0], note: "A different result" }], revision: "b".repeat(64) });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(screen.getByText("Fixed CSV escaping")).toBeTruthy();
  expect(screen.queryByText("A different result")).toBeNull();
});

it("keeps incomplete, failed, and truncated reports visible without implying successful validation", async () => {
  vi.spyOn(api, "getTaskReview").mockResolvedValue({ ...brief, artifacts: [{ ...brief.artifacts[0], snapshotSkipped: "too-large" }], reports: [{ ...brief.reports[0], agent: null, agentId: null,
    role: null, exitCode: null, completedAt: null, note: "", evidence: [], status: "failed", workStatus: "blocked",
    findings: ["CSV still loses columns"], outputTruncated: true }] } as Awaited<ReturnType<typeof api.getTaskReview>>);
  show();
  await screen.findByText("CSV still loses columns");
  expect(screen.getByText("task_review.truncated")).toBeTruthy();
  expect(screen.getByText("task_review.summary_missing")).toBeTruthy();
  expect(screen.getByText("task_review.evidence_missing")).toBeTruthy();
  expect(screen.getByText("task_review.unfinished")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "export.csv" })).toBeNull();
  expect(screen.getByText(/task_review.snapshot_missing/)).toBeTruthy();
});

it("opens the source thread and preserves agent identity in the report", async () => {
  vi.spyOn(api, "getTaskReview").mockResolvedValue({ ...brief, reports: [{ ...brief.reports[0], agentName: "James" }] } as Awaited<ReturnType<typeof api.getTaskReview>>);
  const open = vi.fn();
  show({ onOpenThread: open });
  await screen.findByText("James");
  fireEvent.click(screen.getByRole("link", { name: "backlog.open_thread" }));
  expect(open).toHaveBeenCalledWith("thread");
});

it("offers no acceptance or changes when the recorded work cannot be acted on", async () => {
  vi.spyOn(api, "getTaskReview").mockResolvedValue({ ...brief, description: "", sessionId: null, roundId: null,
    reports: [], criteria: [], artifacts: [], canAccept: false } as Awaited<ReturnType<typeof api.getTaskReview>>);
  show({ compact: true, deferPrimary: true });
  const accept = await screen.findByRole("button", { name: "thread.lifecycle.accept" });
  expect((accept as HTMLButtonElement).disabled).toBe(true);
  expect(accept.getAttribute("data-variant")).toBe("outline");
  expect((screen.getByRole("button", { name: "thread.lifecycle.request_changes" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps acceptance disabled when refreshing after a failed decision also fails", async () => {
  const read = vi.spyOn(api, "getTaskReview").mockResolvedValue(brief as Awaited<ReturnType<typeof api.getTaskReview>>);
  mutateAsync.mockRejectedValueOnce(new Error("Connection lost"));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "thread.lifecycle.accept" }));
  await screen.findByText("task_review.accept_failed");
  read.mockRejectedValueOnce(new Error("Still offline"));
  fireEvent.click(screen.getByRole("button", { name: "task_review.refresh" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect((screen.getByRole("button", { name: "thread.lifecycle.accept" }) as HTMLButtonElement).disabled).toBe(true);
});
