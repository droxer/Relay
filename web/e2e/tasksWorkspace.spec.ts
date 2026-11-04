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
        await route.fulfill({ status: 200, contentType: "text/plain", body: path.endsWith("/notes") ? "# Release notes\n\n" + "Ready to ship.\n\n".repeat(40) + "End of release notes." : "All checks passed." });
        return;
      }
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { runs: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/tasks");
    const panel = page.locator("#backlog-panel");
    await expect(panel.getByRole("group", { name: "Task summary" })).toHaveCount(0);
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
    await statusNav.getByRole("button", { name: "Needs attention 1", exact: true }).click();
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
    // Files gives the preview the drawer's width: the properties are a tab away.
    await expect(drawer.locator(".record-layout-aside")).toBeHidden();
    const notes = drawer.getByRole("button", { name: /release-notes.md/ });
    await notes.click();
    if (!mobile) await page.screenshot({ path: "/tmp/relay-task-files-desktop.png" });
    await expect(drawer.getByRole("heading", { name: "Release notes", exact: true })).toBeVisible();
    // The preview must use the remaining drawer height, including when the
    // narrow layout hides its properties panel. A spare grid row used to
    // leave half the phone blank below a 360px preview.
    const preview = drawer.locator(".artifact-preview-body");
    await expect.poll(async () => {
      const [body, frame] = await Promise.all([preview.boundingBox(), drawer.boundingBox()]);
      return body && frame ? Math.abs(body.y + body.height - frame.y - frame.height) : Infinity;
    }).toBeLessThan(3);
    await preview.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(drawer.getByText("End of release notes.", { exact: true })).toBeInViewport();
    await preview.evaluate((element) => { element.scrollTop = 0; });
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

for (const width of [320, 390, 820]) {
  test(`automation preview fills a ${width}px touch screen`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width, height: 744 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const stamp = "2026-11-03T12:00:00Z";
    const name = "ai-daily-update-2026-11-03.md";
    const routine = {
      id: "daily", title: "AI Daily Updates", description: "", status: "backlog", priority: "normal",
      isRoutine: true, routineState: "active", routineTriggers: [], linkedSessionIds: [], assignedAgentId: "agent",
      ownerUserId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [],
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [], tasks: [routine], skills: [], events: [], runs: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Reader", role: "user", theme: "dark", language: "en" } };
      if (path.endsWith("/tasks/daily")) body = routine;
      if (path.endsWith("/tasks/daily/artifacts")) body = { artifacts: [{ id: "digest", sessionId: "run", kind: "workspace_file", title: name, path: `artifacts/${name}`, contentType: "text/markdown", bytes: 9000, createdAt: stamp }] };
      if (path.endsWith("/threads/run/artifacts/digest")) {
        await route.fulfill({ contentType: "text/markdown", body: "# AI 每日更新 | 2026 年 11 月 3 日\n\n" + "本期按北京时间整理，可核实的进展与原始文件。\n\n".repeat(50) + "最后一段。" });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/automations/daily?tab=artifacts");
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: new RegExp(name) }).click();
    const preview = drawer.locator(".artifact-preview-body");
    await expect(drawer.getByRole("heading", { name: /AI 每日更新/ })).toBeVisible();
    await expect.poll(async () => {
      const [body, frame] = await Promise.all([preview.boundingBox(), drawer.boundingBox()]);
      return body && frame ? Math.abs(body.y + body.height - frame.y - frame.height) : Infinity;
    }).toBeLessThan(3);
    const actions = drawer.locator(".artifact-preview-actions");
    const [controls, toggle] = await Promise.all([actions.boundingBox(), actions.locator(".code-view-toolbar").boundingBox()]);
    expect(Math.abs(controls!.x - toggle!.x)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("preview.png") });
    await preview.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(drawer.getByText("最后一段。", { exact: true })).toBeInViewport();
    await drawer.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Run now", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Run now", exact: true }).press("Escape");
    await drawer.getByRole("button", { name: "Source", exact: true }).click();
    await expect(drawer.locator(".code-view")).toContainText("# AI 每日更新");
    if (width <= 640) {
      await drawer.getByRole("button", { name: "Back to files", exact: true }).click();
      await expect(drawer.getByRole("button", { name: new RegExp(name) })).toBeFocused();
    } else {
      await expect(drawer.getByRole("button", { name: new RegExp(name) })).toBeVisible();
    }
    await context.close();
  });
}
