import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Badge } from "../src/components/ui/badge";
import { LeadBadge } from "../src/components/LeadBadge";
import { StateMark } from "../src/components/StateMark";

it("keeps a long label intact in the DOM and separates its status mark", () => {
  const label = "等待人工确认 · Waiting for approval from the project owner";
  const { container } = render(<Badge><StateMark tone="warn" />{label}</Badge>);
  expect(screen.getByText(label).closest("[data-slot=badge-label]")).not.toBeNull();
  expect(container.querySelector(".state-mark")?.parentElement?.getAttribute("data-slot")).toBe("badge");
});

it("shows the lead label in member cards", () => {
  render(<LeadBadge />);
  expect(screen.getByText("project.lead_badge").closest("[data-slot=badge]")).not.toBeNull();
});

it("names compact lead marks and makes their tooltip reachable by keyboard", () => {
  render(<LeadBadge compact />);
  const mark = screen.getByRole("img", { name: "project.lead_badge" });
  expect(mark.tabIndex).toBe(0);
});
