import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectWorkflows } from "../src/components/workflow/ProjectWorkflows";
import { WorkflowEditor } from "../src/components/workflow/WorkflowEditor";
import { listWorkflowPreviews, saveWorkflow, startProjectWorkflow } from "../src/api";
import type { AgentTeam, ProjectRecord, UserAgent, Workflow } from "../src/types";

vi.mock("../src/api", () => ({ listWorkflowPreviews: vi.fn(), saveWorkflow: vi.fn(async () => ({})), deleteWorkflow: vi.fn(), startProjectWorkflow: vi.fn(async () => ({ id: "run" })) }));
vi.mock("../src/hooks/useTeams", () => ({ TEAMS_QUERY_KEY: "teams", TEAM_RECORD_QUERY_KEY: "team-record", useTeams: () => ({ teams: [], isSuccess: true }) }));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ open, children, footer }: any) => open ? <div>{children}{footer}</div> : null }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: async () => true, announce: vi.fn() }) }));
const updateProject = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({ updateProjectMutation: { mutateAsync: updateProject } }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
const project = { id: "p", name: "Launch", ownerUserId: "owner", computerId: "pc", enabled: true, leadAgentId: "a", members: [{ agentId: "a", enabled: true }] } as ProjectRecord;
const agents = [{ id: "a", displayName: "Ada", enabled: true, executorKind: "codex", placements: [] }] as unknown as UserAgent[];
const workflow = { id: "w", ownerUserId: "owner", projectId: "p", name: "Release", enabled: true,
  workflowSteps: [{ id: "build", name: "Build", agentId: "a", instructions: "Build it", acceptanceCriteria: ["Tests pass"], requiresApproval: false }] } as Workflow;
function mount(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(element, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(listWorkflowPreviews).mockResolvedValue({ workflows: [workflow] }); });

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
  const custom = (await screen.findByRole("heading", { name: "Release" })).closest("li")!;
  fireEvent.click(within(custom).getByRole("button", { name: "workflow.start" }));
  fireEvent.change(screen.getByRole("textbox", { name: /workflow.goal/ }), { target: { value: "Ship release" } });
  fireEvent.click(screen.getAllByRole("button", { name: "workflow.start" }).at(-1)!);
  await waitFor(() => expect(startProjectWorkflow).toHaveBeenCalledWith("w", { requestId: expect.any(String), taskGoal: "Ship release" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("run"));
});

it("starts a predefined Workflow even when the custom catalog fails", async () => {
  vi.mocked(listWorkflowPreviews).mockRejectedValue(new Error("Offline catalog"));
  const open = vi.fn();
  mount(<ProjectWorkflows project={{ ...project, leadAgentId: null }} agents={agents} userId="owner" readOnly={false} onOpenThread={open} />);
  await screen.findByText("workflow.load_failed");
  const lead = screen.getByRole("heading", { name: "collab_style.lead_led" }).closest("li")!;
  expect(lead.textContent).toContain("workflow.project_lead_required");
  expect(within(lead).getByRole<HTMLButtonElement>("button", { name: "workflow.start_named" }).disabled).toBe(true);
  const buildReview = screen.getByRole("heading", { name: "collab_style.build_review" }).closest("li")!;
  fireEvent.click(within(buildReview).getByRole("button", { name: "workflow.start_named" }));
  expect(screen.queryByRole("combobox", { name: "workflow.optional_team" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: /workflow.goal/ }), { target: { value: "Ship from Project" } });
  fireEvent.click(screen.getAllByRole("button", { name: "workflow.start" }).at(-1)!);
  await waitFor(() => expect(startProjectWorkflow).toHaveBeenCalledWith("preset:build_review", {
    requestId: expect.any(String), projectId: "p", taskGoal: "Ship from Project",
  }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("run"));
});

it("offers Project workflow creation even with an empty Team directory", async () => {
  vi.mocked(listWorkflowPreviews).mockResolvedValue({ workflows: [] });
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

const pair = { ...project, version: 4, members: [
  { agentId: "a", role: "planner", enabled: true }, { agentId: "b", role: "reviewer", enabled: true }] } as unknown as ProjectRecord;
const both = [...agents, { id: "b", displayName: "Bo", enabled: true, executorKind: "codex", placements: [] }] as unknown as UserAgent[];

it("shows a Predefined Workflow's participants and saves a narrowed selection", async () => {
  mount(<ProjectWorkflows project={pair} agents={both} userId="owner" readOnly={false} onOpenThread={vi.fn()} />);
  const row = (await screen.findByRole("heading", { name: "collab_style.build_review" })).closest("li")!;
  expect(within(row).getByText("workflow.preset_all_agents")).toBeTruthy();
  expect(within(row).getByText("Bo")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "workflow.select_participants_named" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Bo/ }));
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  await waitFor(() => expect(updateProject).toHaveBeenCalledWith({ projectId: "p", input: {
    expectedVersion: 4, predefinedWorkflowChange: { workflowId: "preset:build_review", agentIds: ["a"] } } }));
});

it("shows only the selected Agents and locks the Lead in Lead-led", async () => {
  const narrowed = { ...pair, predefinedWorkflows: { lead_led: { agentIds: ["b"] }, build_review: { agentIds: ["b"] } } } as ProjectRecord;
  mount(<ProjectWorkflows project={narrowed} agents={both} userId="owner" readOnly={false} onOpenThread={vi.fn()} />);
  const buildReview = (await screen.findByRole("heading", { name: "collab_style.build_review" })).closest("li")!;
  expect(within(buildReview).queryByText("Ada")).toBeNull();
  expect(within(buildReview).getByText("Bo")).toBeTruthy();
  const lead = screen.getByRole("heading", { name: "collab_style.lead_led" }).closest("li")!;
  expect(within(lead).getByText("Ada")).toBeTruthy();
  fireEvent.click(within(lead).getByRole("button", { name: "workflow.select_participants_named" }));
  const box = screen.getByRole("checkbox", { name: /Ada/ });
  expect(box.getAttribute("aria-checked") ?? (box as HTMLInputElement).checked).toBeTruthy();
  expect(box.hasAttribute("disabled") || box.getAttribute("aria-disabled") === "true" || box.hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "workflow.preset_reset" }));
  await waitFor(() => expect(updateProject).toHaveBeenCalledWith({ projectId: "p", input: {
    expectedVersion: 4, predefinedWorkflowChange: { workflowId: "preset:lead_led", agentIds: null } } }));
});

