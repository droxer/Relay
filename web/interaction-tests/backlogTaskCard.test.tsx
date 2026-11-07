import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BacklogTaskCard } from "../src/components/task-board/BacklogRecords";
import type { RelayTaskListItem, TaskPriority } from "../src/types";

function taskWith(priority: TaskPriority) {
  return {
    id: "task_mfoo12_ab12cd", title: "Ship it", status: "assigned", priority,
    assignedAgentId: "agent-1", assignedAgent: "codex", dueDate: null,
    linkedSessionIds: [], createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
  } as RelayTaskListItem;
}

function renderCard(priority: TaskPriority) {
  return render(
    <BacklogTaskCard task={taskWith(priority)} ready selected={false} onToggleSelect={vi.fn()} onOpen={vi.fn()} />,
  );
}

it.each(["high", "normal", "low"] as const)("states %s priority beside the task ref, not in the facts line", (priority) => {
  const { container } = renderCard(priority);
  const badge = container.querySelector(".backlog-card-eyebrow .priority-badge");
  expect(badge).not.toBeNull();
  expect(badge!.getAttribute("data-priority")).toBe(priority);
  // Named in words for every reader, not only as bars.
  expect(badge!.textContent).toContain(`backlog.priorities.${priority}`);
  expect(container.querySelector(".backlog-meta .priority-badge")).toBeNull();
});

it("keeps the task ref first in the eyebrow", () => {
  const { container } = renderCard("high");
  const eyebrow = container.querySelector(".backlog-card-eyebrow")!;
  expect(eyebrow.firstElementChild?.classList.contains("task-card-id")).toBe(true);
});
