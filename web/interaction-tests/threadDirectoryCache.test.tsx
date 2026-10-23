import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as threadRuntime from "../src/lib/threadRuntime";
import { useThreadDirectory } from "../src/hooks/useThreadDirectory";
import type { ProjectRecord, RelaySession, RelayTaskListItem } from "../src/types";

const thread = (id: string, extra: Partial<RelaySession> = {}): RelaySession => ({
  id, taskGoal: `Thread ${id}`, status: "completed", updatedAt: "2026-09-01T00:00:00Z", agentRuns: [], daemonNodeId: "n1", ...extra,
} as unknown as RelaySession);
const node = { id: "n1", online: true, stale: false, status: "ready", activeRuns: [] };
// Held like the app holds them: query results that keep their identity
// between polls, so only the thread list moves between frames.
const fleet = [node];
const projects: ProjectRecord[] = [];
const tasks: RelayTaskListItem[] = [];
const agents: never[] = [];
const options = (myThreads: RelaySession[], overrides: Record<string, unknown> = {}) => ({
  route: "main", myThreads, projects, routedProjectId: null, threadQuery: "", tasks,
  visibleNodes: fleet, runtimeNodes: fleet, logicalAgents: agents, ...overrides,
});

it("re-derives only the session object a streamed frame replaced", () => {
  const offline = vi.spyOn(threadRuntime, "threadNodeOffline");
  const a = thread("a");
  const b = thread("b");
  const hook = renderHook((props) => useThreadDirectory(props), { initialProps: options([a, b]) });
  expect(offline).toHaveBeenCalledTimes(2);
  const [itemA, itemB] = hook.result.current.threadItems;

  // The SSE tail replaces one session object; the list is a new array.
  const b2 = thread("b", { updatedAt: "2026-09-01T00:00:01Z" });
  hook.rerender(options([a, b2]));
  expect(offline).toHaveBeenCalledTimes(3);
  expect(hook.result.current.threadItems[0]).toBe(itemA);
  expect(hook.result.current.threadItems[1]).not.toBe(itemB);
  expect(hook.result.current.threadItems[1].session).toBe(b2);

  // The same list again costs nothing.
  hook.rerender(options([a, b2]));
  expect(offline).toHaveBeenCalledTimes(3);
  offline.mockRestore();
});

it("recomputes every thread when the fleet changes", () => {
  const offline = vi.spyOn(threadRuntime, "threadNodeOffline");
  const a = thread("a");
  const hook = renderHook((props) => useThreadDirectory(props), { initialProps: options([a]) });
  expect(hook.result.current.threadItems[0].nodeOffline).toBe(false);
  const dark = { ...node, online: false };
  hook.rerender(options([a], { visibleNodes: [dark], runtimeNodes: [dark] }));
  expect(offline).toHaveBeenCalledTimes(2);
  expect(hook.result.current.threadItems[0].nodeOffline).toBe(true);
  offline.mockRestore();
});
