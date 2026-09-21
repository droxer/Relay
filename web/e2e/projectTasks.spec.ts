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
    const requests: string[] = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(route.request().url());

      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [project], tasks, sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", employeeId: "u", username: "Designer", role: "employee", theme: "light", language: "en" } };
      if (path.endsWith("/tasks") && route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        expect(input.projectId).toBe("launch");
        const created = { ...tasks[0], ...input, id: "created", activity: [], events: [] };
        tasks.push(created); body = created;
      }
      const detail = tasks.find((task) => path.endsWith(`/tasks/${task.id}`));
      if (detail) body = { ...detail, activity: [], events: [] };
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { runs: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/projects/launch");
    await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Write the release brief" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    await expect(page.getByRole("tab", { name: "Activities", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-nav="projects"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-nav="backlog"]')).not.toHaveAttribute("aria-current", "page");
    await page.getByRole("textbox", { name: "New task", exact: true }).fill("Prepare release notes");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.getByRole("button", { name: "Prepare release notes" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "7");
    await expect(page.getByRole("textbox", { name: "New task", exact: true })).toHaveValue("");
    const panel = page.locator(".project-tasks-panel");
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const finalCard = page.getByRole("button", { name: "Choose the release date" });
    await finalCard.scrollIntoViewIfNeeded();
    await expect(finalCard).toBeInViewport();
    await panel.evaluate((el) => { el.scrollTop = 0; });
    await page.locator(".project-task-board").evaluate((el) => { el.scrollLeft = 0; });
    await page.screenshot({ path: `/tmp/relay-project-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.getByRole("tab", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute("aria-selected", "true");
    // Global creation from a project section returns to that project's tasks.
    await page.keyboard.press("c");
    await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("textbox", { name: "New task", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Prepare release notes", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Definition", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/backlog\/created\?project=launch/);
    await expect(page.locator('[data-nav="backlog"]')).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Prepare release notes", exact: true })).toBeInViewport();
    const definitionTab = page.getByRole("tab", { name: "Definition", exact: true });
    expect((await definitionTab.boundingBox())?.width).toBeGreaterThan(60);
    await definitionTab.click();
    await expect(page.getByRole("tab", { name: "Definition", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    if (mobile) await expect(page.locator(".task-project-nav-mobile select")).toHaveValue("launch");
    else {
      await page.locator(".task-project-nav").getByRole("link", { name: "Write the release brief", exact: true }).click();
      await expect(page).toHaveURL(/\/backlog\/task-0\?project=launch/);
    }
    await page.screenshot({ path: `/tmp/relay-grouped-tasks-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    if (mobile) await page.locator(".task-project-nav-mobile select").selectOption("");
    else await page.locator(".task-project-nav").getByRole("link", { name: "All tasks", exact: true }).click();
    await expect(page).toHaveURL(/\/backlog$/);
    await page.locator("#backlog-panel .page-header").getByRole("button", { name: "New task", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Global project task");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(dialog.getByText("Choose a project before creating a task.")).toBeVisible();
    await dialog.getByRole("combobox", { name: "Projects", exact: true }).click();
    await page.getByRole("option", { name: "Autumn launch", exact: true }).click();
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#backlog-panel").getByRole("link", { name: "Global project task", exact: true })).toBeVisible();
    await page.goto("/projects/launch?task=task-0&recordTab=files");
    await expect(page).toHaveURL((url) => url.pathname === "/backlog/task-0" && url.searchParams.get("project") === "launch" && url.searchParams.get("tab") === "files");
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await expect(page).toHaveURL(/\/backlog$/);
    await page.locator('[data-nav="projects"]').click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator('[data-nav="projects"]')).toHaveAttribute("aria-current", "page");
    expect(requests.some((url) => url.includes("workspace/brief"))).toBe(false);
  });
}

test("creating the first project preserves a global task draft", async ({ page }) => {
  const stamp = "2026-09-01T00:00:00Z";
  const projects: any[] = [];
  const tasks: any[] = [];
  const node = { activeRuns: [], agents: [], queuedCommandCount: 0, stale: false, id: "node", computerId: "computer", employeeId: "u", displayName: "Work computer", capabilities: ["project-workspaces"], online: true, status: "ready", workspacePath: "/workspace" };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [node], projects, tasks, sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", employeeId: "u", username: "Designer", role: "employee", theme: "light", language: "en" } };
    if (path.endsWith("/projects") && route.request().method() === "POST") {
      const project = { ...route.request().postDataJSON(), id: "first", ownerEmployeeId: "u", computerId: "computer", enabled: true, version: 1, workspaceLayout: "project", workspaceSubpath: "projects/first", createdAt: stamp, updatedAt: stamp };
      projects.push(project); body = { project };
    }
    if (path.endsWith("/tasks") && route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      expect(input).toMatchObject({ title: "Keep this draft", projectId: "first" });
      const task = { events: [], activity: [], ...input, id: "task", createdAt: stamp, updatedAt: stamp, linkedSessionIds: [], isRoutine: false, routineEnabled: false, status: "backlog" };
      tasks.push(task); body = task;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/backlog");
  await page.locator("#backlog-panel .page-header").getByRole("button", { name: "New task", exact: true }).click();
  const taskForm = page.getByRole("dialog", { name: "New task", exact: true });
  await taskForm.getByRole("textbox", { name: "Title", exact: true }).fill("Keep this draft");
  await taskForm.getByRole("button", { name: "Create project", exact: true }).click();
  const projectForm = page.getByRole("dialog", { name: "Start a new project", exact: true });
  await projectForm.getByRole("textbox").fill("First project");
  await projectForm.getByRole("combobox", { name: "Computer", exact: true }).click();
  await page.getByRole("option", { name: "Work computer", exact: true }).click();
  await projectForm.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(projectForm).toHaveCount(0);
  await expect(taskForm.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Keep this draft");
  await expect(taskForm.getByRole("combobox", { name: "Projects", exact: true })).toContainText("First project");
  await taskForm.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.locator("#backlog-panel").getByRole("link", { name: "Keep this draft", exact: true })).toBeVisible();
});

test("renaming without a runtime node recovers from a concurrent project edit", async ({ page }) => {
  const stamp = "2026-09-01T00:00:00Z";
  let project = { id: "edit-project", name: "Original project", ownerEmployeeId: "u", computerId: "node:gone",
    enabled: true, members: [], leadAgentId: null, version: 1, workspaceLayout: "project",
    workspaceSubpath: "projects/edit-project", createdAt: stamp, updatedAt: stamp };
  const patches: Array<{ expectedVersion: number; name: string }> = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let status = 200;
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [project], tasks: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", employeeId: "u", username: "Editor", role: "employee", theme: "light", language: "en" } };
    if (path.endsWith("/projects/edit-project")) {
      if (route.request().method() === "PATCH") {
        const input = route.request().postDataJSON();
        patches.push(input);
        if (patches.length === 1) {
          project = { ...project, name: "Concurrent name", version: 2 };
          status = 409;
          body = { detail: "project_version_conflict" };
        } else {
          expect(input.expectedVersion).toBe(2);
          project = { ...project, name: input.name, version: 3 };
          body = { project };
        }
      } else body = { project };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/projects/edit-project");
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Project settings", exact: true });
  await editor.getByRole("textbox", { name: "Project name", exact: true }).fill("My project name");
  await editor.getByRole("button", { name: "Save project", exact: true }).click();
  const conflict = page.getByRole("alertdialog", { name: "Project changed", exact: true });
  await expect(conflict).toContainText("Concurrent name");
  await expect(page.locator('input[name="project-name"]')).toHaveValue("My project name");
  await expect(page.getByRole("region", { name: "Notifications" }).getByRole("dialog")).toHaveCount(0);
  await conflict.getByRole("button", { name: "Save my changes", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "My project name", exact: true })).toBeVisible();
  expect(patches).toEqual([{ expectedVersion: 1, name: "My project name" }, { expectedVersion: 2, name: "My project name" }]);
});
