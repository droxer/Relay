import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { COLLABORATION_STYLES, effectiveStyle, previewSlots, turnSlot, styleForRun, reviewCycle, reviewBudgetExhausted } from "../src/lib/collaborationStyle";
import { TeamWorkflowPreview } from "../src/components/workflow/TeamWorkflowPreview";
import type { AgentTeam, CollaborationStyle } from "../src/types";
import type { SlotMember } from "../src/lib/collaborationStyle";
import { threadMessageInput, threadMessageOperationKey } from "../src/lib/messageRouting";
import { teamMutationInput } from "../src/lib/teamForm";
import { materializeTaskEvents } from "../../packages/relay-core/src/task-store";
import { createTask, updateTask, submitThreadMessage, runLogicalAgents } from "../src/api";
import { TaskRecordDefinition } from "../src/components/task-record/TaskRecordDefinition";
import { MessageBlock } from "../src/components/MessageBlock";
import { taskBoardFormsEqual } from "../src/lib/taskBoardForm";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { PredefinedWorkflowIcon } from "../src/components/workflow/PredefinedWorkflowIcon";

const team = { id: "team", workflows: [] } as unknown as AgentTeam;
/** A predefined Workflow's role preview, rendered the way the Team page does. */
const CollaborationSlotPreview = ({ style, ...rest }: { members: SlotMember[]; leadId?: string; style: CollaborationStyle; approval?: boolean; nameOf: (id: string) => string }) =>
  <TeamWorkflowPreview team={team} workflowId={`preset:${style}`} {...rest} />;

it("gives every predefined workflow a decorative glyph", () => {
  const { container } = render(<>{COLLABORATION_STYLES.map((style) => <PredefinedWorkflowIcon key={style} style={style} />)}</>);
  expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(3);
});

it("states a predefined workflow by name, kind, and meaning above its role slots", () => {
  const { container } = render(<CollaborationSlotPreview members={[{ id: "a", role: "implementer" }, { id: "b", role: "reviewer" }]} leadId="a" style="pipeline" nameOf={(id) => id} />);
  expect(container.querySelector(".workflow-preview")?.getAttribute("data-style")).toBe("pipeline");
  expect(screen.getByText("collab_style.pipeline")).toBeTruthy();
  expect(screen.getByText("workflow.predefined")).toBeTruthy();
  expect(screen.getByText("collab_style.pipeline_hint")).toBeTruthy();
});

it("states a custom workflow in the same frame, with its steps and owners", () => {
  const custom = { ...team, workflows: [{ id: "wf", name: "Ship", projectId: "p", enabled: true,
    workflowSteps: [{ id: "s1", name: "Build", agentId: "a" }, { id: "s2", name: "Verify", agentId: "b", requiresApproval: true }] }] } as unknown as AgentTeam;
  const { container } = render(<TeamWorkflowPreview team={custom} workflowId="wf" members={[]} nameOf={(id) => `agent-${id}`} />);
  expect(container.querySelector(".workflow-preview")?.getAttribute("data-kind")).toBe("steps");
  expect(screen.getByText("Ship")).toBeTruthy();
  expect(screen.getByText("workflow.custom")).toBeTruthy();
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    expect.stringContaining("agent-a"), expect.stringContaining("agent-b"),
  ]);
  expect(screen.getByText("workflow.gate_badge")).toBeTruthy();
});

it("presents the team sequence as an ordered, readable preview", () => {
  render(<CollaborationSlotPreview members={[{ id: "a", role: "implementer" }, { id: "b", role: "reviewer" }]} leadId="a" style="build_review" nameOf={(id) => id} />);
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    expect.stringContaining("a"), expect.stringContaining("b"),
  ]);
});

it("shows the person's approval before the step that closes the round", () => {
  render(<CollaborationSlotPreview members={[{ id: "a", role: "implementer" }, { id: "b", role: "reviewer" }]} leadId="a" style="build_review" approval nameOf={(id) => id} />);
  expect(screen.getAllByRole("listitem").map((item) => item.getAttribute("data-slot"))).toEqual([
    "builder", "approval", "reviewer",
  ]);
  expect(screen.getByText(/collab_style.approval_loop/)).toBeTruthy();
});

