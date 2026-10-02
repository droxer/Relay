import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RelayEmptyState } from "../src/components/RelayEmptyState";
import { TranscriptEmpty } from "../src/components/TranscriptEmpty";
import { BoardEmpty } from "../src/components/BoardEmpty";

it("names each region with its own heading and hides decorative marks", () => {
  const { container } = render(<><RelayEmptyState feature="agents" title="Meet your agents" /><RelayEmptyState feature="teams" title="Build a team" headingLevel={3} /></>);
  const regions = screen.getAllByRole("region");
  expect(regions[0].getAttribute("aria-labelledby")).not.toBe(regions[1].getAttribute("aria-labelledby"));
  expect(screen.getByRole("heading", { level: 3, name: "Build a team" })).toBeTruthy();
  expect(container.querySelectorAll('.relay-empty-illustration[aria-hidden="true"]')).toHaveLength(2);
});

it("preserves custom illustrations and caller-provided actions", () => {
  const onCreate = vi.fn();
  const { container } = render(<RelayEmptyState title="Start a project" illustration={<span>Custom mark</span>} actions={<button onClick={onCreate}>Create project</button>} />);
  expect(screen.getByText("Custom mark")).toBeTruthy();
  expect(container.querySelector(".relay-empty-diagram")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(onCreate).toHaveBeenCalledOnce();
});

it("offers filter recovery without offering creation on a filtered board", () => {
  const onClear = vi.fn();
  render(<BoardEmpty feature="routines" title="No matching routines" body="Try another filter" clearLabel="Clear filters" onClear={onClear} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(onClear).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("starter cards fill the composer with the prompt rather than the short card label", () => {
  const onSuggestion = vi.fn();
  render(<TranscriptEmpty selectedEmployee="employee-1" onSuggestion={onSuggestion} />);
  fireEvent.click(screen.getByRole("button", { name: /transcript.suggestion_plan_label/ }));
  expect(onSuggestion).toHaveBeenCalledWith("transcript.suggestion_plan");
});

it("does not offer starter actions until an employee is selected", () => {
  render(<TranscriptEmpty selectedEmployee="" onSuggestion={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
});
