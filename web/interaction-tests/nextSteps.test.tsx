import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NextSteps, type NextStepAdoption } from "../src/components/NextSteps";
import type { RelayTaskListItem } from "../src/types";

it("sends a suggested next step in one click", async () => {
  const onSend = vi.fn(async () => true);
  render(<NextSteps steps={["Add tests for the parser", "Ship it"]} onSend={onSend} />);
  expect(screen.getByRole("region", { name: "next_steps.title" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add tests for the parser" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("Add tests for the parser"));
  // Nothing else can be sent while that one goes out.
  for (const button of screen.getByRole("list").querySelectorAll("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
});

it("unlocks the suggestions when the send did not go through", async () => {
  const onSend = vi.fn(async () => false);
  render(<NextSteps steps={["Ship it"]} onSend={onSend} />);
  const button = screen.getByRole("button", { name: "Ship it" });
  fireEvent.click(button);
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
});

it("renders nothing without a suggestion", () => {
  const { container } = render(<NextSteps steps={[]} onSend={vi.fn()} />);
  expect(container.innerHTML).toBe("");
});

it("offers the suggestions inline, with no control to fold them away", () => {
  render(<NextSteps steps={["Ship it"]} onSend={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "next_steps.title" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "next_steps.title" })).toBeNull();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Ship it"]);
});

function adoption(overrides: Partial<NextStepAdoption> = {}): NextStepAdoption {
  return {
    projectName: "Relay",
    adoptedTask: () => undefined,
    onAdopt: vi.fn(async (step: string) => ({ id: "task_1", number: 12, title: step }) as RelayTaskListItem),
    onOpenTask: vi.fn(),
    ...overrides,
  };
}

it("creates a task from a suggestion only after the person confirms", async () => {
  const adopt = adoption();
  render(<NextSteps steps={["Ship it"]} onSend={vi.fn()} adoption={adopt} />);
  expect(screen.getByText("next_steps.hint")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "next_steps.adopt_label" }));
  expect(adopt.onAdopt).not.toHaveBeenCalled();
  const confirm = screen.getByRole("group", { name: "next_steps.confirm_label" });
  expect(confirm.textContent).toContain("next_steps.confirm");
  fireEvent.click(screen.getByRole("button", { name: "next_steps.create" }));
  await waitFor(() => expect(adopt.onAdopt).toHaveBeenCalledWith("Ship it"));
  // Created: the confirm closes and the row links to the new task.
  const created = await screen.findByRole("button", { name: "next_steps.open_task" });
  expect(screen.queryByRole("group", { name: "next_steps.confirm_label" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("next_steps.adopted_announce");
  fireEvent.click(created);
  expect(adopt.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task_1" }));
});

it("cancels the confirm without creating anything", () => {
  const adopt = adoption();
  render(<NextSteps steps={["Ship it"]} onSend={vi.fn()} adoption={adopt} />);
  fireEvent.click(screen.getByRole("button", { name: "next_steps.adopt_label" }));
  fireEvent.click(screen.getByRole("button", { name: "next_steps.cancel" }));
  expect(screen.queryByRole("group", { name: "next_steps.confirm_label" })).toBeNull();
  expect(adopt.onAdopt).not.toHaveBeenCalled();
});

it("says so and offers a retry when the task was not created", async () => {
  const adopt = adoption({ onAdopt: vi.fn(async () => { throw new Error("offline"); }) });
  render(<NextSteps steps={["Ship it"]} onSend={vi.fn()} adoption={adopt} />);
  fireEvent.click(screen.getByRole("button", { name: "next_steps.adopt_label" }));
  fireEvent.click(screen.getByRole("button", { name: "next_steps.create" }));
  expect(await screen.findByText("next_steps.adopt_failed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "next_steps.retry" })).toBeTruthy();
});

it("shows a suggestion that is already a task instead of offering it again", () => {
  const existing = { id: "task_9", number: 9, title: "Ship it" } as RelayTaskListItem;
  render(<NextSteps steps={["Ship it"]} onSend={vi.fn()} adoption={adoption({ adoptedTask: () => existing })} />);
  expect(screen.queryByRole("button", { name: "next_steps.adopt_label" })).toBeNull();
  expect(screen.getByRole("button", { name: "next_steps.open_task" }).textContent).toContain("next_steps.adopted");
});
