import { createContext, useContext } from "react";
import { fireEvent, render as testingRender, screen, within } from "@testing-library/react";
import { cloneElement, createElement, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectRecord, ProjectWorkflowChoice } from "../src/types";

function render(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workflow: ProjectWorkflowChoice = { id: "w", projectId: "project-1", name: "Ship workflow", enabled: true, stepAgentIds: [] };
  client.setQueryData(["workflows", "choices", "project-1"], { workflows: [workflow] });
  return testingRender(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
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
    "backlog.statuses.queued",
    "backlog.statuses.running",
    "backlog.statuses.review",
    "backlog.statuses.done",
    "backlog.statuses.cancelled",
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

it("keeps a blocked task's stage label while showing its blocked icon and Unblock", () => {
  const blocked = { ...base, status: "blocked", workflowStage: "running" } as RelayTaskListItem;
  render(<InlineStatus task={blocked} onChange={vi.fn()} onToggleHold={vi.fn()} labeled />);
  const trigger = screen.getByRole("button", { name: "backlog.inline.status_label" });
  expect(trigger.textContent).toBe("backlog.statuses.running · backlog.statuses.blocked");
  expect(trigger.querySelector("[data-status]")?.getAttribute("data-status")).toBe("blocked");
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

  rerender(<InlineDue task={{ ...base, dueDate: "2999-09-30" }} onChange={onChange} />);
  expect(screen.getByRole("button", { name: "backlog.inline.due_label" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "backlog.inline.clear_due" }));
  expect(onChange).toHaveBeenLastCalledWith("");
});

it("says past due in words, not only in red", () => {
  render(<InlineDue task={{ ...base, dueDate: "2000-01-01" }} onChange={vi.fn()} readOnly />);
  expect(screen.getByText("backlog.overdue:", { exact: false })).toBeTruthy();
});

it("names an overdue date in the due control's label", () => {
  render(<InlineDue task={{ ...base, dueDate: "2000-01-01" }} onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "backlog.inline.due_overdue_label" })).toBeTruthy();
});


it("cancels abandoned work through the shared status control", () => {
  const onChange = vi.fn();
  render(<InlineStatus task={{ ...base, status: "blocked", workflowStage: "review", startedAt: base.createdAt }} onChange={onChange} />);
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "backlog.statuses.cancelled" }));
  expect(onChange).toHaveBeenCalledWith("cancelled");
});

it("shows queued work but refuses to fabricate a queue transition", () => {
  const onChange = vi.fn();
  render(<InlineStatus task={base} onChange={onChange} />);
  const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: "backlog.statuses.queued" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item);
  expect(onChange).not.toHaveBeenCalled();
});


it("clears a selected Project Workflow through Assign later", async () => {
  const onChange = vi.fn();
  render(<InlineAssignee task={{ ...base, assignedWorkflowId: "w" }} project={{ id: "project-1", members: [] } as unknown as ProjectRecord}
    agents={[]} teams={[]} display={{ ready: false }} onChange={onChange} />);
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.getByRole("radio", { name: /workflow.workflows/ }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("radio", { name: /backlog.teams_section/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "backlog.assign_later" }));
  expect(onChange).toHaveBeenCalledWith({ kind: "none" });
});

it("replaces a stale Project Team with a Project Workflow", async () => {
  const onChange = vi.fn();
  render(<InlineAssignee task={{ ...base, assignedTeamId: "legacy", assignedWorkflowId: "w" }} project={{ id: "project-1", members: [] } as unknown as ProjectRecord}
    agents={[]} teams={[]} display={{ ready: false }} onChange={onChange} />);
  fireEvent.click(screen.getByRole("combobox", { name: "backlog.assignment_reselect" }));
  fireEvent.click(screen.getByRole("radio", { name: /workflow.workflows/ }));
  fireEvent.click(screen.getByRole("option", { name: /Ship workflow/ }));
  expect(onChange).toHaveBeenCalledWith({ kind: "workflow", id: "w" });
});

it("selects a predefined Project Workflow from the inline assignment", () => {
  const onChange = vi.fn();
  const project = { id: "project-1", members: [{ agentId: "a", enabled: true }], leadAgentId: "a" } as ProjectRecord;
  render(<InlineAssignee task={{ ...base, assignedWorkflowId: "preset:pipeline" }} project={project}
    agents={[]} teams={[]} display={{ ready: false }} onChange={onChange} />);
  expect(screen.getByRole("combobox").textContent).toContain("collab_style.pipeline");
  fireEvent.click(screen.getByRole("option", { name: /collab_style.lead_led/ }));
  expect(onChange).toHaveBeenCalledWith({ kind: "workflow", id: "preset:lead_led" });
});

it("marks a stale assignment in its cell without spelling the sentence into the row", () => {
  render(<InlineAssignee task={{ ...base, assignedTeamId: "legacy" }} project={{ id: "project-1", members: [] } as unknown as ProjectRecord}
    agents={[]} teams={[]} display={{ ready: false }} onChange={vi.fn()} />);
  const trigger = screen.getByRole("combobox", { name: "backlog.assignment_reselect" });
  // A sentence in a nowrap table cell widened the Assignee column until the
  // title column had nothing left; the label speaks it and a mark shows it.
  expect(trigger.textContent).not.toContain("backlog.assignment_reselect");
  expect(trigger.querySelector(".assignee-reselect-mark")?.getAttribute("title")).toBe("backlog.assignment_reselect");
});

// Keep selection semantics while leaving popup positioning to browser tests.
vi.mock("@/components/ui/select", () => {
  const Context = createContext<any>({});
  return {
    Select: ({ children, value, onValueChange, disabled }: any) => <Context.Provider value={{ value, onValueChange, disabled }}>{children}</Context.Provider>,
    SelectTrigger: ({ children, ...rest }: any) => <button type="button" role="combobox" aria-label={rest["aria-label"]} aria-labelledby={rest["aria-labelledby"]}>{children}</button>,
    SelectValue: ({ children }: any) => { const { value } = useContext(Context); return <span>{typeof children === "function" ? children(value) : children}</span>; },
    SelectContent: ({ children, header }: any) => <div>{header}{children}</div>,
    SelectGroup: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ children, value, disabled }: any) => { const choice = useContext(Context); return <button type="button" role="option" disabled={disabled || choice.disabled} onClick={() => { if (value !== choice.value) choice.onValueChange(value); }}>{children}</button>; },
  };
});
