import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThreadRow } from "../src/components/ThreadRow";
import { InlineStatus } from "../src/components/task-board/InlineTaskFields";
import { RoutineStateBadge } from "../src/components/RoutineStateBadge";
import { RoutineStateIcon } from "../src/components/RoutineStateIcon";
import { ROUTINE_STATE_ORDER } from "../src/lib/routine";
import { statusTone } from "../src/lib/statusTone";
import { taskRecoveryGuide } from "../src/lib/executionRecovery";
import type { RelaySession, RelayTaskListItem, TaskStatus } from "../src/types";

const statuses: TaskStatus[] = ["backlog", "assigned", "queued", "running", "review", "waiting_for_human", "blocked", "done", "cancelled"];

it.each(statuses)("keeps the task row and linked thread's %s icon identical", (status) => {
  const task = { id: "task", status, workflowStage: status === "blocked" || status === "waiting_for_human" ? "running" : status } as RelayTaskListItem;
  const session = { id: "thread", taskGoal: "Task thread", status: "completed", updatedAt: "2026-11-10T12:00:00Z", agentRuns: [] } as unknown as RelaySession;
  const thread = render(<ul><ThreadRow item={{ session, origin: { kind: "backlog", taskId: "task", title: "Task", status } }} selected={false} onSelect={vi.fn()} tone="idle" now={Date.parse(session.updatedAt)} /></ul>);
  const row = render(<InlineStatus task={task} onChange={vi.fn()} readOnly />);
  const threadIcon = thread.container.querySelector(".task-status-icon")!;
  const rowIcon = row.container.querySelector(".task-status-icon")!;
  expect(rowIcon.getAttribute("data-status")).toBe(status);
  expect(rowIcon.innerHTML).toBe(threadIcon.innerHTML);
});

it.each(ROUTINE_STATE_ORDER)("uses the same %s automation icon in list filters and detail badges", (state) => {
  const filter = render(<RoutineStateIcon state={state} />);
  const badge = render(<RoutineStateBadge state={state} always />);
  expect(badge.container.querySelector(".routine-state-icon svg")?.innerHTML).toBe(filter.container.querySelector("svg")?.innerHTML);
});

it("treats cancellation as settled while retaining failure and block alerts", () => {
  expect(statusTone("cancelled")).toBe("neutral");
  expect(statusTone("blocked")).toBe("bad");
  expect(statusTone("failed")).toBe("bad");
});

it.each(["review", "waiting_for_human"] as const)("uses the task's attention tone in the %s next-step panel", (status) => {
  expect(taskRecoveryGuide({ status } as RelayTaskListItem)?.tone).toBe("warn");
});

it("distinguishes blocked from cancelled even without color", async () => {
  const { TaskStatusIcon } = await import("../src/components/TaskStatusIcon");
  const blocked = render(<TaskStatusIcon status="blocked" />);
  const cancelled = render(<TaskStatusIcon status="cancelled" />);
  expect(blocked.container.querySelector("path")?.getAttribute("d"))
    .not.toBe(cancelled.container.querySelector("path")?.getAttribute("d"));
});
