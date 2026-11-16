import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskRecordActions } from "../src/components/task-record/TaskRecordActions";
import type { RelayTaskListItem } from "../src/types";

it("routes a blocked workflow to its owner controls instead of starting another Task execution", () => {
  const open = vi.fn();
  const start = vi.fn();
  render(<TaskRecordActions task={{ id: "t", projectId: "p", status: "blocked", attention: { code: "workflow_blocked" } } as RelayTaskListItem}
    busyAction={null} onRun={start} onCancel={vi.fn()} onDone={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onWatchLive={open} />);
  fireEvent.click(screen.getByRole("button", { name: "backlog.open_thread" }));
  expect(open).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "record.retry_run" })).toBeNull();
});
