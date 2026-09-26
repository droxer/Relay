import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskRecordActions } from "../src/components/task-record/TaskRecordActions";
import type { RelayTaskListItem } from "../src/types";

const blockedTask = {
  id: "blocked-task", projectId: "project", title: "Retry me", description: "", status: "blocked",
  priority: "normal", assignedAgentId: "agent", assignedAgent: "codex",
  blockerReason: "Computer was unavailable", linkedSessionIds: [],
  createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
} as RelayTaskListItem;

/* The board card and the compact list row are tiles and carry no actions —
   the retry moved with the rest of the action bar into the record drawer,
   where `recordActions` derives it from the task's own state. */
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

/* An archived or disabled project is a read-only room. The project board
   hides Start and Accept there; the record drawer riding over that same
   project used to keep offering Retry, Block, Done, Edit and Delete. */
it("offers nothing on a record whose project is closed for work", () => {
  render(<TaskRecordActions task={blockedTask} variant="task" readOnly busyAction={null}
    onRun={vi.fn()} onCancel={vi.fn()} onToggleBlock={vi.fn()} onDone={vi.fn()}
    onEdit={vi.fn()} onDelete={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("marks delete as destructive and holds it while another action runs", () => {
  const onDelete = vi.fn();
  render(<TaskRecordActions task={blockedTask} variant="task" busyAction="retry"
    onRun={vi.fn()} onCancel={vi.fn()} onToggleBlock={vi.fn()} onDone={vi.fn()}
    onEdit={vi.fn()} onDelete={onDelete} />);
  const remove = screen.getByRole("button", { name: "backlog.delete_task" }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  fireEvent.click(remove);
  expect(onDelete).not.toHaveBeenCalled();
});
