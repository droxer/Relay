import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TaskRecordView } from "../src/components/task-record/TaskRecordView";

const { getTask, listTaskRuns, listTaskArtifacts, listTaskEvents, startTask, updateTask, resumeAutomation } = vi.hoisted(() => ({
  updateTask: vi.fn(async () => ({})),
  resumeAutomation: vi.fn(async () => ({})),
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
  listTeams: vi.fn(async () => ({ teams: [] })),
  listUserAgents: vi.fn(async () => ({ agents: [] })),
  listControlPanelUsers: vi.fn(async () => ({ users: [] })),
  RelayApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock("../src/hooks/useRelayMutations", () => ({
  useRelayMutations: () => ({
    startTaskMutation: { mutateAsync: startTask },
    updateTaskMutation: { mutateAsync: updateTask },
    cancelRunMutation: { mutateAsync: vi.fn() },
    deleteTaskMutation: { mutateAsync: vi.fn() },
    resumeAutomationMutation: { mutateAsync: resumeAutomation, isPending: false },
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
  routineState: "active",
  routineTriggers: [{ kind: "schedule", schedule: { timezone: "UTC", repeat: { every: "day", at: "09:00" } } }],
  routineNextRunAt: "2026-09-21T09:00:00Z",
  assignedAgentId: "agent-1",
  assigneeUserId: "fei",
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
        currentUser={{ id: "u-1", username: "fei", role: "user", userId: "fei" }}
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

it("opens a routine on its runs, each selectable and each with its own record", async () => {
  renderRecord();

  // The ledger is the routine's default tab — its history is the point of the record.
  const runs = await screen.findAllByRole("button", { name: /backlog\.runs\.outcome/ });
  expect(runs).toHaveLength(2);
  // The newest run is selected, so its folder is what the explorer shows.
  expect(runs[0]!.getAttribute("aria-pressed")).toBe("true");
  // A failed run says why on its own row; nothing else on the row can.
  expect(runs[0]!.textContent).toContain("dispatch refused: no ready computer");
  // A run is addressed under its routine, so it survives a reload or a paste.
  const open = screen.getAllByRole("link", { name: "record.open_run" });
  expect(open[0]!.getAttribute("href")).toBe("/automations/R-42/runs/T-2288");
  // No accordion: a row selects or navigates, it does not unfold.
  expect(document.querySelector("[aria-expanded]")).toBeNull();
});

it("navigates into a run from its open link, and only from there", async () => {
  const user = userEvent.setup();
  const { onOpenRecord } = renderRecord();

  await user.click((await screen.findAllByRole("button", { name: /backlog\.runs\.outcome/ }))[1]!);
  expect(onOpenRecord).not.toHaveBeenCalled();
  // The selected run's detail carries the one link into it.
  await user.click(screen.getByRole("link", { name: "record.open_run" }));
  expect(onOpenRecord).toHaveBeenCalledWith("R-42", "T-2270");
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
  expect(back.getAttribute("href")).toBe("/automations/R-42");

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

it("links a project task result to Threads and opens the same conversation on click", async () => {
  getTask.mockResolvedValue({ ...ROUTINE, id: "T-2270", isRoutine: false, projectId: "p", status: "done" });
  listTaskRuns.mockResolvedValue({ taskId: "T-2270", runs: [RUNS[1]] });
  const onOpenThread = vi.fn();
  renderRecord({ taskId: "T-2270", onOpenThread });
  const link = await screen.findByRole("link", { name: "backlog.open_thread" });
  expect(link.getAttribute("href")).toBe("/threads/s-1");
  await userEvent.setup().click(link);
  expect(onOpenThread).toHaveBeenCalledWith("s-1");
});


it("explains coalesced status triggers in the run ledger", async () => {
  listTaskRuns.mockResolvedValue({ taskId: "R-42", runs: [{ ...RUNS[0], triggerKind: "task_event",
    triggerSummary: { eventType: "task.status_changed", toStatus: "blocked", eventCount: 3 } }] });
  renderRecord();
  expect(await screen.findByText(/automation.ledger.status_changed/)).toBeTruthy();
  expect(screen.getByText(/automation.ledger.event_count/)).toBeTruthy();
});

it("offers one Resume action after the rate cap pauses an automation", async () => {
  getTask.mockResolvedValue({ ...ROUTINE, ownerUserId: "fei", routineState: "paused_by_relay",
    routinePauseReason: "rate_limited", routineNextRunAt: undefined });
  renderRecord();
  expect(await screen.findByText("automation.paused_reasons.rate_limited")).toBeTruthy();
  const [resume, ...others] = screen.getAllByRole("button", { name: "automation.resume" });
  expect(others).toHaveLength(0);
  let finish: (value: unknown) => void = () => undefined;
  resumeAutomation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await userEvent.setup().click(resume);
  await waitFor(() => expect(resumeAutomation).toHaveBeenCalledWith({ taskId: "R-42" }));
  // The record's other actions wait while it resumes.
  for (const name of ["record.edit", "record.delete", "automation.resume"]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  finish({});
  await waitFor(() => expect((screen.getByRole("button", { name: "automation.resume" }) as HTMLButtonElement).disabled).toBe(false));
  expect(updateTask).not.toHaveBeenCalledWith({ taskId: "R-42", input: { routineState: "active" } });
});


it.each([
  ["task.created", "task_event", "task_created"],
  ["run.completed", "run_event", "run_completed"],
  ["run.failed", "run_event", "run_failed"],
])("names the specific %s event in the ledger", async (eventType, triggerKind, label) => {
  listTaskRuns.mockResolvedValue({ taskId: "R-42", runs: [{ ...RUNS[0], triggerKind,
    triggerSummary: { eventType, eventCount: 1 } }] });
  renderRecord();
  // The trigger shares the outcome's second line with the run's detail.
  expect(await screen.findByText(new RegExp(`^automation\\.ledger\\.${label}( · |$)`))).toBeTruthy();
});
