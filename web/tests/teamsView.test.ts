import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { taskAssigneeDisplayName, teamAvailability, teamReady } from "../src/lib/taskAssignment.js";
import { teamMutationInput } from "../src/lib/teamForm.js";
import { selectedTeamForWorkspace } from "../src/lib/teamWorkspace.js";

describe("Agent team management", () => {
  it("keeps teams in employee agent management instead of standalone admin navigation", async () => {
    const adminPageSource = await readFile(resolve("web/src/components/AdminPage.tsx"), "utf8");
    const appSource = await readFile(resolve("web/src/App.tsx"), "utf8");
    const agentsSource = await readFile(resolve("web/src/components/AgentsPage.tsx"), "utf8");
    const teamsSource = await readFile(resolve("web/src/components/TeamsPage.tsx"), "utf8");
    const agentDetailSource = await readFile(resolve("web/src/components/AgentDetailPage.tsx"), "utf8");
    const projectWorkspaceFilesSource = await readFile(resolve("web/src/components/ProjectWorkspaceFiles.tsx"), "utf8");
    const teamWorkspaceSource = await readFile(resolve("web/src/components/TeamWorkspacePage.tsx"), "utf8");
    const teamMarkSource = await readFile(resolve("web/src/components/IdentityMark.tsx"), "utf8");
    const sideNavSource = await readFile(resolve("web/src/components/SideNav.tsx"), "utf8");
    const drawerSource = await readFile(resolve("web/src/components/admin/TeamDrawer.tsx"), "utf8");
    const pickerSource = await readFile(resolve("web/src/components/assignment/AssignmentField.tsx"), "utf8");
    // The identity rows the picker draws live in the shared roster row
    // component now — every agent/team picker renders the same team mark.
    const rosterRowSource = await readFile(resolve("web/src/components/roster/RosterOption.tsx"), "utf8");

    assert.doesNotMatch(adminPageSource, /adminTeam|adminAddTeam|<TeamsView/);
    assert.doesNotMatch(agentsSource, /agentsView|managementView|<TeamDrawer|useTeams/);
    assert.match(appSource, /route === "teams" \? \(\s*<TeamsPage/s);
    assert.match(teamsSource, /className="teams-list"/);
    assert.match(teamsSource, /<TeamWorkspacePage/);
    assert.match(agentDetailSource, /"profile", "activities"/);
    assert.doesNotMatch(agentDetailSource, /"workspace"|ThreadWorkspaceFiles|listAgentWorkspaceFiles|getAgentArtifacts|type: "artifact"/);
    assert.match(teamWorkspaceSource, /"profile", "activities"/);
    assert.doesNotMatch(teamWorkspaceSource, /"workspace"|ThreadWorkspaceFiles|teamWorkspaceAgentId/);
    assert.match(projectWorkspaceFilesSource, /listProjectWorkspaceFiles|readProjectWorkspaceFile/);
    assert.doesNotMatch(projectWorkspaceFilesSource, /listAgentWorkspaceFiles|readAgentWorkspaceFile|threadId|WorkspaceFileScope/);
    assert.doesNotMatch(teamWorkspaceSource, /getTeamArtifacts|TeamArtifacts/);
    assert.match(teamWorkspaceSource, /getWorkspaceBrief\(\{ teamId: team\.id \}/);
    assert.doesNotMatch(agentDetailSource, /nav\.refresh|NavRefresh/);
    assert.doesNotMatch(teamWorkspaceSource, /nav\.refresh|NavRefresh/);
    assert.match(teamsSource, /className="page-header-icon-action"[\s\S]*?onClick=\{\(\) => setAddTeam\(true\)\}/);
    // Creating a team must remain available from a selected team's detail
    // view; the dialog state itself is the sole authority for its visibility.
    assert.match(teamsSource, /open=\{addTeam\}/);
    assert.match(agentsSource, /<RosterFilterBar/);
    assert.doesNotMatch(agentsSource, /isDetailRoute/);
    assert.doesNotMatch(teamsSource, /editTeam/);
    assert.doesNotMatch(teamsSource, /onEdit=/);
    assert.match(teamWorkspaceSource, /className="team-profile-inline-form"/);
    assert.match(teamWorkspaceSource, /updateTeamMutation\.mutateAsync/);
    assert.match(teamWorkspaceSource, /deleteTeamMutation\.mutateAsync/);
    assert.match(teamMarkSource, /Relay's default profile image for an agent or an agent team/);
    assert.match(teamMarkSource, /M10\.83 3\.62Q12 2\.95/);
    assert.match(teamsSource, /className="teams-list-mark"/);
    assert.match(teamWorkspaceSource, /<IdentityMark kind="team" variant="bare"/);
    // The assignment picker identifies a team by its profile image, whose
    // default is the shared team glyph — the same mark the empty state draws.
    assert.match(rosterRowSource, /fallback=\{<IdentityMark kind="team" \/>\}/);
    assert.match(sideNavSource, /data-nav="teams"/);
    assert.match(sideNavSource, /handleRouteClick\(event, "teams"\)/);
    assert.match(drawerSource, /memberAgentIds/);
    assert.match(drawerSource, /leadAgentId/);
    assert.match(drawerSource, /useEmployeeAgents\(open \? employeeId : undefined\)/);
    assert.match(teamsSource, /employeeId=\{currentUser\.employeeId\}/);
    assert.match(pickerSource, /team:\$\{team\.id\}/);
    assert.match(pickerSource, /backlog\.teams_section/);
  });

  it("builds an agent-team payload without exposing employee ownership fields", () => {
    assert.deepEqual(teamMutationInput({
      name: " Delivery ",
      leadAgentId: "agent_lead",
      memberAgentIds: ["agent_lead"],
      enabled: true,
    }), {
      name: "Delivery",
      leadAgentId: "agent_lead",
      memberAgentIds: ["agent_lead"],
      enabled: true,
    });
  });

  it("keeps the employee as assignee when a team executes the task", () => {
    const user = {
      id: "user-1",
      employeeId: "employee-1",
      username: "jordan",
      displayName: "Jordan Lee",
      role: "user" as const,
    };
    assert.equal(taskAssigneeDisplayName({
      assigneeEmployeeId: "employee-1",
      assignedTeamId: "team-1",
    }, user), "Jordan Lee");
    assert.equal(taskAssigneeDisplayName({
      assigneeEmployeeId: "employee-2",
      assignedTeamId: "team-1",
    }, user), "employee-2");
  });

  it("requires every Team member to be ready", () => {
    assert.equal(teamReady({
      enabled: true,
      members: [
        {
          id: "lead",
          displayName: "Lead",
          executorKind: "codex",
          enabled: true,
          availability: "ready",
        },
        {
          id: "support",
          displayName: "Support",
          executorKind: "claude",
          enabled: false,
          availability: "offline",
        },
      ],
    }), false);
    assert.equal(teamReady({
      enabled: true,
      members: [
        {
          id: "lead",
          displayName: "Lead",
          executorKind: "codex",
          enabled: true,
          availability: "ready",
        },
        {
          id: "support",
          displayName: "Support",
          executorKind: "claude",
          enabled: true,
          availability: "ready",
        },
      ],
    }), true);
    assert.equal(teamAvailability({
      enabled: true,
      members: [{
        id: "lead",
        displayName: "Lead",
        executorKind: "codex",
        enabled: true,
        availability: "offline",
      }],
    }), "offline");
    assert.equal(teamAvailability({
      enabled: true,
      members: [{
        id: "lead",
        displayName: "Lead",
        executorKind: "codex",
        enabled: true,
        availability: "busy",
      }],
    }), "busy");
  });

  it("selects only the team addressed by the pathname", () => {
    const teams = [{ id: "team-delivery", name: "Delivery" }, { id: "team-research", name: "Research" }];

    assert.equal(selectedTeamForWorkspace(teams, null), null);
    assert.equal(selectedTeamForWorkspace(teams, "team-research")?.id, "team-research");
    assert.equal(selectedTeamForWorkspace(teams, "team-missing"), null);
  });
});
