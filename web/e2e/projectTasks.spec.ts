import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`project tabs and issues board (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const project = { id: "launch", name: "Autumn launch", description: "Ship the autumn release: landing page, pricing, and notes.",
      ownerUserId: "u", computerId: "c", enabled: true,
      members: [], leadAgentId: null, version: 1, workspaceLayout: "project", workspaceSubpath: "projects/launch", createdAt: stamp, updatedAt: stamp };
    const tasks = ["backlog", "assigned", "running", "review", "done", "blocked"].map((status, i) => ({
      id: `task_${i}abcdef`, title: ["Write the release brief", "Polish onboarding", "Build the launch page", "Review final copy", "Choose the release date", "Resolve the deployment issue"][i],
      projectId: "launch", status, workflowStage: status === "blocked" ? "running" : status,
      description: "", priority: "normal", isRoutine: false,
      linkedSessionIds: [], ownerUserId: "u", createdAt: stamp, updatedAt: stamp,
    }));
    // Another project's task must never reach this project's board.
    const elsewhere = { ...tasks[0], id: "task_elsewhere", title: "Another project's task", projectId: "other" };
    const created: Array<Record<string, unknown>> = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [project], tasks: [...tasks, elsewhere], sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme: "light", language: "en" } };
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

    // The Dashboard leads: the project's four counts and the issues that
    // need a look. Flow readings and the stage card are gone on purpose.
    await page.goto("/projects/launch");
    await expect(page.getByRole("tab", { name: "Dashboard", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("group", { name: "Task summary", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Flow", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
    await expect(page.locator('[data-nav="projects"]')).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-dashboard-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });

    // Members carries the crew's cards; Settings carries the edit form.
    await page.getByRole("tab", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/launch\?tab=members$/);
    await expect(page.getByRole("heading", { name: /Project agents/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-members-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });

    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/launch\?tab=settings$/);
    const details = page.getByRole("form", { name: "Details", exact: true });
    await expect(details).toBeVisible();
    // The brief and the workspace folder moved here with the General tab.
    await expect(details.getByRole("textbox", { name: "Description" })).toHaveValue(project.description);
    await expect(details.getByText("projects/launch")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Danger zone", exact: true })).toBeVisible();
    // On a short window the panel scrolls rather than the shell clipping
    // the bottom: a wheel scroll (not scrollIntoView, which also moves
    // overflow:hidden boxes) must bring the last control into reach.
    await page.setViewportSize({ width: mobile ? 390 : 1440, height: 480 });
    const deleteButton = page.getByRole("button", { name: "Delete project", exact: true });
    await details.hover();
    await page.mouse.wheel(0, 4000);
    await expect.poll(() => deleteButton.evaluate(
      (el) => el.getBoundingClientRect().bottom <= window.innerHeight,
    )).toBe(true);
    expect(await deleteButton.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.bottom <= window.innerHeight && !!hit && el.contains(hit);
    })).toBe(true);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-settings-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });

    // The Issues tab is the board itself, fixed to this project.
    await page.getByRole("tab", { name: "Tasks", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/launch\?tab=tasks$/);
    const board = page.locator(".backlog-page--project");
    await expect(board).toBeVisible();
    await expect(board.locator(".sec-rail")).toHaveCount(0);
    await expect(board.getByRole("link", { name: "Write the release brief", exact: true })).toBeVisible();
    await expect(board.getByText("Another project's task")).toHaveCount(0);
    // On a phone the view toggle rides the one top bar (MobileTopbarSlot), not
    // the board header; the page holds exactly one either way.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    // The board header is controls only: no metrics, and the lanes name each status.
    await expect(board.locator(".backlog-stats")).toHaveCount(0);
    await expect(board.locator(".backlog-project-status")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-tasks-board-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.getByRole("button", { name: "List", exact: true }).click();

    // A new task is created into this project without choosing one.
    // Page actions sit in the phone's top bar, in the board header otherwise.
    const actions = mobile ? page.locator(".mobile-topbar") : board;
    await actions.getByRole("button", { name: "New task", exact: true }).first().click();
    if (mobile) {
      // The phone's plus is a menu: the top bar has no room for a separate
      // GitHub import glyph, so the import rides beside "New task".
      await expect(page.getByRole("menuitem", { name: "Import GitHub issues", exact: true })).toBeVisible();
      await page.getByRole("menuitem", { name: "New task", exact: true }).click();
    }
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
    await expect(page).toHaveURL(/\/projects\/launch\?task=task_0abcdef&recordTab=artifacts$/);
    // The modal drawer hides the page beneath it; the board's tab stays chosen.
    await expect(page.getByRole("tab", { name: "Tasks", exact: true, includeHidden: true })).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: `test-results/project-task-record-${mobile ? "mobile" : "desktop"}.png` });

    // A deep link to a record's tab lands on the same drawer; the retired
    // "workspace" id resolves to the Files tab.
    await page.goto("/projects/launch?task=task_0abcdef&recordTab=workspace");
    await expect(page).toHaveURL(/\/projects\/launch\?task=task_0abcdef&recordTab=artifacts$/);
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  });
}

for (const [mobile, theme] of [[false, "light"], [true, "dark"]] as const) {
  test(`agent proposals live on the Dashboard (${mobile ? "mobile" : "desktop"}, ${theme})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    let project: Record<string, unknown> = {
      id: "launch", name: "Autumn launch", context: "- Ship on Fridays", ownerUserId: "u", computerId: "c", enabled: true,
      members: [{ agentId: "lead", role: "lead", enabled: true }], leadAgentId: "lead", version: 3,
      workspaceLayout: "project", workspaceSubpath: "projects/launch", createdAt: stamp, updatedAt: stamp,
      contextSuggestions: [
        { id: "s1", text: "Release notes go in CHANGELOG.md", evidence: "Two runs wrote them elsewhere", threadId: "th", runId: "r1" },
        { id: "s2", text: "Use the staging computer for previews", threadId: "th", runId: "r2" },
      ],
    };
    const task = { id: "task_1abcdef", title: "Resolve the deployment issue", projectId: "launch", status: "blocked", workflowStage: "running",
      description: "", priority: "normal", isRoutine: false, linkedSessionIds: [], ownerUserId: "u", createdAt: stamp, updatedAt: stamp };
    const patches: Array<Record<string, any>> = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [project], tasks: [task], sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme, language: "en" } };
      if (path.endsWith("/projects/launch") && route.request().method() === "PATCH") {
        const input = route.request().postDataJSON();
        patches.push(input);
        const resolved: string[] = input.resolveContextSuggestions ?? [];
        project = {
          ...project,
          ...(input.context === undefined ? {} : { context: input.context }),
          contextSuggestions: (project.contextSuggestions as Array<{ id: string }>).filter((item) => !resolved.includes(item.id)),
          version: (project.version as number) + 1,
        };
        body = { project };
      } else if (path.endsWith("/projects/launch")) body = { project };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.goto("/projects/launch");
    const suggestions = page.getByRole("region", { name: /Suggested by your agents/ });
    await expect(suggestions).toBeVisible();
    // The lead agent manages the project; the dashboard offers no separate ask panel.
    await expect(page.getByRole("heading", { name: "Ask an agent", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/project-dashboard-proposals-${mobile ? "mobile" : "desktop"}-${theme}.png`, fullPage: true });

    // Adopting commits at once: the line joins the context in the same
    // revision that resolves the suggestion. Dismissing only resolves.
    await suggestions.getByRole("button", { name: "Add to context", exact: true }).first().click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({
      expectedVersion: 3,
      resolveContextSuggestions: ["s1"],
      context: "- Ship on Fridays\n- Release notes go in CHANGELOG.md",
    });
    await expect(suggestions.getByText("Release notes go in CHANGELOG.md")).toHaveCount(0);
    await suggestions.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ expectedVersion: 4, resolveContextSuggestions: ["s2"] });
    await expect(suggestions).toHaveCount(0);

    // Settings keeps the brief and the danger zone; proposals left it.
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("form", { name: "Details", exact: true })).toBeVisible();
  });
}

test("a Computer Task draft does not require a Project", async ({ page }) => {
  const tasks: Record<string, unknown>[] = [];
  const node = { id: "draft-computer", userId: "u", online: true, stale: false, status: "ready", agents: {}, activeRuns: [] };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [node], projects: [], tasks, sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme: "light", language: "en" } };
    if (path.endsWith("/tasks") && route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      tasks.push({ ...input, id: "draft", ownerUserId: "u", description: "", priority: "normal", events: [], activity: [], isRoutine: false, status: "backlog", linkedSessionIds: [], createdAt: "2026-09-01", updatedAt: "2026-09-01" });
      body = tasks[0];
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/computers/node%3Adraft-computer/tasks");
  await page.getByRole("button", { name: "New task", exact: true }).first().click();
  const form = page.getByRole("dialog", { name: "New task", exact: true });
  await form.getByRole("textbox", { name: "Title", exact: true }).fill("Keep this draft");
  await expect(form.getByRole("combobox", { name: "Project", exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("link", { name: "Keep this draft", exact: true })).toBeVisible();
  expect(tasks[0].computerId).toBe("node:draft-computer");
  expect(tasks[0].projectId).toBeUndefined();
});

for (const mobile of [false, true]) {
  test(`Task conversation stays in its Project (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const stamp = "2026-09-01T00:00:00Z";
    const project = { id: "p", name: "Launch", ownerUserId: "u", computerId: "c", enabled: true, members: [], leadAgentId: null, version: 1, workspaceLayout: "project", createdAt: stamp, updatedAt: stamp };
    const session = { id: "s", title: "Release discussion", taskGoal: "Write release notes", projectId: "p", workspacePath: "/workspace", ownerUserId: "u", participants: ["human"], status: "completed", phase: "created", createdAt: stamp, updatedAt: stamp, agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [], eventCount: 0, artifactCount: 0, runCount: 0 };
    const task = { id: "t", title: "Release notes", projectId: "p", status: "done", workflowStage: "done", description: "", priority: "normal", isRoutine: false, linkedSessionIds: ["s"], ownerUserId: "u", createdAt: stamp, updatedAt: stamp, events: [], activity: [] };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [session], tasks: [task], projects: [project], agents: [], teams: [], nodes: [], sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme: "light", language: "en" } };
      if (path.endsWith("/threads/s")) body = session;
      if (path.endsWith("/tasks/t")) body = task;
      if (path.endsWith("/events")) body = { events: [] };
      if (path.endsWith("/runs")) body = { runs: [{ ...task, taskId: "t", latestSessionId: "s", startedAt: stamp, endedAt: stamp, artifactCount: 0 }] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/projects/p");
    if (mobile) await page.getByRole("button", { name: "Projects", exact: true }).click();
    const projectList = page.locator("#thread-panel");
    const projectRow = projectList.getByRole("button", { name: "Launch · 0 agents", exact: true });
    await expect(projectRow).toBeVisible();
    if (!mobile) await expect(projectRow).toHaveAttribute("aria-current", "page");
    await expect(projectList.getByText("Release discussion", { exact: true })).toHaveCount(0);
    await page.goto("/projects/p/threads/s");
    await expect(page).toHaveURL(/\/projects\/p\/threads\/s$/);
    await expect(page.locator("#chat-panel")).toBeVisible();
    await page.reload();
    await expect(page.locator("#chat-panel")).toBeVisible();
    // Both legacy task-thread and task record links retain the Project.
    await page.goto("/tasks/t/threads/s?project=p");
    await expect(page).toHaveURL(/\/projects\/p\/threads\/s$/);
    await page.goto("/tasks/t?project=p");
    await expect(page).toHaveURL(url => url.pathname === "/projects/p" && url.searchParams.get("task") === "t");
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Release notes", exact: true })).toBeVisible();
    await page.goto("/projects/p/new");
    await expect(page).toHaveURL(/\/projects\/p\/new$/);
    await expect(page.locator("form.composer")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

/* Global work destinations remain stable even when a Project owns the active Thread. */
test("sidenav work links open global collections from a Project", async ({ page }) => {
  const stamp = "2026-09-01T00:00:00Z";
  const project = { id: "p", name: "Launch", ownerUserId: "u", computerId: "c", enabled: true, members: [], leadAgentId: null, version: 1, workspaceLayout: "project", createdAt: stamp, updatedAt: stamp };
  const room = { id: "s", title: "Release discussion", taskGoal: "Write release notes", projectId: "p", workspacePath: "/workspace", ownerUserId: "u", participants: ["human"], status: "completed", phase: "created", createdAt: stamp, updatedAt: stamp, agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], events: [], eventCount: 0, artifactCount: 0, runCount: 0 };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [room], tasks: [], projects: [project], agents: [], teams: [], nodes: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme: "light", language: "en" } };
    if (path.endsWith("/threads/s")) body = room;
    if (path.endsWith("/events")) body = { events: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/projects/p?tab=tasks");
  await expect(page.getByRole("tabpanel", { name: "Tasks", exact: true })).toBeVisible();
  await page.locator('[data-nav="threads"]').click();
  await expect(page).toHaveURL(/\/threads$/);
  await expect(page.locator('[data-nav="backlog"]')).toHaveAttribute("href", "/tasks");
  await expect(page.locator('[data-nav="routine"]')).toHaveAttribute("href", "/automations");
});

test("renaming without a runtime node recovers from a concurrent project edit", async ({ page }) => {
  const stamp = "2026-09-01T00:00:00Z";
  let project = { id: "edit-project", name: "Original project", ownerUserId: "u", computerId: "node:gone",
    enabled: true, members: [], leadAgentId: null, version: 1, workspaceLayout: "project",
    workspaceSubpath: "projects/edit-project", createdAt: stamp, updatedAt: stamp };
  const patches: Array<{ expectedVersion: number; name: string }> = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let status = 200;
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [project], tasks: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Editor", role: "user", theme: "light", language: "en" } };
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
  // Settings is a tab on the project now, not a drawer over it.
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/edit-project\?tab=settings$/);
  const editor = page.getByRole("form", { name: "Details", exact: true });
  await editor.getByRole("textbox", { name: "Project name", exact: true }).fill("My project name");
  await editor.getByRole("button", { name: "Save project", exact: true }).click();
  const conflict = page.getByRole("alertdialog", { name: "Project changed", exact: true });
  await expect(conflict).toContainText("Concurrent name");
  await expect(page.locator('input[name="project-name"]')).toHaveValue("My project name");
  await expect(page.getByRole("region", { name: "Notifications" }).getByRole("dialog")).toHaveCount(0);
  await conflict.getByRole("button", { name: "Save my changes", exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Save project", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "My project name", exact: true })).toBeVisible();
  expect(patches).toEqual([{ expectedVersion: 1, name: "My project name" }, { expectedVersion: 2, name: "My project name" }]);
});

test("edits a task's priority, status and due date from its row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = "2026-09-01T00:00:00Z";
  const project = { id: "launch", name: "Autumn launch", ownerUserId: "u", computerId: "c", enabled: true,
    members: [{ agentId: "agent-atlas", enabled: true, role: "implementer", responsibilities: "Deliver" }],
    leadAgentId: "agent-atlas", version: 1, workspaceLayout: "project", workspaceSubpath: "projects/launch", createdAt: stamp, updatedAt: stamp };
  const task = { id: "task_0abcdef", title: "Write the release brief", projectId: "launch", status: "backlog", workflowStage: "backlog",
    description: "", priority: "normal", isRoutine: false,
    linkedSessionIds: [], ownerUserId: "u", createdAt: stamp, updatedAt: stamp };
  // Only the enabled Project Agent is offered, even when another Agent shares its Computer.
  const atlas = { id: "agent-atlas", displayName: "Atlas", executorKind: "codex", enabled: true, availability: "ready",
    placements: [{ computerId: "c", desiredState: "active" }], deletedAt: null, createdAt: stamp, updatedAt: stamp };
  const outsider = { ...atlas, id: "agent-outsider", displayName: "Neighbour" };
  const patches: Array<Record<string, unknown>> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = { sessions: [], agents: [atlas, outsider], teams: [], nodes: [], projects: [project], tasks: [task], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Designer", role: "user", theme: "light", language: "en" } };
    if (path.endsWith(`/tasks/${task.id}`) && request.method() === "PATCH") {
      const input = request.postDataJSON();
      patches.push(input);
      Object.assign(task, input, input.status ? { workflowStage: input.status } : {});
      body = { ...task, activity: [], events: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/projects/launch?tab=tasks");
  const row = page.getByRole("row").filter({ hasText: task.title });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: /^Priority: Normal/ }).click();
  await page.getByRole("menuitem", { name: "High", exact: true }).click();
  await expect(row.getByRole("button", { name: /^Priority: High/ })).toBeVisible();

  await row.getByRole("button", { name: /^Status: Backlog/ }).click();
  // A task that never started cannot jump to review or completion.
  await expect(page.getByRole("menuitem", { name: "Completed", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: "test-results/project-tasks-inline-status-menu.png", clip: { x: 432, y: 320, width: 640, height: 300 } });
  await page.getByRole("menuitem", { name: "Ready", exact: true }).click();
  await expect(row.getByRole("button", { name: /^Status: Ready/ })).toBeVisible();

  await row.hover();
  await row.getByRole("button", { name: "Set due date", exact: true }).click();
  await page.getByRole("grid").getByRole("button").filter({ hasText: /^15$/ }).first().click();
  await expect(row.getByRole("button", { name: /^Due / })).toBeVisible();
  // The assignee is the row's own chip; the shared roster picker opens from it.
  await row.getByRole("combobox", { name: /^Assignee: Unassigned/ }).click();
  await expect(page.getByRole("option", { name: /Neighbour/ })).toHaveCount(0);
  await page.screenshot({ path: "test-results/project-tasks-inline-assignee.png", clip: { x: 900, y: 320, width: 540, height: 360 } });
  await page.getByRole("option", { name: /Atlas/ }).click();
  await expect(row.getByRole("combobox", { name: /^Assignee: Atlas/ })).toBeVisible();
  await page.screenshot({ path: "test-results/project-tasks-inline-edit.png" });

  expect(patches).toEqual([
    { priority: "high" },
    { status: "assigned" },
    { dueDate: expect.stringMatching(/^\d{4}-\d{2}-15$/) },
    { assignedAgentId: "agent-atlas", assignedTeamId: null, collaborationStyle: "" },
  ]);
});
