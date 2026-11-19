import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TaskHoldupLine } from "../src/components/task-board/TaskHoldupLine";
import { TaskRecoveryPanel } from "../src/components/ExecutionRecoveryPanel";
import type { RelayTaskListItem } from "../src/types";

it.each([
  ["task_wip_limit", "backlog.wip_wait"],
  ["capacity_exhausted", "backlog.computer_capacity_wait"],
])("renders the specific %s capacity explanation", (code, key) => {
  render(<TaskHoldupLine task={{
    id: "waiting-task", title: "Waiting task", status: "queued",
    dispatchOutcome: { state: "queued", code, message: "Server capacity explanation" },
  } as RelayTaskListItem} />);
  expect(screen.getByText(key)).toBeTruthy();
});

it("tells the reader the queued task will resume when a Computer slot opens", () => {
  render(<TaskRecoveryPanel task={{
    id: "waiting-task", title: "Waiting task", status: "queued", linkedSessionIds: [],
    dispatchOutcome: { state: "queued", code: "capacity_exhausted", message: "Server capacity explanation" },
  } as RelayTaskListItem} />);
  expect(screen.getByText("backlog.computer_capacity_wait")).toBeTruthy();
  expect(screen.queryByText("recovery.capacity.body")).toBeNull();
});
