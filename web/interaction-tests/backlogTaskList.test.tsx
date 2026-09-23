import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BacklogTaskList } from "../src/components/task-board/BacklogRecords";
import type { RelayTaskListItem } from "../src/types";

const task = {
  id: "t-1", title: "Ship it", status: "blocked", priority: "high",
  assignedAgentId: "agent-1", assignedAgent: "codex", dueDate: "2026-09-30",
  linkedSessionIds: [], createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
} as RelayTaskListItem;

function renderList(sort: Parameters<typeof BacklogTaskList>[0]["sort"] = null) {
  const onOpenTask = vi.fn();
  const onToggleSelect = vi.fn();
  const onSort = vi.fn();
  const utils = render(
    <BacklogTaskList
      tasks={[task]}
      sort={sort}
      onSort={onSort}
      selectAll={<input type="checkbox" aria-label="select all" />}
      selectedIds={new Set(["t-1"])}
      onToggleSelect={onToggleSelect}
      contextFor={() => ({ ready: true, projectName: "Relay", agentDisplayName: "Atlas" })}
      onOpenTask={onOpenTask}
    />,
  );
  return { ...utils, onOpenTask, onToggleSelect, onSort };
}

it("renders a table whose header and row cell counts match", () => {
  const { container } = renderList();
  const headCells = container.querySelectorAll("thead th");
  const bodyCells = container.querySelectorAll("tbody tr td");
  expect(headCells.length).toBe(5);
  expect(bodyCells.length).toBe(headCells.length);
});

it("puts aria-sort only on the actively sorted column", () => {
  const { container } = renderList({ key: "due", direction: "desc" });
  const sorted = container.querySelectorAll("th[aria-sort]");
  expect(sorted.length).toBe(1);
  expect(sorted[0].getAttribute("aria-sort")).toBe("descending");
  expect(sorted[0].textContent).toContain("backlog.due");
});

it("carries the status/priority/selected data attributes on the row", () => {
  const { container } = renderList();
  const row = container.querySelector("tbody tr")!;
  expect(row.getAttribute("data-status")).toBe("blocked");
  expect(row.getAttribute("data-priority")).toBe("high");
  expect(row.getAttribute("data-selected")).toBe("true");
});

it("opens the record from the title link and toggles selection", () => {
  const { container, onOpenTask, onToggleSelect, onSort } = renderList();
  const title = container.querySelector("a.backlog-row-title")!;
  expect(title.getAttribute("href")).toContain("t-1");
  fireEvent.click(title);
  expect(onOpenTask).toHaveBeenCalledWith("t-1");
  fireEvent.click(container.querySelector('[role="checkbox"][aria-label*="backlog.select_task"]')!);
  expect(onToggleSelect).toHaveBeenCalledWith("t-1");
  const dueHead = Array.from(container.querySelectorAll("th button")).find((b) => b.textContent?.includes("backlog.due"))!;
  fireEvent.click(dueHead);
  expect(onSort).toHaveBeenCalledWith("due");
});
