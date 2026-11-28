import { createContext, useContext, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkflowsPage } from "../src/components/WorkflowsPage";
import { RelayApiError } from "../src/api";
import { TaskDrawer } from "../src/components/task-board/TaskDrawer";
import { emptyBacklogForm, type TaskBoardFormState } from "../src/lib/taskBoardForm";
import { assignmentComputerId } from "../src/lib/taskAssignment";
import type {
  CurrentUser,
  DaemonNodeMonitorRecord,
  ProjectWorkflowChoice,
  StandaloneWorkflowChoice,
  UserAgent,
  Workflow,
  WorkflowPreview,
} from "../src/types";

const listStandaloneWorkflowPreviews = vi.fn();
const listStandaloneWorkflowChoices = vi.fn();
const listProjectWorkflowChoices = vi.fn();
const getWorkflow = vi.fn();
const saveWorkflow = vi.fn();
const updateWorkflowDraft = vi.fn();
const deleteWorkflow = vi.fn();
const confirmDialog = vi.fn(async () => true);
const promptDialog = vi.fn();

vi.mock("../src/api", () => ({
  listStandaloneWorkflowPreviews: (...args: unknown[]) => listStandaloneWorkflowPreviews(...args),
  listStandaloneWorkflowChoices: (...args: unknown[]) => listStandaloneWorkflowChoices(...args),
  listProjectWorkflowChoices: (...args: unknown[]) => listProjectWorkflowChoices(...args),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
  saveWorkflow: (...args: unknown[]) => saveWorkflow(...args),
  updateWorkflowDraft: (...args: unknown[]) => updateWorkflowDraft(...args),
  deleteWorkflow: (...args: unknown[]) => deleteWorkflow(...args),
  getWorkflowName: vi.fn(),
  listWorkflowPreviews: vi.fn(),
  getTeamWorkflowChoices: vi.fn(),
  RelayApiError: class extends Error {
    constructor(message: string, public status = 500, public code = "") { super(message); }
  },
}));

vi.mock("../src/hooks/useUserAgents", () => ({
  useUserAgents: () => ({ agents: [agentC1, agentC2] }),
}));

vi.mock("@/components/ui/DialogProvider", () => ({
  useDialogs: () => ({ confirm: confirmDialog, announce: vi.fn(), prompt: promptDialog }),
}));

vi.mock("@/components/ui/Drawer", () => ({
  Drawer: ({ open, children, footer, title }: any) => (open ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null),
}));

vi.mock("../src/components/task-board/TaskTagsField", () => ({ TaskTagsField: () => null }));
vi.mock("../src/components/connections/ConnectionGrantField", () => ({ ConnectionGrantField: () => null }));
vi.mock("../src/hooks/useSessionCapabilities", () => ({ useSessionCapabilities: () => ({}) }));
vi.mock("@/components/ListRailResize", () => ({ ListRailResizeHandle: () => null }));
vi.mock("../src/components/MobileTopbarSlot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/MobileTopbarSlot")>();
  return { ...actual, MobileTopbarBack: () => null };
});

vi.mock("@/components/ui/select", () => {
  const Context = createContext<any>({});
  return {
    Select: ({ children, value, onValueChange, disabled }: any) => (
      <Context.Provider value={{ value, onValueChange, disabled }}>{children}</Context.Provider>
    ),
    SelectTrigger: ({ children, id, ...rest }: any) => (
      <button type="button" role="combobox" id={id} aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]}>
        {children}
      </button>
    ),
    SelectValue: ({ children }: any) => {
      const { value } = useContext(Context);
      return <span>{typeof children === "function" ? children(value) : children}</span>;
    },
    SelectContent: ({ children, header }: any) => <div>{header}{children}</div>,
    SelectGroup: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ children, value, disabled }: any) => {
      const choice = useContext(Context);
      return (
        <button
          type="button"
          role="option"
          disabled={disabled || choice.disabled}
          onClick={() => { if (value !== choice.value) choice.onValueChange(value); }}
        >
          {children}
        </button>
      );
    },
  };
});

const currentUser = { userId: "owner", username: "owner" } as CurrentUser;
const computer1 = { id: "node-1", userId: "owner", workspaceId: "m1", displayName: "Mac Studio" } as DaemonNodeMonitorRecord;
const computer2 = { id: "node-2", userId: "owner", workspaceId: "m2", displayName: "Linux Box" } as DaemonNodeMonitorRecord;
const computer1Id = "device:owner:m1";
const computer2Id = "device:owner:m2";

const agentC1 = {
  id: "agent-1",
  displayName: "Ada",
  executorKind: "codex",
  enabled: true,
  availability: "ready",
  supervisorUserId: "owner",
  placements: [{ computerId: computer1Id, desiredState: "active" }],
} as UserAgent;