it("offers only team styles and normalizes legacy Solo settings", () => {
  expect(COLLABORATION_STYLES).toEqual(["build_review", "pipeline", "lead_led"]);
  expect(effectiveStyle({ collaborationStyle: "solo" })).toBe("build_review");
  expect(effectiveStyle(undefined, "solo")).toBe("build_review");
  // Frozen historical runs still describe what actually ran.
  expect(styleForRun({ teamSnapshot: { collaborationStyle: "solo" } } as never)).toBe("solo");
});

it("mirrors role-based slot filling and excludes on-request specialists", () => {
  expect(effectiveStyle({ collaborationStyle: "pipeline" }, "lead_led")).toBe("lead_led");
  expect(effectiveStyle()).toBe("build_review");
  const members = [{ id: "lead", role: "reviewer" }, { id: "dev", role: "implementer" }, { id: "qa", role: "reviewer", onRequest: true }];
  expect(previewSlots(members, "lead", "build_review").slots).toEqual([
    { slot: "builder", memberId: "dev" }, { slot: "reviewer", memberId: "lead" },
  ]);
  expect(previewSlots(members.slice(0, 1), "lead", "build_review").fallbackFrom).toBe("build_review");
  expect(previewSlots([], undefined, "solo").slots).toEqual([]);
});

it("explains a one-member fallback", () => {
  render(<CollaborationSlotPreview members={[{ id: "a" }]} leadId="a" style="build_review" nameOf={() => "Alice"} />);
  expect(screen.getByText(/collab_style.fallback_solo/)).toBeTruthy();
  expect(screen.getByText(/Alice/)).toBeTruthy();
});

it("persists the team style", () => {
  expect(teamMutationInput({ name: "Team", leadAgentId: "a", memberAgentIds: ["a"], enabled: true, collaborationStyle: "solo" }).collaborationStyle).toBe("solo");
});

it("handles sparse rosters and legacy history", () => {
  expect(effectiveStyle({ collaborationStyle: "pipeline" })).toBe("pipeline");
  expect(previewSlots([{ id: "a", onRequest: true }], "a", "lead_led").slots).toEqual([{ slot: "lead", memberId: "a" }]);
  expect(previewSlots([{ id: "a" }, { id: "b", role: "custom" }], undefined, "pipeline").slots.map((s) => s.memberId)).toEqual(["a", "b"]);
  expect(previewSlots([{ id: "a" }], undefined, "lead_led").slots).toEqual([{ slot: "member", memberId: "a" }]);
  expect(previewSlots([{ id: "a" }, { id: "b" }], undefined, "build_review").slots).toHaveLength(2);
  expect(previewSlots([{ id: "a" }], undefined, "solo").fallbackFrom).toBeUndefined();
  expect(styleForRun({ teamSnapshot: { collaborationStyle: "solo" } } as never)).toBe("solo");
  expect(styleForRun({ teamSnapshot: {} } as never)).toBe("lead_led");
  expect(styleForRun({ assignmentId: "a" }, [{ assignments: [{ assignmentId: "a" }], teamSnapshot: {} }] as never)).toBe("lead_led");
  expect(styleForRun({})).toBeUndefined();
});

it("labels only meaningful turn roles", () => {
  expect(turnSlot({ role: "reviewer" })).toBeNull();
  expect(turnSlot({ coordinator: true }, "lead_led")).toBe("lead");
  expect(turnSlot({ synthesizer: true }, "lead_led")).toBe("lead_summary");
  expect(turnSlot({ role: "reviewer" }, "pipeline")).toBe("reviewer");
  expect(turnSlot({ role: "reviewer", workResult: { status: "done" } }, "build_review")).toBe("reviewer_approved");
  expect(turnSlot({ role: "reviewer", workResult: { status: "continue", findings: [] } }, "build_review")).toBe("reviewer");
  for (const role of ["implementer", "fixer"]) expect(turnSlot({ role }, "solo")).toBe("builder");
  for (const role of ["planner", "tester"]) expect(turnSlot({ role }, "pipeline")).toBe(role);
  expect(turnSlot({}, "solo")).toBeNull();
});

it("does not show repair indicators for missing or inactive rounds", () => {
  expect(reviewCycle({} as never)).toBeNull();
  expect(reviewCycle({ status: "running" } as never)).toBeNull();
  expect(reviewBudgetExhausted({} as never)).toBe(false);
  const round = { style: "build_review", assignments: [] };
  expect(reviewCycle({ status: "running", collaborationRounds: [round] } as never)).toBeNull();
  expect(reviewBudgetExhausted({ workOutcome: "blocked", collaborationRounds: [round] } as never)).toBe(false);
  round.assignments.push({ assignmentId: "b", role: "implementer" } as never);
  expect(reviewCycle({ status: "running", collaborationRounds: [round] } as never)).toBeNull();
  expect(reviewCycle({ status: "running", collaborationRounds: [round], agentRuns: [{ assignmentId: "b" }] } as never)).toBeNull();
});

