import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import * as api from "../src/api";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { PersonalSpaceProvider } from "../src/components/PersonalSpaceProvider";
import { useInlineTaskEdits } from "../src/hooks/useInlineTaskEdits";
import { useRelayMutations } from "../src/hooks/useRelayMutations";
import { TASKS_QUERY_KEY } from "../src/hooks/useRelayData";
import { TASK_RECORD_QUERY_KEY } from "../src/hooks/useTaskRecord";
import { taskSummaryFromTask } from "../src/lib/taskSummary";
import type { RelayTask } from "../src/types";

const task = { id: "task", title: "Export", status: "review", updatedAt: "2026-11-15T00:00:00Z", events: [], activity: [] } as unknown as RelayTask;

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(TASKS_QUERY_KEY, [taskSummaryFromTask(task)]);
  client.setQueryData([TASK_RECORD_QUERY_KEY, task.id], task);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><DialogProvider>{children}</DialogProvider></QueryClientProvider>;
  return { client, ...renderHook(() => useRelayMutations(), { wrapper }) };
}

it("keeps review visible until acceptance commits, then updates both list and detail", async () => {
  let finish!: (task: RelayTask) => void;
  vi.spyOn(api, "updateTask").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { client, result } = setup();
  let decision!: Promise<RelayTask>;
  await act(async () => {
    decision = result.current.updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "done", reviewRevision: "a".repeat(64) } });
  });
  expect(client.getQueryData<RelayTask[]>(TASKS_QUERY_KEY)?.[0].status).toBe("review");
  expect(client.getQueryData<RelayTask>([TASK_RECORD_QUERY_KEY, task.id])?.status).toBe("review");
  const accepted = { ...task, status: "done", updatedAt: "2026-11-15T00:01:00Z" } as RelayTask;
  await act(async () => { finish(accepted); await decision; });
  expect(client.getQueryData<RelayTask[]>(TASKS_QUERY_KEY)?.[0].status).toBe("done");
  expect(client.getQueryData([TASK_RECORD_QUERY_KEY, task.id])).toEqual(accepted);
  client.clear();
});

it("preserves review in both caches after a stale acceptance is refused", async () => {
  vi.spyOn(api, "updateTask").mockRejectedValue(new api.RelayApiError("Changed", 409, "task_review_changed"));
  const { client, result } = setup();
  await act(async () => {
    await expect(result.current.updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "done", reviewRevision: "a".repeat(64) } })).rejects.toThrow("Changed");
  });
  expect(client.getQueryData<RelayTask[]>(TASKS_QUERY_KEY)?.[0].status).toBe("review");
  expect(client.getQueryData<RelayTask>([TASK_RECORD_QUERY_KEY, task.id])?.status).toBe("review");
  client.clear();
});

it("accepts inside the account's personal cache instead of the outer auth cache", async () => {
  const outer = new QueryClient();
  outer.setQueryData(TASKS_QUERY_KEY, [taskSummaryFromTask(task)]);
  const accepted = { ...task, status: "done", updatedAt: "2026-11-15T00:01:00Z" } as RelayTask;
  vi.spyOn(api, "getTaskReview").mockResolvedValue({ taskId: task.id, revision: "a".repeat(64), canAccept: true,
    goal: "Export", criteria: [], reports: [], artifacts: [] } as unknown as Awaited<ReturnType<typeof api.getTaskReview>>);
  vi.spyOn(api, "updateTask").mockResolvedValue(accepted);
  let personal!: QueryClient;
  function Entry() {
    personal = useQueryClient();
    const edits = useInlineTaskEdits();
    return <button onClick={() => edits?.changeStatus(task, "done")}>Complete</button>;
  }
  render(<QueryClientProvider client={outer}><DialogProvider><PersonalSpaceProvider><Entry /></PersonalSpaceProvider></DialogProvider></QueryClientProvider>);
  personal.setQueryData(TASKS_QUERY_KEY, [taskSummaryFromTask(task)]);
  personal.setQueryData([TASK_RECORD_QUERY_KEY, task.id], task);
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  fireEvent.click(await screen.findByRole("button", { name: "thread.lifecycle.accept" }));
  await waitFor(() => expect(personal.getQueryData<RelayTask[]>(TASKS_QUERY_KEY)?.[0].status).toBe("done"));
  expect(personal.getQueryData<RelayTask>([TASK_RECORD_QUERY_KEY, task.id])?.status).toBe("done");
  expect(outer.getQueryData<RelayTask[]>(TASKS_QUERY_KEY)?.[0].status).toBe("review");
});
