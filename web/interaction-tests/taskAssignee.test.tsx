import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BacklogTaskCard, BacklogTaskList } from "../src/components/task-board/BacklogRecords";
import { RoutineTable } from "../src/components/task-board/RoutineRecords";
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
      ? <BacklogTaskCard {...props} />
      : <BacklogTaskList tasks={[task]} sort={null} onSort={vi.fn()} selectAll={null}
          selectedIds={new Set()} onToggleSelect={vi.fn()}
          contextFor={() => ({ ready: props.ready, agentDisplayName: props.agentDisplayName })}
          onOpenTask={vi.fn()} />);
    const label = container.querySelector(".task-assignee-name");
    expect(label?.textContent).toBe(expected);
    expect(label?.closest(".sr-only")).toBeNull();
    expect(container.querySelectorAll(".task-assignee-name")).toHaveLength(1);
    if (Object.keys(assignment).length > 0) {
      expect(container.querySelector('.task-assignee .profile-image[data-has-image="false"]')).not.toBeNull();
    }
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
      ? <BacklogTaskCard {...props} />
      : view === "routine"
        ? <RoutineTable rows={[task]} sort={null} onSort={vi.fn()} ariaLabel="Routines" selectAll={null}
            selection={new Set()} onToggleSelect={vi.fn()} stateFor={() => "paused"}
            assignmentFor={() => ({ name: "Atlas", imageUrl: props.agentImageUrl, ready: true })}
            handlersFor={() => ({ starting: false, onOpen: vi.fn(), onEdit: vi.fn(), onAssign: vi.fn(), onStart: vi.fn() })} />
        : <BacklogTaskList tasks={[task]} sort={null} onSort={vi.fn()} selectAll={null}
            selectedIds={new Set()} onToggleSelect={vi.fn()}
            contextFor={() => ({ ready: props.ready, agentDisplayName: props.agentDisplayName, agentImageUrl: props.agentImageUrl })}
            onOpenTask={vi.fn()} />);
    expect(container.querySelector(".task-assignee img")?.getAttribute("src")).toBe(props.agentImageUrl);
    expect(container.querySelector(".task-assignee-name")?.textContent).toBe("Atlas");
  });
}

it("shows the team's saved avatar alongside its name", async () => {
  const { TaskAssignee } = await import("../src/components/TaskAssignee");
  const { container } = render(<TaskAssignee task={{ assignedTeamId: "team-1" } as RelayTaskListItem}
    ready agentDisplayName="Builders" agentImageUrl="/avatars/teams/shape-grid-01.svg" />);
  expect(container.querySelector(".task-assignee img")?.getAttribute("src")).toBe("/avatars/teams/shape-grid-01.svg");
  expect(container.querySelector(".task-assignee-name")?.textContent).toBe("Builders");
});
