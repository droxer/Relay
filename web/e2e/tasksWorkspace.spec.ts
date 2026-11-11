import { expect, test } from "@playwright/test";

const computer = { id: "workspace", userId: "u", online: true, stale: false, status: "ready", agents: {}, activeRuns: [] };
const tasksPath = "/computers/node%3Aworkspace/tasks";

for (const mobile of [false, true]) {
  test(`Computer task filters, isolation and file drawer (${mobile ? "mobile" : "desktop"})`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const tasks = [
      { id: "ship", title: "Ship the release", status: "review", priority: "high" },
      { id: "answer", title: "Answer customers", status: "running", priority: "normal" },
    ].map(task => ({ ...task, computerId: "node:workspace", description: "Check the execution results.", isRoutine: false,
      linkedSessionIds: [], ownerUserId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [] }));
    const foreign = [
      { ...tasks[0], id: "project-task", title: "Project-only work", computerId: undefined, projectId: "launch" },
      { ...tasks[0], id: "other-task", title: "Another Computer work", computerId: "node:other" },
    ];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [computer], projects: [], tasks: [...tasks, ...foreign], sandboxes: [], skills: [], files: [], entries: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme: "light", language: "en" } };
      const detail = tasks.find(task => path.endsWith(`/tasks/${task.id}`));
      if (detail) body = detail;
      if (path.endsWith("/tasks/ship/artifacts")) body = { artifacts: [
        { id: "notes", sessionId: "run", kind: "workspace_file", title: "release-notes.md", path: "artifacts/release-notes.md", contentType: "text/markdown", bytes: 100, createdAt: stamp },
      ] };
      if (path.endsWith("/threads/run/artifacts/notes")) {
        await route.fulfill({ contentType: "text/plain", body: "# Release notes\n\n" + "Ready to ship.\n\n".repeat(40) + "End of release notes." });
        return;
      }
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { runs: [] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(tasksPath);
    const panel = page.getByRole("region", { name: "Tasks", exact: true });
    const rows = panel.getByRole("table", { name: "Tasks", exact: true });
    await expect(rows.getByRole("link", { name: "Ship the release", exact: true })).toBeVisible();
    await expect(rows.getByRole("link", { name: "Answer customers", exact: true })).toBeVisible();
    await expect(panel.getByText("Project-only work")).toHaveCount(0);
    await expect(panel.getByText("Another Computer work")).toHaveCount(0);
    await panel.getByRole("button", { name: "Add filter", exact: true }).click();
    await page.getByRole("option", { name: /^Priority/ }).click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await expect(rows.getByRole("link", { name: "Answer customers", exact: true })).toHaveCount(0);
    await rows.getByRole("link", { name: "Ship the release", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Close drawer", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === tasksPath && url.searchParams.get("priority") === "high");
    // A legacy record/tab link still resolves to this Computer's Files tab.
    await page.goto("/tasks/ship?tab=workspace");
    await expect(drawer.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
    await drawer.getByRole("button", { name: /release-notes.md/ }).click();
    await expect(drawer.getByRole("heading", { name: "Release notes", exact: true })).toBeVisible();
    const preview = drawer.locator(".artifact-preview-body");
    await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(drawer.getByText("End of release notes.", { exact: true })).toBeInViewport();
    await expect(drawer.locator("a[download]")).toHaveAttribute("href", /\/threads\/run\/artifacts\/notes$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`computer-task-files-${mobile ? "mobile" : "desktop"}.png`) });
  });
}

for (const width of [320, 390, 820]) {
  test(`automation preview fills a ${width}px touch screen`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width, height: 744 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const stamp = "2026-11-03T12:00:00Z";
    const name = "ai-daily-update-2026-11-03.md";
    const routine = {
      id: "daily", computerId: "node:workspace", title: "AI Daily Updates", description: "", status: "backlog", priority: "normal",
      isRoutine: true, routineState: "active", routineTriggers: [], linkedSessionIds: [], assignedAgentId: "agent",
      ownerUserId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [],
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [computer], projects: [], tasks: [routine], skills: [], events: [], runs: [] };
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

for (const width of [390, 1440]) {
  test(`SVG task file preview (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const stamp = "2026-11-10T00:00:00Z";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#e5f3f7"/><text x="32" y="100" font-size="28">SVG 图片 #1</text><script>parent.svgExecuted = true</script></svg>';
    const task = { id: "diagram", computerId: "node:workspace", title: "Diagram output", status: "review", priority: "normal", isRoutine: false, linkedSessionIds: [], ownerUserId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [] };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], tasks: [task], nodes: [computer], projects: [], sandboxes: [], skills: [], events: [], runs: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Reader", role: "user", theme: "light", language: "en" } };
      if (path.endsWith("/tasks/diagram")) body = task;
      if (path.endsWith("/tasks/diagram/artifacts")) body = { artifacts: [{ id: "svg", sessionId: "run", kind: "workspace_file", title: "diagram.SVG", workspaceRelativePath: "artifacts/diagram.SVG", contentType: "application/octet-stream", bytes: svg.length, createdAt: stamp }] };
      if (path.endsWith("/threads/run/artifacts/svg")) {
        await route.fulfill({ contentType: "application/octet-stream", body: svg });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/tasks/diagram?tab=artifacts");
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: /diagram.SVG/ }).click();
    const image = drawer.getByRole("img", { name: "diagram.SVG" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(400);
    expect(await page.evaluate(() => "svgExecuted" in window)).toBe(false);
    await page.screenshot({ path: info.outputPath("svg-preview.png") });
    await drawer.getByRole("button", { name: "Source", exact: true }).click();
    await expect(image).toHaveCount(0);
    await expect(drawer.locator("code")).toHaveText(svg);
    await drawer.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(image).toBeVisible();
  });
}