const agentC2 = {
  id: "agent-2",
  displayName: "Grace",
  executorKind: "claude",
  enabled: true,
  availability: "ready",
  supervisorUserId: "owner",
  placements: [{ computerId: computer2Id, desiredState: "active" }],
} as UserAgent;

const samplePreview: WorkflowPreview = {
  id: "wf-1",
  projectId: null,
  computerId: computer1Id,
  name: "Release Flow",
  enabled: true,
  version: 1,
  createdAt: "2026-11-28T00:00:00Z",
  updatedAt: "2026-11-28T00:00:00Z",
  workflowSteps: [{ id: "s1", name: "Build", agentId: "agent-1", requiresApproval: true }],
};

const sampleFull: Workflow = {
  ...samplePreview,
  ownerUserId: "owner",
  workflowSteps: [{
    id: "s1",
    name: "Build",
    agentId: "agent-1",
    instructions: "Build and verify artifacts",
    acceptanceCriteria: ["Artifacts built"],
    requiresApproval: true,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/workflows");
  listStandaloneWorkflowPreviews.mockResolvedValue({ view: "preview", workflows: [samplePreview] });
  listStandaloneWorkflowChoices.mockResolvedValue({
    workflows: [{
      id: "wf-1",
      name: "Release Flow",
      projectId: null,
      computerId: computer1Id,
      enabled: true,
      stepAgentIds: ["agent-1"],
    } satisfies StandaloneWorkflowChoice],
  });
  listProjectWorkflowChoices.mockResolvedValue({
    workflows: [{
      id: "proj-wf",
      name: "Project Only Flow",
      projectId: "proj-1",
      enabled: true,
      stepAgentIds: ["agent-1"],
    } satisfies ProjectWorkflowChoice],
  });
  getWorkflow.mockResolvedValue({ workflow: sampleFull });
  saveWorkflow.mockResolvedValue({ workflow: sampleFull });
  deleteWorkflow.mockResolvedValue({ deletedWorkflowId: "wf-1" });
});

it("lists standalone workflows, inspects steps, toggles enabled, and deletes without any Team", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelect = vi.fn();
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <WorkflowsPage currentUser={currentUser} nodes={[computer1, computer2]} workflowId={null} onSelectWorkflow={onSelect} />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Release Flow")).toBeTruthy();
  expect(screen.getByText(/Mac Studio/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Release Flow/ }));
  expect(onSelect).toHaveBeenCalledWith("wf-1");

  rerender(
    <QueryClientProvider client={client}>
      <WorkflowsPage currentUser={currentUser} nodes={[computer1, computer2]} workflowId="wf-1" onSelectWorkflow={onSelect} />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Build and verify artifacts")).toBeTruthy();
  expect(screen.getByText("Artifacts built")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "workflows.disable" }));
  await waitFor(() => expect(saveWorkflow).toHaveBeenCalledWith({ enabled: false }, "wf-1"));

  fireEvent.click(screen.getByRole("button", { name: "workflow.delete" }));
  await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith("wf-1"));
  expect(onSelect).toHaveBeenCalledWith(null);
});

function renderPredefinedWorkflow() {
  const workflow: Workflow = {
    ...sampleFull, kind: "predefined", workflowSteps: [],
    predefined: { template: "build_review", memberAgentIds: ["agent-1"], leadAgentId: "agent-1" },
  };
  listStandaloneWorkflowPreviews.mockResolvedValue({ workflows: [workflow] });
  getWorkflow.mockResolvedValue({ workflow });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <WorkflowsPage currentUser={currentUser} nodes={[computer1]} workflowId={workflow.id} onSelectWorkflow={vi.fn()} />
  </QueryClientProvider>);
  return workflow;
}

it("only offers rename for a predefined Workflow and preserves its version", async () => {
  const workflow = renderPredefinedWorkflow();
  promptDialog.mockResolvedValue("  Renamed preset  ");
  saveWorkflow.mockResolvedValue({ workflow: { ...workflow, name: "Renamed preset", version: 2 } });

  const rename = await screen.findByRole("button", { name: "workflow.rename" });
  expect(screen.queryByRole("button", { name: "workflow.edit_steps" })).toBeNull();
  expect(screen.queryByRole("button", { name: "workflows.disable" })).toBeNull();
  expect(screen.queryByRole("button", { name: "workflow.delete" })).toBeNull();
  fireEvent.click(rename);
  await waitFor(() => expect(saveWorkflow).toHaveBeenCalledWith({ name: "Renamed preset", expectedVersion: 1 }, workflow.id));
  expect(promptDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: workflow.name }));
  expect(deleteWorkflow).not.toHaveBeenCalled();
});

