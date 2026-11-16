import { cloneElement, createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WorkflowRun } from "relay-core";
import { WorkflowSlip, workflowNeedsOwner } from "../src/components/composer/WorkflowSlip";
import { WorkflowProgress } from "../src/components/workflow/WorkflowProgress";

// Floating popups do not open under jsdom; render them inline instead.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => createElement("div", null, children),
  DropdownMenuTrigger: ({ render }: any) => cloneElement(render),
  DropdownMenuContent: ({ children }: any) => createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children, onClick, danger: _danger, ...props }: any) => createElement("div", { ...props, role: "menuitem", onClick }, children),
}));
const confirm = vi.fn().mockResolvedValue(true);
vi.mock("@/components/ui/DialogProvider", () => ({
  useDialogs: () => ({ confirm, prompt: vi.fn(), announce: vi.fn() }),
}));

function assignment(step: string, attempt = 1, gated = false) {
  return {
    workflowRunId: "run-1", workflowStepId: step, workflowAttempt: attempt,
    assignmentId: `${step}-a${attempt}`, workItemId: `${step}-w`,
    workOwnerAgentId: `agent-${step}`, workObjective: `do ${step}`,
    awaitApproval: gated, expectedOutputs: [`${step} notes`], acceptanceCriteria: ["ok"],
  };
}

function run(patch: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    workflowRunId: "run-1",
    teamSnapshot: {
      id: "team-1", name: "Ship",
      workflowSteps: [
        { id: "design", name: "Design", agentId: "agent-design", instructions: "x", expectedOutputs: ["x"], acceptanceCriteria: ["x"], kind: "work", requiresApproval: false },
        { id: "deploy", name: "Deploy to staging", agentId: "agent-deploy", instructions: "x", expectedOutputs: ["x"], acceptanceCriteria: ["x"], kind: "deployment", requiresApproval: true },
      ],
    },
    assignments: [assignment("design"), assignment("deploy", 1, true)],
    currentIndex: 1,
    revision: 4,
    status: "awaiting_approval",
    gateDecisions: [],
    attemptResults: [{
      workflowStepId: "design", workflowAttempt: 1, assignmentId: "design-a1", runId: "r", commandId: "c",
      timestamp: "2026-11-16T00:00:00Z", status: "succeeded", outputs: { "design notes": "Use the queue." },
    }],
    startedAt: "2026-11-16T00:00:00Z",
    ...patch,
  };
}

it("asks only while the owner must act", () => {
  expect(workflowNeedsOwner(run())).toBe(true);
  expect(workflowNeedsOwner(run({ status: "blocked" }))).toBe(true);
  expect(workflowNeedsOwner(run({ status: "ready" }))).toBe(false);
  expect(workflowNeedsOwner(undefined)).toBe(false);
});

it("approves exactly the attempt it shows, bound to the run revision", async () => {
  const decide = vi.fn().mockResolvedValue(undefined);
  render(<WorkflowSlip run={run()} decide={decide} />);
  const slip = screen.getByRole("region", { name: "workflow.gate_title" });
  expect(document.activeElement).toBe(within(slip).getByRole("heading"));
  const rows = within(within(slip).getByRole("list")).getAllByRole("button");
  expect(rows.map((row) => row.querySelector(".awaiting-input-choice-label")?.textContent)).toEqual(["workflow.approve", "workflow.reject"]);
  fireEvent.click(rows[0]);
  await waitFor(() => expect(decide).toHaveBeenCalledOnce());
  expect(decide).toHaveBeenCalledWith("approve", {
    workflowRunId: "run-1", workflowStepId: "deploy", workflowAttempt: 1,
    assignmentId: "deploy-a1", expectedRevision: 4,
  });
});

