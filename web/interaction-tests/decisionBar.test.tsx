import { cloneElement, createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DecisionBar } from "../src/components/composer/DecisionBar";

// Floating popups do not open under jsdom; render them inline instead.

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => createElement("div", null, children),
  DropdownMenuTrigger: ({ render }: any) => cloneElement(render),
  DropdownMenuContent: ({ children }: any) => createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({ children, onClick, ...props }: any) => createElement("div", { ...props, role: "menuitem", onClick }, children),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => createElement("div", null, children),
  SelectTrigger: ({ children }: any) => createElement("div", null, children),
  SelectContent: ({ children }: any) => createElement("div", null, children),
  SelectValue: () => null,
}));

function renderBar(overrides: Partial<Parameters<typeof DecisionBar>[0]> = {}) {
  const props = {
    logicalAgents: [],
    sendDecision: vi.fn().mockResolvedValue(true),
    sendHandoff: vi.fn().mockResolvedValue(undefined),
    onRequestChanges: vi.fn(),
    ...overrides,
  };
  render(<DecisionBar {...props} />);
  return props;
}

it("lands focus on the decision's heading, never on a verb a stray Enter would press", () => {
  renderBar();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "decision.title" }));
});

it("keeps the caret where the person is typing", () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  renderBar();
  expect(document.activeElement).toBe(input);
  input.remove();
});

it("offers three verbs and folds the rarer moves into a menu, with no second reject", () => {
  const props = renderBar();
  const card = screen.getByRole("region", { name: "decision.title" });
  const visible = within(card).getAllByRole("button").filter((button) => !button.getAttribute("aria-label"));
  expect(visible.map((button) => button.textContent?.trim())).toEqual([
    "decision.request_changes",
    "decision.rerun",
    "decision.accept",
  ]);
  expect(screen.queryByText("decision.reject")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "decision.request_changes" }));
  expect(props.onRequestChanges).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("menuitem", { name: "decision.mark_done" }));
  expect(props.sendDecision).toHaveBeenCalledWith("mark_done");
});