it.each([null, "Release Flow", "", "x".repeat(201)])("does not save a cancelled, unchanged or invalid rename (%s)", async value => {
  renderPredefinedWorkflow();
  promptDialog.mockResolvedValue(value);
  fireEvent.click(await screen.findByRole("button", { name: "workflow.rename" }));
  await waitFor(() => expect(promptDialog).toHaveBeenCalled());
  expect(saveWorkflow).not.toHaveBeenCalled();
});

it("explains a rename conflict without changing the predefined Workflow", async () => {
  renderPredefinedWorkflow();
  promptDialog.mockResolvedValue("My edit");
  saveWorkflow.mockRejectedValueOnce(new RelayApiError("Conflict", 409, "workflow_version_conflict"));
  fireEvent.click(await screen.findByRole("button", { name: "workflow.rename" }));
  expect((await screen.findByRole("alert")).textContent).toContain("workflow.rename_conflict");
  expect(screen.getByRole("heading", { name: "Release Flow" })).toBeTruthy();
});

it("assigns and edits standalone workflows in TaskDrawer without exposing Teams or Project workflows", async () => {
  const submit = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["workflows", "choices", "standalone"], {
    workflows: [{
      id: "wf-1",
      name: "Release Flow",
      projectId: null,
      computerId: computer1Id,
      enabled: true,
      stepAgentIds: ["agent-1"],
    } satisfies StandaloneWorkflowChoice],
  });

  function Wrapper({ initial }: { initial: TaskBoardFormState }) {
    const [form, setForm] = useState(initial);
    return (
      <TaskDrawer
        open
        form={form}
        formBaseline={initial.id ? initial : null}
        projects={[]}
        logicalAgents={[agentC1, agentC2]}
        teams={[]}
        saving={false}
        title="Task"
        subtitle=""
        projectChoice="optional"
        onClose={vi.fn()}
        onChange={setForm}
        onSubmit={() => submit(form)}
      />
    );
  }

  const { unmount } = render(
    <QueryClientProvider client={client}>
      <Wrapper initial={{ ...emptyBacklogForm(currentUser), title: "Standalone task" }} />
    </QueryClientProvider>,
  );

  expect(screen.queryByRole("radio", { name: /^backlog\.teams_section/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /^workflow\.workflows/ }));
  expect(screen.queryByRole("option", { name: /Project Only Flow/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Release Flow/ }));
  fireEvent.click(screen.getByRole("button", { name: "backlog.create_task" }));
  expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
    assignedWorkflowId: "wf-1",
    assignedAgentId: "",
    assignedTeamId: "",
  }));

  unmount();

  render(
    <QueryClientProvider client={client}>
      <Wrapper initial={{ ...emptyBacklogForm(currentUser), id: "t-1", title: "Saved standalone", computerId: computer1Id, assignedWorkflowId: "wf-1" }} />
    </QueryClientProvider>,
  );

  expect(screen.getByRole("radio", { name: "backlog.assignment_kind_workflow" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("radio", { name: "backlog.assignment_kind_team" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "workflow.select_workflow" }).textContent).toContain("Release Flow");
});

it("renders migrated predefined standalone workflows with participants and without step editing", async () => {
  const predefinedPreview: WorkflowPreview = {
    id: "team-legacy-1",
    projectId: null,
    computerId: computer1Id,
    kind: "predefined",
    name: "Core Delivery",
    enabled: true,
    version: 1,
    createdAt: "2026-11-28T00:00:00Z",
    updatedAt: "2026-11-28T00:00:00Z",
    workflowSteps: [],
  };
  const predefinedFull: Workflow = {
    ...predefinedPreview,
    ownerUserId: "owner",
    predefined: {
      template: "build_review",
      memberAgentIds: ["agent-1"],
      leadAgentId: "agent-1",
      humanApproval: true,
      acceptanceCriteria: ["Tests pass"],
    },
  };
  listStandaloneWorkflowPreviews.mockResolvedValue({ view: "preview", workflows: [predefinedPreview] });
  getWorkflow.mockResolvedValue({ workflow: predefinedFull });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkflowsPage currentUser={currentUser} nodes={[computer1]} workflowId="team-legacy-1" onSelectWorkflow={vi.fn()} />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("collab_style.build_review")).toBeTruthy();
  expect(screen.getByText("Ada")).toBeTruthy();
  expect(screen.getByText("Tests pass")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "workflow.edit_steps" })).toBeNull();
});

it("derives computerId from the chosen standalone Workflow when a task has none yet", () => {
  expect(assignmentComputerId(
    { assignedWorkflowId: "wf-1" },
    [agentC1, agentC2],
    [],
    [{ id: "wf-1", computerId: computer1Id }],
  )).toBe(computer1Id);
});
