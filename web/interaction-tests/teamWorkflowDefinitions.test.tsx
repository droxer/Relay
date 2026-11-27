import { expect, it, vi } from "vitest";
import { act, render, renderHook, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { WorkflowEditor } from "../src/components/workflow/WorkflowEditor";
import { saveWorkflow, deleteWorkflow, updateWorkflowDraft } from "../src/api";
import { RelayApiError } from "../src/api-client/client";
import { syncTeamWorkflowUpdate, useInvalidateWorkflows, WORKFLOWS_QUERY_KEY } from "../src/hooks/useProjectWorkflows";
import { teamRecordKey, TEAMS_QUERY_KEY } from "../src/hooks/useTeams";

vi.mock("../src/api", () => ({
  saveWorkflow: vi.fn(async () => ({})),
  updateWorkflowDraft: vi.fn(),
  deleteWorkflow: vi.fn(async () => ({})),
}));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ open, children, footer }: any) => open ? <div>{children}{footer}</div> : null }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: async () => true }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/workflow/WorkflowStepCard", () => ({ WorkflowStepCard: ({ agents }: any) => <li>{agents.map((agent: any) => agent.displayName).join(",")}</li> }));
import { projectWorkflows, workflowTeams } from "../src/lib/workflowTeamDraft";
import { taskAssignmentMutationFields, taskBoardFormsEqual, emptyBacklogForm, teamAssignmentPatch } from "../src/lib/taskBoardForm";
import type { AgentTeam, AgentTeamsResponse, ProjectRecord, TeamWorkflow, WorkflowPreview } from "../src/types";

const project = { id: "project", computerId: "computer", members: [{ agentId: "builder", enabled: true }] } as ProjectRecord;
const workflow = { id: "build", teamId: "team", projectId: "project", name: "Build", enabled: true, workflowSteps: [] } as unknown as TeamWorkflow;
const team = { id: "team", name: "Delivery", computerId: "computer", memberAgentIds: ["builder", "specialist"], enabled: true,
  workflows: [workflow, { ...workflow, id: "fix", name: "Fix" }] } as AgentTeam;

it("lists distinct workflows under their team and filters Project scope", () => {
  expect(projectWorkflows([team], "project").map(item => item.id)).toEqual(["build", "fix"]);
  expect(projectWorkflows([team], "other")).toEqual([]);
  expect(projectWorkflows([{ ...team, deletedAt: "now" }], "project")).toEqual([]);
});

it("lets workflows use Project members from a larger team on the same Computer", () => {
  expect(workflowTeams([team, { ...team, id: "away", computerId: "other" }], project)).toEqual([team]);
});

it("saves workflow selection and clears it when the team changes", () => {
  const form = { ...emptyBacklogForm({ userId: "owner" } as Parameters<typeof emptyBacklogForm>[0]), assignedTeamId: team.id, assignedWorkflowId: workflow.id };
  expect(taskAssignmentMutationFields(form)).toEqual({ assignedAgentId: null, assignedTeamId: "team", assignedWorkflowId: "build" });
  expect(taskBoardFormsEqual(form, { ...form, assignedWorkflowId: "fix" })).toBe(false);
  expect(teamAssignmentPatch("other").assignedWorkflowId).toBe("");
  expect(taskAssignmentMutationFields({ ...form, assignedWorkflowId: "" }).assignedWorkflowId).toBeNull();
});

// Exercise the editor's request boundary without portal placement in jsdom.

const saved = { ...workflow, workflowSteps: [{ id: "implement", name: "Implement", agentId: "builder", instructions: "Build feature", acceptanceCriteria: ["Verified"], requiresApproval: false }] } as TeamWorkflow;

function renderEditor(definition = saved) {
  const onClose = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const editor = (record: TeamWorkflow) => <QueryClientProvider client={queryClient}><WorkflowEditor open project={project} workflow={record} teams={[team]}
    agents={[{ id: "builder", displayName: "Builder", enabled: true }, { id: "outsider", displayName: "Outsider", enabled: true }] as any}
    onClose={onClose} /></QueryClientProvider>;
  const { rerender } = render(editor(definition));
  return { onClose, refresh: (record: TeamWorkflow) => rerender(editor(record)) };
}

