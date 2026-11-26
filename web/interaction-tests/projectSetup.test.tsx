import { createContext, useContext, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectDrawer } from "../src/components/ProjectDrawer";
import { ProjectTaskPlanning } from "../src/components/ProjectDashboard";
import { ProjectSetupPanel } from "../src/components/ProjectSetupPanel";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { DaemonNodeMonitorRecord, ProjectRecord, ProjectSetup } from "../src/types";

vi.unmock("@/components/ui/dialog");

const { create, startSetup, update, applyTasks, getProjectSetup, checkProjectWorkspace } = vi.hoisted(() => ({
  create: vi.fn(), startSetup: vi.fn(), update: vi.fn(), applyTasks: vi.fn(), getProjectSetup: vi.fn(), checkProjectWorkspace: vi.fn(),
}));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProjectSetup, checkProjectWorkspace }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  createProjectMutation: { isPending: false, mutateAsync: create },
  startProjectSetupMutation: { isPending: false, mutateAsync: startSetup },
  updateProjectMutation: { isPending: false, mutateAsync: update },
  applySetupTasksMutation: { isPending: false, mutateAsync: applyTasks },
}) }));
const agents = [
  { id: "ada", displayName: "Ada", defaultRole: "planner", roleLevel: "senior", executorKind: "claude", availability: "ready", enabled: true, placements: [{ computerId: "device:alice:mac", desiredState: "active" }] },
  { id: "bo", displayName: "Bo", executorKind: "codex", availability: "ready", enabled: true, placements: [{ computerId: "device:alice:mac", desiredState: "active" }] },
];
vi.mock("../src/hooks/useUserAgents", () => ({ useUserAgents: () => ({ agents }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children, open }: any) => open ? children : null }));
/* A select whose items are plain buttons, so a test picks an option by name. */
vi.mock("@/components/ui/select", () => {
  const Pick = createContext<(value: string) => void>(() => undefined);
  return {
    Select: ({ children, onValueChange }: { children: ReactNode; onValueChange: (value: string) => void }) => (
      <Pick.Provider value={onValueChange}>{children}</Pick.Provider>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const pick = useContext(Pick);
      return <button type="button" onClick={() => pick(value)}>{children}</button>;
    },
    SelectTrigger: () => null, SelectValue: () => null, SelectGroup: ({ children }: any) => children,
  };
});

const computers = [{ id: "node", workspaceId: "mac", userId: "alice", capabilities: ["project-workspaces"] }] as unknown as DaemonNodeMonitorRecord[];
const created = { id: "p", version: 1, name: "Launch the site", members: [], leadAgentId: null, enabled: true } as unknown as ProjectRecord;

beforeEach(() => {
  create.mockReset().mockResolvedValue({ project: created });
  startSetup.mockReset().mockResolvedValue({ project: { ...created, version: 2 }, threadId: "t" });
  update.mockReset().mockResolvedValue({ project: created });
  applyTasks.mockReset().mockResolvedValue({ project: created, tasks: [] });
  getProjectSetup.mockReset();
  checkProjectWorkspace.mockReset().mockResolvedValue({ workspaceHostPath: "/Users/alice/code/app" });
});

function renderProjectDrawer(drawer: ReactNode) {
  return render(drawer, { wrapper: DialogProvider });
}

it("opens on intent and asks for one before drafting", () => {
  renderProjectDrawer(<ProjectDrawer open computers={computers} userId="alice" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "project.setup_draft" }));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.setup_intent_required");
});

