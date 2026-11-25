import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectWorkspacePage } from "../src/components/ProjectWorkspacePage";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { removeCachedProjectDiscussion, usePrefetchProjectDiscussions } from "../src/hooks/useProjectDiscussions";
import type { CurrentUser, ProjectRecord, RelayTaskListItem, SessionSummary } from "../src/types";

const automations = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("../src/components/RoutinesPage", () => ({ RoutinesPage: (props: Record<string, unknown>) => { automations.props = props; return <div data-testid="project-automations" />; } }));

const board = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("../src/components/BacklogPage", () => ({
  BacklogPage: (props: Record<string, unknown>) => {
    board.props = props;
    return <div data-testid="backlog-board" />;
  },
}));
vi.mock("../src/components/ProjectWorkspaceFiles", () => ({ ProjectWorkspaceFiles: () => null }));
vi.mock("../src/components/ProjectMemberEditor", () => ({ ProjectMemberEditor: () => null }));

const user: CurrentUser = { id: "u-1", username: "fei", role: "user", userId: "fei" };
const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "p", ownerUserId: "fei", name: "Launch", computerId: "device:fei:m", workspaceLayout: "project",
  workspaceSubpath: "projects/p", leadAgentId: null, members: [], enabled: true, version: 1,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...overrides,
});
const task = (id: string, projectId: string | undefined, deletedAt?: string) =>
  ({ id, title: id, projectId, deletedAt, status: "backlog" }) as unknown as RelayTaskListItem;

function renderPage(record: ProjectRecord, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const actions = { onOpenThread: vi.fn(), onNewThread: vi.fn(), onRenameThread: vi.fn(), onCloseThread: vi.fn() };
  render(
    <QueryClientProvider client={client}>
      <DialogProvider>
        <ProjectWorkspacePage
          project={record} agents={[]} currentUser={user} computers={[]}
          tasks={[
            task("mine", "p"), task("other", "q"), task("gone", "p", "2026-09-02"),
            { ...task("run", "p"), sourceRoutineId: "auto" },
          ]}
          {...actions}
          onDeleted={vi.fn()} onBack={vi.fn()}
        />
      </DialogProvider>
    </QueryClientProvider>,
  );
  return actions;
}

beforeEach(() => {
  board.props = null;
  automations.props = null;
  window.history.replaceState({}, "", "/projects/p");
});

it("opens on the Dashboard, listed first", () => {
  renderPage(project());
  const tabs = screen.getAllByRole("tab");
  expect(tabs[0].textContent).toBe("project.dashboard_tab");
  expect(screen.getByRole("tab", { name: "project.dashboard_tab", selected: true })).toBeTruthy();
  expect(document.querySelector(".project-dashboard")).not.toBeNull();
});

it("offers no second way to the board when nothing needs attention", () => {
  // The Tasks tab sits one row above the dashboard; the card links on only
  // when it held some issues back (projectDashboard.test.tsx).
  renderPage(project());
  expect(screen.queryByRole("button", { name: /project\.dashboard_open_board/ })).toBeNull();
  expect(screen.getByRole("tab", { name: "project.tasks_tab" })).toBeTruthy();
});

function discussion(id: string, title: string, activity?: SessionSummary["taskActivity"]): SessionSummary {
  const stamp = "2026-09-01T00:00:00Z";
  return {
    id, title, taskGoal: title, projectId: "p", ownerUserId: "fei", status: "completed", phase: "done",
    workspacePath: "/workspace", artifactCount: 0, runCount: 2, eventCount: 3,
    createdAt: stamp, updatedAt: stamp,
    taskActivity: activity ?? { awaitsHuman: false, origin: null },
  };
}

