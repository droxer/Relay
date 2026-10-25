import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NextSteps } from "../src/components/NextSteps";

it("sends a suggested next step in one click", async () => {
  const onSend = vi.fn(async () => true);
  render(<NextSteps steps={["Add tests for the parser", "Ship it"]} onSend={onSend} />);
  expect(screen.getByRole("region", { name: "next_steps.title" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add tests for the parser" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith("Add tests for the parser"));
  // Nothing else can be sent while that one goes out.
  for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
});

it("unlocks the suggestions when the send did not go through", async () => {
  const onSend = vi.fn(async () => false);
  render(<NextSteps steps={["Ship it"]} onSend={onSend} />);
  const button = screen.getByRole("button");
  fireEvent.click(button);
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
});

it("renders nothing without a suggestion", () => {
  const { container } = render(<NextSteps steps={[]} onSend={vi.fn()} />);
  expect(container.innerHTML).toBe("");
});
