import { act, render, renderHook, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useThreadDirectory } from "../src/hooks/useThreadDirectory";
import { useAppRouter } from "../src/hooks/useAppRouter";
import { ThreadRow } from "../src/components/ThreadRow";
import type { ProjectRecord, RelaySession, RelayTaskListItem } from "../src/types";

const session = { id: "s", projectId: "p", taskGoal: "Release discussion", status: "completed", updatedAt: "2026-09-01T00:00:00Z", agentRuns: [] } as unknown as RelaySession;
const project = { id: "p", name: "Autumn launch" } as ProjectRecord;
const task = { id: "t", title: "Release notes", linkedSessionIds: ["s"] } as RelayTaskListItem;

it("lists task threads in Threads with their project badge and updates renamed projects", () => {
  const options = { route: "main", myThreads: [session], projects: [project], routedProjectId: null, threadQuery: "", tasks: [task], visibleNodes: [], runtimeNodes: [], logicalAgents: [] };
  const hook = renderHook((props) => useThreadDirectory(props), { initialProps: options });
  expect(hook.result.current.directoryThreads.map(item => item.session.id)).toEqual(["s"]);
  const select = vi.fn();
  const row = render(<ThreadRow item={hook.result.current.directoryThreads[0]} selected={false} onSelect={select} tone="idle" now={Date.parse(session.updatedAt)} />);
  expect(screen.getByText("Autumn launch").closest("[data-slot=badge]")).toBeTruthy();
  hook.rerender({ ...options, projects: [{ ...project, name: "New launch" }] });
  row.rerender(<ThreadRow item={hook.result.current.directoryThreads[0]} selected={false} onSelect={select} tone="idle" now={Date.parse(session.updatedAt)} />);
  expect(screen.getByText("New launch")).toBeTruthy();
  hook.rerender({ ...options, threadQuery: "Autumn" });
  expect(hook.result.current.directoryThreads).toHaveLength(1);
});

it("keeps a task conversation in Threads when sending from Threads", async () => {
  window.history.replaceState({}, "", "/threads/s");
  const options = { composingNew: false, activeSessionId: "s", selectedSessionId: "s", activeSession: session, onApplySessionFromPath: vi.fn(), onSetComposingNewFromPath: vi.fn(), onClearPendingMessage: vi.fn() };
  const { result } = renderHook(() => useAppRouter(options));
  await act(async () => result.current.syncThreadUrl("s", true, "p"));
  expect(window.location.pathname).toBe("/threads/s");
  await act(async () => result.current.navigateToMobileView("threads"));
  expect(window.location.pathname).toBe("/threads");
});

it("keeps a task thread visible while projects load and gives it an ID badge", () => {
  const { result } = renderHook(() => useThreadDirectory({ route: "main", myThreads: [session], projects: [], routedProjectId: null, threadQuery: "", tasks: [task], visibleNodes: [], runtimeNodes: [], logicalAgents: [] }));
  render(<ThreadRow item={result.current.directoryThreads[0]} selected={false} onSelect={vi.fn()} tone="idle" now={Date.parse(session.updatedAt)} />);
  expect(screen.getByText("p").closest("[data-slot=badge]")).toBeTruthy();
});

it("does not give an independent thread a project badge", () => {
  const { container } = render(<ThreadRow item={{ session: { ...session, projectId: undefined } }} selected={false} onSelect={vi.fn()} tone="idle" now={Date.parse(session.updatedAt)} />);
  expect(container.querySelector(".conversation-project")).toBeNull();
});
