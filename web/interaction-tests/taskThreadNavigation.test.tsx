import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { browserUrlForAppState, canonicalBrowserUrl, parseAppPath, pathForAppState } from "../src/lib/appRoute";
import { useAppRouter } from "../src/hooks/useAppRouter";

it("round trips a task thread deep link within Tasks", () => {
  const state = { route: "backlog" as const, mobileView: "chat" as const, taskId: "task", sessionId: "thread" };
  expect(parseAppPath("/tasks/task/threads/thread")).toEqual(state);
  expect(pathForAppState(state)).toBe("/tasks/task/threads/thread");
  expect(canonicalBrowserUrl("/tasks/task/threads/thread", "?project=p&space=1&artifact=a&q=ship")).toBe("/tasks/task/threads/thread?space=1&artifact=a&project=p&q=ship");
  expect(browserUrlForAppState({ ...state, sessionId: null }, "/tasks/task/threads/thread", "?project=p&q=ship&space=1")).toBe("/tasks/task?project=p&q=ship");
});

it("keeps legacy task sends in its Project and returns mobile Back to Threads", async () => {
  window.history.replaceState({}, "", "/tasks/task/threads/thread?project=p");
  const apply = vi.fn();
  const options = { composingNew: false, activeSessionId: "thread", selectedSessionId: "thread", activeSession: undefined, onApplySessionFromPath: apply, onSetComposingNewFromPath: vi.fn(), onClearPendingMessage: vi.fn() };
  const { result, unmount } = renderHook(() => useAppRouter(options));
  expect(apply).toHaveBeenCalledWith("thread");
  await act(async () => result.current.syncThreadUrl("thread", true, "p"));
  expect(window.location.pathname).toBe("/projects/p/threads/thread");
  await act(async () => result.current.navigateToMobileView("threads"));
  expect(window.location.pathname).toBe("/threads");
  expect(window.location.search).toBe("");
  unmount();
});

it("keeps the mobile return control for issue threads", async () => {
  const { fireEvent, render, screen } = await import("@testing-library/react");
  const { ThreadHeader } = await import("../src/components/ThreadHeader");
  window.history.replaceState({}, "", "/tasks/task/threads/thread?project=p&space=1");
  const back = vi.fn();
  render(<ThreadHeader taskThread activeSession={undefined} artifactCount={0} spaceOpen={true} threadListHidden={true} onToggleSpace={vi.fn()} onToggleThreadList={vi.fn()} onBackToThreads={back} />);
  fireEvent.click(screen.getByRole("button", { name: "nav.threads" }));
  expect(back).toHaveBeenCalledOnce();
  expect(screen.queryByRole("link", { name: "thread.back_to_project_activities" })).toBeNull();
});

it("opens a Project Task conversation and returns to Threads", async () => {
  window.history.replaceState({}, "", "/tasks/task?project=p");
  const options = { composingNew: false, activeSessionId: "thread", selectedSessionId: "thread", activeSession: undefined, onApplySessionFromPath: vi.fn(), onSetComposingNewFromPath: vi.fn(), onClearPendingMessage: vi.fn() };
  const { result } = renderHook(() => useAppRouter(options));
  await act(async () => result.current.syncThreadUrl("thread", false, "p", "task"));
  expect(window.location.pathname).toBe("/projects/p/threads/thread");
  expect(result.current.route).toBe("projects");
  expect(result.current.recordTaskId).toBeNull();
  await act(async () => result.current.syncThreadUrl("thread", true, "p"));
  expect(window.location.pathname).toBe("/projects/p/threads/thread");
  await act(async () => result.current.navigateToMobileView("threads"));
  expect(window.location.pathname).toBe("/threads");
});

it("opens and retains a Project Manager's ordinary Thread", async () => {
  const { useThreadNavigation } = await import('../src/hooks/useThreadNavigation');
  const thread = {id:'manager',projectId:'project'} as never;
  const project = {id:'project',managerThreadId:'manager'};
  const sync = vi.fn(); const navigate = vi.fn();
  const {result,rerender} = renderHook(({ready})=>useThreadNavigation({projectsReady:ready,route:'main',myThreads:[thread],projects:[project],tasks:[],tasksStatus:'ready',activeSession:thread,composingNew:false,routedSessionId:'manager',routedProjectId:'project',recordTaskId:null,threadComputers:[],assignableComputers:[],composerRef:{current:null},pinTranscriptToBottom:vi.fn(),showThreadList:vi.fn(),syncThreadUrl:sync,navigateToProject:navigate}),{initialProps:{ready:false}});
  expect(navigate).not.toHaveBeenCalled();
  rerender({ready:true});
  act(()=>result.current.openThread('manager'));
  expect(navigate).not.toHaveBeenCalled();
  expect(sync).toHaveBeenCalledWith('manager',false,'project',null,null);
});
