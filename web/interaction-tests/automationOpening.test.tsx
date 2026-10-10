import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AutomationOpening } from "../src/components/AutomationOpening";
import { parseAutomationOpening } from "../src/lib/automationOpening";

function renderOpening(goal: string, scheduled = false) {
  const opening = parseAutomationOpening(goal, { scheduled });
  if (!opening) throw new Error("expected an automation opening");
  return render(<AutomationOpening opening={opening} time={null} />).container;
}

it("draws a Run now as a card: no raw trigger block, no restated event", () => {
  const container = renderOpening("每周 AI 动态\n\n每周抓取 AI 动态\n\n---\nTrigger context\nFired by: Manual\n- Run now requested.");
  screen.getByRole("heading", { name: "每周 AI 动态" });
  screen.getByText("每周抓取 AI 动态");
  expect(container.querySelector(".automation-opening-trigger")?.textContent).toBe("automation.ledger.manual");
  expect(container.textContent).not.toContain("Trigger context");
  expect(container.textContent).not.toContain("Run now requested");
  expect(container.querySelector(".automation-opening-events")).toBeNull();
});

it("lists an event-fired run's events in translated words", () => {
  const container = renderOpening([
    "Digest",
    "---\nTrigger context\nFired by: Run failed (2 events, 1 not listed)",
    '- Task t_1 "Deploy" — run failed: exit 1',
  ].join("\n\n"));
  const event = container.querySelector(".automation-opening-event");
  expect(event?.textContent).toContain("Deploy");
  expect(event?.textContent).toContain("automation.ledger.run_failed");
  expect(event?.textContent).toContain("exit 1");
  screen.getByText("automation.opening.not_listed");
});

it("marks a scheduled run with no trigger block as scheduled", () => {
  const container = renderOpening("Digest\n\nCollect the news.", true);
  expect(container.querySelector(".automation-opening-trigger")?.textContent).toBe("automation.ledger.schedule");
});