it("uses the only Computer and keeps the drafting agent under Advanced", async () => {
  const onSaved = vi.fn();
  renderProjectDrawer(<ProjectDrawer open computers={computers} userId="alice" onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.setup_intent/ }), { target: { value: "Launch the site.\nWith pricing." } });
  expect(screen.queryByText("project_manager.agent")).toBeNull();
  const advanced = screen.getByText("project.setup_advanced");
  expect(advanced.closest("details")?.open).toBe(false);
  fireEvent.click(advanced);
  expect(advanced.closest("details")?.open).toBe(true);
  const setupAgentField = screen.getByText("project.setup_agent").closest("[data-slot='field']") as HTMLElement;
  fireEvent.click(within(setupAgentField).getByRole("button", { name: /^Bo · / }));
  fireEvent.click(screen.getByRole("button", { name: "project.setup_draft" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith({
    name: "Launch the site", description: "Launch the site.\nWith pricing.", daemonNodeId: "node",
    managerAgentId: null, leadAgentId: null, members: [],
  });
  expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Launch the site.\nWith pricing.", agentId: "bo" } });
  expect(onSaved.mock.calls[0][0].version).toBe(2);
});

it("still opens the created project when its setup cannot start", async () => {
  startSetup.mockRejectedValue(new Error("project_setup_unsupported"));
  const onSaved = vi.fn();
  renderProjectDrawer(<ProjectDrawer open computers={computers} userId="alice" onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.setup_intent/ }), { target: { value: "Launch" } });
  fireEvent.click(screen.getByRole("button", { name: "node" }));
  fireEvent.click(screen.getByRole("button", { name: "project.setup_draft" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
});

it("saves a goal when the owner creates a project manually", async () => {
  renderProjectDrawer(<ProjectDrawer open computers={computers} userId="alice" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "project.setup_manual" }));
  fireEvent.change(screen.getByRole("textbox", { name: "project.name" }), { target: { value: "New repo" } });
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.goal/ }), { target: { value: "  Ship pricing  " } });
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "New repo", goal: "Ship pricing", daemonNodeId: "node" })));
});

const linkingComputers = [{ ...computers[0], capabilities: ["project-workspaces", "project-links"] }] as unknown as DaemonNodeMonitorRecord[];

function openManualForm(list: DaemonNodeMonitorRecord[]) {
  renderProjectDrawer(<ProjectDrawer open computers={list} userId="alice" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "project.origin_existing" }));
  fireEvent.change(screen.getByRole("textbox", { name: "project.name" }), { target: { value: "Existing repo" } });
  fireEvent.click(screen.getByRole("button", { name: "node" }));
}

const folderBox = () => screen.getByRole("textbox", { name: /^project\.folder/ });

it("shows the folder before a computer is chosen, and says to choose one", () => {
  renderProjectDrawer(<ProjectDrawer open computers={[...linkingComputers, { ...linkingComputers[0], id: "other" }]} userId="alice" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "project.origin_existing" }));
  expect((folderBox() as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("project.existing_folder_choose_computer")).toBeTruthy();
});

it("keeps the folder visible but disabled on a computer that cannot link one", () => {
  openManualForm(computers);
  expect((folderBox() as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("project.folder_unsupported")).toBeTruthy();
});

it("enables the folder once a linking computer is chosen", () => {
  openManualForm(linkingComputers);
  expect((folderBox() as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByText("project.existing_folder_hint")).toBeTruthy();
});

it("checks the folder with the computer and creates the project in it", async () => {
  checkProjectWorkspace.mockResolvedValue({ workspaceHostPath: "/Users/alice/code/app" });
  openManualForm(linkingComputers);
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.goal/ }), { target: { value: "Maintain the app" } });
  fireEvent.change(folderBox(), { target: { value: " /Users/alice/code/app/ " } });
  fireEvent.blur(folderBox());
  await waitFor(() => expect(checkProjectWorkspace).toHaveBeenCalledWith("node", "/Users/alice/code/app/"));
  await screen.findByText(/^project\.folder_linkable/);
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0]).toMatchObject({ daemonNodeId: "node", workspaceHostPath: "/Users/alice/code/app/", goal: "Maintain the app" });
});

