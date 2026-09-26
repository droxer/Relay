import { expect, test, type Page } from "@playwright/test";

const stamp = "2026-09-25T00:00:00Z";
const computerId = "device:alice:host";

async function fixture(page: Page, state: { archived?: boolean } = {}) {
  const agents = [["lead", "Atlas", "implementer"], ["qa", "Vera", "reviewer"]].map(([id, displayName, defaultRole]) => ({
    id, displayName, executorKind: "codex", defaultRole, supervisorEmployeeId: "alice", enabled: true, availability: "ready",
    version: 1, skills: [], deletedAt: null, createdAt: stamp, updatedAt: stamp,
    placements: [{ id: `p-${id}`, agentId: id, computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
  }));
  let project: Record<string, unknown> = {
    id: "proj_api", ownerEmployeeId: "alice", name: "API revamp", computerId, workspaceLayout: "project",
    workspaceSubpath: "projects/api", leadAgentId: "lead", enabled: true, version: 4, createdAt: stamp, updatedAt: stamp,
    ...(state.archived ? { archivedAt: stamp } : {}),
    members: [
      { agentId: "lead", role: "implementer", responsibilities: "Own the API", enabled: true },
      { agentId: "qa", role: "reviewer", responsibilities: "Review changes", enabled: true },
    ],
  };
  const node = { id: "node", employeeId: "alice", workspaceId: "host", computerId, name: "Computer", activeRuns: [],
    online: true, stale: false, status: "ready", agents: { codex: "ready" }, queuedCommandCount: 0, capabilities: [] };
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents, teams: [], tasks: [], nodes: [node], projects: [project], sandboxes: [], skills: [], events: [], runs: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", employeeId: "alice", username: "alice", role: "employee", theme: "light", language: "en" } };
    if (path.endsWith("/projects/proj_api")) {
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON();
        patches.push(patch);
        project = { ...project, name: patch.name, version: Number(project.version) + 1 };
      }
      body = { project };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { patches };
}

for (const mobile of [false, true]) {
  test(`project agents tab shows an identity rail and renames in place (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const { patches } = await fixture(page);
    await page.goto("/projects/proj_api?tab=profile");
    const rail = page.getByRole("complementary", { name: "Identity" });
    await expect(rail).toBeVisible();
    await expect(rail).toContainText("Project lead");
    await expect(rail).toContainText("Atlas");
    await expect(rail).toContainText("projects/api");
    await expect(page.getByRole("heading", { name: /Project agents/ })).toContainText("2");
    await rail.getByRole("button", { name: "Rename project" }).click();
    const input = rail.getByRole("textbox", { name: "Project name" });
    await input.fill("Billing revamp");
    await input.press("Enter");
    await expect.poll(() => patches.at(-1)).toEqual({ expectedVersion: 4, name: "Billing revamp" });
    await expect(rail.getByRole("textbox")).toHaveCount(0);
    await expect(rail).toContainText("Billing revamp");
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    if (!mobile) {
      const doc = await page.locator(".project-profile .workspace-dossier-doc").boundingBox();
      const side = await rail.boundingBox();
      expect(side!.x).toBeGreaterThan(doc!.x + doc!.width);
    }
  });
}

test("an archived project shows its name without a rename control", async ({ page }) => {
  await fixture(page, { archived: true });
  await page.goto("/projects/proj_api?tab=profile");
  const rail = page.getByRole("complementary", { name: "Identity" });
  await expect(rail).toContainText("API revamp");
  await expect(rail.getByRole("button", { name: "Rename project" })).toHaveCount(0);
});
