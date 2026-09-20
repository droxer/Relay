import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BacklogTaskCard, BacklogTaskRow } from "../src/components/task-board/BacklogRecords";
import type { RelayTaskListItem } from "../src/types";

it.each([BacklogTaskCard, BacklogTaskRow])("offers an explicit retry for a blocked assigned task (%#)", (Component) => {
  const onStart = vi.fn();
  const task = {
    id: "blocked-task", title: "Retry me", description: "", status: "blocked",
    priority: "normal", assignedAgentId: "agent", assignedAgent: "codex",
    blockerReason: "Computer was unavailable", linkedSessionIds: [],
    createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
  } as RelayTaskListItem;
  render(<Component task={task} ready canDiscuss={false} selected={false}
    starting={false} onStart={onStart} onEdit={vi.fn()} onAssign={vi.fn()}
    onToggleSelect={vi.fn()} onToggleBlock={vi.fn()} onDone={vi.fn()}
    dragging={false} onDragStart={vi.fn()} onDragEnd={vi.fn()} onTouchStart={vi.fn()} />);
  expect(onStart).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "backlog.retry" });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(retry);
  expect(onStart).toHaveBeenCalledTimes(1);
});