it("asks before linking a folder with a .relay directory even without a blur check", async () => {
  const path = "/Users/alice/code/app";
  checkProjectWorkspace.mockResolvedValue({ workspaceHostPath: path, hasRelayDirectory: true });
  openManualForm(linkingComputers);
  fireEvent.change(folderBox(), { target: { value: path } });
  const form = folderBox().closest("form")!;
  fireEvent.submit(form);

  const dialog = await screen.findByRole("alertdialog", { name: "project.folder_relay_notice_title" });
  expect(checkProjectWorkspace).toHaveBeenCalledWith("node", path);
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "dialog.cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(create).not.toHaveBeenCalled();
  expect(folderBox()).toHaveProperty("value", path);

  fireEvent.submit(form);
  const retry = await screen.findByRole("alertdialog", { name: "project.folder_relay_notice_title" });
  fireEvent.click(within(retry).getByRole("button", { name: "project.folder_relay_continue" }));
  await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    daemonNodeId: "node", workspaceHostPath: path,
  })));
});

it("refuses a relative folder without asking the computer", () => {
  openManualForm(linkingComputers);
  fireEvent.change(folderBox(), { target: { value: "code/app" } });
  fireEvent.blur(folderBox());
  expect(checkProjectWorkspace).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.folder_invalid");
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(create).not.toHaveBeenCalled();
});

it("clears the folder when switching computers before creating the project", async () => {
  const other = { ...linkingComputers[0], id: "other", workspaceId: "other-machine" };
  openManualForm([...linkingComputers, other]);
  fireEvent.change(folderBox(), { target: { value: "/Users/alice/code/app" } });
  fireEvent.click(screen.getByRole("button", { name: "other" }));
  expect((folderBox() as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.existing_folder_required");
  fireEvent.change(folderBox(), { target: { value: "/Users/alice/code/other" } });
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0]).toMatchObject({ daemonNodeId: "other", workspaceHostPath: "/Users/alice/code/other" });
  expect(startSetup).not.toHaveBeenCalled();
});

it("pins the computer's refusal to the folder field", async () => {
  const refusal = Object.assign(new Error("outside"), { status: 422, code: "project_workspace_not_allowed" });
  checkProjectWorkspace.mockRejectedValue(refusal);
  openManualForm(linkingComputers);
  fireEvent.change(folderBox(), { target: { value: "/etc" } });
  fireEvent.blur(folderBox());
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("project.folder_not_allowed"));
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  await waitFor(() => expect(checkProjectWorkspace).toHaveBeenCalledTimes(2));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.folder_not_allowed");
});

const proposedSetup: ProjectSetup = {
  state: "proposed", intent: "Launch", agentId: "ada", threadId: "t", startedAt: "s", finishedAt: "f", draftId: "setup_1",
  proposal: {
    name: "Spring launch", goal: "Ship by Friday", context: "Use Next.js.", leadAgentId: "ada",
    members: [
      { agentId: "ada", role: "reviewer", roleLevel: "junior", responsibilities: "Own the plan" },
      { agentId: "bo", role: "implementer", responsibilities: "Build pages" },
    ],
    tasks: [
      { key: "sitemap", title: "Draft the sitemap", assignedAgentId: "bo" },
      { key: "pages", title: "Build the pages", after: ["sitemap"] },
    ],
  },
};

function renderPanel(setup: ProjectSetup = proposedSetup) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const project = { ...created, version: 3, setup } as ProjectRecord;
  return render(
    <QueryClientProvider client={client}>
      <ProjectSetupPanel project={project} setup={setup} agents={agents as never} onOpenThread={vi.fn()} onManual={vi.fn()} />
    </QueryClientProvider>,
  );
}