it("distinguishes styled retries and ignores styles when addressing a member", () => {
  const input = { sessionId: "s", text: "go", intent: "accomplish" as const, addressAgentIds: [] };
  expect(threadMessageOperationKey(input)).toBe(JSON.stringify(["s", "go", "accomplish", []]));
  expect(threadMessageOperationKey({ ...input, style: "solo" })).not.toBe(threadMessageOperationKey(input));
  expect(threadMessageInput({ text: "go", addressAgentIds: [], userMessageId: "m", style: "solo" }).style).toBe("solo");
  expect(threadMessageInput({ text: "go", addressAgentIds: ["a"], userMessageId: "m", style: "solo" }).style).toBeUndefined();
});

it("labels historical runs using their own frozen round", () => {
  const rounds = [
    { style: "lead_led", assignments: [{ assignmentId: "old" }] },
    { style: "build_review", assignments: [{ assignmentId: "new" }] },
  ];
  expect(styleForRun({ assignmentId: "old" }, rounds as never)).toBe("lead_led");
  expect(turnSlot({ role: "reviewer", workResult: { status: "continue", findings: [{}] } }, "build_review")).toBe("reviewer_changes");
});

it.each([
  [["lead", "implementer"], ["qa", "reviewer"], ["dev", "implementer"]],
  [["lead", "planner"], ["fix", "fixer"], ["qa", "tester"]],
  [["lead", "planner"], ["qa", "planner"]],
])("always picks distinct builder and reviewer slots: %j", (...entries) => {
  const members = entries.map(([id, role]) => ({ id, role }));
  const slots = previewSlots(members, "lead", "build_review").slots;
  expect(slots).toHaveLength(2);
  expect(slots[0].memberId).not.toBe(slots[1].memberId);
});

it("orders pipelines stably without mutating the roster", () => {
  const members = [{ id: "r", role: "reviewer" }, { id: "i", role: "implementer" }, { id: "p", role: "planner" }, { id: "t", role: "tester" }, { id: "f", role: "fixer" }];
  const before = structuredClone(members);
  expect(previewSlots(members, "p", "pipeline").slots.map((s) => s.memberId)).toEqual(["p", "i", "f", "t", "r"]);
  expect(previewSlots(members, "p", "lead_led").slots.map((s) => s.memberId)).toEqual(["p", "i", "f", "t", "r", "p"]);
  expect(members).toEqual(before);
});

it("replays task style changes and the explicit inheritance reset", () => {
  const created = { type: "task.created", id: "1", taskId: "t", timestamp: "2026-09-25", title: "T", description: "", priority: "normal", collaborationStyle: "solo" };
  const updated = { type: "task.updated", id: "2", taskId: "t", timestamp: "2026-09-25", collaborationStyle: "pipeline" };
  expect(materializeTaskEvents([created, updated] as never).collaborationStyle).toBe("pipeline");
  expect(materializeTaskEvents([created, { ...updated, collaborationStyle: "" }] as never).collaborationStyle).toBeUndefined();
  expect(materializeTaskEvents([created, { ...updated, collaborationStyle: null }] as never).collaborationStyle).toBe("solo");
});

it("detects style-only form edits", () => {
  const form = { variant: "backlog", collaborationStyle: null };
  expect(taskBoardFormsEqual(form as never, { ...form, collaborationStyle: "solo" } as never)).toBe(false);
  expect(taskBoardFormsEqual(form as never, { ...form, collaborationStyle: undefined } as never)).toBe(true);
});

it("serializes overrides and strips invalid message contexts", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  await createTask({ title: "T", projectId: "p", collaborationStyle: "" });
  await updateTask("t", { collaborationStyle: "" });
  await submitThreadMessage("s", { text: "go", intent: "accomplish", style: "solo" });
  await submitThreadMessage("s", { text: "go", intent: "discuss", style: "solo" });
  await submitThreadMessage("s", { text: "go", intent: "accomplish", addressAgentIds: ["a"], style: "solo" });
  await runLogicalAgents({ taskGoal: "go", teamId: "t", style: "pipeline" });
  expect(bodies[0].collaborationStyle).toBeUndefined();
  expect(bodies[1].collaborationStyle).toBe("");
  expect(bodies.slice(2).map((b) => b.style)).toEqual(["solo", undefined, undefined, "pipeline"]);
});

