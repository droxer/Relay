import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TasksWorkspace } from "../src/components/TasksWorkspace";
import { RoutinesPage } from "../src/components/RoutinesPage";
import { useRelayData, TASKS_QUERY_KEY } from "../src/hooks/useRelayData";
import { createTask, listTasks } from "../src/api";
import type { CurrentUser, RelayTask, TasksResponse } from "../src/types";

vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  listSandboxes: vi.fn(async () => ({ sandboxes: [] })),
  listDaemonNodes: vi.fn(async () => ({ nodes: [] })),
  listSessionSummaries: vi.fn(async () => ({ sessions: [] })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listProjects: vi.fn(async () => ({ projects: [] })),
  getMe: vi.fn(async () => ({ authenticated: true })),
  previewSchedule: vi.fn(async () => ({ summary: "Daily", next: [] })),
  createTask: vi.fn(),
}));
vi.mock("../src/hooks/useUserAgents", () => ({ useUserAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn(), confirm: vi.fn() }) }));
// Keep the real form and page controllers; omit the drawer's portal/animation.
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null }));

const user = { userId: "u", username: "u" } as CurrentUser;
const noop = vi.fn();
const clients: QueryClient[] = [];
function Page({ automation }: { automation: boolean }) {
  const data = useRelayData(undefined, true);
  const props = { tasks: data.tasks, projects: data.projects, nodes: data.nodes, currentUser: user,
    recordTaskId: null, onOpenRecord: noop, onOpenThread: noop, isRefreshing: data.isRefreshing, onRefresh: data.refresh };
  return automation ? <RoutinesPage {...props} /> : <TasksWorkspace {...props} projectsStatus={data.projectsStatus} />;
}
beforeEach(() => {
  vi.mocked(listTasks).mockReset().mockResolvedValue({ tasks: [] });
  vi.mocked(createTask).mockReset();
  window.localStorage.clear();
});
afterEach(() => { clients.splice(0).forEach(client => client.clear()); });

it.each([
  { automation: false, overlap: false }, { automation: false, overlap: true },
  { automation: true, overlap: false }, { automation: true, overlap: true },
])("updates the standalone page after saving (automation: $automation, older fetch: $overlap)", async ({ automation, overlap }) => {
  window.history.replaceState({}, "", automation ? "/automations" : "/tasks");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><Page automation={automation} /></QueryClientProvider>);
  await waitFor(() => expect(client.getQueryState(TASKS_QUERY_KEY)?.status).toBe("success"));

  let finishOldFetch: ((result: TasksResponse) => void) | undefined;
  let oldFetch: Promise<void> | undefined;
  if (overlap) {
    vi.mocked(listTasks).mockImplementationOnce(() => new Promise(resolve => { finishOldFetch = resolve; }));
    act(() => { oldFetch = client.refetchQueries({ queryKey: TASKS_QUERY_KEY, exact: true }); });
    await waitFor(() => expect(finishOldFetch).toBeTypeOf("function"));
  }
  vi.mocked(createTask).mockImplementation(async (input) => ({
    ...input, id: "new-record", title: "New visible record", status: "backlog", priority: "normal",
    ownerUserId: "u", assigneeUserId: "u", description: "", tags: [], linkedSessionIds: [],
    createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", events: [], activity: [],
  }) as RelayTask);

  fireEvent.click(screen.getAllByRole("button", { name: automation ? "routine.new" : "issues.new_issue" })[0]);
  fireEvent.change(screen.getByRole("textbox", { name: "backlog.title_field" }), { target: { value: "New visible record" } });
  fireEvent.click(screen.getByRole("button", { name: automation ? "routine.create" : "backlog.create_task" }));
  await waitFor(() => expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "New visible record" })));
  await waitFor(() => expect(screen.getByRole("link", { name: "New visible record" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: automation ? "routine.create" : "backlog.create_task" })).toBeNull();

  if (finishOldFetch) {
    await act(async () => {
      finishOldFetch!({ tasks: [] });
      await oldFetch;
      // Flush Query observers before checking the rendered rows.
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("link", { name: "New visible record" })).toBeTruthy();
  }
});