it("saves the brief and roster while leaving the draft open to file tasks", async () => {
  getProjectSetup.mockResolvedValue({ setup: proposedSetup, candidates: [] });
  renderPanel();
  expect(screen.getByText("role_levels.senior · admin.v2.agent_role.planner")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "project.instructions · Ada", hidden: true }), {
    target: { value: "Confirm owners before applying" },
  });
  fireEvent.click(screen.getByRole("button", { name: "project.setup_apply_tasks" }));
  await waitFor(() => expect(applyTasks).toHaveBeenCalled());
  const input = update.mock.calls[0][0].input;
  expect(input).toMatchObject({ expectedVersion: 3, name: "Spring launch", goal: "Ship by Friday", leadAgentId: "ada" });
  expect(input).not.toHaveProperty("setupResolution");
  expect(input.members.map((m: { agentId: string }) => m.agentId)).toEqual(["ada", "bo"]);
  expect(input.members[0]).toEqual({
    agentId: "ada", responsibilities: "Own the plan", instructions: "Confirm owners before applying",
    enabled: true, projectManager: true,
  });
  expect(applyTasks).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p", input: {
    draftId: "setup_1", taskKeys: ["sitemap", "pages"], assignedAgentIds: { sitemap: "bo", pages: null },
  } }));
  expect(screen.getByText("project.setup_task_after")).toBeTruthy();
});

it("can apply the brief without creating any tasks", async () => {
  getProjectSetup.mockResolvedValue({ setup: proposedSetup, candidates: [] });
  renderPanel();
  expect(screen.getByText("project.setup_edit_brief").closest("details")?.open).toBe(false);
  const sitemap = screen.getByRole("checkbox", { name: "Draft the sitemap" });
  expect(within(sitemap.closest("li")!).getByText("Bo")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "project.setup_select_none" }));
  expect(sitemap.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "project.setup_select_all" }));
  expect(sitemap.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "project.setup_select_none" }));
  fireEvent.click(screen.getByRole("button", { name: "project.setup_apply" }));
  await waitFor(() => expect(update.mock.calls[0]?.[0].input.setupResolution).toBe("applied"));
  expect(applyTasks).not.toHaveBeenCalled();
});

it("unticks a proposed member who can no longer join and says why", async () => {
  getProjectSetup.mockResolvedValue({
    setup: { ...proposedSetup, proposal: { ...proposedSetup.proposal, members: [
      proposedSetup.proposal!.members![0], { ...proposedSetup.proposal!.members![1], issue: "agent_disabled" },
    ] } },
    candidates: [],
  });
  renderPanel();
  await screen.findByText("project.setup_issue.agent_disabled");
  fireEvent.click(screen.getByRole("button", { name: "project.setup_apply_tasks" }));
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update.mock.calls[0][0].input.members.map((m: { agentId: string }) => m.agentId)).toEqual(["ada"]);
  await waitFor(() => expect(applyTasks).toHaveBeenCalled());
  expect(applyTasks.mock.calls[0][0].input.assignedAgentIds).toEqual({ sitemap: null, pages: null });
});

it("asks for changes in the same thread", async () => {
  getProjectSetup.mockResolvedValue({ setup: proposedSetup, candidates: [] });
  renderPanel();
  expect(screen.queryByRole("textbox", { name: /^project\.setup_revise_label/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "project.setup_revise" }));
  expect(startSetup).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.setup_revise_label/ }), { target: { value: "Drop Bo" } });
  fireEvent.click(screen.getByRole("button", { name: "project.setup_send_revision" }));
  await waitFor(() => expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Drop Bo", revise: true } }));
});

it("creates plan tasks for the owner to start separately", async () => {
  const plan: ProjectSetup = { ...proposedSetup, mode: "plan", proposal: { tasks: proposedSetup.proposal!.tasks } };
  getProjectSetup.mockResolvedValue({ setup: plan, candidates: [] });
  renderPanel(plan);
  expect(screen.queryByText("project.setup_crew")).toBeNull();
  expect(screen.getByText("project.setup_tasks_backlog_hint")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "project.plan_apply_tasks" }));
  await waitFor(() => expect(applyTasks).toHaveBeenCalled());
  expect(update).not.toHaveBeenCalled();
  expect(applyTasks.mock.calls[0][0].input.taskKeys).toEqual(["sitemap", "pages"]);
  expect(applyTasks.mock.calls[0][0].input).not.toHaveProperty("queue");
});

