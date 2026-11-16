import { cloneElement, createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowStepCard } from "../src/components/workflow/WorkflowStepCard";
import type { WorkflowStepDraft } from "../src/lib/workflowTeamDraft";

// Floating popups do not open under jsdom; render them inline instead.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => createElement("div", null, children),
  DropdownMenuTrigger: ({ render }: any) => cloneElement(render),
  DropdownMenuContent: ({ children }: any) => createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children, onClick, danger: _danger, disabled, ...props }: any) =>
    createElement("div", { ...props, role: "menuitem", "aria-disabled": disabled || undefined, onClick: disabled ? undefined : onClick }, children),
  DropdownMenuSeparator: () => null,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => createElement("div", null, children),
  SelectTrigger: ({ children, ...props }: any) => createElement("button", { type: "button", ...props }, children),
  SelectContent: ({ children }: any) => createElement("div", null, children),
  SelectGroup: ({ children }: any) => createElement("div", null, children),
  SelectValue: () => null,
}));

const step: WorkflowStepDraft = {
  id: "step-a", name: "设计一个很长很长的步骤名称 with a long English tail", agentId: "", instructions: "",
  expectedOutputs: "", acceptanceCriteria: "", kind: "work", requiresApproval: false,
};

function renderCard(overrides: Partial<Parameters<typeof WorkflowStepCard>[0]> = {}) {
  const props = {
    step, index: 1, count: 3, agents: [],
    onChange: vi.fn(), onReplace: vi.fn(), onMove: vi.fn(), onRemove: vi.fn(),
    ...overrides,
  };
  render(<ol><WorkflowStepCard {...props} /></ol>);
  return props;
}

it("reorders with buttons a keyboard can reach, never by drag", () => {
  const props = renderCard();
  fireEvent.click(screen.getByRole("button", { name: "workflow.move_up" }));
  fireEvent.click(screen.getByRole("button", { name: "workflow.move_down" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "workflow.move_first" }));
  expect(props.onMove.mock.calls).toEqual([[0], [2], [0]]);
});

it("disables moves past either end and removing the only step", () => {
  renderCard({ index: 0, count: 1 });
  expect((screen.getByRole("button", { name: "workflow.move_up" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "workflow.move_down" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("menuitem", { name: "workflow.step_remove" }).getAttribute("aria-disabled")).toBe("true");
});

it("turns the approval gate on when a step becomes a deployment", () => {
  const props = renderCard();
  fireEvent.click(screen.getByRole("radio", { name: "workflow.kind_deployment" }));
  expect(props.onReplace).toHaveBeenCalledWith(expect.objectContaining({ kind: "deployment", requiresApproval: true }));
});

it("names each invalid field beside its control", () => {
  renderCard({ errors: { name: "required", expectedOutputs: "required", agentId: "not_member" } });
  expect(screen.getAllByText("workflow.error_required")).toHaveLength(2);
  expect(screen.getByText("workflow.error_not_member")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: /workflow\.step_name/ }).getAttribute("aria-invalid")).toBe("true");
});
