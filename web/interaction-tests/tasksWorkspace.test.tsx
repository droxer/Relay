import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { TasksWorkspace } from "../src/components/TasksWorkspace";
import type { CurrentUser, ProjectRecord, RelayTaskListItem } from "../src/types";

// Exercise URL/filter behavior here; browser coverage (e2e) drives the real
// chips. The stub stands in for ReUI's <Filters>: one plain control per field,
// writing the same query tree the chips write, so the page's adapter
// (FiltersBar ↔ lib/filterSelections ↔ the URL) is what runs.
vi.mock("@/components/reui/filters/filters", () => ({
  Filters: ({ fields, query, onQueryChange }: any) => <div>
    {fields.map((field: any) => {
      const value = query.rules.find((rule: any) => rule.path[0] === field.id)?.value ?? "";
      const set = (next: string) => onQueryChange({ ...query, rules: [
        ...query.rules.filter((rule: any) => rule.path[0] !== field.id),
        ...(next ? [{ id: `stub-${field.id}`, type: "rule", path: [field.id], operator: field.defaultOperator, value: next }] : []),
      ] });
      return field.type === "text"
        ? <input key={field.id} aria-label={field.label} value={value} onChange={(event) => set(event.target.value)} />
        : <select key={field.id} aria-label={field.label} value={value} onChange={(event) => set(event.target.value)}>
            <option value="">—</option>
            {field.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>;
    })}
  </div>,
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
const task = (id: string, projectId: string, status = "backlog") => ({ id, title: id, projectId, status, priority: "normal", description: "", ownerEmployeeId: "u", linkedSessionIds: [], createdAt: "2026-09-01", updatedAt: "2026-09-01" }) as RelayTaskListItem;
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
beforeEach(() => { window.history.replaceState({}, "", "/issues"); window.localStorage.clear(); });
it("shows a table grouped into project bands with queue navigation", () => {
  window.history.replaceState({}, "", "/issues?sort=title");
  show();
  const board = screen.getByRole("region", { name: "issues.title" });
  const rows = within(board).getByRole("table", { name: "issues.title" });
  expect(within(rows).getByRole("link", { name: "Ship" })).toBeTruthy();
  expect(within(rows).getByRole("link", { name: "Answer" })).toBeTruthy();
  expect(within(rows).getByRole("link", { name: "Review" })).toBeTruthy();
  expect(within(rows).getAllByRole("link").map((link) => link.textContent)).toEqual(["Review", "Ship", "Answer"]);
  expect(within(board).queryByRole("region", { name: "backlog.statuses.backlog" })).toBeNull();
  expect(within(board).queryByRole("region", { name: "backlog.statuses.review" })).toBeNull();
  expect(within(board).queryByRole("link", { name: "Old" })).toBeNull();
});
it("keeps the flat list behind the execution drawer and restores the list on close", () => {
  show("Ship");
  expect(screen.getByRole("dialog", { name: "Execution" })).toBeTruthy();
  const board = screen.getByRole("region", { name: "issues.title" });
  expect(within(board).getByRole("link", { name: "Answer" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close execution" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(screen.getByRole("region", { name: "issues.title" })).getByRole("link", { name: "Ship" })).toBeTruthy();
});
it("shows a project filter even for an empty project and preserves the search when changing scope", async () => {
  window.history.replaceState({}, "", "/issues?q=Ship&project=q");
  show();
  const board = screen.getByRole("region", { name: "issues.title" });
  const filter = within(board).getByRole("combobox", { name: "project.projects" });
  fireEvent.change(filter, { target: { value: "" } });
  expect(new URL(window.location.href).searchParams.get("q")).toBe("Ship");
  expect(new URL(window.location.href).searchParams.has("project")).toBe(false);
  expect(within(screen.getByRole("region", { name: "issues.title" })).getByRole("link", { name: "Ship" })).toBeTruthy();
});

it("paginates the flat list and selects only the tasks visible on the current page", () => {
  const work = Array.from({ length: 55 }, (_, index) => task(`Task ${index}`, index < 51 ? "p" : "q"));
  window.history.replaceState({}, "", "/issues?page=2");
  show(undefined, work);
  const board = screen.getByRole("region", { name: "issues.title" });
  expect(within(board).getAllByRole("link")).toHaveLength(5);
  fireEvent.click(within(board).getByRole("checkbox", { name: "issues.select_all" }));
  expect(within(board).getAllByRole("checkbox", { checked: true })).toHaveLength(6);
  expect(within(board).getByRole("table", { name: "issues.title" })).toBeTruthy();
});
it("always shows the issues table even with an old board preference", () => {
  window.localStorage.setItem("relay-web.backlogView", "board");
  show();
  expect(screen.getByRole("table", { name: "issues.title" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "backlog.view_board" })).toBeNull();
});

it("keeps the project list quiet and puts execution actions in the drawer", () => {
  show();
  const board = screen.getByRole("region", { name: "issues.title" });
  expect(within(board).queryByRole("group", { name: "backlog.metrics" })).toBeNull();
  expect(within(board).getByRole("columnheader", { name: "backlog.col_ref" })).toBeTruthy();
  expect(within(board).queryByRole("columnheader", { name: "backlog.agent" })).toBeNull();
  expect(within(board).queryByRole("columnheader", { name: "backlog.actions" })).toBeNull();
  expect(within(board).queryByRole("button", { name: "backlog.assign_task" })).toBeNull();
  expect(screen.getAllByRole("link", { name: "Ship" })).toHaveLength(1);
  expect(screen.getByRole("navigation", { name: "issues.queues_label" })).toBeTruthy();
});

it("queue navigation preserves project scope and counts other queues", () => {
  window.history.replaceState({}, "", "/issues?project=p");
  show();
  const nav = screen.getByRole("navigation", { name: "issues.queues_label" });
  const review = within(nav).getByRole("button", { name: "issues.queues.needs_me 1" });
  fireEvent.click(review);
  expect(review.getAttribute("aria-current")).toBe("page");
  expect(new URL(window.location.href).searchParams.get("queue")).toBe("needs_me");
  expect(new URL(window.location.href).searchParams.get("project")).toBe("p");
  expect(screen.queryByRole("link", { name: "Ship" })).toBeNull();
  expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
  expect(within(nav).getByRole("button", { name: "issues.queues.open 2" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "issues.queues_label" })).toBeNull();
});

it("keeps blocked tasks separate from their underlying workflow stage", () => {
  window.history.replaceState({}, "", "/issues?queue=running");
  show(undefined, [task("Running", "p", "running"), { ...task("Blocked", "p", "blocked"), workflowStage: "running" }]);
  expect(screen.getByRole("link", { name: "Running" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Blocked" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "issues.queues.blocked 1" }));
  expect(screen.getByRole("link", { name: "Blocked" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Running" })).toBeNull();
});
it("clearing filters keeps the selected queue", () => {
  window.history.replaceState({}, "", "/issues?queue=needs_me&priority=high");
  show();
  fireEvent.click(screen.getAllByRole("button", { name: "backlog.clear_filters" })[0]);
  expect(new URL(window.location.href).searchParams.get("queue")).toBe("needs_me");
  expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
});

it("keeps project loading failures visible after replacing the project rail", () => {
  render(<QueryClientProvider client={new QueryClient()}><Workspace projectsStatus="error" /></QueryClientProvider>);
  expect(screen.getByRole("alert").textContent).toContain("project.load_failed");
  expect(screen.getByRole("button", { name: "project.retry" })).toBeTruthy();
});

it("offers every task filter in the chip bar and applies a chosen one to the list and URL", () => {
  show(undefined, [task("Unassigned", "p"), { ...task("Agent", "p"), assignedAgentId: "a" },
    { ...task("Team", "p"), assignedTeamId: "team-a" }, { ...task("Legacy", "p"), assignedAgent: "codex" }]);
  for (const name of ["project.projects", "backlog.priority", "backlog.due", "backlog.agent", "backlog.team_filter", "backlog.assignment_filter", "backlog.source"]) {
    expect(screen.getByRole("combobox", { name })).toBeTruthy();
  }
  expect(screen.getByRole("textbox", { name: "backlog.assignee_filter" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "backlog.assignment_filter" }), { target: { value: "unassigned" } });
  const rows = screen.getByRole("table", { name: "issues.title" });
  expect(within(rows).getAllByRole("link").map((link) => link.textContent)).toEqual(["Unassigned"]);
  expect(new URL(window.location.href).searchParams.get("assignment")).toBe("unassigned");
});
it("restores combined team and assignment filters from the URL", () => {
  window.history.replaceState({}, "", "/issues?team=team-a&assignment=assigned");
  show(undefined, [task("Unassigned", "p"), { ...task("Team A", "p"), assignedTeamId: "team-a" },
    { ...task("Team B", "p"), assignedTeamId: "team-b" }]);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Team A"]);
});
it("draws a filter restored from the URL as a chip, and removing it clears the URL", () => {
  window.history.replaceState({}, "", "/issues?priority=high");
  show();
  const priority = screen.getByRole("combobox", { name: "backlog.priority" }) as HTMLSelectElement;
  expect(priority.value).toBe("high");
  fireEvent.change(priority, { target: { value: "" } });
  expect(new URL(window.location.href).searchParams.has("priority")).toBe(false);
});
