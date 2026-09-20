import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BacklogTaskRow } from "../src/components/task-board/BacklogRecords";
import { TaskRecordActions } from "../src/components/task-record/TaskRecordActions";
import type { RelayTaskListItem } from "../src/types";

const blockedTask = {
  id: "blocked-task", title: "Retry me", description: "", status: "blocked",
  priority: "normal", assignedAgentId: "agent", assignedAgent: "codex",
  blockerReason: "Computer was unavailable", linkedSessionIds: [],
  createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
} as RelayTaskListItem;

it("offers an explicit retry for a blocked assigned task on the list row", () => {
  const onStart = vi.fn();
  render(<BacklogTaskRow task={blockedTask} ready canDiscuss={false} selected={false}
    starting={false} onStart={onStart} onEdit={vi.fn()} onAssign={vi.fn()}
    onToggleSelect={vi.fn()} onToggleBlock={vi.fn()} onDone={vi.fn()} />);
  expect(onStart).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "backlog.retry" });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(retry);
  expect(onStart).toHaveBeenCalledTimes(1);
});

/* The board card is a tile and carries no actions — the retry moved with the
   rest of the action bar into the record drawer, where `recordActions`
   derives it from the task's own state. */
it("offers an explicit retry for a blocked assigned task on the record", () => {
  const onRun = vi.fn();
  render(<TaskRecordActions task={blockedTask} variant="task" busyAction={null}
    onRun={onRun} onCancel={vi.fn()} onToggleBlock={vi.fn()} onDone={vi.fn()}
    onEdit={vi.fn()} onDelete={vi.fn()} />);
  expect(onRun).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "record.retry_run" });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(retry);
  expect(onRun).toHaveBeenCalledTimes(1);
});
