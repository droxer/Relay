import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TaskRecordView } from "../src/components/task-record/TaskRecordView";

const { getTask, listTaskRuns, listTaskArtifacts, listTaskEvents, startTask } = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTaskRuns: vi.fn(),
  listTaskArtifacts: vi.fn(async () => ({ artifacts: [] })),
  listTaskEvents: vi.fn(async () => ({ events: [] })),
  startTask: vi.fn(async () => ({ task: {}, session: null, dispatch: { state: "started" } })),
}));

vi.mock("../src/api", () => ({
  getTask,
  listTaskRuns,
  listTaskArtifacts,
  listTaskEvents,
  startTask,
  cancelRun: vi.fn(),
  deleteTask: vi.fn(),
  listTaskWorkspaceFiles: vi.fn(async () => ({ files: [] })),
  readTaskWorkspaceFile: vi.fn(),
  taskWorkspaceStatus: vi.fn(async () => ({ state: "idle" })),
  RelayApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock("../src/hooks/useRelayMutations", () => ({
  useRelayMutations: () => ({
    startTaskMutation: { mutateAsync: startTask },
    cancelRunMutation: { mutateAsync: vi.fn() },
    deleteTaskMutation: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("@/components/ui/DialogProvider", () => ({
  useDialogs: () => ({ announce: vi.fn(), confirm: vi.fn(async () => true) }),
}));

const ROUTINE = {
  id: "R-42",
  title: "Daily standup digest",
  description: "Collect yesterday's threads.",
  priority: "normal",
  status: "backlog",
  isRoutine: true,
  routineEnabled: true,
  routineCadence: "daily",
  routineType: "task",
  routineNextRunDate: "2026-09-21",
  assignedAgentId: "agent-1",
  assigneeEmployeeId: "fei",
  linkedSessionIds: [],
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-19T09:04:00Z",
} as any;

const RUNS = [
  { taskId: "T-2288", scheduledFor: "2026-09-18", status: "blocked", createdAt: "2026-09-18T09:00:00Z", startedAt: null, endedAt: null, failureMessage: "dispatch refused: no ready computer", sessionIds: [], latestSessionId: null, artifactCount: 0 },
  { taskId: "T-2270", scheduledFor: "2026-09-17", status: "done", createdAt: "2026-09-17T09:00:00Z", startedAt: "2026-09-17T09:00:00Z", endedAt: "2026-09-17T09:03:48Z", failureMessage: null, sessionIds: ["s-1"], latestSessionId: "s-1", artifactCount: 2 },
];

function renderRecord(props: Partial<Parameters<typeof TaskRecordView>[0]> = {}) {
  const onOpenRecord = vi.fn();
  const onEdit = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskRecordView
        taskId="R-42"
        tasks={[ROUTINE]}
        onEdit={onEdit}
        onOpenThread={vi.fn()}
        onOpenRecord={onOpenRecord}
        onDeleted={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOpenRecord, onEdit };
}

beforeEach(() => {
  vi.clearAllMocks();
  getTask.mockResolvedValue(ROUTINE);
  listTaskRuns.mockResolvedValue({ taskId: "R-42", runs: RUNS });
});

it("opens a routine on its runs, with one destination per run", async () => {
  renderRecord();

  // The ledger is the routine's default tab — its history is the point of the record.
  const runs = await screen.findAllByRole("link", { name: /backlog\.runs\.outcome/ });
  expect(runs).toHaveLength(2);
  // A run is addressed under its routine, so it survives a reload or a paste.
  expect(runs[0]!.getAttribute("href")).toBe("/routines/R-42/runs/T-2288");
  // A failed run says why on its own row; nothing else on the row can.
  expect(runs[0]!.textContent).toContain("dispatch refused: no ready computer");
  // No accordion: the row navigates, it does not unfold.
  expect(document.querySelector("[aria-expanded]")).toBeNull();
});

it("navigates into a run instead of expanding it", async () => {
  const user = userEvent.setup();
  const { onOpenRecord } = renderRecord();

  await user.click((await screen.findAllByRole("link", { name: /backlog\.runs\.outcome/ }))[0]!);
  expect(onOpenRecord).toHaveBeenCalledWith("R-42", "T-2288");
});

it("gives a run its own title and a breadcrumb back to its routine", async () => {
  getTask.mockResolvedValue({
    ...ROUTINE,
    id: "T-2288",
    isRoutine: false,
    status: "blocked",
    sourceRoutineId: "R-42",
    scheduledFor: "2026-09-18",
  });
  const { onOpenRecord } = renderRecord({ runId: "T-2288" });

  // The occurrence carries the routine's title, so the date is what tells the
  // two records apart.
  expect(await screen.findByRole("heading", { name: "record.run_of" })).toBeTruthy();
  const back = screen.getByRole("link", { name: "Daily standup digest" });
  expect(back.getAttribute("href")).toBe("/routines/R-42");

  const user = userEvent.setup();
  await user.click(back);
  expect(onOpenRecord).toHaveBeenCalledWith("R-42", null);
});

it("offers a refused dispatch a retry, and dispatches the run itself", async () => {
  getTask.mockResolvedValue({ ...ROUTINE, id: "T-2288", isRoutine: false, status: "blocked", sourceRoutineId: "R-42" });
  renderRecord({ runId: "T-2288" });

  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /record\.retry_run/ }));
  await waitFor(() => expect(startTask).toHaveBeenCalled());
  expect(startTask.mock.calls[0]![0].taskId).toBe("T-2288");
  expect(screen.queryByRole("button", { name: /record\.cancel_run/ })).toBeNull();
});

it("refuses to render a run under a routine it does not belong to", async () => {
  getTask.mockResolvedValue({ ...ROUTINE, id: "T-2288", isRoutine: false, sourceRoutineId: "R-99" });
  renderRecord({ runId: "T-2288" });

  // A breadcrumb over the wrong routine would be a lie, so the record is not
  // found rather than shown.
  expect(await screen.findByText("record.run_not_of_routine")).toBeTruthy();
});

it("sends editing back to the board's drawer instead of growing a form", async () => {
  const user = userEvent.setup();
  const { onEdit } = renderRecord();

  await user.click(await screen.findByRole("button", { name: /record\.edit/ }));
  expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "R-42" }));
});
