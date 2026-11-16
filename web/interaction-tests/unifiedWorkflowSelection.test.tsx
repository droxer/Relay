import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowSelect } from "../src/components/workflow/WorkflowSelect";
import { defaultWorkflowId, workflowOptions, predefinedStyle } from "../src/lib/workflowSelection";
import type { AgentTeam } from "../src/types";

const team = { id: "team", collaborationStyle: "pipeline", workflows: [
  { id: "custom", teamId: "team", projectId: "project", name: "Release", workflowSteps: [], enabled: true },
] } as AgentTeam;

it("maps old collaboration settings to predefined workflows", () => {
  expect(defaultWorkflowId(team)).toBe("preset:pipeline");
  expect(defaultWorkflowId({ ...team, defaultWorkflowId: "custom" })).toBe("custom");
  expect(predefinedStyle("preset:lead_led")).toBe("lead_led");
  expect(predefinedStyle("custom")).toBeUndefined();
});

it("offers predefined and scoped custom workflows in one catalog", () => {
  expect(workflowOptions(team, "project").map(item => item.id)).toEqual([
    "preset:build_review", "preset:pipeline", "preset:lead_led", "custom",
  ]);
  expect(workflowOptions(team, "other").map(item => item.id)).not.toContain("custom");
  expect(workflowOptions(team).map(item => item.id)).toContain("custom");
});


it("shows one picker for inherited, predefined, and custom workflows", async () => {
  const onChange = vi.fn();
  render(<WorkflowSelect team={team} value={null} onChange={onChange} inherit projectId="project" />);
  await userEvent.click(screen.getByRole("combobox", { name: "workflow.select_workflow" }));
  await userEvent.click(await screen.findByRole("option", { name: /collab_style.pipeline/ }));
  expect(onChange).toHaveBeenCalledWith("preset:pipeline");
});

it("sends a custom definition id from the same picker", async () => {
  const onChange = vi.fn();
  render(<WorkflowSelect team={team} value={null} onChange={onChange} inherit projectId="project" />);
  await userEvent.click(screen.getByRole("combobox", { name: "workflow.select_workflow" }));
  await userEvent.click(await screen.findByRole("option", { name: /Release/ }));
  expect(onChange).toHaveBeenCalledWith("custom");
});
