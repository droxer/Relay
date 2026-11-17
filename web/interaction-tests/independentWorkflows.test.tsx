import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectWorkflows } from "../src/components/workflow/ProjectWorkflows";
import { WorkflowEditor } from "../src/components/workflow/WorkflowEditor";
import { listWorkflows, saveWorkflow, startProjectWorkflow } from "../src/api";
import type { AgentTeam, ProjectRecord, UserAgent, Workflow } from "../src/types";

vi.mock("../src/api", () => ({ listWorkflows: vi.fn(), saveWorkflow: vi.fn(async () => ({})), deleteWorkflow: vi.fn(), startProjectWorkflow: vi.fn(async () => ({ id: "run" })) }));
vi.mock("../src/hooks/useTeams", () => ({ TEAMS_QUERY_KEY: "teams", useTeams: () => ({ teams: [], isSuccess: true }) }));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ open, children }: any) => open ? <div>{children}</div> : null }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: async () => true, announce: vi.fn() }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
const project = { id: "p", name: "Launch", ownerUserId: "owner", computerId: "pc", enabled: true, leadAgentId: "a", members: [{ agentId: "a", enabled: true }] } as ProjectRecord;
const agents = [{ id: "a", displayName: "Ada", enabled: true, executorKind: "codex", placements: [] }] as unknown as UserAgent[];
const workflow = { id: "w", ownerUserId: "owner", projectId: "p", name: "Release", enabled: true,
  workflowSteps: [{ id: "build", name: "Build", agentId: "a", instructions: "Build it", acceptanceCriteria: ["Tests pass"], requiresApproval: false }] } as Workflow;
function mount(element: React.ReactNode) { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(listWorkflows).mockResolvedValue({ workflows: [workflow] }); });

it("creates a Project definition with no Teams or Team fields", async () => {
  const close = vi.fn();
  mount(<WorkflowEditor open project={project} workflow={null} teams={[]} agents={agents} onClose={close} />);
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.team_name" }), { target: { value: "Release" } });
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.step_name" }), { target: { value: "Build" } });
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.step_instructions" }), { target: { value: "Build it" } });
  fireEvent.change(screen.getByRole("textbox", { name: /workflow.step_criteria/ }), { target: { value: "Tests pass" } });
  expect(screen.queryByRole("combobox", { name: "workflow.owning_team" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  await waitFor(() => expect(saveWorkflow).toHaveBeenCalledWith({ name: "Release", projectId: "p", enabled: true,
    workflowSteps: [expect.objectContaining({ agentId: "a", instructions: "Build it" })] }, undefined));
  expect(close).toHaveBeenCalled();
});

it("starts a Project Workflow independently when there are no Teams", async () => {
  const open = vi.fn();
  mount(<ProjectWorkflows project={project} agents={agents} userId="owner" readOnly={false} onOpenThread={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "workflow.start" }));
  fireEvent.change(screen.getByRole("textbox", { name: /workflow.goal/ }), { target: { value: "Ship release" } });
  fireEvent.click(screen.getAllByRole("button", { name: "workflow.start" }).at(-1)!);
  await waitFor(() => expect(startProjectWorkflow).toHaveBeenCalledWith("w", { requestId: expect.any(String), taskGoal: "Ship release" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("run"));
});

it("offers Project workflow creation even with an empty Team directory", async () => {
  vi.mocked(listWorkflows).mockResolvedValue({ workflows: [] });
  mount(<ProjectWorkflows project={project} agents={agents} userId="owner" readOnly={false} onOpenThread={vi.fn()} />);
  expect(await screen.findByText("workflow.project_empty_title")).toBeTruthy();
  expect((screen.getByRole("button", { name: "workflow.create" }) as HTMLButtonElement).disabled).toBe(false);
});


it("creates a Team-owned definition without a Project", async () => {
  const team = { id: "team", name: "Delivery", leadAgentId: "a", memberAgentIds: ["a"] } as AgentTeam;
  mount(<WorkflowEditor open team={team} workflow={null} teams={[team]} agents={agents} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.team_name" }), { target: { value: "Team delivery" } });
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.step_name" }), { target: { value: "Build" } });
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.step_instructions" }), { target: { value: "Build it" } });
  fireEvent.change(screen.getByRole("textbox", { name: /workflow.step_criteria/ }), { target: { value: "Tests pass" } });
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  await waitFor(() => expect(saveWorkflow).toHaveBeenCalledWith(expect.objectContaining({
    name: "Team delivery", ownerTeamId: "team", projectId: null,
  }), undefined));
});
