import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectWorkspacePage } from "../src/components/ProjectWorkspacePage";
import type { CurrentUser, ProjectRecord, RelayTaskListItem } from "../src/types";

const board = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("../src/components/BacklogPage", () => ({
  BacklogPage: (props: Record<string, unknown>) => {
    board.props = props;
    return <div data-testid="backlog-board" />;
  },
}));
vi.mock("../src/components/ProjectWorkspaceFiles", () => ({ ProjectWorkspaceFiles: () => null }));
vi.mock("../src/components/ProjectMemberEditor", () => ({ ProjectMemberEditor: () => null }));

const user: CurrentUser = { id: "u-1", username: "fei", role: "user", employeeId: "fei" };
const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "p", ownerEmployeeId: "fei", name: "Launch", computerId: "device:fei:m", workspaceLayout: "project",
  workspaceSubpath: "projects/p", leadAgentId: null, members: [], enabled: true, version: 1,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...overrides,
});
const task = (id: string, projectId: string | undefined, deletedAt?: string) =>
  ({ id, title: id, projectId, deletedAt, status: "backlog" }) as unknown as RelayTaskListItem;

function renderPage(record: ProjectRecord, onOpenSettings = vi.fn()) {
  return render(<ProjectWorkspacePage
    project={record} agents={[]} teams={[]} currentUser={user} computers={[]}
    tasks={[task("mine", "p"), task("other", "q"), task("gone", "p", "2026-09-02")]}
    onOpenThread={vi.fn()} onOpenSettings={onOpenSettings} onBack={vi.fn()}
  />);
}

beforeEach(() => {
  board.props = null;
  window.history.replaceState({}, "", "/projects/p");
});

it("opens on General with the description and the agents as sections", () => {
  const onOpenSettings = vi.fn();
  renderPage(project({ description: "Ship the GA release." }), onOpenSettings);
  expect(screen.getByRole("tab", { name: "project.general_tab", selected: true })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "project.description" })).toBeTruthy();
  expect(screen.getByText("Ship the GA release.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: /project\.members/ })).toBeTruthy();
  // The description is edited in Project settings, with the name.
  const description = screen.getByRole("region", { name: "project.description" });
  fireEvent.click(within(description).getByRole("button"));
  expect(onOpenSettings).toHaveBeenCalledOnce();
});

it("says so when a project has no description yet", () => {
  renderPage(project());
  expect(screen.getByText("project.description_empty")).toBeTruthy();
});

it("renders the backlog board on Tasks, scoped to this project's live tasks", async () => {
  renderPage(project());
  fireEvent.click(screen.getByRole("tab", { name: "project.tasks_tab" }));
  await waitFor(() => expect(screen.getByTestId("backlog-board")).toBeTruthy());
  expect(board.props).toMatchObject({ variant: "project", projectId: "p", readOnly: false });
  expect((board.props?.tasks as RelayTaskListItem[]).map((item) => item.id)).toEqual(["mine"]);
});

it("opens a task record over the project instead of leaving for the backlog", async () => {
  window.history.replaceState({}, "", "/projects/p?tab=tasks");
  renderPage(project());
  const onOpenRecord = () => board.props?.onOpenRecord as (id: string | null) => void;
  onOpenRecord()("mine");
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/projects/p?task=mine"));
  // An open task implies Tasks even though the URL does not restate it.
  expect(screen.getByRole("tab", { name: "project.tasks_tab", selected: true })).toBeTruthy();
  // Closing the record returns to the board, not to the default tab.
  onOpenRecord()(null);
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/projects/p?tab=tasks"));
  expect(screen.getByRole("tab", { name: "project.tasks_tab", selected: true })).toBeTruthy();
});

it("leaves an open task behind when the reader switches to General", async () => {
  window.history.replaceState({}, "", "/projects/p?task=mine");
  renderPage(project());
  fireEvent.click(screen.getByRole("tab", { name: "project.general_tab" }));
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/projects/p"));
  expect(screen.getByRole("tab", { name: "project.general_tab", selected: true })).toBeTruthy();
});

it("hands a closed project's board over read-only", () => {
  window.history.replaceState({}, "", "/projects/p?tab=tasks");
  renderPage(project({ enabled: false }));
  expect(board.props).toMatchObject({ readOnly: true });
});
