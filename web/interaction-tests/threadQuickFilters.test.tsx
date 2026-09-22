import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { ThreadListPanel } from "../src/components/ThreadListPanel";
import { THREAD_FILTERS_NONE, type ThreadFilters } from "../src/lib/threadFilters";
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

/* The panel is controlled: the filters live with the owner, beside the search
   query, so they outlive a remount. The harness stands in for App. */
function Harness({ threads, onFilters }: { threads: ThreadItem[]; onFilters?: (filters: ThreadFilters) => void }) {
  const [filters, setFilters] = useState<ThreadFilters>(THREAD_FILTERS_NONE);
  return (
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
      filters={filters}
      setFilters={(next) => {
        setFilters(next);
        onFilters?.(next);
      }}
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
    />
  );
}

function renderPanel(threads: ThreadItem[], onFilters?: (filters: ThreadFilters) => void) {
  render(<Harness threads={threads} onFilters={onFilters} />);
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

it("scopes project counts to the selected attention filter", () => {
  const filters = renderPanel([
    { session: session("a", "running", "p1") },
    { session: session("b", "completed", "p1") },
    { session: session("c", "running", "p2") },
  ]);

  fireEvent.click(within(filters).getByRole("button", { name: /thread\.group_running/ }));
  // The chip SET is stable — it tracks which projects have threads at all, so
  // chips do not appear and vanish as the attention filter moves — but each
  // count previews what clicking that chip would actually yield.
  expect(within(filters).getAllByRole("button").map((chip) => chip.textContent)).toEqual([
    "thread.filter_all3",
    "thread.group_needs_you0",
    "thread.group_running2",
    "thread.group_idle1",
    "Launch1",
    "Ledger1",
  ]);
});

it("clears every filter from the empty state", () => {
  const filters = renderPanel([
    { session: session("a", "completed", "p1") },
    { session: session("b", "running") },
  ]);

  fireEvent.click(within(filters).getByRole("button", { name: /Launch/ }));
  fireEvent.click(within(filters).getByRole("button", { name: /thread\.group_running/ }));
  expect(screen.getByText("thread.no_filter_matches")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "thread.clear_filters" }));
  expect(screen.getByText("Thread a")).toBeTruthy();
  expect(screen.getByText("Thread b")).toBeTruthy();
  expect(screen.queryByText("thread.no_filter_matches")).toBeNull();
});

it("reports filter changes to its owner, so they outlive a remount", () => {
  const seen: ThreadFilters[] = [];
  const filters = renderPanel([{ session: session("a", "running", "p1") }], (next) => seen.push(next));

  fireEvent.click(within(filters).getByRole("button", { name: /thread\.group_running/ }));
  fireEvent.click(within(filters).getByRole("button", { name: /Launch/ }));
  expect(seen).toEqual([
    { attention: "running", projectId: "all" },
    { attention: "running", projectId: "p1" },
  ]);
});
