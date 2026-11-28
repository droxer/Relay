import { createContext, useContext, type ReactNode } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkflowSelect } from "../src/components/workflow/WorkflowSelect";
import { WorkflowEditor } from "../src/components/workflow/WorkflowEditor";
import { TeamWorkflowLibrary } from "../src/components/workflow/TeamWorkflowLibrary";
import { ProjectWorkflows } from "../src/components/workflow/ProjectWorkflows";
import { taskAssignmentOptions } from "../src/lib/taskAssignment";
import { defaultWorkflowId, explicitTaskWorkflowId, workflowSelectionIssue } from "../src/lib/workflowSelection";
import { getTeamWorkflowChoices, saveWorkflow, listWorkflowPreviews, listProjectWorkflowChoices, linkTeamWorkflow, setTeamProjectWorkflow, deleteWorkflow } from "../src/api";
import type { AgentTeam, ProjectRecord, TeamWorkflow, UserAgent } from "../src/types";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock("../src/api", () => ({ getTeamWorkflowChoices: vi.fn(), updateTeam: vi.fn(async () => ({})), saveWorkflow: vi.fn(), deleteWorkflow: vi.fn(), startProjectWorkflow: vi.fn(), listWorkflowPreviews: vi.fn(), listProjectWorkflowChoices: vi.fn(), linkTeamWorkflow: vi.fn(async () => ({})), setTeamProjectWorkflow: vi.fn(async () => ({})) }));
vi.mock("../src/hooks/useTeams", () => ({ TEAMS_QUERY_KEY: "teams", TEAM_RECORD_QUERY_KEY: "team-record", teamRecordKey: (...parts: string[]) => ["team-record", ...parts], useTeams: () => ({ teams: [team], isSuccess: true }) }));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ open, children, footer }: any) => open ? <div>{children}{footer}</div> : null }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm, announce: vi.fn() }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/workflow/WorkflowStepCard", () => ({ WorkflowStepCard: ({ step, errors }: any) => <li><span data-testid="assignee">{step.agentId}</span>{errors?.agentId && <p role="alert">{errors.agentId}</p>}</li> }));
vi.mock("@/components/ui/select", () => {
  const Context = createContext<any>({});
  return {
    Select: ({ children, value, onValueChange, disabled }: any) => <Context.Provider value={{ value, onValueChange, disabled }}>{children}</Context.Provider>,
    SelectTrigger: ({ children, ...rest }: any) => <div role="combobox" aria-label={rest["aria-label"]}>{children}</div>,
    SelectValue: ({ children }: any) => { const { value } = useContext(Context); return <span>{typeof children === "function" ? children(value) : children}</span>; },
    SelectContent: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ children, value, disabled }: any) => { const choice = useContext(Context); return <button type="button" role="option" disabled={disabled || choice.disabled} onClick={() => choice.onValueChange(value)}>{children}</button>; },
  };
});

const project = { id: "p", name: "Website", ownerUserId: "owner", enabled: true, computerId: "c", members: [{ agentId: "a", enabled: true }] } as ProjectRecord;
const workflow = { id: "w", teamId: "t", projectId: "p", name: "Ship", enabled: true, workflowSteps: [{ id: "s", name: "Build", agentId: "a", instructions: "Build it", acceptanceCriteria: ["Tests pass"], requiresApproval: false }] } as TeamWorkflow;
const team = { id: "t", name: "Delivery", ownerUserId: "owner", enabled: true, computerId: "c", memberAgentIds: ["a", "b"], members: [], workflows: [workflow], defaultWorkflowId: "w" } as unknown as AgentTeam;
const agents = [{ id: "a", displayName: "Ada", enabled: true }, { id: "b", displayName: "Ben", enabled: true }] as UserAgent[];
function mount(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  const choice = { id: "w", name: "Ship", projectId: "p" };
  vi.mocked(getTeamWorkflowChoices).mockResolvedValue({ projects: [{ id: project.id, name: project.name }], workflows: [choice] });
  vi.mocked(listWorkflowPreviews).mockResolvedValue({ workflows: [workflow] });
  vi.mocked(listProjectWorkflowChoices).mockResolvedValue({ workflows: [{ ...choice, enabled: true, stepAgentIds: ["a"] }] });
  confirm.mockResolvedValue(true);
});

