import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ComputerOptionsFeedback } from "../src/components/computer/ComputerOptionsFeedback";

it("distinguishes an unavailable list from having no computers and offers retry", () => {
  const retry = vi.fn();
  render(<ComputerOptionsFeedback isLoading={false} isError isFetching={false} empty retry={retry} />);
  expect(screen.getByRole("alert").textContent).toContain("computer.options_failed");
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "computer.options_retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("gives a new user a route to computers when there are none to select", () => {
  render(<ComputerOptionsFeedback isLoading={false} isError={false} isFetching={false} empty retry={vi.fn()} />);
  expect(screen.getByRole("link", { name: "nav.computers" }).getAttribute("href")).toBe("/computers");
});

it("does not show an empty-state instruction while loading", () => {
  const { container } = render(<ComputerOptionsFeedback isLoading isError={false} isFetching empty retry={vi.fn()} />);
  expect(container.textContent).toBe("");
});