it("offers retry with the stop's reason when a step is blocked, and cancels only after confirming", async () => {
  const decide = vi.fn().mockResolvedValue(undefined);
  const blocked = run({
    status: "blocked",
    currentIndex: 0,
    assignments: [assignment("design", 2), assignment("deploy", 1, true)],
    attemptResults: [{
      workflowStepId: "design", workflowAttempt: 2, assignmentId: "design-a2", runId: "r", commandId: "c",
      timestamp: "t", status: "blocked", reason: "workflow_outputs_required", outputs: {},
    }],
  });
  render(<WorkflowSlip run={blocked} decide={decide} />);
  expect(screen.getByText("workflow.reason.workflow_outputs_required")).toBeTruthy();
  expect(screen.queryByText("workflow.approve")).toBeNull();
  fireEvent.click(screen.getByText("workflow.retry").closest("button")!);
  await waitFor(() => expect(decide).toHaveBeenCalledWith("retry", expect.objectContaining({ workflowAttempt: 2, assignmentId: "design-a2" })));
  fireEvent.click(screen.getByRole("menuitem", { name: "workflow.cancel_run" }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith("cancel", expect.objectContaining({ workflowStepId: "design" })));
  expect(confirm).toHaveBeenCalledOnce();
});

it("reads status in words and keeps recorded outputs in the timeline", () => {
  render(<WorkflowProgress run={run()} agentName={(id) => `name:${id}`} />);
  expect(screen.getByText("workflow.status_awaiting_approval")).toBeTruthy();
  expect(screen.getByText("workflow.step_done")).toBeTruthy();
  expect(screen.getByText("workflow.step_waiting")).toBeTruthy();
  expect(screen.getByText("Use the queue.")).toBeTruthy();
  expect(screen.getByText("name:agent-design")).toBeTruthy();
});

it("retains a failed attempt's reason after a successful retry", () => {
  const completed = run({
    assignments: [assignment("design", 2), assignment("deploy", 1, true)],
    attemptResults: [
      { workflowStepId: "design", workflowAttempt: 1, assignmentId: "design-a1", runId: "r1", commandId: "c1",
        timestamp: "2026-11-16T00:00:00Z", status: "blocked", reason: "workflow_outputs_required", outputs: {} },
      { workflowStepId: "design", workflowAttempt: 2, assignmentId: "design-a2", runId: "r2", commandId: "c2",
        timestamp: "2026-11-16T00:01:00Z", status: "succeeded", outputs: { "design notes": "Recorded retry output" } },
    ],
  });
  render(<WorkflowProgress run={completed} agentName={(id) => id} />);
  expect(screen.getByText("workflow.reason.workflow_outputs_required")).toBeTruthy();
  expect(screen.getByText("Recorded retry output")).toBeTruthy();
  const attempts = screen.getAllByTestId("workflow-attempt");
  expect(attempts.map((item) => item.getAttribute("data-attempt"))).toEqual(["1", "2"]);
  expect(attempts.map((item) => item.getAttribute("data-state"))).toEqual(["blocked", "succeeded"]);
});

it("shows recorded evidence, notes, timestamps and owner decisions in the frozen timeline", () => {
  const frozen = run();
  frozen.attemptResults![0].evidence = ["Verified against saved design"];
  frozen.attemptResults![0].note = "Design accepted";
  frozen.gateDecisions = [{ ...frozen.assignments[1], expectedRevision: 3, kind: "approve", timestamp: "2026-11-16T01:00:00Z" }];
  render(<WorkflowProgress run={frozen} agentName={id => id} expanded />);
  expect(screen.getByText("Verified against saved design")).toBeTruthy();
  expect(screen.getByText("Design accepted")).toBeTruthy();
  expect(screen.getByText("workflow.decision_approve")).toBeTruthy();
  expect(document.querySelector('time[datetime="2026-11-16T00:00:00Z"]')).toBeTruthy();
});


it("shows acceptance criteria at approval without listing expected outputs", () => {
  render(<WorkflowSlip run={run()} decide={vi.fn()} />);
  expect(screen.getByText("workflow.gate_criteria")).toBeTruthy();
  expect(screen.queryByText("workflow.gate_outputs")).toBeNull();
});

it("quotes a step's question and sends the owner's picked or written answer", async () => {
  const decide = vi.fn().mockResolvedValue(undefined);
  const asking = run({
    status: "awaiting_input",
    currentIndex: 1,
    attemptResults: [...(run().attemptResults ?? []), {
      workflowStepId: "deploy", workflowAttempt: 1, assignmentId: "deploy-a1", runId: "r2", commandId: "c2",
      timestamp: "2026-11-16T00:01:00Z", status: "question", reason: "workflow_question", outputs: {},
      question: "Which region?", options: ["us-east", "eu-west"],
    }],
  });
  expect(workflowNeedsOwner(asking)).toBe(true);
  render(<WorkflowSlip run={asking} decide={decide} />);
  const slip = screen.getByRole("region", { name: "workflow.question_title" });
  expect(within(slip).getByText("Which region?")).toBeTruthy();
  const rows = within(within(slip).getByRole("list")).getAllByRole("button");
  expect(rows.map((row) => row.querySelector(".awaiting-input-choice-label")?.textContent)).toEqual(["us-east", "eu-west"]);
  fireEvent.click(rows[1]);
  await waitFor(() => expect(decide).toHaveBeenCalledOnce());
  const binding = { workflowRunId: "run-1", workflowStepId: "deploy", workflowAttempt: 1, assignmentId: "deploy-a1", expectedRevision: 4 };
  expect(decide).toHaveBeenLastCalledWith("answer", binding, "eu-west");
  const send = within(slip).getByRole("button", { name: "workflow.answer_send" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(slip).getByRole("textbox", { name: "workflow.answer_label" }), { target: { value: "  both, us first " } });
  fireEvent.click(send);
  await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  expect(decide).toHaveBeenLastCalledWith("answer", binding, "both, us first");
  expect(within(slip).queryByText("workflow.retry")).toBeNull();
});
