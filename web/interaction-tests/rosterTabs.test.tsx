import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRosterTabs } from "../src/components/roster/RosterTabs";
import { AgentSelect } from "../src/components/composer/AgentSelect";
import { AssignmentSelect } from "../src/components/assignment/AssignmentField";
import type { AgentTeam, UserAgent } from "../src/types";

// Keep the popup mounted while its options change, as SelectContent does.
// Options own DOM focus; replacing the roster must not strand it on body.
function Picker({ emptyTeams = false }: {
  emptyTeams?: boolean;
}) {
  const roster = useRosterTabs({
    tabs: [
      { id: "agents", label: "Agents", count: 1 },
      { id: "teams", label: "Teams", count: emptyTeams ? 0 : 2 },
    ],
    activeTab: "agents",
    label: "Target",
  });
  return (
    <div data-slot="select-content" tabIndex={-1} onKeyDownCapture={roster.onKeyDownCapture}>
      {roster.header}
      <div role="listbox" aria-label="Target">
        {roster.tab === "agents" ? (
          <button key="agent" role="option" aria-selected={false}>Alice</button>
        ) : emptyTeams ? null : (
          <>
            <button key="offline" role="option" aria-selected={false} aria-disabled="true">Offline team</button>
            <button key="team" role="option" aria-selected={false}>Team One</button>
          </>
        )}
      </div>
    </div>
  );
}

it("moves keyboard focus to an enabled option in the new roster", () => {
  render(<Picker />);
  screen.getByRole("option", { name: "Alice" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Team One" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Alice" }));
});

it("keeps focus inside an empty roster so the user can switch back", () => {
  const { container } = render(<Picker emptyTeams />);
  screen.getByRole("option", { name: "Alice" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(container.querySelector('[data-slot="select-content"]'));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Alice" }));
});

it("moves focus into the new roster after a tab click", () => {
  render(<Picker />);
  screen.getByRole("option", { name: "Alice" }).focus();
  fireEvent.click(screen.getByRole("radio", { name: /Teams/ }));
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Team One" }));
});

it.each(["task assignment", "conversation"] as const)("uses Agent roles and levels in the %s roster", async (surface) => {
  const ada: UserAgent = {
    id: "ada", displayName: "Ada", executorKind: "codex", enabled: true, availability: "ready",
    defaultRole: "planner", modelPolicy: { model: "provider/custom-model" }, skillPolicy: {}, toolPolicy: {},
    placements: [], version: 1, createdAt: "2026-11-26T00:00:00Z", updatedAt: "2026-11-26T00:00:00Z",
  };
  const bob: UserAgent = { ...ada, id: "bob", displayName: "Bob", modelPolicy: {}, defaultRole: "reviewer", roleLevel: "senior" };
  const agents = [ada, bob];
  const onPick = vi.fn();
  render(surface === "task assignment"
    ? <AssignmentSelect agents={agents} teams={[]} value="agent:bob" selectedAgent={bob} onSelect={onPick} />
    : <AgentSelect logicalAgents={agents} activeLogicalAgentId={bob.id} onLogicalAgentPicked={onPick} />);

  const trigger = screen.getByRole("combobox");
  expect(trigger.textContent).toContain("role_levels.badge_senior");
  expect(trigger.textContent).toContain("admin.v2.agent_role.reviewer");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const pinned = await screen.findByRole("option", { name: /Ada.*admin\.v2\.agent_role\.planner/ });
  const senior = screen.getByRole("option", { name: /Bob.*role_levels\.senior.*admin\.v2\.agent_role\.reviewer/ });
  expect(pinned.textContent).not.toMatch(/Codex|provider\/custom-model/);
  expect(senior.textContent).not.toMatch(/Codex|agents_page\.model_default/);
  act(() => pinned.focus());
  fireEvent.keyDown(pinned, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith(surface === "task assignment" ? { kind: "agent", id: ada.id } : ada);
});

it("selects a composer team with Enter after switching rosters", async () => {
  const agent = { id: "a", displayName: "Alice", executorKind: "claude", enabled: true, availability: "ready" } as UserAgent;
  const team = { id: "t", name: "Team One", enabled: true, members: [agent] } as AgentTeam;
  const onTeamPicked = vi.fn();
  render(<AgentSelect logicalAgents={[agent]} activeLogicalAgentId="a" onLogicalAgentPicked={vi.fn()}
    teams={[team]} teamOptionsEnabled onTeamPicked={onTeamPicked} />);
  const trigger = screen.getByRole("combobox");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: /Alice/ });
  // jsdom has no layout for the popup's automatic initial-focus positioning.
  act(() => option.focus());
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  await waitFor(() => {
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Team One/ }));
  });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(onTeamPicked).toHaveBeenCalledWith(team);
});
