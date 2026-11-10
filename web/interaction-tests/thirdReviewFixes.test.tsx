import { act, render, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useTaskRecord } from "../src/hooks/useTaskRecord";
import { RecordHistory } from "../src/components/task-record/RecordHistory";
import { RecordResultLine } from "../src/components/task-record/RecordResultLine";
import { mergeSessionSnapshotIntoSessions } from "../src/lib/sessionPollMerge";
import { applySessionEventUnchecked, applySessionEventsUnchecked } from "../src/lib/sessionEvents";
import { getTask, listTaskEvents, listTaskRuns } from "../src/api";
import type { RelaySession } from "../src/types";
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getTask: vi.fn(), listTaskEvents: vi.fn(), listTaskRuns: vi.fn() }));
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
it.each([false, true])("fetches the latest settled detail after a pending request (initial row absent: %s)", async (absent) => {
  vi.useFakeTimers();
  const { client, wrapper } = setup();
  const old = { id: "t", status: "done", title: "Old title", updatedAt: "2026-11-01" };
  const latest = { ...old, title: "New title", updatedAt: "2026-11-02" };
  let finish!: (value: never) => void;
  vi.mocked(getTask).mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(latest as never);
  const view = renderHook(({ row }) => useTaskRecord("t", row as never), { wrapper, initialProps: { row: absent ? undefined : old } });
  await act(async () => {});
  await act(async () => { view.rerender({ row: latest }); });
  await act(async () => finish(old as never));
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(getTask).toHaveBeenCalledTimes(2);
  expect(view.result.current.task?.title).toBe("New title");
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(getTask).toHaveBeenCalledTimes(2);
  view.unmount(); client.clear();
});
it("fetches final history when the task completes and then stops polling", async () => {
  const { client, wrapper } = setup();
  vi.mocked(listTaskEvents).mockReset().mockResolvedValue({ events: [] } as never);
  const view = render(<RecordHistory taskId="t" live revision="running:1" />, { wrapper });
  await act(async () => {});
  view.rerender(<RecordHistory taskId="t" live={false} revision="done:2" />);
  await act(async () => {});
  expect(listTaskEvents).toHaveBeenCalledTimes(2);
  view.unmount(); client.clear();
});
it("fetches the final run result without remounting its panel", async () => {
  const { client, wrapper } = setup();
  vi.mocked(listTaskRuns).mockReset().mockResolvedValue({ runs: [] } as never);
  const view = render(<RecordResultLine taskId="t" revision="running:1" />, { wrapper });
  await act(async () => {});
  vi.mocked(listTaskRuns).mockResolvedValue({ runs: [{ taskId: "t", status: "blocked", createdAt: "2026-11-01", artifactCount: 1, failureMessage: "Final failure" }] } as never);
  view.rerender(<RecordResultLine taskId="t" revision="blocked:2" />);
  expect(await view.findByText("Final failure")).toBeTruthy();
  view.unmount(); client.clear();
});
it("replays a snapshot gap in one batch with the same projection", () => {
  const events = Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, type: "session.renamed", title: `Title ${i}`, timestamp: "2026-11-10", sessionId: "s" })) as RelaySession["events"];
  const snapshot = { id: "s", events: events.slice(0, 100), status: "running", agentRuns: [], artifacts: [], decisions: [] } as unknown as RelaySession;
  const current = { ...snapshot, events };
  const single = vi.fn(applySessionEventUnchecked);
  const batch = vi.fn(applySessionEventsUnchecked);
  const merged = mergeSessionSnapshotIntoSessions([current], snapshot, single, batch);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(single).not.toHaveBeenCalled();
  expect(merged[0].events).toEqual(events);
  expect(merged[0].title).toBe("Title 499");
  expect(snapshot.events).toHaveLength(100);
  expect(current.events).toHaveLength(500);
});
