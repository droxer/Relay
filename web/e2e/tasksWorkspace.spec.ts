import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`issue queues and execution drawer (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const projects = ["Launch", "Support", "Empty"].map((name) => ({ id: name.toLowerCase(), name, enabled: true, members: [], ownerUserId: "u", computerId: "c", createdAt: stamp, updatedAt: stamp }));
    const tasks = [
      { id: "ship", title: "Ship the release", projectId: "launch", status: "review", assignedTeamId: "team-a" },
      { id: "answer", title: "Answer customers", projectId: "support", status: "running" },
    ].map((task) => ({ ...task, description: "Check the execution results before completing this task.", priority: "normal", isRoutine: false, linkedSessionIds: [], ownerUserId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [] }));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [{ id: "team-a", name: "Launch team", enabled: true, members: [] }], nodes: [], projects, tasks, sandboxes: [], skills: [], files: [], entries: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme: "light", language: "en" } };
      const detail = tasks.find((task) => path.endsWith(`/tasks/${task.id}`));
      if (detail) body = detail;
      if (path.endsWith("/tasks/ship/artifacts")) body = { artifacts: [
        { id: "notes", sessionId: "run", kind: "workspace_file", title: "release-notes.md", path: "artifacts/release-notes.md", contentType: "text/markdown", bytes: 100, createdAt: stamp },
        { id: "checks", sessionId: "run", kind: "workspace_file", title: "checks.txt", path: "artifacts/checks.txt", contentType: "text/plain", bytes: 50, createdAt: stamp },
      ] };
      if (path.endsWith("/threads/run/artifacts/notes") || path.endsWith("/threads/run/artifacts/checks")) {
        await route.fulfill({ status: 200, contentType: "text/plain", body: path.endsWith("/notes") ? "# Release notes\n\nReady to ship." : "All checks passed." });
        return;
      }
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { runs: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/tasks");
    const panel = page.locator("#backlog-panel");
    await expect(panel.getByRole("group", { name: "Backlog metrics" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Ship the release", exact: true })).toHaveCount(1);
    await expect(panel.getByRole("columnheader", { name: "Actions", exact: true })).toHaveCount(0);
    const rows = panel.getByRole("table", { name: "Tasks", exact: true });
    await expect(rows.getByRole("link", { name: "Ship the release" })).toBeVisible();
    await expect(rows.getByRole("link", { name: "Answer customers" })).toBeVisible();
    await expect(panel.locator(".issues-band")).toHaveCount(2);
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
    await panel.getByRole("button", { name: "Clear filters", exact: true }).click();
    await addFilter("Team", "Launch team");
    await expect(rows.getByRole("link", { name: "Answer customers" })).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.searchParams.get("team") === "team-a");
    await panel.getByRole("button", { name: "Clear filters", exact: true }).click();
    const statusNav = panel.getByRole("navigation", { name: "Task queues", exact: true });
    await statusNav.getByRole("button", { name: "Awaiting your input 1", exact: true }).click();
    await expect(panel.getByRole("link", { name: "Answer customers" })).toHaveCount(0);
    await expect(statusNav.getByRole("button", { name: "Running 1", exact: true })).toBeVisible();
    await statusNav.getByRole("button", { name: "All open 2", exact: true }).click();
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
    await expect(drawer.getByRole("tab", { name: "Workspace", exact: true })).toHaveCount(0);
    await expect(drawer.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
    await expect(drawer).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `/tmp/relay-task-drawer-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await drawer.getByRole("button", { name: "Close drawer", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(panel.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("Ship");
    await expect(page).toHaveURL((url) => url.pathname === "/tasks" && url.searchParams.get("q") === "Ship");
    await panel.getByRole("searchbox", { name: "Search tasks" }).fill("");
    await expect(panel.getByRole("link", { name: "Answer customers" })).toBeVisible();
    // A retired ?tab=workspace link opens the task's files.
    await page.goto("/tasks/ship?project=launch&tab=workspace");
    await expect(drawer.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
    const notes = drawer.getByRole("button", { name: /release-notes.md/ });
    await notes.click();
    await expect(drawer.getByRole("heading", { name: "Release notes", exact: true })).toBeVisible();
    await expect(drawer.locator("a[download]")).toHaveAttribute("href", /\/threads\/run\/artifacts\/notes$/);
    await drawer.getByRole("button", { name: "Source", exact: true }).click();
    await expect(drawer.locator(".code-view")).toContainText("# Release notes");
    if (mobile) {
      await drawer.getByRole("button", { name: "Back to files", exact: true }).click();
      await expect(notes).toBeFocused();
    }
    const checks = drawer.getByRole("button", { name: /checks.txt/ });
    await checks.click();
    await expect(drawer.getByText("All checks passed.", { exact: true })).toBeVisible();
    if (mobile) {
      await drawer.getByRole("button", { name: "Back to files", exact: true }).click();
      await expect(checks).toBeFocused();
      await expect(checks).toHaveAttribute("aria-current", "true");
    }
    await drawer.getByRole("button", { name: "Close drawer", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === "/tasks" && url.searchParams.get("project") === "launch");
    await expect(panel.getByRole("link", { name: "Ship the release" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Answer customers" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}
