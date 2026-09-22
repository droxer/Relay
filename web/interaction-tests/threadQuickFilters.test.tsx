import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThreadListPanel } from "../src/components/ThreadListPanel";
import type { ProjectRecord, RelaySession } from "../src/types";
import type { ThreadItem } from "../src/lib/threads";

function session(id: string, status: string, projectId?: string): RelaySession {
  return {
    id,
    taskGoal: `Thread ${id}`,
    status,
    updatedAt: "2026-09-01T00:00:00Z",
    agentRuns: [],
    ...(projectId ? { projectId } : {}),
  } as unknown as RelaySession;
}

const projects = [
  { id: "p1", name: "Launch" } as ProjectRecord,
  { id: "p2", name: "Ledger" } as ProjectRecord,
];

function renderPanel(threads: ThreadItem[]) {
  render(
    <ThreadListPanel
      directoryMode="threads"
      threads={threads}
      projects={projects}
      projectsStatus="ready"
      projectsError=""
      onRetryProjects={vi.fn()}
      computers={[]}
      query=""
      setQuery={vi.fn()}
      selectedSessionId={undefined}
      selectedProjectId={null}
      onSelectThread={vi.fn()}
      onSelectProject={vi.fn()}
      onCreateProject={vi.fn()}
      onNewThread={vi.fn()}
      onRenameThread={vi.fn()}
      onCloseThread={vi.fn()}
      width={280}
      onResize={vi.fn()}
      onResizeActive={vi.fn()}
    />,
  );
  return screen.getByRole("group", { name: "thread.filter_label" });
}

it("filters the rail by attention state, with per-group counts", () => {
  const filters = renderPanel([
    { session: session("w", "waiting_for_human") },
    { session: session("r", "running") },
    { session: session("i", "completed") },
  ]);
  expect(screen.getByText("Thread w")).toBeTruthy();
  expect(screen.getByText("Thread r")).toBeTruthy();
  expect(screen.getByText("Thread i")).toBeTruthy();
  expect(within(filters).getAllByRole("button").map((chip) => chip.textContent)).toEqual([
    "thread.filter_all3",
    "thread.group_needs_you1",
    "thread.group_running1",
    "thread.group_idle1",
  ]);

  fireEvent.click(within(filters).getByRole("button", { name: /thread\.group_running/ }));
  expect(screen.queryByText("Thread w")).toBeNull();
  expect(screen.getByText("Thread r")).toBeTruthy();
  expect(screen.queryByText("Thread i")).toBeNull();

  fireEvent.click(within(filters).getByRole("button", { name: /thread\.filter_all/ }));
  expect(screen.getByText("Thread w")).toBeTruthy();
  expect(screen.getByText("Thread i")).toBeTruthy();
});

it("filters the rail by project and toggles the chip back off", () => {
  const filters = renderPanel([
    { session: session("a", "completed", "p1") },
    { session: session("b", "completed", "p1") },
    { session: session("c", "completed", "p2") },
    { session: session("d", "completed") },
  ]);

  fireEvent.click(within(filters).getByRole("button", { name: /Launch/ }));
  expect(screen.getByText("Thread a")).toBeTruthy();
  expect(screen.getByText("Thread b")).toBeTruthy();
  expect(screen.queryByText("Thread c")).toBeNull();
  expect(screen.queryByText("Thread d")).toBeNull();

  fireEvent.click(within(filters).getByRole("button", { name: /Launch/ }));
  expect(screen.getByText("Thread c")).toBeTruthy();
  expect(screen.getByText("Thread d")).toBeTruthy();
});

it("scopes attention counts to the selected project", () => {
  const filters = renderPanel([
    { session: session("a", "running", "p1") },
    { session: session("b", "completed", "p1") },
    { session: session("c", "running", "p2") },
  ]);

  fireEvent.click(within(filters).getByRole("button", { name: /Launch/ }));
  expect(within(filters).getAllByRole("button").map((chip) => chip.textContent)).toEqual([
    "thread.filter_all2",
    "thread.group_needs_you0",
    "thread.group_running1",
    "thread.group_idle1",
    "Launch2",
    "Ledger1",
  ]);
});

it("combines project and attention filters", () => {
  const filters = renderPanel([
    { session: session("a", "running", "p1") },
    { session: session("b", "completed", "p1") },
    { session: session("c", "running") },
  ]);

  fireEvent.click(within(filters).getByRole("button", { name: /Launch/ }));
  fireEvent.click(within(filters).getByRole("button", { name: /thread\.group_idle/ }));
  expect(screen.queryByText("Thread a")).toBeNull();
  expect(screen.getByText("Thread b")).toBeTruthy();
  expect(screen.queryByText("Thread c")).toBeNull();
});

it("says so when a filter leaves no threads", () => {
  const filters = renderPanel([{ session: session("a", "completed") }]);
  fireEvent.click(within(filters).getByRole("button", { name: /thread\.group_running/ }));
  expect(screen.getByText("thread.no_filter_matches")).toBeTruthy();
});
