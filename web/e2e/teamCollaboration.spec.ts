import { expect, test } from "@playwright/test";

test("team responsibilities can be edited and persist after reload", async ({ page }) => {
  const stamp = "2026-09-18T00:00:00Z";
  const agents = ["lead", "builder"].map(id => ({ id, displayName: id === "lead" ? "Lead" : "Builder", executorKind: "codex", defaultRole: "implementer", supervisorEmployeeId: "alice", enabled: true, availability: "ready", computerId: "c", placements: [], version: 1, createdAt: stamp, updatedAt: stamp }));
  let team = { id: "delivery", name: "Delivery", ownerEmployeeId: "alice", computerId: "c", leadAgentId: "lead", memberAgentIds: ["lead", "builder"], members: agents, lead: agents[0], enabled: true, memberConfigs: {}, acceptanceCriteria: [], createdAt: stamp, updatedAt: stamp };
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], tasks: [], nodes: [], projects: [], sandboxes: [], agents, teams: [team] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", employeeId: "alice", username: "alice", role: "employee", language: "en", theme: "light" } };
    if (path.endsWith("/teams/delivery") && route.request().method() === "PATCH") {
      saved = route.request().postDataJSON();
      team = { ...team, ...saved };
      body = { team };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/teams/delivery");
  // A member's contract is edited on its own card and saved on its own.
  await page.getByRole("button", { name: "Edit Builder", exact: true }).click();
  await page.getByLabel("Responsibility", { exact: true }).fill("Own the API and regression tests");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saved?.memberConfigs).toEqual({ builder: { responsibility: "Own the API and regression tests" } });
  // Acceptance criteria belong to the team and are edited with the roster.
  await page.getByRole("button", { name: "Edit members" }).click();
  await page.getByLabel("Acceptance criteria").fill("Existing clients remain compatible");
  await page.getByRole("button", { name: "Save team", exact: true }).click();
  await expect.poll(() => saved?.acceptanceCriteria).toEqual(["Existing clients remain compatible"]);
  await expect.poll(() => saved?.memberConfigs).toEqual({ builder: { responsibility: "Own the API and regression tests" } });
  await page.reload();
  await expect(page.getByText("Own the API and regression tests", { exact: true })).toBeVisible();
});