it("requests chats on every Project Discussions page and preserves rows when pagination fails", async () => {
  const head = discussion("first", "Release planning");
  const older = discussion("older", "Older rollout", {
    awaitsHuman: true,
    origin: null,
  });
  const requests: URL[] = [];
  let moreFails = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input), window.location.origin);
    if (!url.pathname.endsWith("/threads")) return Response.json({});
    requests.push(url);
    if (url.searchParams.has("q")) return Response.json({ sessions: [], nextCursor: null });
    if (url.searchParams.get("cursor") === "older") {
      if (moreFails) return Response.json({ detail: "Unavailable" }, { status: 503 });
      return Response.json({ sessions: [older], nextCursor: null });
    }
    return Response.json({ sessions: [head], nextCursor: "older" });
  });
  const actions = renderPage(project());
  expect(requests).toHaveLength(0);
  fireEvent.click(screen.getByRole("tab", { name: "project.discussions_tab" }));
  expect(await screen.findByRole("button", { name: /Release planning/ })).toBeTruthy();
  expect(Object.fromEntries(requests[0].searchParams)).toMatchObject({ projectId: "p", view: "summary", include: "activity", kind: "chats" });
  expect(screen.queryByRole("button", { name: "thread.kind_filter_chats" })).toBeNull();
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(screen.queryByRole("heading", { name: "project.discussions_recent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "project.discussions_new" }));
  expect(actions.onNewThread).toHaveBeenCalledWith("p");

  const loadMore = screen.getByRole("button", { name: "project.discussions_load_more" });
  fireEvent.click(loadMore);
  expect((await screen.findByRole("alert")).textContent).toContain("project.discussions_load_older_failed");
  expect(screen.getByRole("button", { name: /Release planning/ })).toBeTruthy();
  moreFails = false;
  fireEvent.click(loadMore);
  const row = await screen.findByRole("button", { name: /Older rollout/ });
  expect(screen.getByRole("list", { name: "thread.group_needs_you" }).contains(row)).toBe(true);
  expect(screen.getByRole("heading", { name: "project.discussions_recent" })).toBeTruthy();
  fireEvent.click(row);
  expect(actions.onOpenThread).toHaveBeenCalledWith("older");
  const rowElement = row.closest("li");
  expect(rowElement?.querySelector("button button")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "thread.rename" })[0]);
  expect(actions.onRenameThread).toHaveBeenCalledWith(expect.objectContaining({ id: "older" }));
  fireEvent.click(screen.getAllByRole("button", { name: "thread.delete" })[0]);
  expect(actions.onCloseThread).toHaveBeenCalledWith("older", "Older rollout");

  fireEvent.change(screen.getByRole("searchbox", { name: "project.discussions_search" }), { target: { value: "launch" } });
  await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe("launch"));
  expect(window.location.search).toBe("?tab=discussions&q=launch");
  expect(requests.every(url => url.searchParams.get("kind") === "chats")).toBe(true);
  expect(await screen.findByText("project.discussions_no_matches")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "project.discussions_new" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "backlog.clear_filters" }));
  expect(window.location.search).toBe("?tab=discussions");
});

it("refreshes only the first Discussions page and keeps loaded history when a row moves up", async () => {
  window.history.replaceState({}, "", "/projects/p?tab=discussions");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const cursors: (string | null)[] = [];
  const first = discussion("first", "Original head");
  const older = { ...discussion("older", "Older discussion"), updatedAt: "2026-08-01T00:00:00Z" };
  let refreshed = false;
  let waitingForHead: Promise<Response> | undefined;
  const updatedHead = () => Response.json({
    sessions: [{ ...older, title: "Updated discussion", updatedAt: "2026-09-02T00:00:00Z" }], nextCursor: "new-head",
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input), window.location.origin);
    if (!url.pathname.endsWith("/threads")) return Response.json({});
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    if (cursor === "history-1") return Response.json({ sessions: [older], nextCursor: "history-2" });
    if (cursor === "history-2") return Response.json({ sessions: [discussion("oldest", "Oldest discussion")], nextCursor: null });
    if (refreshed) return waitingForHead ?? updatedHead();
    return Response.json({ sessions: [first], nextCursor: "history-1" });
  });
  renderPage(project(), client);
  fireEvent.click(await screen.findByRole("button", { name: "project.discussions_load_more" }));
  expect(await screen.findByRole("button", { name: /Older discussion/ })).toBeTruthy();
  refreshed = true;
  await client.invalidateQueries({ queryKey: ["project-discussions", "p"] });
  expect(await screen.findByRole("button", { name: /Updated discussion/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Original head/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Older discussion/ })).toBeNull();
  expect(cursors).toEqual([null, "history-1", null]);
  let respondToHead!: (response: Response) => void;
  waitingForHead = new Promise(resolve => { respondToHead = resolve; });
  const refreshing = client.invalidateQueries({ queryKey: ["project-discussions", "p"] });
  await waitFor(() => expect(cursors).toHaveLength(4));
  fireEvent.click(screen.getByRole("button", { name: "project.discussions_load_more" }));
  expect(await screen.findByRole("button", { name: /Oldest discussion/ })).toBeTruthy();
  expect(cursors.at(-1)).toBe("history-2");
  respondToHead(updatedHead());
  await refreshing;
  removeCachedProjectDiscussion(client, "oldest", "p");
  await waitFor(() => expect(screen.queryByRole("button", { name: /Oldest discussion/ })).toBeNull());
  expect(screen.getByRole("button", { name: /Original head/ })).toBeTruthy();
});

