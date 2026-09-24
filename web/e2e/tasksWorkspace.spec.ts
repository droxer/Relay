import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`task status list and execution drawer (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const projects = ["Launch", "Support", "Empty"].map((name) => ({ id: name.toLowerCase(), name, enabled: true, members: [], ownerEmployeeId: "u", computerId: "c", createdAt: stamp, updatedAt: stamp }));
    const tasks = [
      { id: "ship", title: "Ship the release", projectId: "launch", status: "review", assignedTeamId: "team-a" },
      { id: "answer", title: "Answer customers", projectId: "support", status: "running" },
    ].map((task) => ({ ...task, description: "Check the execution results before completing this task.", priority: "normal", isRoutine: false, routineEnabled: false, linkedSessionIds: [], ownerEmployeeId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [] }));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [{ id: "team-a", name: "Launch team", enabled: true, members: [] }], nodes: [], projects, tasks, sandboxes: [], skills: [], files: [], entries: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", employeeId: "u", username: "Designer", role: "employee", theme: "light", language: "en" } };
      const detail = tasks.find((task) => path.endsWith(`/tasks/${task.id}`));
      if (detail) body = detail;
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { runs: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/backlog");
    const panel = page.locator("#backlog-panel");
    await expect(panel.getByRole("group", { name: "Backlog metrics" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Ship the release", exact: true })).toHaveCount(1);
    await expect(panel.getByRole("columnheader", { name: "Actions", exact: true })).toHaveCount(0);
    const rows = panel.getByRole("table", { name: "All tasks", exact: true });
    await expect(rows.getByRole("link", { name: "Ship the release" })).toBeVisible();
    await expect(rows.getByRole("link", { name: "Answer customers" })).toBeVisible();
    await expect(panel.locator(".list-group-band")).toHaveCount(0);
    // Filters are chips: "Add filter" → field → value (one condition, so no
    // condition step). The page's filter state still lives in the URL.
    const addFilter = async (field: string, value: string) => {
      await panel.getByRole("button", { name: "Add filter", exact: true }).click();
      await page.getByRole("option", { name: new RegExp(`^${field}`) }).click();
      await page.getByRole("option", { name: value, exact: true }).click();
    };
    await addFilter("Assignment", "Unassigned");
    await expect(rows.getByRole("link", { name: "Ship the release" })).toHaveCount(0);
    await expect(rows.getByRole("link", { name: "Answer customers" })).toBeVisible();
    await panel.getByRole("button", { name: "Clear", exact: true }).click();
    await addFilter("Team", "Launch team");
    await expect(rows.getByRole("link", { name: "Answer customers" })).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.searchParams.get("team") === "team-a");
    await panel.getByRole("button", { name: "Clear", exact: true }).click();
    const statusNav = panel.getByRole("navigation", { name: "Status", exact: true });
    await statusNav.getByRole("button", { name: "Review 1", exact: true }).click();
    await expect(panel.getByRole("link", { name: "Answer customers" })).toHaveCount(0);
    await expect(statusNav.getByRole("button", { name: "In progress 1", exact: true })).toBeVisible();
    await statusNav.getByRole("button", { name: "All tasks 2", exact: true }).click();
    await addFilter("Projects", "Empty");
    await expect(panel.getByRole("link", { name: "Ship the release" })).toHaveCount(0);
    // The project chip survives an empty project; removing it returns to all projects.
    await panel.getByRole("button", { name: "Projects filter options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    await expect(panel.getByRole("link", { name: "Answer customers" })).toBeVisible();
    const taskLink = panel.getByRole("link", { name: "Ship the release", exact: true });
    await taskLink.scrollIntoViewIfNeeded();
    await expect.poll(() => taskLink.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === element || element.contains(hit);
    })).toBe(true);
    await page.screenshot({ path: `/tmp/relay-tasks-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await panel.getByRole("searchbox", { name: "Search tasks" }).fill("Ship");
    await panel.getByRole("link", { name: "Ship the release", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(drawer.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
    await expect(drawer).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `/tmp/relay-task-drawer-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await drawer.getByRole("button", { name: "Close drawer", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(panel.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("Ship");
    await expect(page).toHaveURL((url) => url.pathname === "/backlog" && url.searchParams.get("q") === "Ship");
    await panel.getByRole("searchbox", { name: "Search tasks" }).fill("");
    await expect(panel.getByRole("link", { name: "Answer customers" })).toBeVisible();
    await page.goto("/backlog/ship?project=launch&tab=files");
    await expect(drawer.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
    await drawer.getByRole("button", { name: "Close drawer", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === "/backlog" && url.searchParams.get("project") === "launch");
    await expect(panel.getByRole("link", { name: "Ship the release" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Answer customers" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}