it("renames an independent Project Workflow with only the changed name", async () => {
  const { onClose } = renderEditor();
  fireEvent.change(screen.getByRole("textbox", { name: "workflow.team_name" }), { target: { value: "Delivery" } });
  expect(screen.queryByText("Outsider")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  await waitFor(() => expect(saveWorkflow).toHaveBeenCalledWith({ name: "Delivery" }, "build"));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("keeps the draft and its original revision when a workflow changes during editing", async () => {
  const original = { ...saved, version: 5 };
  const { onClose, refresh } = renderEditor(original);
  const name = screen.getByRole("textbox", { name: "workflow.team_name" });
  fireEvent.change(name, { target: { value: "Local change" } });
  refresh({ ...original, name: "Another edit", version: 6 });
  vi.mocked(updateWorkflowDraft).mockRejectedValueOnce(new RelayApiError("Conflict", 409, "workflow_version_conflict"));
  fireEvent.click(screen.getByRole("button", { name: "workflow.save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("workflow.version_conflict");
  expect(updateWorkflowDraft).toHaveBeenCalledExactlyOnceWith(original, { name: "Local change" });
  expect((name as HTMLInputElement).value).toBe("Local change");
  expect(onClose).not.toHaveBeenCalled();
});

it.each([5, 7])("updates Team caches without refetching when their Workflow revision is %s", async version => {
  const base = { ...saved, version: 5, ownerTeamId: team.id, ownerUserId: "user", projectId: null };
  const workflow = { ...base, version: 6, updatedAt: "after",
    workflowSteps: base.workflowSteps.map(step => ({ ...step, name: "Implement release", agentId: "specialist" })) };
  const row = { ...team, workflows: undefined, ownerUserId: "user", version: 12,
    workflowOptions: [{ id: base.id, name: base.name, kind: "steps" as const, version, enabled: true, stepAgentIds: ["builder"], stepCount: 1 }],
  };
  const preview = { ...row, workflowPreviews: [{ ...base, version,
    workflowSteps: [{ id: "implement", name: "Implement", agentId: "builder", requiresApproval: false }] }],
  };
  const client = new QueryClient();
  const rosterKey = [TEAMS_QUERY_KEY, "user"];
  const recordKey = teamRecordKey("user", team.id);
  client.setQueryData(rosterKey, { teams: [row], view: "summary" }, { updatedAt: 100 });
  client.setQueryData(recordKey, { team: preview }, { updatedAt: 100 });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(useInvalidateWorkflows, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await act(() => result.current({ workflow, teamLinkUnchanged: true }, base));
  const cached = client.getQueryData<{ team: AgentTeam }>(recordKey)!.team;
  const roster = client.getQueryData<AgentTeamsResponse>(rosterKey)!.teams[0]!;
  expect(cached.version).toBe(12);
  expect(cached.workflowPreviews?.[0]?.workflowSteps[0]?.name).toBe(version === 5 ? "Implement release" : "Implement");
  expect(cached.workflowPreviews?.[0]?.workflowSteps[0]).not.toHaveProperty("instructions");
  expect(roster.workflowOptions?.[0]).toMatchObject({ version: Math.max(version, 6), stepAgentIds: [version === 5 ? "specialist" : "builder"] });
  expect(client.getQueryState(recordKey)?.dataUpdatedAt).toBe(100);
  expect(invalidate.mock.calls.some(([filter]) => filter?.queryKey?.[0] === TEAMS_QUERY_KEY || filter?.queryKey?.[0] === recordKey[0])).toBe(false);
});

it.each([false, true])("updates a Project Workflow preview without refetching with a linked Team of %s", async linked => {
  const original = { ...saved, version: 5, ownerUserId: "user" };
  const workflow = { ...original, version: 6, updatedAt: "after",
    workflowSteps: original.workflowSteps.map(step => ({ ...step, name: "Implement release" })) };
  const { id, name, agentId, requiresApproval } = original.workflowSteps[0];
  const previewKey = [WORKFLOWS_QUERY_KEY, "preview", original.projectId];
  const choicesKey = [WORKFLOWS_QUERY_KEY, "choices", original.projectId];
  const rosterKey = [TEAMS_QUERY_KEY, "user"];
  const recordKey = teamRecordKey("user", team.id);
  const client = new QueryClient();
  const previous = { ...original, workflowSteps: [{ id, name, agentId, requiresApproval }] };
  client.setQueryData(previewKey, { view: "preview", workflows: [previous] });
  client.setQueryData(choicesKey, { workflows: [{ id: original.id, name: original.name, stepAgentIds: [agentId] }] });
  const row = {
    ...team, workflows: undefined,
    workflowOptions: linked ? [{
      id: original.id, name: original.name, kind: "steps" as const, version: original.version, enabled: true,
    }] : [],
  };
  client.setQueryData(rosterKey, { teams: [row], view: "summary" });
  client.setQueryData(recordKey, { team: { ...row, workflowPreviews: linked ? [previous] : [] } });
  const { result } = renderHook(useInvalidateWorkflows, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await act(() => result.current({ workflow }, original));
  const preview = client.getQueryData<{ workflows: WorkflowPreview[] }>(previewKey)?.workflows[0];
  expect(preview?.workflowSteps).toEqual([{ id, name: "Implement release", agentId, requiresApproval }]);
  const teamPreview = client.getQueryData<{ team: AgentTeam }>(recordKey)?.team.workflowPreviews?.[0];
  expect(teamPreview?.workflowSteps).toEqual(linked ? preview?.workflowSteps : undefined);
  for (const key of [previewKey, choicesKey, rosterKey, recordKey]) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
});

it("updates both Team views from the default-workflow receipt", async () => {
  const client = new QueryClient();
  const recordKey = teamRecordKey("user", team.id);
  const rosterKey = [TEAMS_QUERY_KEY, "user"];
  const initial = { ...team, version: 4, projectId: "project", workflowStepCount: 1,
    defaultWorkflowId: saved.id, projectWorkflowDefaults: { project: saved.id, another: "other-workflow" } };
  const previews = [{ ...saved }];
  client.setQueryData(recordKey, { team: { ...initial, workflowPreviews: previews } });
  client.setQueryData(rosterKey, { view: "summary", teams: [initial] });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await syncTeamWorkflowUpdate(client, "user", team.id, {
    teamId: team.id, baseVersion: 4, version: 5, updatedAt: "after", defaultWorkflowId: "preset:pipeline",
    legacyWorkflow: false, projectDefault: { projectId: "project", workflowId: null },
  });
  const detail = client.getQueryData<{ team: AgentTeam }>(recordKey)!.team;
  const summary = client.getQueryData<AgentTeamsResponse>(rosterKey)!.teams[0];
  for (const view of [detail, summary]) {
    expect(view).toMatchObject({ version: 5, updatedAt: "after", defaultWorkflowId: "preset:pipeline",
      projectWorkflowDefaults: { another: "other-workflow" } });
    expect(view.projectWorkflowDefaults).toEqual({ another: "other-workflow" });
    expect(view).not.toHaveProperty("projectId");
    expect(view).not.toHaveProperty("workflowStepCount");
  }
  expect(detail.workflowPreviews).toBe(previews);
  expect(invalidate).not.toHaveBeenCalled();
});

it("refreshes only the stale Team view and preserves a newer roster", async () => {
  const client = new QueryClient();
  const recordKey = teamRecordKey("user", team.id);
  const rosterKey = [TEAMS_QUERY_KEY, "user"];
  const current = { ...team, version: 8, defaultWorkflowId: "preset:lead_led" };
  client.setQueryData(recordKey, { team: { ...team, version: 5 } });
  client.setQueryData(rosterKey, { view: "summary", teams: [current] });
  const fetchRecord = vi.fn(async () => ({ team: current }));
  const fetchRoster = vi.fn(async () => ({ view: "summary", teams: [current] }));
  const stopRecord = new QueryObserver(client, { queryKey: recordKey, queryFn: fetchRecord, staleTime: Infinity }).subscribe(() => {});
  const stopRoster = new QueryObserver(client, { queryKey: rosterKey, queryFn: fetchRoster, staleTime: Infinity }).subscribe(() => {});
  try {
    await syncTeamWorkflowUpdate(client, "user", team.id, {
      teamId: team.id, baseVersion: 6, version: 7, updatedAt: "older", defaultWorkflowId: "preset:pipeline", legacyWorkflow: false,
    });
    expect(fetchRecord).toHaveBeenCalledTimes(1);
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(client.getQueryData(recordKey)).toEqual({ team: current });
    expect(client.getQueryData<AgentTeamsResponse>(rosterKey)?.teams[0]).toEqual(current);
  } finally {
    stopRecord();
    stopRoster();
    client.clear();
  }
});

it.each([false, true])("applies link receipts in server order with stale Team preview %s", async stale => {
  const client = new QueryClient();
  const recordKey = teamRecordKey("user", team.id);
  const rosterKey = [TEAMS_QUERY_KEY, "user"];
  const existing = { ...saved, teamId: team.id, version: 2 };
  const linked = {
    ...existing, id: "linked", name: "Audit", version: 1,
    workflowSteps: [{ id: "review", name: "Review", agentId: "builder", requiresApproval: true }],
  };
  const option = { id: existing.id, name: existing.name, enabled: true, kind: "steps" as const, version: existing.version };
  const row = { ...team, workflows: undefined, version: 4, defaultWorkflowId: "preset:pipeline", workflowOptions: [option] };
  client.setQueryData(rosterKey, { view: "summary", teams: [row] });
  client.setQueryData(recordKey, { team: { ...row, workflowPreviews: [{ ...existing, version: stale ? 1 : 2 }] } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await syncTeamWorkflowUpdate(client, "user", team.id, {
    teamId: team.id, baseVersion: 4, version: 5, updatedAt: "after", workflowId: linked.id,
    workflow: linked, workflowOrder: [{ id: linked.id, version: 1 }, { id: existing.id, version: 2 }],
  });
  expect(client.getQueryData<AgentTeamsResponse>(rosterKey)?.teams[0].workflowOptions?.map(item => item.id))
    .toEqual([linked.id, existing.id]);
  if (stale) {
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: recordKey, exact: true });
    expect(client.getQueryData<{ team: AgentTeam }>(recordKey)?.team.version).toBe(4);
    return;
  }
  const detail = client.getQueryData<{ team: AgentTeam }>(recordKey)?.team;
  expect(detail?.workflowPreviews).toEqual([linked, existing]);
  expect(detail?.workflowOptions?.[0]).toMatchObject({ stepCount: 1, stepAgentIds: ["builder"], version: 1 });
  await syncTeamWorkflowUpdate(client, "user", team.id, {
    teamId: team.id, baseVersion: 5, version: 6, updatedAt: "after", workflowId: linked.id,
    workflow: null, workflowOrder: [{ id: existing.id, version: 2 }],
  });
  expect(client.getQueryData<{ team: AgentTeam }>(recordKey)?.team).toMatchObject({
    version: 6, workflowPreviews: [existing], defaultWorkflowId: "preset:pipeline",
  });
  expect(client.getQueryData<AgentTeamsResponse>(rosterKey)?.teams[0].workflowOptions).toEqual([option]);
  expect(invalidate).not.toHaveBeenCalled();
});

it("deletes only the selected Workflow", async () => {
  const { onClose } = renderEditor();
  fireEvent.click(screen.getByRole("button", { name: "workflow.delete" }));
  await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith("build"));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