it("shares the filtered Discussions request started before the Project page mounts", async () => {
  window.history.replaceState({}, "", "/projects/p?tab=discussions&q=rollout");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let respond!: (response: Response) => void;
  const waiting = new Promise<Response>(resolve => { respond = resolve; });
  const requests: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input), window.location.origin);
    if (!url.pathname.endsWith("/threads")) return Response.json({});
    requests.push(url);
    return waiting;
  });
  renderHook(() => usePrefetchProjectDiscussions("p", "rollout"), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].searchParams.get("q")).toBe("rollout");
  renderPage(project(), client);
  respond(Response.json({ sessions: [discussion("rollout", "Rollout planning")], nextCursor: null }));
  expect(await screen.findByRole("button", { name: /Rollout planning/ })).toBeTruthy();
  expect(requests).toHaveLength(1);
});

it("shows a single creation action and no search box when the Project has no chats", async () => {
  window.history.replaceState({}, "", "/projects/p?tab=discussions");
  const taskRun = discussion("task-run", "A task run", {
    awaitsHuman: true,
    origin: { kind: "backlog", taskId: "t", title: "Rollout", ref: "#8", status: "review" },
  });
  const automationRun = discussion("automation-run", "An automation run", {
    awaitsHuman: false,
    origin: { kind: "routine", taskId: "r", title: "Daily report", ref: "#9", status: "done" },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    sessions: [taskRun, automationRun], nextCursor: null,
  }));
  const actions = renderPage(project());
  expect(await screen.findByText("project.discussions_empty")).toBeTruthy();
  expect(screen.queryByRole("searchbox", { name: "project.discussions_search" })).toBeNull();
  expect(screen.queryByRole("button", { name: /A task run|An automation run/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "project.discussions_new" }));
  expect(actions.onNewThread).toHaveBeenCalledWith("p");
});

it("keeps archived discussions readable with no creation action", async () => {
  window.history.replaceState({}, "", "/projects/p?tab=discussions");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    sessions: [discussion("past", "Archived planning")], nextCursor: null,
  }));
  const actions = renderPage(project({ archivedAt: "2026-09-01" }));
  fireEvent.click(await screen.findByRole("button", { name: /Archived planning/ }));
  expect(actions.onOpenThread).toHaveBeenCalledWith("past");
  expect(screen.queryByRole("button", { name: "project.discussions_new" })).toBeNull();
});

it("has no General tab; a retired ?tab=general link lands on the Dashboard", () => {
  window.history.replaceState({}, "", "/projects/p?tab=general");
  renderPage(project());
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/u, ""))).toEqual([
    "project.dashboard_tab", "project.tasks_tab", "project.discussions_tab", "routine.title", "workspace.tab_workspace", "project.members_tab", "project.settings_tab",
  ]);
  expect(screen.getByRole("tab", { name: "project.dashboard_tab", selected: true })).toBeTruthy();
});

