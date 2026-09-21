import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { TasksWorkspace } from "../src/components/TasksWorkspace";
import type { CurrentUser, ProjectRecord, RelayTaskListItem } from "../src/types";

// Exercise URL/filter behavior here; browser coverage uses the real popup.
vi.mock("../src/components/FiltersBar", async (original) => ({
  ...await original<typeof import("../src/components/FiltersBar")>(),
  FilterSelect: ({ label, value, onValueChange, options }: any) => <select aria-label={label} value={value} onChange={(event) => onValueChange(event.target.value)}>
    {options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
vi.mock("../src/hooks/useEmployeeAgents", () => ({ useEmployeeAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));
vi.mock("../src/hooks/useEmployeeNames", () => ({ useEmployeeNames: () => new Map() }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({ startTaskMutation: {}, updateTaskMutation: {}, deleteTaskMutation: {}, deleteTasksMutation: {} }) }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn(), confirm: vi.fn(), prompt: vi.fn() }) }));
vi.mock("../src/components/ProjectDrawer", () => ({ ProjectDrawer: () => null }));
vi.mock("../src/components/task-record/TaskRecordView", () => ({ TaskRecordView: ({ taskId, drawer }: any) => drawer?.open
  ? <div role="dialog" aria-label="Execution"><span>{taskId}</span><button onClick={drawer.onClose}>Close execution</button></div>
  : <div>Full page record</div> }));

const projects = [{ id: "p", name: "Launch" }, { id: "q", name: "Support" }, { id: "a", name: "Archive", archivedAt: "today" }] as ProjectRecord[];
const task = (id: string, projectId: string, status = "backlog") => ({ id, title: id, projectId, status, priority: "normal", description: "", linkedSessionIds: [], createdAt: "2026-09-01", updatedAt: "2026-09-01" }) as RelayTaskListItem;
const tasks = [task("Ship", "p"), task("Review", "p", "review"), task("Answer", "q"), task("Old", "a")];
function Workspace({ initialRecord = null, work = tasks, projectsStatus = "ready" }: { projectsStatus?: "ready" | "error" | "loading"; initialRecord?: string | null; work?: RelayTaskListItem[] }) {
  const [record, setRecord] = useState(initialRecord);
  return <TasksWorkspace projects={projects} projectsStatus={projectsStatus} tasks={work} sessions={[]} nodes={[]}
    currentUser={{ employeeId: "u", username: "u" } as CurrentUser} recordTaskId={record}
    onOpenRecord={setRecord} onOpenThread={vi.fn()} isRefreshing={false} onRefresh={vi.fn()} />;
}
function show(initialRecord?: string, work?: RelayTaskListItem[]) {
  return render(<QueryClientProvider client={new QueryClient()}><Workspace initialRecord={initialRecord} work={work} /></QueryClientProvider>);
}
beforeEach(() => { window.history.replaceState({}, "", "/backlog"); window.localStorage.clear(); });
it("shows one flat task list with status filtering only in the second sidebar", () => {
  window.history.replaceState({}, "", "/backlog?sort=title");
  show();
  const board = screen.getByRole("region", { name: "backlog.title" });
  const rows = within(board).getByRole("table", { name: "backlog.title" });
  expect(within(rows).getByRole("link", { name: "Ship" })).toBeTruthy();
  expect(within(rows).getByRole("link", { name: "Answer" })).toBeTruthy();
  expect(within(rows).getByRole("link", { name: "Review" })).toBeTruthy();
  expect(within(rows).getAllByRole("link").map((link) => link.textContent)).toEqual(["Answer", "Review", "Ship"]);
  expect(within(board).queryByRole("region", { name: "backlog.statuses.backlog" })).toBeNull();
  expect(within(board).queryByRole("region", { name: "backlog.statuses.review" })).toBeNull();
  expect(within(board).queryByRole("link", { name: "Old" })).toBeNull();
});
it("keeps the flat list behind the execution drawer and restores the list on close", () => {
  show("Ship");
  expect(screen.getByRole("dialog", { name: "Execution" })).toBeTruthy();
  const board = screen.getByRole("region", { name: "backlog.title" });
  expect(within(board).getByRole("link", { name: "Answer" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close execution" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(screen.getByRole("region", { name: "backlog.title" })).getByRole("link", { name: "Ship" })).toBeTruthy();
});
it("shows a project filter even for an empty project and preserves the search when changing scope", async () => {
  window.history.replaceState({}, "", "/backlog?q=Ship&project=q");
  show();
  const board = screen.getByRole("region", { name: "backlog.title" });
  const filter = within(board).getByRole("combobox", { name: "project.projects" });
  fireEvent.change(filter, { target: { value: "" } });
  expect(new URL(window.location.href).searchParams.get("q")).toBe("Ship");
  expect(new URL(window.location.href).searchParams.has("project")).toBe(false);
  expect(within(screen.getByRole("region", { name: "backlog.title" })).getByRole("link", { name: "Ship" })).toBeTruthy();
});

it("paginates the flat list and selects only the tasks visible on the current page", () => {
  const work = Array.from({ length: 30 }, (_, index) => task(`Task ${index}`, index < 26 ? "p" : "q"));
  window.history.replaceState({}, "", "/backlog?page=2");
  show(undefined, work);
  const board = screen.getByRole("region", { name: "backlog.title" });
  expect(within(board).getAllByRole("link")).toHaveLength(5);
  fireEvent.click(within(board).getByRole("checkbox", { name: "backlog.select_all_tasks" }));
  expect(within(board).getAllByRole("checkbox", { checked: true })).toHaveLength(6);
  expect(within(board).getByRole("table", { name: "backlog.title" })).toBeTruthy();
});
it("retains an explicitly saved board preference", () => {
  window.localStorage.setItem("relay-web.backlogView", "board");
  show();
  expect(screen.getByRole("region", { name: "backlog.title" }).getAttribute("data-view")).toBe("board");
});

it("keeps the project list quiet and puts execution actions in the drawer", () => {
  show();
  const board = screen.getByRole("region", { name: "backlog.title" });
  expect(within(board).queryByRole("group", { name: "backlog.metrics" })).toBeNull();
  expect(within(board).queryByRole("columnheader", { name: "backlog.col_ref" })).toBeNull();
  expect(within(board).queryByRole("columnheader", { name: "backlog.agent" })).toBeNull();
  expect(within(board).queryByRole("columnheader", { name: "backlog.actions" })).toBeNull();
  expect(within(board).queryByRole("button", { name: "backlog.assign_task" })).toBeNull();
  expect(screen.getAllByRole("link", { name: "Ship" })).toHaveLength(1);
  expect(screen.getByRole("navigation", { name: "backlog.status" })).toBeTruthy();
});

it("status navigation preserves project scope and counts other statuses", () => {
  window.history.replaceState({}, "", "/backlog?project=p");
  show();
  const nav = screen.getByRole("navigation", { name: "backlog.status" });
  const review = within(nav).getByRole("button", { name: "backlog.statuses.review 1" });
  fireEvent.click(review);
  expect(review.getAttribute("aria-current")).toBe("page");
  expect(new URL(window.location.href).searchParams.get("status")).toBe("review");
  expect(new URL(window.location.href).searchParams.get("project")).toBe("p");
  expect(screen.queryByRole("link", { name: "Ship" })).toBeNull();
  expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
  expect(within(nav).getByRole("button", { name: "backlog.statuses.backlog 1" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "backlog.status" })).toBeNull();
});

it("keeps blocked tasks separate from their underlying workflow stage", () => {
  window.history.replaceState({}, "", "/backlog?status=running");
  show(undefined, [task("Running", "p", "running"), { ...task("Blocked", "p", "blocked"), workflowStage: "running" }]);
  expect(screen.getByRole("link", { name: "Running" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Blocked" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "backlog.statuses.blocked 1" }));
  expect(screen.getByRole("link", { name: "Blocked" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Running" })).toBeNull();
});
it("clearing filters keeps the selected status section", () => {
  window.history.replaceState({}, "", "/backlog?status=review&priority=high");
  show();
  fireEvent.click(screen.getAllByRole("button", { name: "backlog.clear_filters" })[0]);
  expect(new URL(window.location.href).searchParams.get("status")).toBe("review");
  expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
});

it("keeps project loading failures visible after replacing the project rail", () => {
  render(<QueryClientProvider client={new QueryClient()}><Workspace projectsStatus="error" /></QueryClientProvider>);
  expect(screen.getByRole("alert").textContent).toContain("project.load_failed");
  expect(screen.getByRole("button", { name: "project.retry" })).toBeTruthy();
});

it("keeps common filters visible and reveals additional filters on demand", () => {
  show(undefined, [task("Unassigned", "p"), { ...task("Agent", "p"), assignedAgentId: "a" },
    { ...task("Team", "p"), assignedTeamId: "team-a" }, { ...task("Legacy", "p"), assignedAgent: "codex" }]);
  for (const name of ["backlog.priority", "backlog.due"]) {
    expect(screen.getByRole("combobox", { name })).toBeTruthy();
  }
  expect(screen.queryByRole("combobox", { name: "backlog.agent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "backlog.more_filters" }));
  fireEvent.change(screen.getByRole("combobox", { name: "backlog.assignment_filter" }), { target: { value: "unassigned" } });
  const rows = screen.getByRole("table", { name: "backlog.title" });
  expect(within(rows).getAllByRole("link").map((link) => link.textContent)).toEqual(["Unassigned"]);
  expect(new URL(window.location.href).searchParams.get("assignment")).toBe("unassigned");
});
it("restores combined team and assignment filters from the URL", () => {
  window.history.replaceState({}, "", "/backlog?team=team-a&assignment=assigned");
  show(undefined, [task("Unassigned", "p"), { ...task("Team A", "p"), assignedTeamId: "team-a" },
    { ...task("Team B", "p"), assignedTeamId: "team-b" }]);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Team A"]);
});
it("remembers when the task filters are collapsed", () => {
  const first = show();
  fireEvent.click(screen.getByRole("button", { name: "backlog.more_filters" }));
  fireEvent.click(screen.getByRole("button", { name: "backlog.hide_filters" }));
  first.unmount();
  show();
  expect(screen.queryByRole("combobox", { name: "backlog.agent" })).toBeNull();
  expect(screen.getByRole("button", { name: "backlog.more_filters" })).toBeTruthy();
});
