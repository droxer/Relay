import { fireEvent, render, screen, within } from "@testing-library/react";
import { cloneElement, createElement } from "react";
import { expect, it, vi } from "vitest";
import { InlineAssignee, InlineDue, InlinePriority, InlineStatus } from "../src/components/task-board/InlineTaskFields";
import type { RelayTaskListItem } from "../src/types";

// Floating popups do not position under jsdom; render them inline instead, the
// same way these tests stand in for <Select>.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => createElement("div", null, children),
  DropdownMenuTrigger: ({ render }: any) => render,
  DropdownMenuContent: ({ children }: any) => createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children, disabled, onClick, ...props }: any) => createElement(
    "div",
    { ...props, role: "menuitem", "aria-disabled": disabled ? "true" : undefined, onClick: disabled ? undefined : onClick },
    children,
  ),
  DropdownMenuSeparator: () => createElement("hr"),
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => createElement("div", null, children),
  PopoverTrigger: ({ render }: any) => cloneElement(render),
  PopoverContent: ({ children }: any) => createElement("div", { role: "dialog" }, children),
}));
vi.mock("@/components/ui/calendar", () => ({
  Calendar: ({ onSelect }: any) => createElement("button", { type: "button", onClick: () => onSelect(new Date(2026, 9, 1)) }, "pick-oct-1"),
}));

const base = {
  id: "task_1", title: "Ship it", status: "backlog", priority: "normal",
  linkedSessionIds: [], createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
  projectId: "project-1",
} as RelayTaskListItem;

it("offers the workflow stages and commits the chosen one", () => {
  const onChange = vi.fn();
  render(<InlineStatus task={base} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "backlog.inline.status_label" })).toBeTruthy();
  const menu = screen.getByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "backlog.statuses.backlog",
    "backlog.statuses.assigned",
    "backlog.statuses.running",
    "backlog.statuses.review",
    "backlog.statuses.done",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "backlog.statuses.assigned" }));
  expect(onChange).toHaveBeenCalledWith("assigned");
});

it("disables moves the workflow refuses and does not re-commit the current stage", () => {
  const onChange = vi.fn();
  render(<InlineStatus task={base} onChange={onChange} />);
  const item = (name: string) => within(screen.getByRole("menu")).getByRole("menuitem", { name });
  // A task that never started cannot be reviewed or finished.
  expect(item("backlog.statuses.review").getAttribute("aria-disabled")).toBe("true");
  expect(item("backlog.statuses.done").getAttribute("aria-disabled")).toBe("true");
  expect(item("backlog.statuses.backlog").getAttribute("data-current")).toBe("true");
  fireEvent.click(item("backlog.statuses.backlog"));
  expect(onChange).not.toHaveBeenCalled();
});

it("offers Block after the stages, and only when a hold handler is given", () => {
  const onToggleHold = vi.fn();
  const { unmount } = render(<InlineStatus task={base} onChange={vi.fn()} />);
  expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "backlog.block" })).toBeNull();
  unmount();
  render(<InlineStatus task={base} onChange={vi.fn()} onToggleHold={onToggleHold} />);
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "backlog.block" }));
  expect(onToggleHold).toHaveBeenCalledOnce();
});

it("shows a blocked task in the stage it is held in, and offers Unblock", () => {
  const blocked = { ...base, status: "blocked", workflowStage: "running" } as RelayTaskListItem;
  render(<InlineStatus task={blocked} onChange={vi.fn()} onToggleHold={vi.fn()} labeled />);
  const trigger = screen.getByRole("button", { name: "backlog.inline.status_label" });
  expect(trigger.textContent).toBe("backlog.statuses.running · backlog.statuses.blocked");
  expect(trigger.querySelector("[data-status]")?.getAttribute("data-status")).toBe("running");
  expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "backlog.unblock" })).toBeTruthy();
});

it("offers no hold on a live run", () => {
  render(<InlineStatus task={{ ...base, status: "running" }} onChange={vi.fn()} onToggleHold={vi.fn()} />);
  const names = within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
  expect(names).not.toContain("backlog.block");
});

it("renders a plain status mark when read-only", () => {
  render(<InlineStatus task={base} onChange={vi.fn()} readOnly />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("backlog.statuses.backlog")).toBeTruthy();
});

it("changes priority from the menu", () => {
  const onChange = vi.fn();
  render(<InlinePriority priority="normal" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "backlog.inline.priority_label" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "backlog.priorities.high" }));
  expect(onChange).toHaveBeenCalledWith("high");
});

it.each([
  ["a task not yet started", {}, true],
  ["a Ready task", { status: "assigned" }, true],
  ["a running task", { status: "running" }, false],
  ["an intake issue with no project", { projectId: undefined }, false],
] as const)("offers an assignee picker on %s: %s", (_label, over, editable) => {
  render(
    <InlineAssignee
      task={{ ...base, ...over } as RelayTaskListItem}
      agents={[]}
      teams={[]}
      display={{ ready: false }}
      onChange={vi.fn()}
    />,
  );
  expect(Boolean(screen.queryByRole("combobox", { name: "backlog.inline.assignee_label" }))).toBe(editable);
  // The row's own chip is drawn either way.
  expect(screen.getByText("backlog.unassigned")).toBeTruthy();
});

it("renders the plain assignee chip when the row is read-only", () => {
  render(<InlineAssignee task={base} agents={[]} teams={[]} display={{ ready: false }} onChange={vi.fn()} readOnly />);
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("sets a missing due date and clears an existing one", () => {
  const onChange = vi.fn();
  const { rerender } = render(<InlineDue task={base} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "backlog.inline.due_empty" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "backlog.inline.clear_due" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "pick-oct-1" }));
  expect(onChange).toHaveBeenLastCalledWith("2026-10-01");

  rerender(<InlineDue task={{ ...base, dueDate: "2026-09-30" }} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "backlog.inline.due_label" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "backlog.inline.clear_due" }));
  expect(onChange).toHaveBeenLastCalledWith("");
});
