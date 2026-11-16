import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskRecordDefinition } from "../src/components/task-record/TaskRecordDefinition";
import type { AgentTeam, RelayTaskListItem } from "../src/types";
vi.mock("../src/components/LazyMarkdown", () => ({ Markdown: () => null }));

it("describes workflow Tasks as ordered steps rather than a legacy collaboration style", () => {
  const team = { workflowSteps: [{ id: "design" }, { id: "deploy" }] } as AgentTeam;
  render(<TaskRecordDefinition task={{ assignedTeamId: "workflow", description: "", priority: "normal" } as RelayTaskListItem}
    variant="task" locale="en" team={team} />);
  expect(screen.queryByText("collab_style.task_label")).toBeNull();
  expect(screen.getByText("workflow.section_title")).toBeTruthy();
});
