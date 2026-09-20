import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`project task lifecycle and layout (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const project = { id: "launch", name: "Autumn launch", ownerEmployeeId: "u", computerId: "c", enabled: true,
      members: [], leadAgentId: null, version: 1, workspaceLayout: "project", workspaceSubpath: "projects/launch", createdAt: stamp, updatedAt: stamp };
    const tasks = ["backlog", "assigned", "running", "review", "done", "blocked"].map((status, i) => ({
      id: `task-${i}`, title: ["Write the release brief", "Polish onboarding", "Build the launch page", "Review final copy", "Choose the release date", "Resolve the deployment issue"][i],
      projectId: "launch", status, workflowStage: status === "blocked" ? "running" : status,
      description: "", priority: "normal", isRoutine: false, routineEnabled: false,
      linkedSessionIds: [], ownerEmployeeId: "u", createdAt: stamp, updatedAt: stamp,
    }));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [project], tasks, sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", employeeId: "u", username: "Designer", role: "employee", theme: "light", language: "en" } };
      if (path.endsWith("/tasks") && route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        expect(input.projectId).toBe("launch");
        const created = { ...tasks[0], ...input, id: "created", activity: [], events: [] };
        tasks.push(created); body = created;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/projects/launch");
    await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("link", { name: "Write the release brief" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    await page.getByRole("textbox", { name: "New task", exact: true }).fill("Prepare release notes");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.getByRole("link", { name: "Prepare release notes" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "7");
    await expect(page.getByRole("textbox", { name: "New task", exact: true })).toHaveValue("");
    const panel = page.locator(".project-tasks-panel");
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const finalCard = page.getByRole("link", { name: "Choose the release date" });
    await finalCard.scrollIntoViewIfNeeded();
    await expect(finalCard).toBeInViewport();
    await panel.evaluate((el) => { el.scrollTop = 0; });
    await page.locator(".project-task-board").evaluate((el) => { el.scrollLeft = 0; });
    await page.screenshot({ path: `/tmp/relay-project-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.getByRole("tab", { name: "Team", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Team", exact: true })).toHaveAttribute("aria-selected", "true");
  });
}
