import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BacklogTaskCard, BacklogTaskRow } from "../src/components/task-board/BacklogRecords";
import { RoutineRow } from "../src/components/task-board/RoutineRecords";
import type { RelayTaskListItem } from "../src/types";

for (const view of ["card", "row"] as const) {
  it.each([
    [{ assignedAgentId: "agent-1", assignedAgent: "codex" }, "Atlas", "Atlas"],
    [{ assignedAgentId: "agent-missing" }, undefined, "backlog.assignment_unavailable_agent"],
    [{ assignedAgent: "claude" }, undefined, "claude"],
    [{ assignedTeamId: "team-1" }, "Builders", "Builders"],
    [{ assignedTeamId: "team-missing" }, undefined, "backlog.assignment_unavailable_team"],
    [{}, undefined, "backlog.unassigned"],
  ])(`shows the assigned agent or explicit fallback on every ${view}: %j`, (assignment, name, expected) => {
    const task = {
      id: "task-1", title: "Ship feature", status: "backlog", priority: "normal",
      ownerEmployeeId: "employee-1", assigneeEmployeeId: "employee-1",
      linkedSessionIds: [], createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
      ...assignment,
    } as RelayTaskListItem;
    const props = { task, ready: false, agentDisplayName: name, selected: false,
      onToggleSelect: vi.fn(), onOpen: vi.fn() };
    const { container } = render(view === "card"
      ? <BacklogTaskCard {...props} dragging={false} onDragStart={vi.fn()} onDragEnd={vi.fn()} onTouchStart={vi.fn()} />
      : <table><tbody><BacklogTaskRow {...props} canDiscuss={false} starting={false} onStart={vi.fn()}
          onEdit={vi.fn()} onAssign={vi.fn()} onToggleBlock={vi.fn()} onDone={vi.fn()} /></tbody></table>);
    const label = container.querySelector(".task-assignee-name");
    expect(label?.textContent).toBe(expected);
    expect(label?.closest(".sr-only")).toBeNull();
    expect(container.querySelectorAll(".task-assignee-name")).toHaveLength(1);
  });
}

it.each(["ready", "busy", "offline", "pending"] as const)(
  "keeps the team name visible while availability is %s", async (availability) => {
    const { TaskAssignee } = await import("../src/components/TaskAssignee");
    const { container } = render(<TaskAssignee
      task={{ assignedTeamId: "team-1" } as RelayTaskListItem}
      ready={availability === "ready"} availability={availability}
      agentDisplayName="Builders" />);
    expect(container.querySelector(".task-assignee-name")?.textContent).toBe("Builders");
    expect(container.querySelector(".agent-state")?.getAttribute("title")).toContain(`status.${availability}`);
  },
);

for (const view of ["card", "row", "routine"] as const) {
  it.each([true, false])(`shows the saved avatar on the ${view}, executor recorded: %s`, (withExecutor) => {
    const task = {
      id: "avatar-task", title: "Avatar task", status: "backlog", priority: "normal",
      assignedAgentId: "agent-1", assignedAgent: withExecutor ? "codex" : undefined,
      linkedSessionIds: [], createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
    } as RelayTaskListItem;
    const props = { task, ready: true, agentDisplayName: "Atlas",
      agentImageUrl: "/avatars/agents/bottts-01.svg", selected: false,
      onToggleSelect: vi.fn(), onOpen: vi.fn(), onEdit: vi.fn(), onAssign: vi.fn(),
      onStart: vi.fn(), starting: false };
    const { container } = render(view === "card"
      ? <BacklogTaskCard {...props} dragging={false} onDragStart={vi.fn()} onDragEnd={vi.fn()} onTouchStart={vi.fn()} />
      : view === "routine"
        ? <table><tbody><RoutineRow {...props} state="paused" /></tbody></table>
        : <table><tbody><BacklogTaskRow {...props} canDiscuss={false}
            onToggleBlock={vi.fn()} onDone={vi.fn()} /></tbody></table>);
    expect(container.querySelector(".task-assignee img")?.getAttribute("src")).toBe(props.agentImageUrl);
    expect(container.querySelector(".task-assignee-name")?.textContent).toBe("Atlas");
  });
}