it("marks incompatible inherited defaults unavailable before Task save", () => {
  mount(<WorkflowSelect team={team} projectId="other" inherit value={null} onChange={vi.fn()} />);
  expect((screen.getByRole("option", { name: "workflow.inherit_default" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("workflow.incompatible_project");
});

it("keeps compatible inheritance available", () => {
  mount(<WorkflowSelect team={team} projectId="p" inherit value={null} onChange={vi.fn()} />);
  expect((screen.getByRole("option", { name: "workflow.inherit_default" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("changes only the Team default for this Project", async () => {
  mount(<TeamWorkflowLibrary team={{ ...team, defaultWorkflowId: "preset:pipeline" }} agents={agents} userId="owner" />);
  const row = (await screen.findByText("Ship")).closest("li")!;
  fireEvent.click(await within(row).findByRole("button", { name: "workflow.set_project_default" }));
  await waitFor(() => expect(setTeamProjectWorkflow).toHaveBeenCalledWith("t", "p", "w"));
});

it("shows a retry when Team Workflow choices fail to load", async () => {
  vi.mocked(getTeamWorkflowChoices).mockRejectedValueOnce(new Error("offline"));
  mount(<TeamWorkflowLibrary team={team} agents={agents} userId="owner" />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("workflow.assign_hint")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "workspace.retry" }));
  await waitFor(() => expect(getTeamWorkflowChoices).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("link", { name: "Website" })).toBeTruthy();
});

it("preserves step ownership and flags invalid assignees when Project changes", () => {
  const other = { ...project, id: "q", name: "Docs", members: [{ agentId: "b", enabled: true }] } as ProjectRecord;
  mount(<WorkflowEditor open project={project} projects={[project, other]} workflow={null} teams={[team]} agents={agents} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("option", { name: "Docs" }));
  expect(screen.getByTestId("assignee").textContent).toBe("a");
  expect(screen.getByText("not_member")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  expect(saveWorkflow).not.toHaveBeenCalled();
});

it("manages and starts the independent Workflow in its Project", async () => {
  mount(<ProjectWorkflows project={project} agents={agents} userId="owner" readOnly={false} onOpenThread={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "workflow.edit_steps" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "workflow.start" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "workflow.start_named" })).toHaveLength(2);
});

it("shows the independent review setting and explains why a solo Build and review cannot start", () => {
  const strictProject = {
    ...project,
    predefinedWorkflows: { build_review: { agentIds: null, requireIndependentReview: true } },
  } satisfies ProjectRecord;
  mount(<ProjectWorkflows project={strictProject} agents={agents} userId="owner" readOnly={false} onOpenThread={vi.fn()} />);

  const row = screen.getByRole("heading", { name: "collab_style.build_review" }).closest("li");
  if (!row) throw new Error("Build and review workflow row is missing");
  expect(within(row).getByRole("button", { name: "workflow.start_named" }).hasAttribute("disabled")).toBe(true);
  expect(within(row).getByText("workflow.project_reviewer_required")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "workflow.select_participants_named" }));
  expect(screen.getByRole("checkbox", { name: "workflow.preset_require_independent_review" }).getAttribute("aria-checked")).toBe("true");
});

it("shows legacy definitions in the same Team library", async () => {
  mount(<TeamWorkflowLibrary team={{ ...team, projectId: "p", workflowSteps: workflow.workflowSteps }} agents={agents} userId="owner" />);
  // The Project's name is the link to its Workflows tab.
  const link = await screen.findByRole("link", { name: "Website" });
  expect(link.getAttribute("href")).toContain("tab=members");
  expect(link.closest(".workflow-project-origin")?.textContent).toContain("workflow.project_origin");
});

it("unassigns a reference without deleting the Project definition", async () => {
  mount(<TeamWorkflowLibrary team={{ ...team, defaultWorkflowId: "preset:pipeline" }} agents={agents} userId="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "workflow.unassign" }));
  await waitFor(() => expect(linkTeamWorkflow).toHaveBeenCalledWith("t", "w", false));
  expect(deleteWorkflow).not.toHaveBeenCalled();
});

it("explains an unavailable explicit selection", () => {
  mount(<WorkflowSelect team={team} projectId="p" inherit value="deleted" onChange={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("workflow.unavailable_selection");
});

it("prevents custom inheritance on a Projectless Automation", () => {
  mount(<WorkflowSelect team={team} restrictToProject inherit value={null} onChange={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("workflow.incompatible_project");
});

it("excludes Project Teams even when their custom Workflow fits the roster", () => {
  const placed = agents.map(agent => ({ ...agent, placements: [{ computerId: "c", desiredState: "active" }] })) as UserAgent[];
  expect(taskAssignmentOptions({ project, agents: placed, teams: [team], assigneeUserId: "owner" }).teams.map(item => item.id)).toEqual([]);
});

it("excludes Project Teams even when a Workflow picker is available", () => {
  const placed = agents.map(agent => ({ ...agent, placements: [{ computerId: "c", desiredState: "active" }] })) as UserAgent[];
  const input = { project, agents: placed, teams: [{ ...team, defaultWorkflowId: "preset:pipeline" }], assigneeUserId: "owner" };
  expect(taskAssignmentOptions(input).teams).toEqual([]);
  expect(taskAssignmentOptions({ ...input, allowWorkflowSelection: true }).teams.map(item => item.id)).toEqual([]);
});

it("excludes Project Teams even with a compatible Project default", () => {
  const placed = agents.map(agent => ({ ...agent, placements: [{ computerId: "c", desiredState: "active" }] })) as UserAgent[];
  const scoped = { ...team, defaultWorkflowId: "preset:pipeline", projectWorkflowDefaults: { p: team.workflows![0].id } };
  expect(taskAssignmentOptions({ project, agents: placed, teams: [scoped], assigneeUserId: "owner" }).teams.map(item => item.id)).toEqual([]);
});

it("offers only the custom process when the rest of the Team is outside the Project", () => {
  mount(<WorkflowSelect team={team} projectId="p" projectAgentIds={["a"]} inherit value={null} onChange={vi.fn()} />);
  expect(screen.queryByRole("option", { name: /collab_style.pipeline/ })).toBeNull();
  expect(screen.getByRole("option", { name: /Ship/ })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("requires a replacement if a step's Agent leaves the Project", () => {
  mount(<WorkflowSelect team={team} projectId="p" projectAgentIds={["b"]} inherit value={null} onChange={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("workflow.unavailable_selection");
});

it("keeps canonical selections ahead of legacy style aliases", () => {
  expect(defaultWorkflowId({ ...team, collaborationStyle: "pipeline" })).toBe("w");
  expect(defaultWorkflowId({ collaborationStyle: "pipeline" } as AgentTeam)).toBe("preset:pipeline");
  expect(defaultWorkflowId({ ...team, defaultWorkflowId: undefined, projectId: "p" })).toBe("t");
  expect(defaultWorkflowId()).toBe("preset:build_review");
  expect(explicitTaskWorkflowId({ assignedWorkflowId: "w", collaborationStyle: "pipeline" })).toBe("w");
  expect(explicitTaskWorkflowId({ collaborationStyle: "solo" })).toBe("preset:build_review");
  expect(explicitTaskWorkflowId({ collaborationStyle: "lead_led" })).toBe("preset:lead_led");
  expect(explicitTaskWorkflowId({})).toBeUndefined();
});

it("refuses disabled defaults but leaves individual Agent work alone", () => {
  expect(workflowSelectionIssue(undefined, null, "p")).toBeNull();
  expect(workflowSelectionIssue({ ...team, workflows: [{ ...workflow, enabled: false }] }, null, "p")).toBe("unavailable");
});