it("shows the crew's cards and the add action on Members", () => {
  window.history.replaceState({}, "", "/projects/p?tab=members");
  renderPage(project({
    members: [{ agentId: "a1", role: "planner", responsibilities: "Plans the release", enabled: true }],
  } as Partial<ProjectRecord>));
  expect(screen.getByText("Plans the release")).toBeTruthy();
  expect(screen.getByRole("button", { name: /project\.member_add/ })).toBeTruthy();
});

it("carries the project's fixed facts on Settings beside the editable brief", () => {
  window.history.replaceState({}, "", "/projects/p?tab=settings");
  renderPage(project({ description: "Ship the GA release." }));
  expect((screen.getByRole("textbox", { name: /^project\.description/ }) as HTMLTextAreaElement).value).toBe("Ship the GA release.");
  expect(screen.getByText("project.shared_workspace")).toBeTruthy();
  expect(screen.getByText("projects/p")).toBeTruthy();
});

it("hides member management on a closed project's Members tab", () => {
  window.history.replaceState({}, "", "/projects/p?tab=members");
  renderPage(project({
    enabled: false,
    members: [{ agentId: "a1", role: "planner", responsibilities: "Plans", enabled: true }],
  } as Partial<ProjectRecord>));
  expect(screen.queryByRole("button", { name: /project\.member_add/ })).toBeNull();
});

it("renders the backlog board on Tasks, scoped to this project's live tasks, without automation runs", async () => {
  renderPage(project());
  fireEvent.click(screen.getByRole("tab", { name: "project.tasks_tab" }));
  await waitFor(() => expect(screen.getByTestId("backlog-board")).toBeTruthy());
  expect(screen.getByRole("tab", { name: "project.tasks_tab", selected: true }).textContent).toBe("project.tasks_tab1");
  expect(board.props).toMatchObject({ projectId: "p", readOnly: false });
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

it("leaves an open task behind when the reader switches to Members", async () => {
  window.history.replaceState({}, "", "/projects/p?task=mine");
  renderPage(project());
  fireEvent.click(screen.getByRole("tab", { name: "project.members_tab" }));
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/projects/p?tab=members"));
  expect(screen.getByRole("tab", { name: "project.members_tab", selected: true })).toBeTruthy();
});

it("hands a closed project's board over read-only", () => {
  window.history.replaceState({}, "", "/projects/p?tab=tasks");
  renderPage(project({ enabled: false }));
  expect(board.props).toMatchObject({ readOnly: true });
});

it("offers project-scoped automations, with their runs, directly inside a project", () => {
  window.history.replaceState({}, "", "/projects/p?tab=automations");
  renderPage(project());
  expect(screen.getByRole("tab", { name: "routine.title", selected: true })).toBeTruthy();
  expect(screen.getByTestId("project-automations")).toBeTruthy();
  expect(automations.props).toMatchObject({ projectId: "p", readOnly: false });
  expect((automations.props?.tasks as RelayTaskListItem[]).map((item) => item.id)).toEqual(["mine", "run"]);
});

it("keeps a closed project's automations read-only", () => {
  window.history.replaceState({}, "", "/projects/p?tab=automations");
  renderPage(project({ archivedAt: "2026-10-01" }));
  expect(automations.props).toMatchObject({ projectId: "p", readOnly: true });
});

it("opens automations and their runs without leaving the project", async () => {
  window.history.replaceState({}, "", "/projects/p?tab=automations&q=weekly");
  renderPage(project());
  const open = () => automations.props?.onOpenRecord as (id: string | null, runId?: string | null) => void;
  open()("auto");
  await waitFor(() => expect(automations.props).toMatchObject({ recordTaskId: "auto" }));
  expect(window.location.pathname).toBe("/projects/p");
  expect(new URLSearchParams(window.location.search).get("q")).toBe("weekly");
  open()("auto", "run");
  await waitFor(() => expect(automations.props).toMatchObject({ recordTaskId: "auto", recordRunId: "run" }));
  open()(null);
  await waitFor(() => expect(new URLSearchParams(window.location.search).has("automation")).toBe(false));
  expect(screen.getByRole("tab", { name: "routine.title", selected: true })).toBeTruthy();
});