it("offers a retry and the manual path when a draft fails", async () => {
  renderPanel({ ...proposedSetup, state: "failed", error: "setup_no_proposal", proposal: undefined });
  expect(screen.getByText("project.setup_failed_no_proposal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "project.setup_try_again" }));
  await waitFor(() => expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Launch", agentId: "ada" } }));
});

it("keeps plan mode when retrying a failed plan", async () => {
  renderPanel({ ...proposedSetup, mode: "plan", state: "failed", error: "setup_run_failed", proposal: undefined });
  fireEvent.click(screen.getByRole("button", { name: "project.setup_try_again" }));
  await waitFor(() => expect(startSetup).toHaveBeenCalledWith({
    projectId: "p", input: { intent: "Launch", agentId: "ada", mode: "plan" },
  }));
});


it("offers fresh and existing projects and keeps drafting exclusive to fresh projects", () => {
  renderProjectDrawer(<ProjectDrawer open computers={linkingComputers} userId="alice" onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByRole("radio", { name: "project.origin_fresh" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("textbox", { name: /^project\.folder/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "project.origin_existing" }));
  expect(screen.queryByRole("button", { name: "project.setup_draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "project.setup_describe" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "project.name" })).toBeTruthy();
  expect(folderBox()).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "project.origin_fresh" }));
  expect(screen.getByRole("button", { name: "project.setup_draft" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /^project\.folder/ })).toBeNull();
});


it("keeps an existing project's open proposal reviewable without drafting it again", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const project = { ...created, version: 3, setup: proposedSetup, workspaceHostPath: "/Users/alice/code/app" } as ProjectRecord;
  render(
    <QueryClientProvider client={client}>
      <ProjectSetupPanel project={project} setup={proposedSetup} agents={agents as never} onOpenThread={vi.fn()} onManual={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "project.setup_dismiss" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "project.setup_revise" })).toBeNull();
});

it("disables creating an existing project on a computer that cannot link folders", () => {
  openManualForm(computers);
  expect((screen.getByRole("button", { name: "project.create" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("project.existing_folder_required")).toBeNull();
});

it("links to the drafting Thread without exposing its bookkeeping Task", () => {
  const onOpenThread = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const drafting: ProjectSetup = { ...proposedSetup, state: "drafting", proposal: undefined, taskId: "task_setup" };
  render(
    <QueryClientProvider client={client}>
      <ProjectSetupPanel
        project={{ ...created, version: 3, setup: drafting } as ProjectRecord}
        setup={drafting}
        agents={agents as never}
        onOpenThread={onOpenThread}
        onManual={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("button", { name: "project.setup_open_task" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "project.setup_open_thread" }));
  expect(onOpenThread).toHaveBeenCalledWith("t");
});

it("saves a missing goal before starting the first task plan", async () => {
  const project = { ...created, leadAgentId: "ada" };
  render(<ProjectTaskPlanning project={project} empty onOpenBoard={vi.fn()} onAssignLead={vi.fn()} />);
  const submit = screen.getByRole<HTMLButtonElement>("button", { name: "project.plan_save_goal" });
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.goal/ }), { target: { value: "  Ship pricing  " } });
  fireEvent.click(submit);
  await waitFor(() => expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { mode: "plan" } }));
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ input: { expectedVersion: 1, goal: "Ship pricing" } }));
  expect(update.mock.invocationCallOrder[0]).toBeLessThan(startSetup.mock.invocationCallOrder[0]);
});

it("sends the owner to Collaboration when the project has no Lead", () => {
  const onAssignLead = vi.fn();
  render(<ProjectTaskPlanning project={created} empty onOpenBoard={vi.fn()} onAssignLead={onAssignLead} />);
  fireEvent.click(screen.getByRole("button", { name: "project.plan_assign_lead" }));
  expect(onAssignLead).toHaveBeenCalled();
  expect(startSetup).not.toHaveBeenCalled();
});
