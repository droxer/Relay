import { expect, test } from "@playwright/test";

test("team responsibilities can be edited and persist after reload", async ({ page }) => {
  const stamp = "2026-09-18T00:00:00Z";
  const agents = ["lead", "builder"].map(id => ({ id, displayName: id === "lead" ? "Lead" : "Builder", executorKind: "codex", defaultRole: "implementer", supervisorUserId: "alice", enabled: true, availability: "ready", computerId: "c",
    placements: [{ id: `place-${id}`, computerId: "c", nodeDisplayName: "Build Computer", desiredState: "active", priority: 0 }],
    version: 1, createdAt: stamp, updatedAt: stamp }));
  let team = { id: "delivery", name: "Delivery", ownerUserId: "alice", computerId: "c", leadAgentId: "lead", memberAgentIds: ["lead", "builder"], members: agents, lead: agents[0], enabled: true, version: 1, memberConfigs: { lead: { role: "implementer" }, builder: { role: "implementer", expectedOutputs: ["Keep the build notes"] } }, acceptanceCriteria: [], createdAt: stamp, updatedAt: stamp };
  let saved: Record<string, unknown> | undefined;
  let memberPatch: Record<string, unknown> | undefined;
  const reads: string[] = [];
  const agentRosterReads: string[] = [];
  await page.route("**/api/**", async route => {
    const { pathname: path, search } = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && (path.endsWith("/member-choices")
        || (path.endsWith("/agents") && new URLSearchParams(search).get("view") === "summary"))) {
      agentRosterReads.push(path + search);
    }
    let body: unknown = { sessions: [], tasks: [], nodes: [], projects: [], sandboxes: [], agents, teams: [team] };
    if (path.endsWith("/member-choices")) body = { computerId: "c", agents };
    if (path.endsWith("/workflow-choices")) body = { workflows: [], projects: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "alice", username: "alice", role: "user", language: "en", theme: "light" } };
    if (method === "GET" && path.endsWith("/teams")) {
      reads.push(path + search);
      const { members, lead, ...summary } = team;
      body = {
        view: "summary", memberDirectory: members.map(({ placements, computerId, ...member }) => member), predefinedWorkflows: [],
        teams: [{ ...summary, workflowOptions: [], memberConfigs: { lead: { role: "implementer" }, builder: { role: "implementer" } } }],
      };
    }
    if (method === "GET" && path.endsWith("/teams/delivery")) {
      reads.push(path + search);
      body = { team };
    }
    if (method === "PATCH" && path.endsWith("/teams/delivery/members/builder")) {
      memberPatch = route.request().postDataJSON();
      const baseVersion = team.version;
      team = { ...team, version: baseVersion + 1, memberConfigs: {
        ...team.memberConfigs, builder: { ...team.memberConfigs.builder, ...memberPatch },
      } };
      body = { teamMemberUpdate: { teamId: team.id, agentId: "builder", baseVersion, version: team.version, updatedAt: stamp, fields: memberPatch } };
    }
    if (path.endsWith("/teams/delivery") && method === "PATCH") {
      saved = route.request().postDataJSON();
      team = { ...team, ...saved, version: team.version + 1 };
      body = { team };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/teams/delivery");
  await expect(page.getByText("Build Computer", { exact: true }).first()).toBeVisible();
  // A member's contract is edited on its own card and saved on its own.
  await page.getByRole("button", { name: "Edit Builder", exact: true }).click();
  await page.getByLabel("Responsibility", { exact: true }).fill("Own the API and regression tests");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => memberPatch).toEqual({ responsibility: "Own the API and regression tests" });
  await expect(page.getByText("Own the API and regression tests", { exact: true })).toBeVisible();
  await expect(page.getByText("Keep the build notes", { exact: true })).toBeVisible();
  expect(reads).toEqual(["/api/v1/teams?view=summary&format=compact", "/api/v1/teams/delivery?view=preview"]);
  expect(agentRosterReads).toEqual([]);
  // Acceptance criteria belong to the team and are edited with the roster.
  await page.getByRole("button", { name: "Edit team" }).click();
  await expect.poll(() => agentRosterReads).toEqual(["/api/v1/teams/delivery/member-choices"]);
  await page.getByLabel("Acceptance criteria").fill("Existing clients remain compatible");
  await page.getByRole("button", { name: "Save team", exact: true }).click();
  await expect.poll(() => saved?.acceptanceCriteria).toEqual(["Existing clients remain compatible"]);
  await expect.poll(() => saved?.memberConfigs).toEqual({
    lead: { role: "implementer" },
    builder: { responsibility: "Own the API and regression tests", role: "implementer", expectedOutputs: ["Keep the build notes"] },
  });
  expect(agentRosterReads).toEqual(["/api/v1/teams/delivery/member-choices"]);
  await page.reload();
  await expect(page.getByText("Own the API and regression tests", { exact: true })).toBeVisible();
});
