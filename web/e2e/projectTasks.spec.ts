import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`project general and tasks board (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const project = { id: "launch", name: "Autumn launch", description: "Ship the autumn release: landing page, pricing, and notes.",
      ownerEmployeeId: "u", computerId: "c", enabled: true,
      members: [], leadAgentId: null, version: 1, workspaceLayout: "project", workspaceSubpath: "projects/launch", createdAt: stamp, updatedAt: stamp };
    const tasks = ["backlog", "assigned", "running", "review", "done", "blocked"].map((status, i) => ({
      id: `task_${i}abcdef`, title: ["Write the release brief", "Polish onboarding", "Build the launch page", "Review final copy", "Choose the release date", "Resolve the deployment issue"][i],
      projectId: "launch", status, workflowStage: status === "blocked" ? "running" : status,
      description: "", priority: "normal", isRoutine: false, routineEnabled: false,
      linkedSessionIds: [], ownerEmployeeId: "u", createdAt: stamp, updatedAt: stamp,
    }));
    // Another project's task must never reach this project's board.
    const elsewhere = { ...tasks[0], id: "task_elsewhere", title: "Another project's task", projectId: "other" };
    const created: Array<Record<string, unknown>> = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [project], tasks: [...tasks, elsewhere], sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", employeeId: "u", username: "Designer", role: "employee", theme: "light", language: "en" } };
      if (path.endsWith("/tasks") && route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        created.push(input);
        const task = { ...tasks[0], ...input, id: "task_created1", activity: [], events: [] };
        tasks.push(task); body = task;
      }
      const detail = tasks.find((task) => path.endsWith(`/tasks/${task.id}`));
      if (detail) body = { ...detail, activity: [], events: [] };
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { taskId: "", runs: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    // General leads: the brief, then the crew, beside the identity rail.
    await page.goto("/projects/launch");
    await expect(page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Description", exact: true })).toBeVisible();
    await expect(page.getByText(project.description)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Project agents/ })).toBeVisible();
    await expect(page.locator('[data-nav="projects"]')).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-general-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });

    // Tasks is the backlog board itself, fixed to this project.
    await page.getByRole("tab", { name: "Tasks", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/launch\?tab=tasks$/);
    const board = page.locator(".backlog-page--project");
    await expect(board).toBeVisible();
    await expect(board.locator(".sec-rail")).toHaveCount(0);
    await expect(board.getByRole("link", { name: "Write the release brief", exact: true })).toBeVisible();
    await expect(board.getByText("Another project's task")).toHaveCount(0);
    await board.getByRole("button", { name: "Board view", exact: true }).click();
    await expect(board.locator(".backlog-stats")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-tasks-board-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await board.getByRole("button", { name: "List view", exact: true }).click();

    // A new task is created into this project without choosing one.
    await board.getByRole("button", { name: "New task", exact: true }).first().click();
    const form = page.getByRole("dialog", { name: "New task", exact: true });
    await form.getByRole("textbox", { name: "Title", exact: true }).fill("Prepare release notes");
    await form.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(created[0]).toMatchObject({ title: "Prepare release notes", projectId: "launch" });

    // A record opens as a drawer over the project, not on the backlog route.
    await board.getByRole("link", { name: "Write the release brief", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/launch\?task=task_0abcdef$/);
    await expect(page.getByRole("tab", { name: "Activity", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/launch\?task=task_0abcdef&recordTab=files$/);
    // The modal drawer hides the page beneath it; the board's tab stays chosen.
    await expect(page.getByRole("tab", { name: "Tasks", exact: true, includeHidden: true })).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: `test-results/project-task-record-${mobile ? "mobile" : "desktop"}.png` });

    // A deep link to a record's tab lands on the same drawer.
    await page.goto("/projects/launch?task=task_0abcdef&recordTab=files");
    await expect(page).toHaveURL(/\/projects\/launch\?task=task_0abcdef&recordTab=files$/);
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
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

for (const mobile of [false, true]) {
  test(`task thread stays in Tasks (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const project = { id: "p", name: "Launch", ownerEmployeeId: "u", computerId: "c", enabled: true, members: [], leadAgentId: null, version: 1, workspaceLayout: "project", createdAt: stamp, updatedAt: stamp };
    const session = { id: "s", title: "Release discussion", taskGoal: "Write release notes", projectId: "p", workspacePath: "/workspace", ownerEmployeeId: "u", participants: ["human"], status: "completed", phase: "created", createdAt: stamp, updatedAt: stamp, agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [], eventCount: 0, artifactCount: 0, runCount: 0 };
    const task = { id: "t", title: "Release notes", projectId: "p", status: "done", workflowStage: "done", description: "", priority: "normal", isRoutine: false, linkedSessionIds: ["s"], ownerEmployeeId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [] };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [session], tasks: [task], projects: [project], agents: [], teams: [], nodes: [], sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", employeeId: "u", username: "Designer", role: "employee", theme: "light", language: "en" } };
      if (path.endsWith("/threads/s")) body = session;
      if (path.endsWith("/tasks/t")) body = task;
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { runs: [{ ...task, taskId: "t", latestSessionId: "s", startedAt: stamp, endedAt: stamp, artifactCount: 0 }] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/projects/p/threads/s");
    await expect(page).toHaveURL(/\/backlog\/t\/threads\/s\?project=p$/);
    await expect(page.locator('[data-nav="backlog"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#chat-panel")).toBeVisible();
    await expect(mobile ? page.locator(".mobile-topbar-title") : page.getByRole("heading", { name: "Release discussion" })).toHaveText("Release discussion");
    await expect(page.locator("#thread-panel")).toHaveCount(0);
    const back = page.getByRole(mobile ? "button" : "link", { name: "Back to task", exact: true });
    if (!mobile) await expect(back).toHaveAttribute("href", "/backlog/t?project=p");
    await page.reload();
    await expect(back).toBeVisible();
    expect((await page.locator("#chat-panel > .record-band").boundingBox())!.height).toBeLessThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/task-thread-${mobile ? "mobile" : "desktop"}.png` });
    await back.click();
    await expect(page).toHaveURL(/\/backlog\/t\?project=p$/);
    await expect(page.getByRole("heading", { name: "Release notes", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open thread", exact: true }).click();
    await expect(page).toHaveURL(/\/backlog\/t\/threads\/s/);
    await expect(mobile ? page.locator(".mobile-topbar-title") : page.getByRole("heading", { name: "Release discussion" })).toHaveText("Release discussion");
    await page.goto("/threads");
    const row = page.locator(".conversation-row").filter({ hasText: "Release discussion" });
    await expect(row.locator(".conversation-project")).toHaveText("Launch");
    await expect(row.getByRole("button", { name: /Project: Launch/ })).toBeVisible();
    await page.screenshot({ path: `test-results/task-thread-list-${mobile ? "mobile" : "desktop"}.png` });
    await row.getByRole("button", { name: /Project: Launch/ }).click();
    await expect(page).toHaveURL(/\/threads\/s$/);
    await expect(page.locator('[data-nav="threads"]')).toHaveAttribute("aria-current", "page");
    await page.reload();
    await expect(page).toHaveURL(/\/threads\/s$/);
    await expect(page.locator("#chat-panel")).toBeVisible();
    if (!mobile) await expect(page.locator("#thread-panel")).toBeVisible();
    if (mobile) await page.getByRole("button", { name: "Threads", exact: true }).click();
    await expect(row.locator(".conversation-project")).toBeVisible();
    await page.goto("/projects/p/new");
    await expect(page).toHaveURL(/\/backlog\?project=p$/);
  });
}

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