it("sends a chosen workflow by id and never beside a contradicting style alias", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  await submitThreadMessage("s", { text: "go", intent: "accomplish", workflowId: "preset:lead_led", style: "pipeline" });
  await submitThreadMessage("s", { text: "go", intent: "discuss", workflowId: "preset:lead_led" });
  await submitThreadMessage("s", { text: "go", intent: "accomplish", addressAgentIds: ["a"], workflowId: "preset:lead_led" });
  await runLogicalAgents({ taskGoal: "go", teamId: "t", workflowId: "wf_custom", style: "pipeline" });
  await runLogicalAgents({ taskGoal: "go", workflowId: "preset:pipeline" });
  expect(bodies.map((b) => [b.workflowId, b.style])).toEqual([
    ["preset:lead_led", undefined], [undefined, undefined], [undefined, undefined],
    ["wf_custom", undefined], [undefined, undefined],
  ]);
});

it("shows the task override only for team assignments", () => {
  const task = { id: "t", title: "T", description: "", assignedTeamId: "team", collaborationStyle: "solo" };
  const { rerender } = render(<TaskRecordDefinition task={task as never} variant="task" locale="en" />);
  expect(screen.getByText("collab_style.build_review")).toBeTruthy();
  rerender(<TaskRecordDefinition task={{ ...task, assignedTeamId: undefined } as never} variant="task" locale="en" />);
  expect(screen.queryByText("collab_style.task_label")).toBeNull();
});

it("renders a slot label and the solo fallback note on a turn", () => {
  const message = { kind: "agent", id: "m", timestamp: "2026-09-25", agent: "codex", runId: "r", streaming: false, stdout: "", stderr: "", collaborations: [], attachments: [] };
  render(<DialogProvider><MessageBlock message={message as never} sessionId="s" slotLabel="collab_style.turn_builder" styleFallback /></DialogProvider>);
  expect(screen.getByText("collab_style.turn_builder")).toBeTruthy();
  expect(screen.getByText("collab_style.ran_solo")).toBeTruthy();
});

it("counts only active-round repairs and distinguishes budget exhaustion from other blocks", () => {
  const round = { roundId: "new", style: "build_review", assignments: [{ assignmentId: "b", role: "implementer" }, { assignmentId: "r", role: "reviewer" }] };
  const runs = [{ assignmentId: "old" }, { assignmentId: "b" }, { assignmentId: "r" }, { assignmentId: "b" }, { assignmentId: "b", consultation: true }];
  const session = { status: "running", activeRoundId: "new", collaborationRounds: [round], agentRuns: runs };
  expect(reviewCycle(session as never)).toEqual({ cycle: 2, max: 3 });
  expect(reviewBudgetExhausted({ ...session, workOutcome: "blocked" } as never)).toBe(false);
  const reviews = Array.from({ length: 3 }, () => ({ assignmentId: "r", workResult: { status: "continue", findings: [{ workItemId: "b" }] } }));
  expect(reviewBudgetExhausted({ ...session, status: "completed", workOutcome: "blocked", agentRuns: reviews } as never)).toBe(true);
});

it("shows the review loop and labels pipeline steps by role", () => {
  const { unmount } = render(<CollaborationSlotPreview members={[{ id: "a", role: "implementer" }, { id: "b", role: "reviewer" }]} leadId="a" style="build_review" nameOf={(id) => id} />);
  expect(screen.getByText("collab_style.loop_until_approved")).toBeTruthy();
  unmount();
  render(<CollaborationSlotPreview members={[{ id: "a", role: "planner" }, { id: "b", role: "reviewer" }]} style="pipeline" nameOf={(id) => id} />);
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    expect.stringContaining("team_work.role_planner"), expect.stringContaining("team_work.role_reviewer"),
  ]);
  expect(screen.queryByText("collab_style.loop_until_approved")).toBeNull();
});

it("names the lead's closing lead-led step for what it does", () => {
  render(<CollaborationSlotPreview members={[{ id: "a" }, { id: "b" }]} leadId="a" style="lead_led" nameOf={(id) => id} />);
  const items = screen.getAllByRole("listitem").map((item) => item.textContent);
  expect(items[0]).toContain("collab_style.slot_lead");
  expect(items.at(-1)).toContain("collab_style.slot_lead_summary");
});
