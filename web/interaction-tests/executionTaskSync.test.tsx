import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useRelayMutations } from "../src/hooks/useRelayMutations";
import type { RelaySession, RelayTask } from "../src/types";

const { cancelRun, getSession, startTask, submitThreadMessage } = vi.hoisted(() => ({
  cancelRun: vi.fn(), getSession: vi.fn(), startTask: vi.fn(), submitThreadMessage: vi.fn(),
}));
vi.mock("../src/api", () => ({ cancelRun, getSession, startTask, submitThreadMessage }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));

const task = {
  id: "task", title: "Write a report", status: "assigned",
  linkedSessionIds: [], updatedAt: "2026-11-28T08:00:00Z", events: [], activity: [],
} as unknown as RelayTask;
const thread = {
  id: "thread", status: "running", agentRuns: [], events: [], artifacts: [],
  messageQueue: { paused: true, messages: [{ id: "q-later", text: "Follow up" }] },
} as unknown as RelaySession;

const recordKey = ["task-record", task.id];
const threadTasksKey = ["relay", "tasks", "thread", thread.id];
const sessionsKey = ["relay", "sessions"];
const queueKey = ["thread-queue", thread.id];

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(useRelayMutations, { wrapper });
  return { client, view };
}

it("publishes a started Task into its open record and invalidates its other projections", async () => {
  const { client, view } = setup();
  client.setQueryData(recordKey, { ...task, eventCount: 1, unblocks: ["dependent"] });
  client.setQueryData(["relay", "tasks", "home"], { tasks: [task] });
  startTask.mockResolvedValueOnce({
    task: { ...task, status: "running", linkedSessionIds: [thread.id], events: [{ id: "start" }, { id: "link" }] },
    session: null, dispatch: { state: "started" },
  });
  await act(async () => { await view.result.current.startTaskMutation.mutateAsync({ taskId: task.id }); });
  expect(client.getQueryData(recordKey)).toMatchObject({ status: "running", linkedSessionIds: [thread.id], unblocks: ["dependent"] });
  expect(client.getQueryState(["relay", "tasks", "home"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(recordKey)?.isInvalidated).toBe(true);
  client.clear();
});

it("keeps a newer Task revision when a delayed start response arrives", async () => {
  const { client, view } = setup();
  client.setQueryData(recordKey, { ...task, status: "done", eventCount: 3 });
  startTask.mockResolvedValueOnce({
    task: { ...task, status: "running", events: [{ id: "start" }, { id: "link" }] },
    session: null, dispatch: { state: "started" },
  });
  await act(async () => { await view.result.current.startTaskMutation.mutateAsync({ taskId: task.id }); });
  expect(client.getQueryData(recordKey)).toMatchObject({ status: "done", eventCount: 3 });
  client.clear();
});

it("refreshes a started Automation's definition and run ledger when the response names its occurrence", async () => {
  const { client, view } = setup();
  const definitionKey = ["task-record", "automation"];
  const ledgerKey = ["task-runs", "automation", 25];
  client.setQueryData(definitionKey, { ...task, id: "automation", isRoutine: true });
  client.setQueryData(ledgerKey, { runs: [] });
  startTask.mockResolvedValueOnce({
    task: { ...task, status: "running", sourceRoutineId: "automation" },
    session: null, dispatch: { state: "started" },
  });
  await act(async () => { await view.result.current.startTaskMutation.mutateAsync({ taskId: "automation" }); });
  expect(client.getQueryState(definitionKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(ledgerKey)?.isInvalidated).toBe(true);
  client.clear();
});

it("refreshes Task state after an ordinary continuation on a Task Thread", async () => {
  const { client, view } = setup();
  client.setQueryData(threadTasksKey, { tasks: [{ ...task, linkedSessionIds: [thread.id] }] });
  client.setQueryData(recordKey, task);
  client.setQueryData(sessionsKey, [thread]);
  submitThreadMessage.mockResolvedValueOnce(thread);
  await act(async () => { await view.result.current.submitThreadMessageMutation.mutateAsync({
    sessionId: thread.id, input: { text: "Continue the work", intent: "accomplish" },
  }); });
  expect(client.getQueryState(threadTasksKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(recordKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(sessionsKey)?.isInvalidated).toBe(true);
  client.clear();
});

it("reconciles the queue and authoritative execution when Stop only acknowledges the request", async () => {
  const { client, view } = setup();
  const running = { ...thread, execution: { phase: "running" } };
  client.setQueryData(sessionsKey, [running]);
  client.setQueryData(queueKey, { ...thread.messageQueue, paused: false, eventCount: 0 });
  client.setQueryData(recordKey, { ...task, linkedSessionIds: [thread.id] });
  cancelRun.mockResolvedValueOnce(thread);
  getSession.mockResolvedValueOnce({ ...thread, execution: { phase: "stopping" } });
  await act(async () => { await view.result.current.cancelRunMutation.mutateAsync({ sessionId: thread.id }); });
  expect(client.getQueryData(sessionsKey)).toMatchObject([{ execution: { phase: "stopping" } }]);
  expect(client.getQueryData(queueKey)).toMatchObject({ paused: true, messages: [{ id: "q-later" }] });
  expect(client.getQueryState(recordKey)?.isInvalidated).toBe(true);
  client.clear();
});