it("saves against the Project version when the editor opened", async () => {
  const renderWorkflows = (record: ProjectRecord) =>
    <ProjectWorkflows project={record} agents={both} userId="owner" readOnly={false} onOpenThread={vi.fn()} />;
  const { rerender } = mount(renderWorkflows(pair));
  const row = (await screen.findByRole("heading", { name: "collab_style.build_review" })).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "workflow.select_participants_named" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Bo/ }));
  rerender(renderWorkflows({ ...pair, version: 5 }));
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  await waitFor(() => expect(updateProject).toHaveBeenCalledWith({ projectId: "p", input: {
    expectedVersion: 4, predefinedWorkflowChange: { workflowId: "preset:build_review", agentIds: ["a"] },
  } }));
});

it.each([true, false])("saves independent review as %s when toggled", async (requireIndependentReview) => {
  const record: ProjectRecord = requireIndependentReview ? pair : {
    ...pair,
    predefinedWorkflows: { build_review: { agentIds: null, requireIndependentReview: true } },
  };
  mount(<ProjectWorkflows project={record} agents={both} userId="owner" readOnly={false} onOpenThread={vi.fn()} />);
  const row = (await screen.findByRole("heading", { name: "collab_style.build_review" })).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "workflow.select_participants_named" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "workflow.preset_require_independent_review" }));
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  await waitFor(() => expect(updateProject).toHaveBeenCalledWith({ projectId: "p", input: {
    expectedVersion: 4,
    predefinedWorkflowChange: { workflowId: "preset:build_review", agentIds: null, requireIndependentReview },
  } }));
});

it("blocks a Predefined Workflow whose selection leaves no enabled Agent", async () => {
  const empty = { ...pair, predefinedWorkflows: { build_review: { agentIds: ["gone"] } } } as ProjectRecord;
  mount(<ProjectWorkflows project={empty} agents={both} userId="owner" readOnly={false} onOpenThread={vi.fn()} />);
  const row = (await screen.findByRole("heading", { name: "collab_style.build_review" })).closest("li")!;
  expect(within(row).getByRole<HTMLButtonElement>("button", { name: "workflow.start_named" }).disabled).toBe(true);
});
