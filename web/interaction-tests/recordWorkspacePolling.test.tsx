import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { RecordWorkspace } from "../src/components/task-record/RecordWorkspace";
import { taskWorkspaceStatus } from "../src/api";
import { RELAY_POLL_INTERVALS_MS } from "../src/lib/relayPolling";

vi.mock("../src/api", () => ({
  listTaskWorkspaceFiles: vi.fn(async () => ({ entries: [], path: "" })),
  readTaskWorkspaceFile: vi.fn(),
  taskWorkspaceStatus: vi.fn(async () => ({ waiting: false })),
}));

async function pollsFor(status: string, waiting = false): Promise<number> {
  vi.useFakeTimers();
  vi.mocked(taskWorkspaceStatus).mockReset().mockResolvedValue({ waiting });
  const client = new QueryClient();
  client.setQueryData(["task-record", "t1"], { id: "t1", status });
  const view = render(<QueryClientProvider client={client}><RecordWorkspace taskId="t1" /></QueryClientProvider>);
  await act(async () => {});
  // Three poll ticks past the initial read.
  await act(() => vi.advanceTimersByTimeAsync(RELAY_POLL_INTERVALS_MS.tasks * 3 + 500));
  const calls = vi.mocked(taskWorkspaceStatus).mock.calls.length;
  view.unmount(); client.clear(); vi.useRealTimers();
  return calls;
}

it("polls workspace status only while the task can still change it", async () => {
  expect(await pollsFor("running")).toBe(4);
  expect(await pollsFor("done")).toBe(1);
  // A note that is showing is watched until it clears, even on a settled task.
  expect(await pollsFor("done", true)).toBe(4);
});
