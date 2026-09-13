import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRosterTabs } from "../src/components/roster/RosterTabs";
import { AgentSelect } from "../src/components/composer/AgentSelect";
import type { AgentTeam, EmployeeAgent } from "../src/types";

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
  fireEvent.click(screen.getByRole("tab", { name: /Teams/ }));
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "Team One" }));
});

it("selects a composer team with Enter after switching rosters", async () => {
  const agent = { id: "a", displayName: "Alice", executorKind: "claude", enabled: true, availability: "ready" } as EmployeeAgent;
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
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("option", { name: /Team One/ }));
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(onTeamPicked).toHaveBeenCalledWith(team);
}, 60000);
