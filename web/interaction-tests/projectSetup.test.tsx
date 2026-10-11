import { createContext, useContext, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectDrawer } from "../src/components/ProjectDrawer";
import { ProjectSetupPanel } from "../src/components/ProjectSetupPanel";
import type { DaemonNodeMonitorRecord, ProjectRecord, ProjectSetup } from "../src/types";

const { create, startSetup, update, createTask, getProjectSetup } = vi.hoisted(() => ({
  create: vi.fn(), startSetup: vi.fn(), update: vi.fn(), createTask: vi.fn(), getProjectSetup: vi.fn(),
}));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProjectSetup }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  createProjectMutation: { isPending: false, mutateAsync: create },
  startProjectSetupMutation: { isPending: false, mutateAsync: startSetup },
  updateProjectMutation: { isPending: false, mutateAsync: update },
  createTaskMutation: { isPending: false, mutateAsync: createTask },
}) }));
const agents = [
  { id: "ada", displayName: "Ada", enabled: true, placements: [{ computerId: "device:alice:mac", desiredState: "active" }] },
  { id: "bo", displayName: "Bo", enabled: true, placements: [{ computerId: "device:alice:mac", desiredState: "active" }] },
];
vi.mock("../src/hooks/useEmployeeAgents", () => ({ useEmployeeAgents: () => ({ agents }) }));
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

const computers = [{ id: "node", workspaceId: "mac", employeeId: "alice", capabilities: ["project-workspaces"] }] as unknown as DaemonNodeMonitorRecord[];
const created = { id: "p", version: 1, name: "Launch the site", members: [], leadAgentId: null, enabled: true } as unknown as ProjectRecord;

beforeEach(() => {
  create.mockReset().mockResolvedValue({ project: created });
  startSetup.mockReset().mockResolvedValue({ project: { ...created, version: 2 }, threadId: "t" });
  update.mockReset().mockResolvedValue({ project: created });
  createTask.mockReset().mockResolvedValue({});
  getProjectSetup.mockReset();
});

it("opens on intent and asks for one before drafting", () => {
  render(<ProjectDrawer open computers={computers} employeeId="alice" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "project.setup_draft" }));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.setup_intent_required");
});

it("creates the project from the intent and asks the chosen agent to draft its setup", async () => {
  const onSaved = vi.fn();
  render(<ProjectDrawer open computers={computers} employeeId="alice" onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.setup_intent/ }), { target: { value: "Launch the site.\nWith pricing." } });
  fireEvent.click(screen.getByRole("button", { name: "node" }));
  fireEvent.click(screen.getByRole("button", { name: "Bo" }));
  fireEvent.click(screen.getByRole("button", { name: "project.setup_draft" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith({
    name: "Launch the site", description: "Launch the site.\nWith pricing.", daemonNodeId: "node", leadAgentId: null, members: [],
  });
  expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Launch the site.\nWith pricing.", agentId: "bo" } });
  expect(onSaved.mock.calls[0][0].version).toBe(2);
});

it("still opens the created project when its setup cannot start", async () => {
  startSetup.mockRejectedValue(new Error("project_setup_unsupported"));
  const onSaved = vi.fn();
  render(<ProjectDrawer open computers={computers} employeeId="alice" onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.setup_intent/ }), { target: { value: "Launch" } });
  fireEvent.click(screen.getByRole("button", { name: "node" }));
  fireEvent.click(screen.getByRole("button", { name: "project.setup_draft" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
});

it("keeps the manual form one click away", () => {
  render(<ProjectDrawer open computers={computers} employeeId="alice" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "project.setup_manual" }));
  expect(screen.getByRole("textbox", { name: "project.name" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "project.create" })).toBeTruthy();
});

const proposedSetup: ProjectSetup = {
  state: "proposed", intent: "Launch", agentId: "ada", threadId: "t", startedAt: "s", finishedAt: "f",
  proposal: {
    name: "Spring launch", goal: "Ship by Friday", context: "Use Next.js.", leadAgentId: "ada",
    members: [
      { agentId: "ada", role: "planner", responsibilities: "Own the plan" },
      { agentId: "bo", role: "implementer", responsibilities: "Build pages" },
    ],
    tasks: [{ title: "Draft the sitemap", assignedAgentId: "bo" }],
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

it("applies a reviewed proposal in one patch and files its tasks", async () => {
  getProjectSetup.mockResolvedValue({ setup: proposedSetup, candidates: [] });
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "project.setup_apply" }));
  await waitFor(() => expect(createTask).toHaveBeenCalled());
  const input = update.mock.calls[0][0].input;
  expect(input).toMatchObject({ expectedVersion: 3, name: "Spring launch", goal: "Ship by Friday", leadAgentId: "ada", setupResolution: "applied" });
  expect(input.members.map((m: { agentId: string }) => m.agentId)).toEqual(["ada", "bo"]);
  expect(createTask).toHaveBeenCalledWith({ title: "Draft the sitemap", projectId: "p", assignedAgentId: "bo" });
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
  fireEvent.click(screen.getByRole("button", { name: "project.setup_apply" }));
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update.mock.calls[0][0].input.members.map((m: { agentId: string }) => m.agentId)).toEqual(["ada"]);
  await waitFor(() => expect(createTask).toHaveBeenCalledWith({ title: "Draft the sitemap", projectId: "p" }));
});

it("asks for changes in the same thread", async () => {
  getProjectSetup.mockResolvedValue({ setup: proposedSetup, candidates: [] });
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "project.setup_revise" }));
  expect(startSetup).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.setup_revise_label/ }), { target: { value: "Drop Bo" } });
  fireEvent.click(screen.getByRole("button", { name: "project.setup_revise" }));
  await waitFor(() => expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Drop Bo", revise: true } }));
});

it("offers a retry and the manual path when a draft fails", async () => {
  renderPanel({ ...proposedSetup, state: "failed", error: "setup_no_proposal", proposal: undefined });
  expect(screen.getByText("project.setup_failed_no_proposal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "project.setup_try_again" }));
  await waitFor(() => expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Launch", agentId: "ada" } }));
});
