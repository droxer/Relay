import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { browserUrlForAppState, canonicalBrowserUrl, parseAppPath, pathForAppState } from "../src/lib/appRoute";
import { useAppRouter } from "../src/hooks/useAppRouter";

it("round trips a task thread deep link within Tasks", () => {
  const state = { route: "backlog" as const, mobileView: "chat" as const, taskId: "task", sessionId: "thread" };
  expect(parseAppPath("/backlog/task/threads/thread")).toEqual(state);
  expect(pathForAppState(state)).toBe("/backlog/task/threads/thread");
  expect(canonicalBrowserUrl("/backlog/task/threads/thread", "?project=p&space=1&artifact=a&q=ship")).toBe("/backlog/task/threads/thread?space=1&artifact=a&project=p&q=ship");
  expect(browserUrlForAppState({ ...state, sessionId: null }, "/backlog/task/threads/thread", "?project=p&q=ship&space=1")).toBe("/backlog/task?project=p&q=ship");
});

it("loads a task thread and keeps sends and mobile Back in the task context", async () => {
  window.history.replaceState({}, "", "/backlog/task/threads/thread?project=p");
  const apply = vi.fn();
  const options = { composingNew: false, activeSessionId: "thread", selectedSessionId: "thread", activeSession: undefined, onApplySessionFromPath: apply, onSetComposingNewFromPath: vi.fn(), onClearPendingMessage: vi.fn() };
  const { result, unmount } = renderHook(() => useAppRouter(options));
  expect(apply).toHaveBeenCalledWith("thread");
  await act(async () => result.current.syncThreadUrl("thread", true, "p"));
  expect(window.location.pathname).toBe("/backlog/task/threads/thread");
  await act(async () => result.current.navigateToMobileView("threads"));
  expect(window.location.pathname).toBe("/backlog/task");
  expect(window.location.search).toBe("?project=p");
  unmount();
});

it("offers a task breadcrumb without a project conversation link", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { ThreadHeader } = await import("../src/components/ThreadHeader");
  window.history.replaceState({}, "", "/backlog/task/threads/thread?project=p&space=1");
  render(<ThreadHeader taskId="task" projectId="p" activeSession={undefined} artifactCount={0} spaceOpen={true} threadListHidden={true} onToggleSpace={vi.fn()} onToggleThreadList={vi.fn()} onBackToThreads={vi.fn()} />);
  expect(screen.getByRole("link", { name: "thread.back_to_task" }).getAttribute("href")).toBe("/backlog/task?project=p");
  expect(screen.queryByRole("link", { name: "thread.back_to_project_activities" })).toBeNull();
});

it("opens a project task conversation in Threads and returns to the thread list", async () => {
  window.history.replaceState({}, "", "/backlog/task?project=p");
  const options = { composingNew: false, activeSessionId: "thread", selectedSessionId: "thread", activeSession: undefined, onApplySessionFromPath: vi.fn(), onSetComposingNewFromPath: vi.fn(), onClearPendingMessage: vi.fn() };
  const { result } = renderHook(() => useAppRouter(options));
  await act(async () => result.current.syncThreadUrl("thread", false, "p", "task"));
  expect(window.location.pathname).toBe("/threads/thread");
  expect(result.current.route).toBe("main");
  expect(result.current.recordTaskId).toBeNull();
  await act(async () => result.current.syncThreadUrl("thread", true, "p"));
  expect(window.location.pathname).toBe("/threads/thread");
  await act(async () => result.current.navigateToMobileView("threads"));
  expect(window.location.pathname).toBe("/threads");
});
